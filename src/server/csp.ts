/**
 * Content-Security-Policy for what `serve` answers a browser with.
 *
 * The web UI renders text that people, imported folders and agents wrote
 * (web/markdown.js keeps it to formatting), so the page is also held to
 * running only this server's own scripts: no inline script, no inline event
 * handler, no `javascript:` URL, no plugin, no foreign frame or form target.
 * Should markup ever get past the renderer, it stays inert. web/index.html and
 * web/app.js are written to need nothing more — no inline `<script>`,
 * `<style>` or `style="…"` (styles set through `element.style` are fine).
 *
 * Images may come from https: a document that embeds a picture from the web
 * keeps showing it. Everything else is same-origin.
 *
 * API answers are data and are never meant to render as a page: they get a
 * policy that allows nothing.
 */

export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** The policy for a response of this content type: the page's for an HTML document, nothing for anything else. */
export function contentSecurityPolicy(contentType: string | null | undefined): string {
  return /^\s*text\/html\b/i.test(contentType ?? '') ? UI_CSP : API_CSP;
}
