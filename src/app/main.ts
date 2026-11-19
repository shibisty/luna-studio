import './style.css';
import { loadBundle, mount, previewTarget, TUI_SCRIPTS, TUI_STYLES, localized, RU, type Words } from '../editor';

/**
 * Luna Studio's page: a bar (where the site lives, sign-in, archive
 * buttons, language, theme) over the editor. The target is either the
 * local folder (the studio's own API) or an application of a dashboard
 * the studio is signed in to (through the studio's proxy, which adds the
 * token). Switching reloads the page: one editor per target.
 */

declare const window: Window & Record<string, any>;

type Target = { mode: 'local' } | { mode: 'remote'; url: string; app: string; name: string };

interface State {
  dir: string;
  site: string;
  edited: string[];
  dashboard: string;
  accounts: Array<{ url: string; developer: { name?: string; email?: string } }>;
  current: string | null;
  mcp: { url: string; token: string } | null;
}

const UI = {
  en: {
    local: 'Local folder',
    signIn: 'Sign in to Luna…',
    signOut: 'Sign out',
    dashboardPrompt: 'The address of your Luna dashboard:',
    exportZip: 'Export ZIP',
    importZip: 'Import ZIP',
    preview: 'Preview',
    upload: 'Upload the folder here',
    uploadConfirm: 'Write the local folder’s pages, layouts, templates and site into %s? Records with the same id or address are replaced.',
    pull: 'Save to the folder',
    pullConfirm: 'Replace the designs in the local folder with %s’s? Entries in the folder stay.',
    pulled: 'Saved to the folder: %s records.',
    uploaded: 'Uploaded: %s new, %s updated.',
    failed: 'Failed: %s',
    apps: 'Applications',
    noApps: 'No applications',
    signedOutThere: 'Not signed in to that dashboard any more: back to the local folder.',
    editedOutside: 'Taken from HTML edited outside the studio: %s.',
    working: 'Working…',
    light: 'Light',
    system: 'As in the system',
    dark: 'Dark',
    mcp: 'MCP',
    mcpOn: 'Claude is connected (MCP server at %s)',
    mcpOff: 'Waiting for the MCP server at %s: start Claude Code with luna-studio-mcp',
  },
  ru: {
    local: 'Локальная папка',
    signIn: 'Войти в Luna…',
    signOut: 'Выйти',
    dashboardPrompt: 'Адрес вашего дашборда Luna:',
    exportZip: 'Экспорт ZIP',
    importZip: 'Импорт ZIP',
    preview: 'Предпросмотр',
    upload: 'Загрузить папку сюда',
    uploadConfirm: 'Записать страницы, макеты, шаблоны и сайт из локальной папки в %s? Записи с тем же id или адресом будут заменены.',
    pull: 'Сохранить в папку',
    pullConfirm: 'Заменить дизайн в локальной папке дизайном %s? Записи в папке останутся.',
    pulled: 'Сохранено в папку: %s записей.',
    uploaded: 'Загружено: новых %s, обновлено %s.',
    failed: 'Не удалось: %s',
    apps: 'Приложения',
    noApps: 'Нет приложений',
    signedOutThere: 'Вы больше не вошли в этот дашборд: открыта локальная папка.',
    editedOutside: 'Взято из HTML, изменённого вне студии: %s.',
    working: 'Работаем…',
    light: 'Светлая',
    system: 'Как в системе',
    dark: 'Тёмная',
    mcp: 'MCP',
    mcpOn: 'Claude подключён (MCP-сервер %s)',
    mcpOff: 'Ждём MCP-сервер %s: запустите Claude Code с luna-studio-mcp',
  },
};
type UiWords = (typeof UI)['en'];

