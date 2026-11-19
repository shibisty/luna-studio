import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readArchive } from 'grapesjs-site-pages/archive';
import { main, parseArgs, runningStudio } from '../src/server/commands';
import { createProject, findProject, packageName, siteDir } from '../src/server/project';
import { SiteStore } from '../src/server/siteStore';

let tmp: string;
let output: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'lunastudio-'));
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
    output += String(s);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe('arguments', () => {
  it('reads values, flags and their negations', () => {
    expect(parseArgs(['a', '--port', '80', '--title=My site', '--no-install', '--open'], ['port', 'title'], ['install', 'open'])).toEqual({
      args: ['a'],
      opts: { port: '80', title: 'My site', install: false, open: true },
    });
    expect(() => parseArgs(['--port'], ['port'], [])).toThrow(/needs a value/);
    expect(() => parseArgs(['--nope'], [], [])).toThrow(/unknown option --nope/);
    expect(parseArgs(['--', '--x'], [], []).args).toEqual(['--x']);
  });
});

describe('lunastudio new', () => {
  it('makes a project the other commands find', async () => {
    const dir = path.join(tmp, 'Кофейня Brew');
    await main(['new', dir, '--no-install', '--mcp-port', '8800', '--title', 'Brew & Co', '--from', 'file:../luna-studio.tgz']);
    expect(output).toMatch(/Created/);
    expect(output).toMatch(/npm install\n {2}npm start/);

    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: 'brew', private: true, devDependencies: { 'luna-studio': 'file:../luna-studio.tgz' } });
    expect(pkg.scripts.start).toBe('lunastudio start --open');
    const mcp = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['luna-studio']).toEqual({ command: 'node', args: ['node_modules/luna-studio/bin/lunastudio.js', 'mcp'] });
    expect(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toMatch(/# Brew & Co/);

    await mkdir(path.join(dir, 'deeper', 'still'), { recursive: true });
    const p = (await findProject(path.join(dir, 'deeper', 'still')))!;
    expect(p.root).toBe(dir);
    expect(p.config).toEqual({ site: 'site', port: 5174, mcp: { port: 8800 } });

    const store = new SiteStore(siteDir(p));
    await store.load();
    expect(store.records.get('site')!.name).toBe('Brew & Co');
    expect(store.list('page').map((r) => [r.name, r.slug])).toEqual([['Home', '/']]);
  });

  it('refuses a folder with something in it', async () => {
    await writeFile(path.join(tmp, 'x.txt'), '1');
    await expect(createProject(tmp, { version: '^1' })).rejects.toThrow(/not empty/);
  });

  it('names the package after the folder', () => {
    expect(packageName('My Site!')).toBe('my-site');
    expect(packageName('Café')).toBe('cafe');
    expect(packageName('Кофе')).toBe('luna-site');
  });
});

describe('lunastudio export / import', () => {
  it('round-trips the site', async () => {
    const a = path.join(tmp, 'a');
    await createProject(a, { version: '^1', title: 'A' });
    const zip = path.join(tmp, 'a.zip');
    await main(['export', zip, '--site', path.join(a, 'site')]);
    expect(output).toMatch(/2 records/);
    const arc = readArchive(new Uint8Array(await readFile(zip)));
    expect(arc.records.map((r) => r.kind).sort()).toEqual(['page', 'site']);

    const b = path.join(tmp, 'b');
    await main(['import', zip, '--site', b]);
    const store = new SiteStore(b);
    await store.load();
    expect(store.records.get('site')!.name).toBe('A');
    expect(store.list('page')[0].slug).toBe('/');
  });

  it('does not import under a running studio', async () => {
    const site = path.join(tmp, 's');
    await mkdir(path.join(site, '.studio'), { recursive: true });
    await writeFile(path.join(site, '.studio', 'server.json'), JSON.stringify({ pid: process.pid, url: 'http://localhost:5174/' }));
    expect(await runningStudio(site)).toMatchObject({ pid: process.pid });
    await expect(main(['import', path.join(tmp, 'none.zip'), '--site', site])).rejects.toThrow(/stop it first/);
    // A studio that is gone does not count.
    await writeFile(path.join(site, '.studio', 'server.json'), JSON.stringify({ pid: 2 ** 22 + 12345, url: 'x' }));
    expect(await runningStudio(site)).toBeNull();
  });

  it('says what is wrong', async () => {
    await expect(main(['export', '--site', tmp])).rejects.toThrow(/not a site folder/);
    await writeFile(path.join(tmp, 'bad.zip'), 'nope');
    await expect(main(['import', path.join(tmp, 'bad.zip'), '--site', path.join(tmp, 'x')])).rejects.toThrow(/not a site archive/);
    expect(existsSync(path.join(tmp, 'x'))).toBe(false);
  });
});

describe('help', () => {
  it('has a page per command', async () => {
    await main(['help', 'new']);
    expect(output).toMatch(/lunastudio new <name>/);
    output = '';
    await main(['--version']);
    expect(output).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
