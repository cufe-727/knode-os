import fs from 'node:fs';
import { AppContext } from '../context.js';
import { safePath } from '../fs/files.js';
import { parseFrontmatter } from '../markdown.js';
import { webRenderer } from '../web-render.js';
import { ResearchJob } from './jobs.js';
import { studyView } from './study.js';

/**
 * A study as one HTML file (docs/design/15, D13): `GET /api/research/studies/:id/export`.
 *
 * The pages stay the source of truth — Markdown with ```chart blocks — and
 * this is a reading of them made for people outside knode: one
 * self-contained document to save, send or print. The report comes first,
 * then the pages in the brief's order, after a cover (the question, the
 * as-of date, how much of it is reviewed) and a table of contents. Every
 * chart is a numbered figure, drawn as inline SVG by web/chart.js itself
 * (src/web-render.ts) with its source paths under it, and listed again at
 * the end; links between the study's pages land inside the file, and a
 * cited capture links to its entry in the list of sources. A print
 * stylesheet makes the browser's Print → PDF a clean document: each page on
 * a sheet of its own, figures and tables never split, the data toggles left
 * out.
 *
 * The file carries no script — what an agent wrote stays text, as in the
 * file view — and a policy of its own that keeps script off wherever it is
 * opened, a browser tab or a copy saved to disk.
 */

export class StudyExportError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

export interface StudyExport {
  html: string;
  /** `<study slug>.html`. */
  filename: string;
  documents: number;
  figures: number;
}

/** In the page itself, whoever opens it: no script, no plugin, no frame, no form; styles inline, pictures from the web. */
export const EXPORT_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'";

const LABELS = {
  en: {
    study: 'Research study', contents: 'Contents', report: 'Report', page: 'Page', figure: 'Figure', figures: 'Figures',
    sources: 'Sources', source: 'Source', note: 'Note', asOf: 'As of', exported: 'Exported', status: 'Status', pages: 'Pages',
    captured: 'Sources captured', register: 'Register', trusted: 'trusted', quarantined: 'quarantined — not reviewed yet', unindexed: 'not indexed yet',
    review: (n: number, m: number) => `${n} of the ${m} documents are not reviewed: research agents wrote them, and nobody has promoted them to trusted yet.`,
    missing: (list: string) => `Not written yet: ${list}.`,
    colophon: 'Exported from knode-os',
  },
  zh: {
    study: '研究课题', contents: '目录', report: '总报告', page: '页面', figure: '图', figures: '图表',
    sources: '资料', source: '来源', note: '注', asOf: '截至', exported: '导出于', status: '状态', pages: '页面',
    captured: '已收集资料', register: '资料登记表', trusted: '已信任', quarantined: '隔离中——尚未审阅', unindexed: '尚未索引',
    review: (n: number, m: number) => `${m} 份文档中有 ${n} 份尚未审阅：由研究 agent 写成，还没有人把它们提升为可信。`,
    missing: (list: string) => `尚未写成：${list}。`,
    colophon: '由 knode-os 导出',
  },
};
type Labels = (typeof LABELS)['en'];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Markup down to its text, entities kept: what a heading reads as in the contents. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').trim();

interface Doc {
  id: string;
  kind: 'report' | 'page';
  title: string;
  path: string;
  trust: string | null;
  html: string;
  headings: { level: number; id: string; text: string }[];
}

interface Figure {
  n: number;
  title: string;
  source: string;
  doc: Doc;
}

/** What one document's markup is rewritten against: where the study's own links land, the sources it may cite, the figures so far. */
interface Context {
  targets: Map<string, string>;
  sources: Map<string, number>;
  figures: Figure[];
  labels: Labels;
}

