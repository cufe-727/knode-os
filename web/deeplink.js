/* knode-os web UI — links that open the full UI at a file */
'use strict';

/**
 * A deep link opens the web UI at a file or folder of a workspace:
 *
 *   /?open=<workspace path>&kind=<personal|team>&ws=<workspace id or Team name>#<fragment>
 *
 * app.js reads one on load and, once signed in, switches to that workspace
 * when it is another one, shows Library → Files and opens the file there —
 * at the fragment, an export's entry anchor (`e-88703d61`) or a heading — or
 * picks the folder in the tree. The embedded reader (web/embed/embed.js)
 * links here for "Open in knode-os", and other apps may link here too.
 *
 * Plain functions on `knodeDeepLink`, loaded before app.js and the reader;
 * the tests load this file the same way.
 */
(function (global) {
  /** A workspace path as the API takes it: no leading, trailing or doubled slash, no `.`; null when it climbs above the root. */
  function normalize(value) {
    const parts = [];
    for (const part of String(value ?? '').replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
        continue;
      }
      parts.push(part);
    }
    return parts.join('/');
  }

  /**
   * What an address asks to open — `{ path, kind, ws, fragment }` — or null
   * when it has no `open`, or names a path outside the workspace. Without
   * `ws` the link is for whichever workspace is open (`kind` null); with
   * `ws` and no `kind`, a personal workspace.
   */
  function read(search, hash) {
    const q = new URLSearchParams(search || '');
    const raw = q.get('open');
    if (raw === null) return null;
    const path = normalize(raw);
    if (path === null) return null;
    const ws = (q.get('ws') || '').trim() || null;
    const kind = ws ? (q.get('kind') === 'team' ? 'team' : 'personal') : null;
    let fragment = String(hash || '').replace(/^#/, '');
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // a stray % stays as written
    }
    return { path, kind, ws, fragment: fragment || null };
  }

  /** The link itself, on `base` (an origin, or '' for this one). */
  function href(base, link) {
    const q = new URLSearchParams();
    q.set('open', link.path || '');
    if (link.ws) {
      q.set('kind', link.kind === 'team' ? 'team' : 'personal');
      q.set('ws', link.ws);
    }
    return `${String(base || '').replace(/\/+$/, '')}/?${q}${link.fragment ? `#${encodeURIComponent(link.fragment)}` : ''}`;
  }

  /** Comparable form of a workspace or Team name: what the server's slugs make of it, near enough. */
  const fold = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s/\\]+/g, '-');

  /**
   * The workspace a link names, among `workspaces` (what this browser has
   * open, then the Teams the server says the account may open): a personal
   * one by id, a Team by id, name, code or slug. null when none of them is it.
   */
  function pick(link, workspaces) {
    if (!link?.ws) return null;
    const want = fold(link.ws);
    const names = (w) => (link.kind === 'team'
      ? [w.id, String(w.id ?? '').replace(/^team-/, ''), w.name, w.code, w.slug]
      : [w.id]);
    return (workspaces || []).find((w) => w && w.kind === link.kind && names(w).some((n) => n && fold(n) === want)) ?? null;
  }

  global.knodeDeepLink = { read, href, pick, normalize };
})(globalThis);
