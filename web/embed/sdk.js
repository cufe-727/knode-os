/* knode-os embed SDK — the embedded reader (/embed/v1) in a page of another app */

/**
 * For a page on an origin the server lists in `server.embed.allowedOrigins`,
 * which is also what lets this module load there (it goes out with CORS for
 * those origins alone):
 *
 *   import { mount } from 'https://knode.example.com/embed/sdk.js';
 *
 *   const embed = mount(document.querySelector('#reader'), {
 *     baseUrl: 'https://knode.example.com',
 *     view: 'doc',                          // 'doc' | 'folder' | 'search'
 *     path: 'raw/docs/notes/x.md',          // a workspace path, for a document or a folder
 *     q: '…', scope: 'raw/docs',            // a search, optionally under a folder
 *     fragment: 'e-88703d61',               // an entry anchor or a heading in the document
 *     workspace: { kind: 'personal', id: 'default' },   // or { kind: 'team', id: '<Team name>' }
 *     theme: 'dark',                        // 'light' | 'dark'; left out, the system's
 *     tokens: { background, foreground, muted, mutedForeground, border, primary, radius, fontSans, fontMono, fontHeading },
 *     autoHeight: true, minHeight: 320, maxHeight: 2000,
 *     onReady, onNavigate, onAuth, onError, onResize,
 *   });
 *   embed.navigate({ view: 'doc', path: 'raw/docs/notes/y.md' });
 *   embed.setTheme('light', tokens);
 *   embed.destroy();
 *
 * Tokens are CSS values as the page should use them — "#0b0d12",
 * "oklch(0.98 0 0)", "0.5rem", "Inter, sans-serif" — never `var(--…)`,
 * which means nothing inside the frame; a bare HSL triple ("222.2 84% 4.9%")
 * is read as hsl(…). Callbacks get the message's payload: onNavigate
 * `{ view, path, title, fragment? }` (`q` and `scope` for a search), onAuth
 * `{ state: 'signed-in' | 'signed-out' }`, onError `{ code: 'not-found' |
 * 'forbidden' | 'unavailable', message }`, onResize `{ height }`, onReady
 * `{ view, path }`.
 *
 * The frame says `ready` before it loads anything. Without that within
 * eight seconds (`readyTimeoutMs`), knode-os is down or refuses to be framed
 * here: onError hears 'unavailable', and the frame gives way to a link that
 * opens the file in knode-os (`fallback: false` leaves that to you).
 *
 * The protocol is web/embed/embed.js's; this module is one client of it, and
 * a host may speak it directly instead. No dependencies, no build step.
 */

const PROTOCOL = 1;
const VIEWS = ['doc', 'folder', 'search'];
export const READY_TIMEOUT_MS = 8000;

function originOf(baseUrl) {
  let url = null;
  try {
    url = new URL(String(baseUrl ?? ''));
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new TypeError('knode-os embed: baseUrl must be the origin knode-os is reached at, such as https://knode.example.com');
  }
  return url.origin;
}

const str = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** What to show, as the protocol carries it; an unknown view is refused rather than guessed at. */
function cleanTarget(target = {}) {
  const view = target.view ?? (target.q && !target.path ? 'search' : 'doc');
  if (!VIEWS.includes(view)) throw new TypeError(`knode-os embed: view must be one of ${VIEWS.join(', ')}`);
  const out = { view };
  for (const key of ['path', 'q', 'scope', 'fragment']) if (target[key]) out[key] = str(target[key]);
  return out;
}

/** The reader's address for these options. */
export function embedUrl(options = {}) {
  const base = originOf(options.baseUrl);
  const target = cleanTarget(options);
  const q = new URLSearchParams({ view: target.view });
  if (target.view === 'search') {
    if (target.q) q.set('q', target.q);
    if (target.scope) q.set('scope', target.scope);
  } else if (target.path) q.set('path', target.path);
  const ws = options.workspace;
  if (ws?.kind) q.set('kind', str(ws.kind));
  if (ws?.id) q.set('ws', str(ws.id));
  if (options.theme === 'light' || options.theme === 'dark') q.set('theme', options.theme);
  if (options.origin) q.set('origin', str(options.origin));
  return `${base}/embed/v1?${q}${target.fragment ? `#${encodeURIComponent(target.fragment)}` : ''}`;
}