/** A wikilink's target as a study names its pages: `research/<study>/<page>`, no extension, no heading. */
const linkKey = (target: string) => target.split('#', 1)[0].replace(/\\/g, '/').replace(/^\/+/, '').replace(/^wiki\//, '').replace(/\.(md|markdown)$/i, '');

/**
 * One document's markup, as web/markdown.js rendered it, made to stand on
 * its own in the file: headings get ids for the contents, the in-app links
 * (wikilinks, cited paths, footnotes) become links inside the file or plain
 * text, links to the web open a tab, and each chart becomes a numbered figure.
 */
function localize(doc: Doc, html: string, ctx: Context): string {
  let k = 0;
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level: string, inner: string) => {
    const id = `${doc.id}-${++k}`;
    doc.headings.push({ level: Number(level), id, text: textOf(inner) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  // a wikilink to one of the study's pages lands on it; any other has nowhere to go in this file
  html = html.replace(/<a class="wikilink" href="#" data-wikilink="([^"]*)">([\s\S]*?)<\/a>/g, (_, target: string, label: string) => {
    const at = ctx.targets.get(linkKey(unesc(target)));
    return at ? `<a class="wikilink" href="#${at}">${label}</a>` : `<span class="wikilink">${label}</span>`;
  });
  // a cited capture links to its entry among the sources; any other path is shown whole, with nowhere to go
  html = html.replace(/<a class="path-link" href="#" data-wikilink="([^"]*)" title="[^"]*"><code>([\s\S]*?)<\/code><\/a>/g, (_, target: string, label: string) => {
    const rel = unesc(target).split('#', 1)[0];
    const n = ctx.sources.get(rel);
    return n ? `<a class="path-link" href="#src-${n}" title="${target}"><code>${label}</code></a>` : `<code title="${target}">${esc(unesc(target))}</code>`;
  });
  // footnotes: each marker and its note, both ways; the first marker is where a note's ↩ returns to
  const marked = new Set<string>();
  const numbers = new Map<string, string>();
  html = html.replace(/<sup class="fn-ref"><a href="#" data-fn="([^"]*)" title="([^"]*)">\[(\d+)\]<\/a><\/sup>/g, (_, label: string, title: string, n: string) => {
    numbers.set(label, n);
    const id = marked.has(n) ? '' : ` id="${doc.id}-fnref-${n}"`;
    marked.add(n);
    return `<sup class="fn-ref"${id}><a href="#${doc.id}-fn-${n}" title="${title}">[${n}]</a></sup>`;
  });
  html = html.replace(/<li class="fn" data-fn-def="([^"]*)"><span class="fn-num">\[(\d+)\]<\/span>/g, (_, label: string, n: string) => `<li class="fn" id="${doc.id}-fn-${n}"><span class="fn-num">[${n}]</span>`);
  html = html.replace(/<a href="#" class="fn-back" data-fn-back="([^"]*)" title="Back to the text">↩<\/a>/g, (_, label: string) => {
    const n = numbers.get(label);
    return n ? `<a href="#${doc.id}-fnref-${n}" class="fn-back">↩</a>` : '';
  });
  // a link to the web opens beside the document; a relative one pointed into the workspace, and has nowhere to go here
  html = html.replace(/<a href="([^"]*)"((?: title="[^"]*")?)>([\s\S]*?)<\/a>/g, (all, href: string, title: string, label: string) => {
    if (/^(?:https?:|mailto:)/i.test(href)) return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${label}</a>`;
    return href.startsWith('#') ? all : `<span class="link">${label}</span>`;
  });
  html = html.replace(/<img src="([^"]*)" alt="([^"]*)"((?: title="[^"]*")?)>/g, (all, src: string, alt: string) => (/^(?:https:|data:image\/)/i.test(src) ? all : `<span class="image-missing">[${alt}]</span>`));
  // figures, numbered through the whole file; the hover targets are for a page that runs web/chart.js, which this one never does
  html = html.replace(/<figure class="kchart kchart-([a-z-]+)" data-kchart="[a-z-]+">([\s\S]*?)<\/figure>/g, (_, type: string, inner: string) => {
    const n = ctx.figures.length + 1;
    const title = /<span class="kchart-title">([\s\S]*?)<\/span>/.exec(inner)?.[1] ?? '';
    const source = /<p class="kchart-source"><span class="kchart-label">Source<\/span> ([\s\S]*?)<\/p>/.exec(inner)?.[1] ?? '';
    ctx.figures.push({ n, title, source, doc });
    const number = `<span class="kchart-num">${esc(ctx.labels.figure)} ${n}</span>`;
    let body = inner.replace(/<g class="kc-hits">[\s\S]*?<\/g>/, '');
    body = body.includes('<figcaption class="kchart-head">')
      ? body.replace('<figcaption class="kchart-head">', `<figcaption class="kchart-head">${number}`)
      : `<figcaption class="kchart-head">${number}</figcaption>${body}`;
    body = body.replace('<span class="kchart-label">Source</span>', `<span class="kchart-label">${esc(ctx.labels.source)}</span>`)
      .replace('<span class="kchart-label">Note</span>', `<span class="kchart-label">${esc(ctx.labels.note)}</span>`);
    return `<figure class="kchart kchart-${type}" data-kchart="${type}" id="fig-${n}">${body}</figure>`;
  });
  return html;
}

const trustText = (trust: string | null, L: Labels) => (trust === 'trusted' ? L.trusted : trust === 'quarantined' ? L.quarantined : L.unindexed);

export async function exportStudy(ctx: AppContext, job: ResearchJob, now: Date = new Date()): Promise<StudyExport> {
  const view = await studyView(ctx, job);
  const b = view.payload.brief;
  const L = b.language.toLowerCase().startsWith('zh') ? LABELS.zh : LABELS.en;
  const slug = job.target ?? b.slug;
  const planned: Omit<Doc, 'id' | 'html' | 'headings'>[] = [
    { kind: 'report', title: b.report.title, path: view.reportPath, trust: view.reportTrust },
    ...view.pages.map((pg) => ({ kind: 'page' as const, title: pg.title, path: pg.path, trust: pg.trust })),
  ];
  const exists = (rel: string) => fs.existsSync(safePath(ctx.dataDir, rel));
  const written = planned.filter((d) => exists(d.path));
  if (written.length === 0) throw new StudyExportError('nothing to export yet: the study has not written its report or any page', 409);

  const docs: Doc[] = written.map((d, i) => ({ ...d, id: `d${i}`, html: '', headings: [] }));
  const targets = new Map<string, string>();
  for (const d of docs) targets.set(linkKey(d.path), d.id);
  const sources = new Map(view.captures.map((c, i) => [c.path, i + 1]));
  const context: Context = { targets, sources, figures: [], labels: L };
  const renderer = webRenderer();
  for (const d of docs) {
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(safePath(ctx.dataDir, d.path), 'utf8'));
    if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) d.title = frontmatter.title.trim();
    let html = renderer.markdown(body);
    // a page opens with its title as its heading; one that does not gets it
    if (!/^\s*<h1>/.test(html)) html = `<h1>${esc(d.title)}</h1>\n${html}`;
    d.html = localize(d, html, context);
  }

  const quarantined = docs.filter((d) => d.trust !== 'trusted').length;
  const missing = planned.filter((d) => !exists(d.path)).map((d) => d.title);
  const stamp = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const lang = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(b.language) ? b.language : 'en';

  const facts = [
    [L.asOf, b.scope.asOf],
    [L.status, job.status],
    [L.pages, `${docs.filter((d) => d.kind === 'page').length} / ${view.pages.length}`],
    [L.captured, String(view.captures.length)],
    [L.exported, stamp],
  ].filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  const cover = `<header class="cover">
<p class="eyebrow">${esc(L.study)} · <code>${esc(job.id)}</code></p>
<h1 class="study-title">${esc(b.title)}</h1>
${b.objective ? `<p class="objective">${esc(b.objective)}</p>` : ''}
<dl class="facts">${facts}</dl>
${quarantined ? `<p class="notice">${esc(L.review(quarantined, docs.length))}</p>` : ''}
${missing.length ? `<p class="notice">${esc(L.missing(missing.join(' · ')))}</p>` : ''}
</header>`;

  const tocDoc = (d: Doc) => {
    const top = d.headings.find((h) => h.level === 1);
    const sections = d.headings.filter((h) => h.level === 2).map((h) => `<li><a href="#${h.id}">${h.text}</a></li>`).join('');
    return `<li><a href="#${d.id}">${top ? top.text : esc(d.title)}</a> <span class="toc-kind">${esc(d.kind === 'report' ? L.report : L.page)}</span>${sections ? `<ol>${sections}</ol>` : ''}</li>`;
  };
  const toc = `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">${esc(L.contents)}</h2><ol>${docs.map(tocDoc).join('')}`
    + `${context.figures.length ? `<li class="toc-end"><a href="#figures">${esc(L.figures)}</a></li>` : ''}`
    + `${view.captures.length ? `<li class="toc-end"><a href="#sources">${esc(L.sources)}</a></li>` : ''}</ol></nav>`;

  const articles = docs.map((d) => `<article class="doc" id="${d.id}">
<p class="doc-meta"><span class="doc-kind">${esc(d.kind === 'report' ? L.report : L.page)}</span> <code>${esc(d.path)}</code> <span class="trust trust-${esc(d.trust ?? 'none')}">${esc(trustText(d.trust, L))}</span></p>
${d.html}
</article>`).join('\n');

  const figureList = context.figures.length
    ? `<section class="appendix" id="figures"><h2>${esc(L.figures)}</h2><ol class="figure-list">${context.figures.map((f) => `<li><a href="#fig-${f.n}">${esc(L.figure)} ${f.n}</a> ${f.title}`
      + ` <span class="fig-doc">— <a href="#${f.doc.id}">${esc(f.doc.title)}</a></span>${f.source ? `<div class="fig-source">${esc(L.source)}: ${f.source}</div>` : ''}</li>`).join('')}</ol></section>`
    : '';
  const sourceList = view.captures.length
    ? `<section class="appendix" id="sources"><h2>${esc(L.sources)}</h2><p class="hint">${esc(L.register)}: <code>${esc(view.registerPath)}</code></p><ol class="source-list">${view.captures.map((c, i) => {
      const url = /^https?:\/\//i.test(c.url) ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a>` : '';
      const meta = [c.site, c.published?.slice(0, 10), c.kind].filter(Boolean).map(esc).join(' · ');
      return `<li id="src-${i + 1}"><span class="src-title">${esc(c.title || c.url || c.path)}</span>${meta ? ` <span class="hint">${meta}</span>` : ''}<div><code>${esc(c.path)}</code>${url}</div>${c.why ? `<div class="hint">${esc(c.why)}</div>` : ''}</li>`;
    }).join('')}</ol></section>`
    : '';

  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(EXPORT_POLICY)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="knode-os">
<title>${esc(b.title)}</title>
<style>
${renderer.chartCss}
${EXPORT_CSS}
</style>
</head>
<body>
<div class="sheet">
${cover}
${toc}
<main>
${articles}
</main>
${figureList}
${sourceList}
<footer class="colophon">${esc(L.colophon)} · ${esc(stamp)} · <code>${esc(slug)}</code></footer>
</div>
</body>
</html>
`;
  return { html, filename: `${slug}.html`, documents: docs.length, figures: context.figures.length };
}

