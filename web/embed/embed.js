/* knode-os embedded reader — one document, folder or search, for another app's iframe */
'use strict';

/**
 * The page /embed/v1 serves (src/server/embed.ts): another app puts it in an
 * iframe to show one file, folder or search of a knode-os workspace, drawn by
 * the web UI's own renderers (web/markdown.js, web/chart.js) under the UI's
 * own policy. Its address says what to show:
 *
 *   /embed/v1?view=doc|folder|search&path=…&q=…&scope=…&kind=personal|team&ws=…
 *            &theme=light|dark&origin=<the host page's origin>#<fragment>
 *
 * It signs in nothing: its requests ride the browser's knode-os session
 * cookie and name the workspace in the X-Knode-Workspace-* headers. Signed
 * out, it says so, with a button that opens knode-os in a new tab, and loads
 * by itself once the reader comes back signed in.
 *
 * It talks to its host over postMessage, to the `origin` parameter alone,
 * and only when the server lists that origin (server.embed.allowedOrigins,
 * written into the page as <meta name="knode-embed-origins">) and the frame's
 * parent is that origin where the browser can tell:
 *
 *   to the host     { source: 'knode-embed', version: 1, type, ...payload }
 *     ready         { view, path }       the page is up, before its content
 *     resize        { height }           the content's height, whenever it changes
 *     navigate      { view, path, title, fragment?, q?, scope? }   after a move inside the page
 *     auth          { state: 'signed-in' | 'signed-out' }          when known, and when it changes
 *     error         { code: 'not-found' | 'forbidden' | 'unavailable', message }
 *   from the host   { source: 'knode-host', version: 1, type, ...payload }
 *     theme         { theme: 'light' | 'dark', tokens? }   tokens: CSS values for the page's variables
 *     navigate      { view, path?, q?, scope?, fragment? } another file, folder or search, no reload
 *
 * Links stay inside: a relative link or a [[wikilink]] opens here, with a
 * back button; a web link opens a new tab. Markup goes in only from the
 * Markdown renderer or as text.
 *
 * A plain script, no build step. Its helpers are on `knodeEmbed`; the tests
 * load this file without a document, which stops it there.
 */
