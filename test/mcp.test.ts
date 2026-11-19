import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import WebSocket from 'ws';
import { createMcp, type Mcp } from '../src/mcp';
import { mcpConfig } from '../src/server/studio';

let mcp: Mcp;
let client: Client;
let port: number;
const editors: WebSocket[] = [];

/** A fake editor tab: answers the bridge's methods with `handle`. */
function editor(handle: (method: string, params: any) => unknown, origin = 'http://localhost:5174', query = ''): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { origin });
    editors.push(ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', info: { title: 'Luna Studio' } }));
      resolve(ws);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      try {
        ws.send(JSON.stringify({ id: m.id, result: await handle(m.method, m.params) }));
      } catch (e) {
        ws.send(JSON.stringify({ id: m.id, error: (e as Error).message }));
      }
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const textOf = (r: any) => JSON.parse(r.content[0].text);

async function start(opts: Parameters<typeof createMcp>[0] = {}) {
  mcp = createMcp({ port: 0, log: () => undefined, timeoutMs: 500, ...opts });
  port = await mcp.listening;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
}

beforeEach(() => start());

afterEach(async () => {
  editors.splice(0).forEach((w) => w.close());
  await client.close();
  await mcp.close();
});

describe('the MCP server', () => {
  it('lists the tools and tells Claude how to work', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['editor_status', 'list_records', 'open_record', 'create_record', 'update_record', 'publish', 'add_html', 'screenshot', 'set_device'])
      expect(names).toContain(n);
    expect(names).not.toContain('eval');
    expect(client.getInstructions()).toMatch(/page-slot/);
  });

  it('says how to connect when no editor is there', async () => {
    const r = textOf(await client.callTool({ name: 'editor_status', arguments: {} }));
    expect(r.connected).toBe(false);
    expect(r.hint).toMatch(/--mcp/);
    const e: any = await client.callTool({ name: 'get_page', arguments: {} });
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toMatch(/not connected/);
  });

  it('passes calls to the editor and its answers back', async () => {
    const calls: Array<[string, any]> = [];
    await editor((method, params) => {
      calls.push([method, params]);
      if (method === 'info') return { open: { id: 'p1', kind: 'page' } };
      if (method === 'add_html') return { added: ['c1'] };
      if (method === 'publish') throw new Error('Publishing needs the remote mode.');
      if (method === 'screenshot') return { imageBase64: 'AAAA', mimeType: 'image/jpeg', width: 375, height: 800 };
      return { ok: true };
    });
    await settle();

    const st = textOf(await client.callTool({ name: 'editor_status', arguments: {} }));
    expect(st).toMatchObject({ connected: true, page: { title: 'Luna Studio' }, open: { id: 'p1' } });

    const add = textOf(await client.callTool({ name: 'add_html', arguments: { html: '<section class="hero"></section>', css: '.hero{}' } }));
    expect(add).toEqual({ added: ['c1'] });
    expect(calls.at(-1)).toEqual(['add_html', { html: '<section class="hero"></section>', css: '.hero{}' }]);

    const pub: any = await client.callTool({ name: 'publish', arguments: {} });
    expect(pub.isError).toBe(true);
    expect(pub.content[0].text).toBe('Publishing needs the remote mode.');

    const shot: any = await client.callTool({ name: 'screenshot', arguments: { device: 'mobile' } });
    expect(shot.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect(JSON.parse(shot.content[1].text)).toEqual({ width: 375, height: 800 });
    expect(calls.at(-1)).toEqual(['screenshot', { device: 'mobile' }]);
  });

  it('checks the arguments before the editor sees them', async () => {
    const calls: string[] = [];
    await editor((m) => void calls.push(m));
    await settle();
    const r: any = await client.callTool({ name: 'set_device', arguments: { device: 'watch' } });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('gives up on an editor that does not answer', async () => {
    await editor(() => new Promise(() => undefined));
    await settle();
    const r: any = await client.callTool({ name: 'get_tree', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/did not answer "get_tree"/);
  });

  it('lets the newest tab take over', async () => {
    const first = await editor(() => ({ tab: 1 }));
    await editor(() => ({ tab: 2 }));
    await settle();
    expect(first.readyState).toBeGreaterThan(WebSocket.OPEN);
    expect(textOf(await client.callTool({ name: 'get_page', arguments: {} }))).toEqual({ tab: 2 });
  });

  it('refuses pages of other origins', async () => {
    await expect(editor(() => 1, 'https://evil.example')).rejects.toThrow(/403/);
    await expect(editor(() => 1, 'http://localhost:3000')).resolves.toBeTruthy();
  });

  it('wants the token when it has one', async () => {
    await client.close();
    await mcp.close();
    await start({ token: 's3cret' });
    await expect(editor(() => 1)).rejects.toThrow(/401/);
    await expect(editor(() => 1, undefined, '?token=s3cret')).resolves.toBeTruthy();
  });
});

describe('the studio side', () => {
  it('gives the page the server to connect to', () => {
    expect(mcpConfig(null)).toBeNull();
    expect(mcpConfig(true)).toEqual({ url: 'ws://127.0.0.1:8765', token: '' });
    expect(mcpConfig({ port: 9001, token: 't' })).toEqual({ url: 'ws://127.0.0.1:9001', token: 't' });
  });
});