const fmt = (s: string, ...a: Array<string | number>) => a.reduce<string>((r, v) => r.replace('%s', String(v)), s);
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`luna-studio:${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`luna-studio:${k}`, v);
    } catch {
      /* private mode */
    }
  },
};

const HEADERS = { 'X-Luna-Studio': '1' };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...HEADERS, ...(body !== undefined && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
  });
  if (r.status === 204) return undefined as T;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j as T;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Array<Node | string>) => {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  e.append(...kids);
  return e;
};

const ICONS = {
  light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0z',
  system: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 17.93V4.07A8 8 0 0 1 13 19.93z',
  dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
};

async function main(): Promise<void> {
  const lang = (store.get('lang') || (navigator.language || 'en').slice(0, 2)) === 'ru' ? 'ru' : 'en';
  const theme = store.get('theme') || 'system';
  document.documentElement.lang = lang;
  document.documentElement.dataset.theme = theme;
  const w: UiWords = UI[lang];
  const ew: Words = (lang === 'ru' ? localized(RU) : localized()).words;

  const bar = document.getElementById('bar')!;
  const status = el('span', { class: 'status', role: 'status' });
  const say = (text: string, isError = false) => {
    status.textContent = text || '';
    status.title = text || '';
    status.classList.toggle('error', !!isError);
  };

  const state = await api<State>('GET', '/studio/api/state');
  let target: Target = { mode: 'local' };
  try {
    const saved = JSON.parse(store.get('target') || 'null');
    if (saved?.mode === 'remote' && saved.app && saved.url) target = saved;
  } catch {
    /* none */
  }
  if (target.mode === 'remote' && !state.accounts.some((a) => a.url === (target as any).url)) {
    target = { mode: 'local' };
    store.set('target', JSON.stringify(target));
    setTimeout(() => say(w.signedOutThere, true), 0);
  }
  if (target.mode === 'remote' && state.current !== target.url) await api('POST', '/studio/api/use', { url: target.url });

  /* ---- the bar ---- */
  const go = (t: Target) => {
    store.set('target', JSON.stringify(t));
    location.reload();
  };
  const picker = el('select', { class: 'target', 'aria-label': w.apps });
  picker.append(el('option', { value: 'local' }, `${w.local}: ${state.dir}`));
  const apps: Array<{ id: string; name: string }> = [];
  if (state.current) {
    const group = el('optgroup', { label: `${w.apps} · ${state.current.replace(/^https?:\/\//, '')}` });
    try {
      const res = await api<{ items: Array<{ id: string; name: string }> }>('GET', '/studio/api/apps');
      apps.push(...(res.items || []));
      apps.forEach((a) => group.append(el('option', { value: `app:${a.id}` }, a.name)));
      if (!apps.length) group.append(el('option', { value: '', disabled: '' }, w.noApps));
    } catch (e) {
      say(fmt(w.failed, (e as Error).message), true);
    }
    picker.append(group);
  }
  picker.value = target.mode === 'local' ? 'local' : `app:${target.app}`;
  picker.addEventListener('change', () => {
    const v = picker.value;
    if (v === 'local') return go({ mode: 'local' });
    const a = apps.find((x) => `app:${x.id}` === v);
    if (a && state.current) go({ mode: 'remote', url: state.current, app: a.id, name: a.name });
  });

  const button = (label: string, onclick: () => void, title = '') => {
    const b = el('button', { type: 'button', ...(title ? { title } : {}) }, label);
    b.addEventListener('click', onclick);
    return b;
  };
  const account = state.accounts.find((a) => a.url === state.current);
  const signBtn = account
    ? button(w.signOut, async () => {
        await api('POST', '/studio/api/sign-out', { url: account.url });
        go({ mode: 'local' });
      }, `${account.developer.name || ''} ${account.developer.email || ''} · ${account.url}`.trim())
    : button(w.signIn, async () => {
        const url = window.prompt(w.dashboardPrompt, state.dashboard);
        if (!url) return;
        try {
          const r = await api<{ location: string }>('POST', '/studio/api/sign-in', { url, back: '/' });
          location.href = r.location;
        } catch (e) {
          say(fmt(w.failed, (e as Error).message), true);
        }
      });

  const toggle = (items: Array<[string, string, boolean, () => void, string?]>, label: string) => {
    const nav = el('nav', { class: 'toggle', 'aria-label': label });
    items.forEach(([text, title, current, fn, icon]) => {
      const a = el('a', { href: '#', title, 'aria-label': title, 'aria-current': String(current) });
      if (icon) a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg>`;
      else a.textContent = text;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
      });
      nav.append(a);
    });
    return nav;
  };
  const setPref = (k: string, v: string) => {
    store.set(k, v);
    location.reload();
  };

  const editorBox = document.getElementById('gjs')!;
  let editor: any = null;
  const isRemote = target.mode === 'remote';
  const remoteName = isRemote ? (target as Extract<Target, { mode: 'remote' }>).name : '';

  const preview = button(w.preview, async () => {
    if (!editor) return;
    const t = await previewTarget(editor, ew);
    if ('error' in t) return say(t.error, true);
    const url = isRemote
      ? `${(target as any).url}/apps/${encodeURIComponent((target as any).app)}/pages/preview?id=${encodeURIComponent(t.id)}`
      : `/studio/preview/${encodeURIComponent(t.id)}`;
    window.open(url, '_blank', 'noopener');
  });
  const exportBtn = button(w.exportZip, () => editor?.runCommand('pages-manager:export'));
  const importBtn = button(w.importZip, () => editor?.runCommand('pages-manager:import'));
  const extra: HTMLElement[] = [];
  if (isRemote) {
    // The folder → this application: the plugin imports the folder's archive here.
    extra.push(
      button(w.upload, async () => {
        if (!editor || !window.confirm(fmt(w.uploadConfirm, remoteName))) return;
        say(w.working);
        try {
          const r = await fetch('/studio/api/export.zip', { headers: HEADERS });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const rep = await editor.PagesManager.importArchive(new Uint8Array(await r.arrayBuffer()), { mode: 'replace' });
          const errs = rep.errors.map((e: any) => `${e.name}: ${e.error}`).join('; ');
          say(fmt(w.uploaded, rep.created, rep.updated) + (errs ? ' ' + fmt(w.failed, errs) : ''), !!errs);
        } catch (e) {
          say(fmt(w.failed, (e as Error).message), true);
        }
      }),
      // This application → the folder (work offline, keep it in git).
      button(w.pull, async () => {
        if (!editor || !window.confirm(fmt(w.pullConfirm, remoteName))) return;
        say(w.working);
        try {
          const bytes: Uint8Array = await editor.PagesManager.exportArchive({ html: true });
          const r = await api<{ records: number }>('POST', '/studio/api/import', bytes);
          say(fmt(w.pulled, r.records));
        } catch (e) {
          say(fmt(w.failed, (e as Error).message), true);
        }
      })
    );
  }

  // Claude's connection (luna-studio --mcp): a chip, green when the MCP server is there.
  const mcpChip = state.mcp ? el('span', { class: 'mcp', role: 'status', 'aria-live': 'polite' }, w.mcp) : null;
  const mcpStatus = (on: boolean) => {
    if (!mcpChip || !state.mcp) return;
    mcpChip.classList.toggle('on', on);
    mcpChip.title = fmt(on ? w.mcpOn : w.mcpOff, state.mcp.url);
  };

  bar.append(
    el('span', { class: 'title' }, 'Luna Studio'),
    picker,
    el('span', { class: 'spacer' }),
    status,
    ...(mcpChip ? [mcpChip] : []),
    preview,
    exportBtn,
    importBtn,
    ...extra,
    signBtn,
    toggle(
      (['en', 'ru'] as const).map((l) => [l.toUpperCase(), l === 'ru' ? 'Русский' : 'English', l === lang, () => setPref('lang', l)]),
      'Language'
    ),
    toggle(
      (['light', 'system', 'dark'] as const).map((t) => [t, w[t], t === theme, () => setPref('theme', t), ICONS[t]]),
      'Theme'
    )
  );
  if (state.edited.length && !isRemote) say(fmt(w.editedOutside, state.edited.length));

  /* ---- the editor ---- */
  await loadBundle('/editor');
  const base = isRemote ? `/studio/remote/${encodeURIComponent((target as any).app)}` : '';
  editor = mount({
    container: editorBox,
    pagesApi: isRemote ? `${base}/pages/editor` : '/studio/local/editor',
    contentApi: isRemote ? `${base}/pages/content` : '/studio/local/content',
    headers: () => HEADERS,
    // One cache per target, so a local folder and an application never mix.
    cacheDbName: isRemote ? `luna-studio-${(target as any).url}-${(target as any).app}` : `luna-studio-local-${state.dir}`,
    files: isRemote ? { api: `${base}/files`, max: 10 * 1024 * 1024, headers: () => HEADERS } : null,
    lang,
    fonts: '/studio/fonts',
    icons: '/editor/font-awesome.min.css',
    tui: { script: TUI_SCRIPTS.map((f) => `/editor/${f}`), style: TUI_STYLES.map((f) => `/editor/${f}`) },
    callbacks: { dropbox: '/editor/dropbox-callback.html', microsoft: '/editor/microsoft-callback.html' },
    status: say,
    pagesOptions: { archiveName: () => `${(isRemote ? remoteName : state.site) || 'site'}-${new Date().toISOString().slice(0, 10)}` },
    mcp: state.mcp ? { url: state.mcp.url, token: state.mcp.token, onStatus: mcpStatus } : null,
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String((e as Error).message).replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</pre>`);
});