(function (global) {
  const PROTOCOL = 1;
  const VIEWS = ['doc', 'folder', 'search'];
  /** MAX_FILE_BYTES: the whole of a weekly digest, so that its later entries — and their anchors — are there. */
  const READ_BYTES = 4 * 1024 * 1024;
  const SEARCH_K = 24;
  const SEARCH_SHOWN = 12;
  const FOLDER_SHOWN = 1000;
  const TRAIL_MAX = 50;
  const SIGNED_OUT_POLL_MS = 15000;
  const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

  /**
   * The host's theme tokens and the page variables each one sets (web/embed/embed.css),
   * by the CSS property a value must be valid for.
   */
  const TOKENS = {
    background: { vars: ['--bg'], property: 'color' },
    foreground: { vars: ['--fg'], property: 'color' },
    muted: { vars: ['--bg2', '--bg3'], property: 'color' },
    mutedForeground: { vars: ['--muted'], property: 'color' },
    border: { vars: ['--border', '--border-strong'], property: 'color' },
    primary: { vars: ['--accent'], property: 'color' },
    radius: { vars: ['--radius'], property: 'border-radius' },
    fontSans: { vars: ['--font-sans'], property: 'font-family' },
    fontMono: { vars: ['--mono'], property: 'font-family' },
    fontHeading: { vars: ['--font-heading'], property: 'font-family' },
  };

  /* ------------------------------- helpers ------------------------------- */

  const normalizePath = (value) => global.knodeDeepLink.normalize(value);
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseName = (p) => p.split('/').pop() || p;
  const isMarkdown = (p) => /\.(md|markdown)$/i.test(p ?? '');
  const isImage = (p) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(p ?? '');
  /** Files a browser shows as they are (src/server/originals.ts). */
  const hasOriginal = (p) => /\.(pdf|html?|xhtml|png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif|svg)$/i.test(p ?? '');
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /** A search hit's passage as plain text: links as their labels, without the table pipes, emphasis and heading marks. */
  const plainText = (s) => squash(String(s ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s*(?:#{1,6}\s|>\s?|[-*+]\s)/gm, '')
    .replace(/\|?\s*:?-{3,}:?\s*\|?/g, ' ')
    .replace(/[|`]|\*\*|__/g, ' '));

  /** A link's or a picture's target, read from the folder of the file it is in; null when it climbs out of the workspace. */
  function joinPath(dir, rel) {
    let target = String(rel ?? '');
    try {
      target = decodeURI(target);
    } catch {
      // written with a stray %: as it is
    }
    return normalizePath(target.startsWith('/') ? target : `${dir}/${target}`);
  }

  const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

  function unquote(value) {
    const v = String(value).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        return String(JSON.parse(v));
      } catch {
        return v.slice(1, -1);
      }
    }
    if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
    return v;
  }

  /** `a, "b, c", [d]` — a flow list's items, cut at its top level. */
  function flowItems(inner) {
    const items = [];
    let item = '';
    let quote = null;
    let depth = 0;
    for (const ch of inner) {
      if (quote) {
        item += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        items.push(item);
        item = '';
        continue;
      }
      item += ch;
    }
    items.push(item);
    return items.map(unquote).filter(Boolean);
  }

  /**
   * The frontmatter's top-level fields a reader shows: a scalar as text, a
   * list (flow or block) as an array, a folded or literal block as its text; a
   * nested map is left out. Read line by line and leniently, the way
   * markdown.js reads its summary: half-written YAML still shows. null when the
   * text opens with no frontmatter.
   */
  function readFrontmatter(text) {
    const block = FRONTMATTER.exec(String(text ?? ''));
    if (!block) return null;
    const fields = {};
    let list = null;
    let scalar = null;
    const closeScalar = () => {
      if (scalar) fields[scalar.key] = scalar.lines.join(scalar.fold ? ' ' : '\n').trim();
      scalar = null;
    };
    for (const line of block[1].split(/\r?\n/)) {
      if (scalar && (/^[ \t]/.test(line) || !line.trim())) {
        scalar.lines.push(line.trim());
        continue;
      }
      closeScalar();
      const top = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
      if (top) {
        const [, key, raw = ''] = top;
        const value = raw.trim();
        list = null;
        if (!value) list = fields[key] = [];
        else if (/^[|>][+-]?$/.test(value)) scalar = { key, lines: [], fold: value[0] === '>' };
        else if (value.startsWith('[') && value.endsWith(']')) fields[key] = flowItems(value.slice(1, -1));
        else if (!value.startsWith('{')) fields[key] = unquote(value);
        continue;
      }
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(line);
      if (item && list) list.push(unquote(item[1]));
    }
    closeScalar();
    return fields;
  }

  function cssSupports(property, value) {
    try {
      return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports(property, value);
    } catch {
      return false;
    }
  }

  /** shadcn's older themes keep bare HSL channels, "222.2 84% 4.9%", for `hsl(var(--x))`. */
  const HSL_CHANNELS = /^-?[\d.]+(?:deg)?\s+[\d.]+%\s+[\d.]+%(?:\s*\/\s*[\d.]+%?)?$/;

  /**
   * The host's tokens as the page variables they set — `{ '--bg': '#fff', … }`
   * — keeping only short values valid for their property: never a reference
   * to the host's own variables (which mean nothing here), a URL to load, or
   * anything that could end the declaration.
   */
  function sanitizeTokens(tokens, supports = cssSupports) {
    const vars = {};
    if (!tokens || typeof tokens !== 'object') return vars;
    for (const [name, spec] of Object.entries(TOKENS)) {
      const raw = tokens[name];
      if (typeof raw !== 'string') continue;
      let value = raw.trim();
      if (!value || value.length > 200 || /[;{}<>\\]|url\s*\(|var\s*\(|expression\s*\(|@import/i.test(value)) continue;
      if (spec.property === 'color' && HSL_CHANNELS.test(value)) value = `hsl(${value})`;
      if (!supports(spec.property, value)) continue;
      for (const v of spec.vars) vars[v] = value;
    }
    return vars;
  }

  /**
   * The host this page may talk to: the `origin` it was given — exactly an
   * origin — when the server lists it or it is this page's own, and when the
   * frame's parent, where the browser says (`ancestor`), is that origin.
   */
  function hostOrigin(param, allowed, self, ancestor) {
    if (typeof param !== 'string' || !param) return null;
    let origin;
    try {
      origin = new URL(param).origin;
    } catch {
      return null;
    }
    if (origin === 'null' || (param !== origin && param !== `${origin}/`)) return null;
    if (origin !== self && !(allowed || []).includes(origin)) return null;
    if (ancestor && ancestor !== origin) return null;
    return origin;
  }

  const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

  /** A target named by an address or a host's message, cleaned; `invalid` says why it cannot be shown. */
  function readTarget(input) {
    const get = (key) => (typeof input.get === 'function' ? input.get(key) : input[key]);
    const q = text(get('q'), 500);
    const asked = get('view');
    const view = VIEWS.includes(asked) ? asked : q && !get('path') ? 'search' : 'doc';
    const rawPath = text(get('path'), 2048);
    const path = normalizePath(rawPath);
    const scope = normalizePath(text(get('scope'), 2048)) || '';
    const fragment = text(get('fragment'), 512) || null;
    const target = { view, path: path ?? '', q, scope, fragment };
    if (path === null) target.invalid = `${rawPath} is outside the workspace`;
    else if (view === 'doc' && !path) target.invalid = 'no file named: the address needs path=…';
    return target;
  }

  /** How the host hears of an API failure — or 'auth', which is the sign-in panel, not an error. */
  function errorCode(status, reason) {
    if (status === 401 && reason === 'auth') return 'auth';
    if (status === 403 && reason !== 'https' && reason !== 'csrf') return 'forbidden';
    if (status === 400 || status === 401 || status === 404) return 'not-found';
    return 'unavailable';
  }

  global.knodeEmbed = { PROTOCOL, normalizePath, joinPath, readFrontmatter, sanitizeTokens, hostOrigin, readTarget, errorCode };
  if (typeof document === 'undefined') return;

  /* -------------------------------- page --------------------------------- */

  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  // before the first paint; without one the page follows the system's
  const asked = params.get('theme');
  if (asked === 'light' || asked === 'dark') root.dataset.theme = asked;

  const workspace = { kind: params.get('kind') === 'team' ? 'team' : 'personal', id: text(params.get('ws'), 128) || 'default' };
  const headers = {
    'x-knode-workspace-kind': workspace.kind,
    'x-knode-workspace-id': workspace.id,
    // a Team is found by its name; a personal workspace by its id
    'x-knode-workspace-name': workspace.id,
  };

  const allowed = (() => {
    try {
      const list = JSON.parse(document.querySelector('meta[name="knode-embed-origins"]')?.content || '[]');
      return Array.isArray(list) ? list.filter((o) => typeof o === 'string') : [];
    } catch {
      return [];
    }
  })();
  const framed = window.parent !== window;
  const ancestor = location.ancestorOrigins?.length ? location.ancestorOrigins[0] : null;
  const host = framed ? hostOrigin(params.get('origin'), allowed, location.origin, ancestor) : null;
  if (framed && !host) {
    console.warn(`knode-os embed: origin=${params.get('origin') ?? '(none)'} is not this frame's host or not in server.embed.allowedOrigins — no messages will be sent or taken`);
  }

  function post(type, payload = {}) {
    if (host) window.parent.postMessage({ source: 'knode-embed', version: PROTOCOL, type, ...payload }, host);
  }

  let current = readTarget({ ...Object.fromEntries(params), fragment: decodeHash(location.hash) });
  const trail = [];
  let auth = null; // 'signed-in' | 'signed-out', once known
  let seq = 0;
  let poll = null;
  let pendingReveal = null;
  let barVisible = true;
  let els = null;

  function decodeHash(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  class EmbedError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(url) {
    let res;
    try {
      res = await fetch(url, { headers, credentials: 'same-origin' });
    } catch (e) {
      throw new EmbedError('unavailable', `knode-os did not answer (${e.message})`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    throw new EmbedError(errorCode(res.status, data.reason), data.error || `${res.status} ${res.statusText}`);
  }

  const enc = encodeURIComponent;
  const el = (tag, cls, content) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
  };

  /** The file itself, to open or show: a request from the page names its workspace in the query, as a link must. */
  function originalHref(path) {
    const q = new URLSearchParams({ path, kind: workspace.kind, id: workspace.id, name: workspace.id });
    if (headers['x-knode-user']) q.set('user', headers['x-knode-user']);
    return `/api/file/original?${q}`;
  }

  /* -------------------------------- auth --------------------------------- */

  /** Whether requests will be answered: a session cookie, or a server with sign-in off (development), which takes `user=`. */
  async function signedIn() {
    const res = await fetch('/api/auth/state', { credentials: 'same-origin' });
    const state = await res.json();
    if (state.auth === false) {
      const user = text(params.get('user'), 64);
      if (user) headers['x-knode-user'] = user;
      return true;
    }
    return Boolean(state.signedIn);
  }

  function setAuth(state) {
    if (auth === state) return;
    auth = state;
    post('auth', { state });
    if (state === 'signed-out' && !poll) poll = setInterval(recheck, SIGNED_OUT_POLL_MS);
    if (state === 'signed-in' && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  /** Back from signing in in another tab: look again, and load if it worked. */
  async function recheck() {
    if (auth !== 'signed-out' || document.visibilityState === 'hidden') return;
    try {
      if (!(await signedIn()) || auth !== 'signed-out') return;
    } catch {
      return;
    }
    setAuth('signed-in');
    show(current);
  }

  function showSignedOut() {
    seq++;
    const panel = el('section', 'panel');
    panel.append(el('h2', '', 'Sign in to knode-os'));
    panel.append(el('p', '', 'This view reads from knode-os, and your browser is not signed in there. Sign in in a new tab, then come back: it loads by itself.'));
    const button = el('a', 'button', 'Sign in to knode-os ↗');
    button.href = openHref();
    button.target = '_blank';
    button.rel = 'noopener';
    panel.append(button);
    panel.append(el('p', 'hint', 'Signed in already? The browser shares the sign-in only between pages on the same site: this page and knode-os must both be on one domain, or both on localhost (127.0.0.1 is another site).'));
    els.main.replaceChildren(panel);
    paintBar();
    setAuth('signed-out');
  }

  /* -------------------------------- views -------------------------------- */

  const ERROR_TITLES = { 'not-found': 'Not found', forbidden: 'Not allowed', unavailable: 'knode-os is unavailable' };

  function showError(error) {
    const panel = el('section', 'panel panel-error');
    panel.append(el('h2', '', ERROR_TITLES[error.code] ?? ERROR_TITLES.unavailable));
    panel.append(el('p', '', error.message));
    els.main.replaceChildren(panel);
  }

  /**
   * Show a target: fetch, then paint unless another move came first. true
   * when it is on screen; a failure is painted and told to the host.
   */
  async function show(target, { scroll = null } = {}) {
    const n = ++seq;
    current = { ...target, title: target.title ?? null };
    paintBar();
    els.main.setAttribute('aria-busy', 'true');
    try {
      if (target.invalid) throw new EmbedError('not-found', target.invalid);
      const paint = target.view === 'folder' ? await loadFolder(target) : target.view === 'search' ? await loadSearch(target) : await loadDoc(target);
      if (n !== seq) return false;
      current = { ...current, ...paint.target, title: paint.title };
      els.main.replaceChildren(paint.node);
      paintBar();
      syncAddress();
      if (scroll !== null) window.scrollTo(0, scroll);
      else if (!(current.fragment && scrollToFragment(current.fragment))) window.scrollTo(0, 0);
      return true;
    } catch (e) {
      if (n !== seq) return false;
      if (e.code === 'auth') {
        showSignedOut();
        return false;
      }
      const error = e instanceof EmbedError ? e : new EmbedError('unavailable', e.message);
      // a file system error names where the server keeps the workspace on disk, which is not the host's business
      if (/\bE[A-Z]{3,}\b:/.test(error.message)) {
        error.message = /\bENO(?:ENT|TDIR)\b/.test(error.message)
          ? `${target.path || 'This folder'} does not exist in this workspace`
          : `${target.path || 'This folder'} cannot be read here`;
      }
      showError(error);
      post('error', { code: error.code, message: error.message });
      return false;
    } finally {
      if (n === seq) els.main.removeAttribute('aria-busy');
    }
  }

  /** A document: its frontmatter as a title area, its Markdown through the UI's renderer, anything else as text. */
  async function loadDoc(target) {
    let file = null;
    try {
      file = await api(`/api/file?path=${enc(target.path)}&maxBytes=${READ_BYTES}`);
    } catch (e) {
      if (e.code !== 'not-found') throw e;
      // a folder asked for as a document opens as the folder; a picture not converted yet still shows
      const node = await api(`/api/tree?path=${enc(target.path)}&depth=1`).catch(() => null);
      if (node?.kind === 'dir') return loadFolder({ ...target, view: 'folder' });
      if (!(node?.kind === 'file' && isImage(target.path))) throw e;
    }
    const article = el('article', 'doc');
    let title = baseName(target.path);
    if (file && (isMarkdown(target.path) || file.derived)) {
      const fields = file.derived ? null : readFrontmatter(file.content);
      const body = el('div', 'markdown');
      body.innerHTML = global.knodeMarkdown.render(file.content);
      global.knodeChart?.hydrate(body);
      global.knodeMindmap?.hydrate(body);
      fixLinks(body, target.path);
      const head = docHead(fields, body);
      title = text(fields?.title, 300) || squash(body.querySelector('h1')?.textContent) || title;
      if (head) article.append(head);
      article.append(body);
    } else if (file) {
      article.append(el('pre', 'doc-text', file.content));
    }
    if (hasOriginal(target.path)) article.prepend(originalNote(target.path, file));
    if (file?.truncated) article.append(el('p', 'doc-note', `Only the first ${Math.round(READ_BYTES / 1e6)} MB of this file is shown — open it in knode-os for the rest.`));
    return { node: article, title, target: { view: 'doc' } };
  }

  /** What knode-os read out of a PDF or a picture, and the way to the file itself: a picture shows here too. */
  function originalNote(path, file) {
    const box = el('div', 'doc-original');
    if (isImage(path)) {
      const img = el('img', 'doc-image');
      img.src = originalHref(path);
      img.alt = baseName(path);
      box.append(img);
    }
    const note = el('p', 'doc-note', file?.derived ? 'Text knode-os read out of the original. ' : file ? '' : 'knode-os has not read this file yet. ');
    const link = el('a', '', 'Open the original ↗');
    link.href = originalHref(path);
    link.target = '_blank';
    link.rel = 'noopener';
    note.append(link);
    box.append(note);
    return box;
  }

  /**
   * The title area from the frontmatter — title, type, date, stage, verdict,
   * description, tags — with the renderer's folded metadata panel beneath; the
   * body's first heading goes when it only repeats the title.
   */
  function docHead(fields, body) {
    if (!fields) return null;
    const head = el('header', 'doc-head');
    const title = text(fields.title, 300);
    if (title) {
      const h1 = body.querySelector(':scope > h1');
      if (h1 && squash(h1.textContent) === squash(title)) h1.remove();
      head.append(el('h1', 'doc-title', title));
    }
    const chips = el('div', 'doc-chips');
    for (const key of ['type', 'date', 'stage', 'verdict']) {
      const value = text(Array.isArray(fields[key]) ? fields[key].join(', ') : fields[key], 80);
      if (!value) continue;
      const chip = el('span', `chip chip-${key}`, value);
      chip.title = key;
      chips.append(chip);
    }
    if (chips.childElementCount) head.append(chips);
    const description = text(fields.description, 2000);
    if (description) head.append(el('p', 'doc-desc', description));
    const tags = (Array.isArray(fields.tags) ? fields.tags : String(fields.tags ?? '').split(',')).map((t) => text(t, 60)).filter(Boolean);
    if (tags.length) {
      const list = el('ul', 'doc-tags');
      for (const tag of tags.slice(0, 30)) list.append(el('li', '', `#${tag}`));
      head.append(list);
    }
    const meta = body.querySelector(':scope > details.md-meta');
    if (meta) head.append(meta);
    return head.childElementCount ? head : null;
  }

  /** Web links open a new tab; a picture next to the file is fetched from the workspace. */
  function fixLinks(body, path) {
    for (const a of body.querySelectorAll('a[href]')) {
      if (a.dataset.wikilink !== undefined || a.dataset.fn !== undefined || a.dataset.fnBack !== undefined) continue;
      if (!EXTERNAL.test(a.getAttribute('href'))) continue;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    for (const img of body.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (EXTERNAL.test(src) || src.startsWith('#')) continue;
      const file = joinPath(dirOf(path), src.split(/[?#]/)[0]);
      if (file) img.src = originalHref(file);
    }
  }

  function entryButton(kind, target, name, extra) {
    const button = el('button', `entry entry-${kind}`);
    button.type = 'button';
    button.dataset.view = target.view;
    button.dataset.path = target.path;
    button.append(el('span', 'entry-icon'));
    const main = el('span', 'entry-main');
    main.append(el('span', 'entry-name', name));
    for (const line of extra.lines) if (line) main.append(el('span', line.cls, line.text));
    button.append(main);
    if (extra.aside) button.append(el('span', 'entry-aside', extra.aside));
    return button;
  }

  /** A folder: its folders, then its files, a Markdown file by its frontmatter's title, description and date. */
  async function loadFolder(target) {
    const node = await api(`/api/tree?path=${enc(target.path || '.')}&depth=1&meta=1`);
    // a file asked for as a folder opens as itself
    if (node.kind === 'file') return loadDoc({ ...target, view: 'doc' });
    const list = el('ul', 'entries');
    const children = node.children ?? [];
    for (const child of children.slice(0, FOLDER_SHOWN)) {
      const item = el('li');
      if (child.kind === 'dir') {
        item.append(entryButton('dir', { view: 'folder', path: child.path }, `${child.name}/`, { lines: [child.about && { cls: 'entry-desc', text: child.about }] }));
      } else {
        const meta = child.meta ?? {};
        const name = meta.title || child.name;
        item.append(entryButton('file', { view: 'doc', path: child.path }, name, {
          lines: [meta.description && { cls: 'entry-desc', text: meta.description }, name !== child.name && { cls: 'entry-filename', text: child.name }],
          aside: meta.date || (child.mtime ? child.mtime.slice(0, 10) : ''),
        }));
      }
      list.append(item);
    }
    const box = el('section', 'folder');
    if (children.length) box.append(list);
    else box.append(el('p', 'doc-note', 'This folder is empty.'));
    if (children.length > FOLDER_SHOWN) box.append(el('p', 'doc-note', `${children.length - FOLDER_SHOWN} more — open the folder in knode-os to see them all.`));
    return { node: box, title: node.path ? `${baseName(node.path)}/` : 'Workspace', target: { view: 'folder', path: node.path ?? target.path } };
  }

  /** A hybrid search, one row per document (its best passage), optionally under a folder. */
  async function loadSearch(target) {
    const box = el('section', 'search');
    const title = target.q ? `Search: ${target.q}` : 'Search';
    if (!target.q) {
      box.append(el('p', 'doc-note', 'Nothing to search for: the address needs q=…'));
      return { node: box, title, target: {} };
    }
    const results = await api(`/api/search?q=${enc(target.q)}&mode=hybrid&k=${SEARCH_K}${target.scope ? `&sources=${enc(target.scope)}` : ''}`);
    const seen = new Set();
    const list = el('ul', 'entries');
    for (const r of Array.isArray(results) ? results : []) {
      if (seen.has(r.path) || seen.size >= SEARCH_SHOWN) continue;
      seen.add(r.path);
      const item = el('li');
      item.append(entryButton('file', { view: 'doc', path: r.path }, r.title || baseName(r.path), {
        lines: [{ cls: 'entry-desc entry-snippet', text: plainText(r.content).slice(0, 280) }, { cls: 'entry-filename', text: r.path }],
        aside: r.docDate || '',
      }));
      list.append(item);
    }
    box.append(seen.size ? list : el('p', 'doc-note', 'Nothing found.'));
    return { node: box, title, target: {} };
  }

  /* ----------------------------- navigation ------------------------------ */

  function paintBar() {
    const t = current;
    els.title.textContent = t.title || (t.view === 'search' ? (t.q ? `Search: ${t.q}` : 'Search') : t.path ? baseName(t.path) : 'Workspace');
    els.path.textContent = t.view === 'search' ? (t.scope ? `in ${t.scope}/` : 'whole workspace') : t.path || '/';
    els.path.title = els.path.textContent;
    els.open.href = openHref();
    els.back.hidden = trail.length === 0;
    els.back.title = trail.length ? `Back to ${trail.at(-1).title || trail.at(-1).path || 'the previous view'}` : '';
  }

  /** "Open in knode-os": the full UI at this file or folder, in this workspace (web/deeplink.js). */
  function openHref() {
    const t = current;
    return global.knodeDeepLink.href(location.origin, {
      path: t.view === 'search' ? '' : t.path,
      kind: workspace.kind,
      ws: workspace.id,
      fragment: t.view === 'doc' ? t.fragment : null,
    });
  }

  /** The frame's address follows what it shows, so a reload of the frame comes back to it. */
  function syncAddress() {
    const q = new URLSearchParams(params);
    for (const key of ['view', 'path', 'q', 'scope']) q.delete(key);
    q.set('view', current.view);
    if (current.view === 'search') {
      if (current.q) q.set('q', current.q);
      if (current.scope) q.set('scope', current.scope);
    } else if (current.path) q.set('path', current.path);
    const hash = current.view === 'doc' && current.fragment ? `#${enc(current.fragment)}` : '';
    try {
      history.replaceState(null, '', `${location.pathname}?${q}${hash}`);
    } catch {
      // a sandboxed frame may not: the address just stays
    }
  }

  function announce() {
    const t = current;
    post('navigate', {
      view: t.view,
      path: t.view === 'search' ? t.scope : t.path,
      title: t.title || '',
      ...(t.view === 'doc' && t.fragment ? { fragment: t.fragment } : {}),
      ...(t.view === 'search' ? { q: t.q, scope: t.scope } : {}),
    });
  }

  /** A move inside the page: the view left goes on the trail the back button walks. */
  async function go(target) {
    trail.push({ ...current, scroll: window.scrollY });
    if (trail.length > TRAIL_MAX) trail.shift();
    paintBar();
    if (!(await show(target))) return;
    if (!(current.view === 'doc' && current.fragment)) toTop();
    announce();
  }

  async function back() {
    const last = trail.pop();
    if (!last) return;
    paintBar();
    if (await show(last, { scroll: last.scroll })) announce();
  }

  /** The host's own move: a fresh start, with nothing to go back to. */
  function hostNavigate(msg) {
    const target = readTarget(msg);
    trail.length = 0;
    current = target;
    if (auth !== 'signed-in') {
      // shown once signed in
      paintBar();
      return;
    }
    show(target);
  }

  /* ------------------------------ in the text ---------------------------- */

  function flash(...nodes) {
    for (const node of nodes) {
      node.classList.remove('flash');
      void node.offsetWidth; // restart the animation on a second jump to the same place
      node.classList.add('flash');
    }
  }

  /** Bring a node into view; again when the host resizes the frame to the content, which can undo the first scroll. */
  function reveal(node) {
    node.scrollIntoView({ block: 'start' });
    pendingReveal = { node, until: Date.now() + 2500 };
  }

  /**
   * Where a #fragment points: an export's entry anchor, which lights up the
   * whole entry (up to the next anchor or rule), else a heading with that
   * text — as the file view does.
   */
  function scrollToFragment(fragment) {
    const view = els.main;
    const anchor = view.querySelector(`[data-anchor="${CSS.escape(fragment)}"]`);
    if (anchor) {
      const entry = [];
      for (let node = anchor.nextElementSibling; node && !node.matches('.md-anchor, hr'); node = node.nextElementSibling) entry.push(node);
      reveal(entry[0] ?? anchor);
      flash(...entry);
      return true;
    }
    const want = fragment.trim().toLowerCase();
    const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, '-');
    const heading = [...view.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((h) => h.textContent.trim().toLowerCase() === want || slug(h.textContent) === want);
    if (!heading) return false;
    reveal(heading);
    flash(heading);
    return true;
  }

  /** A citation's note, or back from a note to where the text first cites it. */
  function jumpTo(selector) {
    const node = els.main.querySelector(selector);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(node.closest('sup') ?? node);
  }

  /**
   * After a move inside the page, its top where the reader can see it: a host
   * that sizes the frame to its content scrolls itself, and would otherwise
   * leave the reader looking at the middle of the next document.
   */
  function toTop() {
    if (!barVisible) els.root.scrollIntoView({ block: 'start' });
  }

  /** A note beside what was clicked, for a moment: where the reader is looking, wherever the frame sits in its host. */
  function bubble(message, near) {
    document.querySelector('.embed-bubble')?.remove();
    const note = el('div', 'embed-bubble', message);
    note.setAttribute('role', 'status');
    const box = near?.getBoundingClientRect?.() ?? { left: 16, bottom: 48 };
    note.style.left = `${Math.max(8, Math.min(box.left + window.scrollX, document.documentElement.clientWidth - 328))}px`;
    note.style.top = `${box.bottom + window.scrollY + 6}px`;
    document.body.append(note);
    setTimeout(() => note.remove(), 4000);
  }

  /** A link out of the document: resolved by the server as the file view resolves it, opened here. */
  async function follow(target, near) {
    if (current.view !== 'doc' || !current.path) return;
    try {
      const resolved = await api(`/api/link/resolve?target=${enc(target)}&from=${enc(current.path)}`);
      if (resolved.path === current.path) {
        if (resolved.fragment) scrollToFragment(resolved.fragment);
        return;
      }
      if (resolved.path) {
        await go({ view: 'doc', path: resolved.path, fragment: resolved.fragment || null });
        return;
      }
      if (resolved.entity) bubble(`“${resolved.entity.name}” is an entity of the knowledge graph, without a page of its own`, near);
    } catch (e) {
      if (e.code === 'auth') {
        showSignedOut();
        return;
      }
      // a folder's link (`outputs/`, `../strategies/`) opens the folder
      const bare = target.split('#')[0];
      if (e.code === 'not-found' && bare.endsWith('/')) {
        const dir = joinPath(dirOf(current.path), bare);
        if (dir !== null) {
          await go({ view: 'folder', path: dir });
          return;
        }
      }
      bubble(`Link unavailable: ${e.message}`, near);
    }
  }

  function onClick(event) {
    const entry = event.target.closest('button.entry');
    if (entry) {
      go({ view: entry.dataset.view, path: entry.dataset.path, fragment: null });
      return;
    }
    const a = event.target.closest('a');
    if (!a || !els.main.contains(a)) return;
    if (a.dataset.fn !== undefined || a.dataset.fnBack !== undefined) {
      event.preventDefault();
      if (a.dataset.fn !== undefined) jumpTo(`[data-fn-def="${CSS.escape(a.dataset.fn)}"]`);
      else jumpTo(`[data-fn="${CSS.escape(a.dataset.fnBack)}"]`);
      return;
    }
    const wiki = a.dataset.wikilink;
    const href = a.getAttribute('href') || '';
    // web links, and the original's, open their new tab
    if (wiki === undefined && (!href || EXTERNAL.test(href) || href.startsWith('/api/'))) return;
    event.preventDefault();
    if (wiki === undefined && href.startsWith('#')) {
      scrollToFragment(decodeHash(href));
      return;
    }
    follow(wiki ?? href, a);
  }

  /* -------------------------------- host --------------------------------- */

  let hostVars = [];

  /** The host's look: light or dark, and its tokens when it sends them (`{}` clears them). */
  function applyTheme(theme, tokens) {
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    if (tokens === undefined) return;
    for (const name of hostVars) root.style.removeProperty(name);
    const vars = sanitizeTokens(tokens);
    hostVars = Object.keys(vars);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  }

  function onMessage(event) {
    if (!host || event.source !== window.parent || event.origin !== host) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.source !== 'knode-host' || msg.version !== PROTOCOL) return;
    if (msg.type === 'theme') applyTheme(msg.theme, msg.tokens);
    else if (msg.type === 'navigate') hostNavigate(msg);
  }

  /** The content's height, whenever it changes, for a host that sizes the frame to it. */
  function watchHeight() {
    let last = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = Math.ceil(els.root.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      post('resize', { height });
    };
    new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(measure);
    }).observe(els.root);
    measure();
  }

  async function boot() {
    els = {
      root: document.getElementById('embed-root'),
      bar: document.getElementById('embed-bar'),
      main: document.getElementById('embed-main'),
      title: document.getElementById('embed-title'),
      path: document.getElementById('embed-path'),
      open: document.getElementById('embed-open'),
      back: document.getElementById('embed-back'),
    };
    // seen against the top window's viewport, wherever the host has scrolled the frame
    new IntersectionObserver((entries) => {
      barVisible = entries.at(-1).isIntersecting;
    }).observe(els.bar);
    els.back.addEventListener('click', back);
    els.main.addEventListener('click', onClick);
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('resize', () => {
      if (pendingReveal && Date.now() < pendingReveal.until && pendingReveal.node.isConnected) pendingReveal.node.scrollIntoView({ block: 'start' });
    });
    paintBar();
    // before any content: the host knows the page was allowed to load
    post('ready', { view: current.view, path: current.view === 'search' ? current.scope : current.path });
    watchHeight();
    let ok;
    try {
      ok = await signedIn();
    } catch (e) {
      const error = new EmbedError('unavailable', `knode-os did not answer (${e.message})`);
      showError(error);
      post('error', { code: error.code, message: error.message });
      return;
    }
    if (!ok) {
      showSignedOut();
      return;
    }
    setAuth('signed-in');
    show(current);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(globalThis);