/** The full knode-os UI at a file or folder: /?open=<path>&kind=&ws=#<fragment> (web/deeplink.js). */
export function deepLink(options = {}) {
  const base = originOf(options.baseUrl);
  const q = new URLSearchParams({ open: str(options.path) });
  const ws = options.workspace;
  if (ws?.id) {
    q.set('kind', ws.kind === 'team' ? 'team' : 'personal');
    q.set('ws', str(ws.id));
  }
  return `${base}/?${q}${options.fragment ? `#${encodeURIComponent(options.fragment)}` : ''}`;
}

const number = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

export function mount(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function' || !container.ownerDocument) {
    throw new TypeError('knode-os embed: mount(container, options) needs an element to mount the reader in');
  }
  const base = originOf(options.baseUrl);
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const autoHeight = options.autoHeight !== false;
  const minHeight = number(options.minHeight, 320);
  const maxHeight = Math.max(minHeight, number(options.maxHeight, 2000));
  const timeout = number(options.readyTimeoutMs, READY_TIMEOUT_MS);
  const workspace = options.workspace;

  const iframe = doc.createElement('iframe');
  iframe.src = embedUrl({ ...options, origin: win.location.origin });
  iframe.title = options.title || 'knode-os';
  iframe.style.display = 'block';
  iframe.style.width = '100%';
  iframe.style.border = '0';
  iframe.style.height = autoHeight ? `${minHeight}px` : '100%';
  if (!autoHeight) iframe.style.minHeight = `${minHeight}px`;
  container.appendChild(iframe);

  let ready = false;
  let destroyed = false;
  let fallback = null;
  /** Where the reader is, for the fallback link: what it was opened at, then where it says it went. */
  let shown = cleanTarget(options);
  /** The look to give the frame each time it is ready (a reload of the frame forgets it). */
  let look = options.tokens ? { theme: options.theme, tokens: options.tokens } : null;
  const queue = [];

  const post = (type, payload) => iframe.contentWindow?.postMessage({ source: 'knode-host', version: PROTOCOL, type, ...payload }, base);

  function showFallback() {
    fallback = doc.createElement('div');
    fallback.className = 'knode-embed-fallback';
    fallback.append(doc.createTextNode('knode-os could not be shown here. '));
    const link = doc.createElement('a');
    link.href = deepLink({ baseUrl: base, path: shown.view === 'search' ? '' : shown.path, workspace, fragment: shown.fragment });
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open in knode-os ↗';
    fallback.append(link);
    iframe.style.display = 'none';
    container.appendChild(fallback);
  }

  const timer = win.setTimeout(() => {
    if (ready || destroyed) return;
    options.onError?.({ code: 'unavailable', message: `knode-os did not answer within ${Math.round(timeout / 1000)} s: it may be down, or may not let ${win.location.origin} frame it (server.embed.allowedOrigins)` });
    if (options.fallback !== false) showFallback();
  }, timeout);

  function onMessage(event) {
    if (destroyed || event.source !== iframe.contentWindow || event.origin !== base) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.source !== 'knode-embed' || msg.version !== PROTOCOL) return;
    const { source, version, type, ...payload } = msg;
    if (type === 'ready') {
      ready = true;
      win.clearTimeout(timer);
      if (fallback) {
        fallback.remove();
        fallback = null;
        iframe.style.display = 'block';
      }
      if (look) post('theme', look);
      for (const queued of queue.splice(0)) post(queued.type, queued.payload);
      options.onReady?.(payload);
    } else if (type === 'resize') {
      if (autoHeight && Number.isFinite(payload.height)) iframe.style.height = `${Math.min(maxHeight, Math.max(minHeight, Math.ceil(payload.height)))}px`;
      options.onResize?.(payload);
    } else if (type === 'navigate') {
      shown = { ...payload };
      options.onNavigate?.(payload);
    } else if (type === 'auth') {
      options.onAuth?.(payload);
    } else if (type === 'error') {
      options.onError?.(payload);
    }
  }
  win.addEventListener('message', onMessage);

  return {
    iframe,
    get ready() {
      return ready;
    },
    /** Another file, folder or search in the same frame: `{ view, path?, q?, scope?, fragment? }`. */
    navigate(target) {
      if (destroyed) return;
      const next = cleanTarget(target);
      shown = next;
      if (ready) post('navigate', next);
      else queue.push({ type: 'navigate', payload: next });
    },
    /** Light or dark, with the host's tokens when given (`{}` clears those sent before). */
    setTheme(theme, tokens) {
      if (destroyed) return;
      look = tokens === undefined ? { ...look, theme } : { theme, tokens };
      if (ready) post('theme', tokens === undefined ? { theme } : { theme, tokens });
    },
    destroy() {
      destroyed = true;
      win.clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      queue.length = 0;
      fallback?.remove();
      iframe.remove();
    },
  };
}