/**
 * The document's own styles, after web/chart.css: paper-white with the
 * palette's light steps (the Mac app's), dark on a screen that asks for it,
 * and always white in print.
 */
const EXPORT_CSS = `
:root {
  color-scheme: light dark;
  --paper: #ffffff; --panel: #f4f5f7; --rule: #e1e4e9; --rule-strong: #c3c9d2;
  --ink: #1b2028; --ink-2: #3c444f; --ink-3: #5c6573; --link: #1f5fc4; --notice: #8a5300; --notice-bg: #fff6e6;
  /* the tokens web/chart.css reads */
  --bg2: var(--paper); --bg3: var(--panel); --border: var(--rule); --border-strong: var(--rule-strong);
  --fg: var(--ink); --muted: var(--ink-3); --warn: #b26b00; --bad: #b42335; --accent: var(--link);
}
.kchart {
  --kc-ink-2: var(--ink-2);
  --kc-s1: #2a78d6; --kc-s2: #eb6834; --kc-s3: #1baf7a; --kc-s4: #eda100;
  --kc-s5: #e87ba4; --kc-s6: #008300; --kc-s7: #6250d6; --kc-s8: #e34948;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
@media screen and (prefers-color-scheme: dark) {
  :root {
    --paper: #0f1217; --panel: #171b22; --rule: #262d39; --rule-strong: #354052;
    --ink: #d7dde6; --ink-2: #aeb7c4; --ink-3: #8b95a5; --link: #7fb2ff; --notice: #f0b45a; --notice-bg: #2a2112;
    --bg2: #161a21; --bg3: #1e242e;
  }
  .kchart {
    --kc-s1: #3987e5; --kc-s2: #d95926; --kc-s3: #199e70; --kc-s4: #c98500;
    --kc-s5: #d55181; --kc-s6: #008300; --kc-s7: #9085e9; --kc-s8: #e66767;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans", Helvetica, Arial, sans-serif;
}
.sheet { max-width: 840px; margin: 0 auto; padding: 48px 28px 72px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; color: var(--ink); }
h1 { margin: 0 0 16px; font-size: 27px; }
h2 { margin: 34px 0 12px; padding-bottom: 5px; border-bottom: 1px solid var(--rule); font-size: 20px; }
h3 { margin: 26px 0 8px; font-size: 16.5px; }
h4, h5, h6 { margin: 20px 0 6px; font-size: 15px; }
p, ul, ol, dl, blockquote, pre, table { margin: 0 0 13px; }
ul, ol { padding-left: 24px; }
li + li { margin-top: 3px; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
code { padding: 1px 4px; border-radius: 4px; background: var(--panel); font: 0.86em/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
pre { padding: 12px 14px; border-radius: 8px; background: var(--panel); overflow: auto; }
pre code { padding: 0; background: none; }
blockquote { padding: 2px 0 2px 14px; border-left: 3px solid var(--rule-strong); color: var(--ink-2); }
hr { margin: 24px 0; border: 0; border-top: 1px solid var(--rule); }
img { max-width: 100%; }
.doc table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; font-size: 13.5px; font-variant-numeric: tabular-nums; }
.doc th, .doc td { padding: 5px 12px 5px 0; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
.doc thead th { border-bottom: 1.5px solid var(--rule-strong); font-weight: 600; white-space: nowrap; }
.hint { color: var(--ink-3); font-size: 13px; }
.cover { padding: 8px 0 20px; }
.eyebrow { margin: 0 0 10px; color: var(--ink-3); font-size: 12.5px; letter-spacing: 0.02em; }
.study-title { font-size: 32px; }
.objective { max-width: 680px; color: var(--ink-2); font-size: 16.5px; }
.facts { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 18px 0; }
.facts div { min-width: 0; }
.facts dt { color: var(--ink-3); font-size: 12px; }
.facts dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.notice { max-width: 680px; padding: 8px 12px; border-left: 3px solid var(--notice); border-radius: 0 6px 6px 0; background: var(--notice-bg); color: var(--ink); font-size: 13.5px; }
.toc { padding: 4px 0 8px; }
.toc ol { margin: 0; padding-left: 20px; }
.toc > ol > li { margin-top: 8px; font-weight: 600; }
.toc > ol > li ol { margin-top: 3px; font-weight: 400; font-size: 14px; }
.toc-kind { color: var(--ink-3); font-size: 12px; font-weight: 400; }
.doc { padding-top: 26px; margin-top: 30px; border-top: 2px solid var(--rule); }
.doc-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0 0 10px; color: var(--ink-3); font-size: 12.5px; }
.doc-kind { font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.trust-quarantined { color: var(--notice); }
.kchart { max-width: none; }
.kchart-num { color: var(--ink-3); font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em; }
.footnotes { margin-top: 26px; padding-top: 10px; border-top: 1px solid var(--rule); font-size: 13px; }
.footnotes ol { padding-left: 0; list-style: none; }
.fn-num { display: inline-block; min-width: 32px; color: var(--ink-3); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.fn-back { margin-left: 6px; }
.appendix { margin-top: 40px; }
.figure-list li, .source-list li { margin-bottom: 8px; }
.fig-doc, .fig-source { color: var(--ink-3); font-size: 13px; }
.src-title { font-weight: 600; }
.colophon { margin-top: 48px; padding-top: 10px; border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 12px; }
@media (max-width: 600px) {
  .sheet { padding: 28px 16px 48px; }
  .study-title { font-size: 26px; }
}
@media print {
  @page { margin: 16mm 15mm 18mm; }
  :root { color-scheme: light; }
  body { font-size: 10.5pt; line-height: 1.55; background: #fff; }
  .sheet { max-width: none; padding: 0; }
  .toc { break-after: page; }
  .doc, .appendix { margin-top: 0; padding-top: 0; border-top: 0; break-before: page; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  figure, .kchart, table, pre, blockquote, .notice, .toc li, .figure-list li, .source-list li { break-inside: avoid; }
  p { orphans: 3; widows: 3; }
  a { color: inherit; }
  .kchart { margin: 10px 0 14px; border-color: var(--rule-strong); }
  .kchart-data { display: none; }
  .colophon { break-before: avoid; }
}
`;
