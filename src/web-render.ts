import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { findMarkedUmd, findWebDir } from './web-assets.js';

/**
 * The web UI's own Markdown and chart renderers, run on the server — for a
 * study's export (src/research/export.ts), which has to draw what the page
 * draws without a browser.
 *
 * web/chart.js draws a chart as a string of SVG markup: its layout measures
 * text with a table of character widths, never the DOM, and only `hydrate`,
 * the hover layer a page wires afterwards, touches a document. web/markdown.js
 * is a string-to-string renderer on marked. So the server loads the three
 * plain scripts into one `node:vm` context, the way the tests do and the page
 * does (one shared global, marked first), and calls `knodeMarkdown.render`:
 * the export's figures are the very markup the viewer shows, and there is no
 * second renderer to keep in step. No DOM shim is involved — the context has
 * no `document`, so a renderer that reached for one would fail here, and in
 * tests/web-chart.test.ts, before it reached a page.
 *
 * The scripts are read again when one of them changes on disk: `serve`
 * answers the browser from the same live web/ folder.
 */

export interface WebRenderer {
  /** A Markdown document as the file view renders it: formatting only, ```chart blocks drawn. */
  markdown(text: string): string;
  /** web/chart.css, for a page of its own that shows the charts. */
  chartCss: string;
}

let cached: { key: string; renderer: WebRenderer } | null = null;

export function webRenderer(): WebRenderer {
  const web = findWebDir();
  const marked = findMarkedUmd();
  if (!web || !marked) throw new Error('the web UI assets (web/, marked) are not installed, so nothing can be rendered');
  const files = [marked, path.join(web, 'chart.js'), path.join(web, 'markdown.js'), path.join(web, 'chart.css')];
  const key = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join('|');
  if (cached?.key === key) return cached.renderer;
  const page = vm.createContext({});
  for (const file of files.slice(0, 3)) vm.runInContext(fs.readFileSync(file, 'utf8'), page, { filename: file });
  const md = (page as { knodeMarkdown?: { render: (text: string) => string } }).knodeMarkdown;
  if (!md || !(page as { knodeChart?: unknown }).knodeChart) throw new Error('web/markdown.js or web/chart.js did not load');
  const renderer: WebRenderer = { markdown: (text) => md.render(text), chartCss: fs.readFileSync(files[3], 'utf8') };
  cached = { key, renderer };
  return renderer;
}
