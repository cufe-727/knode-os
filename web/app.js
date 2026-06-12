/* knode-os web UI — vanilla JS, no build step */
'use strict';

const $ = (sel) => document.querySelector(sel);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const toast = (msg, ms = 2600) => {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const renderMd = (s) => (window.marked && window.marked.parse ? window.marked.parse(s) : `<pre>${esc(s)}</pre>`);

/* ------------------------------- tabs ---------------------------------- */

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'traces') loadTraces();
    if (b.dataset.tab === 'dream') loadSuggestions();
    if (b.dataset.tab === 'graph' && !graphState.loaded) loadGraph('');
  });
});

/* ------------------------------- stats --------------------------------- */

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('#statsbar').textContent =
      `${s.documents} docs · ${s.chunks} chunks · ${s.entities} entities · ${s.relations} rels · ${s.traces} traces` +
      (s.pending_suggestions ? ` · ☾${s.pending_suggestions}` : '');
  } catch { /* server still starting */ }
}
loadStats();
setInterval(loadStats, 15000);

/* ------------------------------- files --------------------------------- */

let currentFile = null;
let editing = false;

function renderTree(node, container) {
  if (!node.children) return;
  for (const child of node.children) {
    const div = document.createElement('div');
    div.className = child.kind === 'dir' ? 'tree-dir' : 'tree-file';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = (child.kind === 'dir' ? '▸ ' : '· ') + child.name;
    label.dataset.path = child.path;
    div.appendChild(label);
    if (child.kind === 'dir') {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      renderTree(child, kids);
      div.appendChild(kids);
      const topLevel = !child.path.includes('/');
      if (!topLevel) div.classList.add('collapsed');
      label.textContent = (div.classList.contains('collapsed') ? '▸ ' : '▾ ') + child.name;
      label.addEventListener('click', () => {
        div.classList.toggle('collapsed');
        label.textContent = (div.classList.contains('collapsed') ? '▸ ' : '▾ ') + child.name;
      });
    } else {
      label.addEventListener('click', () => openFile(child.path, label));
    }
    container.appendChild(div);
  }
}

async function loadTree() {
  const tree = await api('/api/tree');
  const el = $('#filetree');
  el.innerHTML = '';
  renderTree(tree, el);
}

async function openFile(path, labelEl) {
  try {
    const { content } = await api(`/api/file?path=${encodeURIComponent(path)}`);
    currentFile = path;
    editing = false;
    document.querySelectorAll('.tree-label.selected').forEach((x) => x.classList.remove('selected'));
    if (labelEl) labelEl.classList.add('selected');
    $('#file-path').textContent = path;
    $('#file-view').hidden = false;
    $('#file-editor').hidden = true;
    $('#file-view').innerHTML = path.endsWith('.md') ? renderMd(content) : `<pre>${esc(content)}</pre>`;
    $('#file-editor').value = content;
    $('#btn-edit').disabled = false;
    $('#btn-save').disabled = true;
    $('#btn-delete').disabled = false;
  } catch (e) {
    toast(`open failed: ${e.message}`);
  }
}

$('#btn-edit').addEventListener('click', () => {
  editing = !editing;
  $('#file-view').hidden = editing;
  $('#file-editor').hidden = !editing;
  $('#btn-edit').textContent = editing ? 'preview' : 'edit';
  $('#btn-save').disabled = !editing;
  if (!editing) $('#file-view').innerHTML = currentFile.endsWith('.md') ? renderMd($('#file-editor').value) : `<pre>${esc($('#file-editor').value)}</pre>`;
});

$('#btn-save').addEventListener('click', async () => {
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: currentFile, content: $('#file-editor').value }) });
    toast(`saved ${currentFile}`);
    $('#file-view').innerHTML = currentFile.endsWith('.md') ? renderMd($('#file-editor').value) : `<pre>${esc($('#file-editor').value)}</pre>`;
  } catch (e) {
    toast(`save failed: ${e.message}`);
  }
});

$('#btn-delete').addEventListener('click', async () => {
  if (!currentFile || !confirm(`Delete ${currentFile}?`)) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(currentFile)}`, { method: 'DELETE' });
    toast(`deleted ${currentFile}`);
    currentFile = null;
    $('#file-path').textContent = '';
    $('#file-view').innerHTML = '';
    $('#btn-edit').disabled = $('#btn-save').disabled = $('#btn-delete').disabled = true;
    loadTree();
  } catch (e) {
    toast(`delete failed: ${e.message}`);
  }
});

$('#btn-new-file').addEventListener('click', async () => {
  const path = prompt('New file path (under wiki/ or raw/docs/):', 'wiki/concepts/new-note.md');
  if (!path) return;
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path, content: `# ${path.split('/').pop().replace(/\.md$/, '')}\n\n` }) });
    await loadTree();
    openFile(path);
  } catch (e) {
    toast(`create failed: ${e.message}`);
  }
});

$('#btn-refresh-tree').addEventListener('click', loadTree);

$('#file-upload').addEventListener('change', async (ev) => {
  const files = ev.target.files;
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`uploaded: ${data.saved.join(', ')} — ingesting…`);
    await api('/api/ingest', { method: 'POST' });
    toast('ingest complete');
    loadTree();
    loadStats();
  } catch (e) {
    toast(`upload failed: ${e.message}`);
  }
  ev.target.value = '';
});

$('#btn-ingest').addEventListener('click', async () => {
  toast('ingesting…', 60000);
  try {
    const s = await api('/api/ingest', { method: 'POST' });
    toast(`ingest: ${s.indexed} indexed, ${s.unchanged} unchanged, ${s.chunks} chunks`);
    loadStats();
  } catch (e) {
    toast(`ingest failed: ${e.message}`);
  }
});

/* ------------------------------- search -------------------------------- */

async function doSearch() {
  const q = $('#search-q').value.trim();
  if (!q) return;
  const mode = $('#search-mode').value;
  const el = $('#search-results');
  el.innerHTML = '<p class="hint">searching…</p>';
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}&k=12`);
    el.innerHTML = results.length ? '' : '<p class="hint">no results — upload docs and run ingest first.</p>';
    for (const r of results) {
      const div = document.createElement('div');
      div.className = 'result';
      div.innerHTML = `<span class="rscore">${r.score.toFixed(4)} ${Object.keys(r.signals).join('+')}</span>
        <div class="rpath">${esc(r.path)}</div>
        <div class="rsnippet">${esc(r.content.slice(0, 360))}</div>`;
      div.addEventListener('click', () => {
        document.querySelector('#tabs button[data-tab="files"]').click();
        openFile(r.path);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">search failed: ${esc(e.message)}</p>`;
  }
}
$('#btn-search').addEventListener('click', doSearch);
$('#search-q').addEventListener('keydown', (e) => e.key === 'Enter' && doSearch());

/* -------------------------------- ask ---------------------------------- */

async function doAsk() {
  const q = $('#ask-q').value.trim();
  if (!q) return;
  const el = $('#ask-result');
  el.innerHTML = '<p class="hint">thinking…</p>';
  try {
    const res = await api('/api/ask', { method: 'POST', body: JSON.stringify({ question: q }) });
    let html = `<div class="answer markdown">${renderMd(res.answer)}</div>`;
    for (const c of res.citations) html += `<div class="citation">[${c.ref}] ${esc(c.path)}</div>`;
    if (res.gaps?.length) html += `<p class="gap">gaps: ${res.gaps.map(esc).join(' · ')}</p>`;
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<p class="hint">ask failed: ${esc(e.message)}</p>`;
  }
}
$('#btn-ask').addEventListener('click', doAsk);
$('#ask-q').addEventListener('keydown', (e) => e.key === 'Enter' && doAsk());

/* ------------------------------- graph --------------------------------- */

const graphState = { nodes: [], edges: [], loaded: false, anim: null, selected: null };

async function loadGraph(q) {
  const depth = $('#graph-depth').value;
  const url = q ? `/api/graph?q=${encodeURIComponent(q)}&depth=${depth}` : '/api/graph';
  try {
    const res = await api(url);
    graphState.loaded = true;
    startGraph(res.nodes, res.edges);
    const side = $('#graph-side');
    side.innerHTML = res.nodes.length === 0 ? '<p class="hint">graph is empty — ingest docs first (entities come from [[wikilinks]] and LLM extraction).</p>' : '';
    for (const n of res.nodes.slice(0, 30)) {
      const card = document.createElement('div');
      card.className = 'entity-card';
      card.innerHTML = `<span class="etype">${esc(n.type)}</span> <span class="ename">${esc(n.name)}</span>
        <div class="hint">${esc((n.description || '').slice(0, 140))}</div>
        <div class="hint mono">score ${(n.score ?? 0).toFixed(2)} · ${n.mentionCount} mentions</div>`;
      side.appendChild(card);
    }
    if (res.chunks?.length) {
      const h = document.createElement('p');
      h.className = 'hint';
      h.textContent = 'grounded in: ' + [...new Set(res.chunks.map((c) => c.path))].slice(0, 5).join(', ');
      side.appendChild(h);
    }
  } catch (e) {
    toast(`graph failed: ${e.message}`);
  }
}

function startGraph(nodes, edges) {
  const canvas = $('#graph-canvas');
  const ctx = canvas.getContext('2d');
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const H = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const colors = { person: '#5fd297', organization: '#ffc861', product: '#ff9e7a', project: '#ff7a90', component: '#7ab8ff', technology: '#5cc8ff', concept: '#b48cff', event: '#e98cff', location: '#8cffe2', other: '#8b95a5' };

  const ns = nodes.slice(0, 150).map((n, i) => ({
    ...n,
    x: W / 2 + Math.cos((i / nodes.length) * 6.283) * Math.min(W, H) * 0.33,
    y: H / 2 + Math.sin((i / nodes.length) * 6.283) * Math.min(W, H) * 0.33,
    vx: 0, vy: 0,
    r: (6 + Math.min(14, Math.sqrt(n.mentionCount + 1) * 3)) * devicePixelRatio,
  }));
  const byId = new Map(ns.map((n) => [n.id, n]));
  const es = edges.filter((e) => byId.has(e.source) && byId.has(e.target));

  if (graphState.anim) cancelAnimationFrame(graphState.anim);
  graphState.nodes = ns;
  graphState.edges = es;

  let ticks = 0;
  const step = () => {
    // forces
    for (const a of ns) {
      a.vx += (W / 2 - a.x) * 0.0004;
      a.vy += (H / 2 - a.y) * 0.0004;
      for (const b of ns) {
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy + 0.01;
        if (d2 < 40000 * devicePixelRatio) {
          const f = 1200 * devicePixelRatio / d2;
          a.vx += dx * f * 0.01;
          a.vy += dy * f * 0.01;
        }
      }
    }
    for (const e of es) {
      const a = byId.get(e.source), b = byId.get(e.target);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const want = 110 * devicePixelRatio;
      const f = ((d - want) / d) * 0.004 * Math.min(2, e.weight);
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of ns) {
      n.vx *= 0.85; n.vy *= 0.85;
      n.x = Math.max(n.r, Math.min(W - n.r, n.x + n.vx));
      n.y = Math.max(n.r, Math.min(H - n.r, n.y + n.vy));
    }
    // draw
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(140,150,170,0.25)';
    for (const e of es) {
      const a = byId.get(e.source), b = byId.get(e.target);
      ctx.lineWidth = Math.min(3, 0.5 + e.weight * 0.4) * devicePixelRatio;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.font = `${11 * devicePixelRatio}px sans-serif`;
    for (const n of ns) {
      ctx.fillStyle = colors[n.type] || colors.other;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#d7dde6';
      ctx.fillText(n.name.slice(0, 22), n.x + n.r + 3, n.y + 4);
    }
    if (++ticks < 240) graphState.anim = requestAnimationFrame(step);
  };
  step();

  canvas.onclick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * devicePixelRatio;
    const y = (ev.clientY - rect.top) * devicePixelRatio;
    const hit = ns.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 <= (n.r + 4) ** 2);
    if (hit) {
      $('#graph-q').value = hit.name;
      loadGraph(hit.name);
    }
  };
}

$('#btn-graph').addEventListener('click', () => loadGraph($('#graph-q').value.trim()));
$('#graph-q').addEventListener('keydown', (e) => e.key === 'Enter' && loadGraph($('#graph-q').value.trim()));
$('#btn-graph-insights').addEventListener('click', async () => {
  try {
    const ins = await api('/api/graph/insights');
    const side = $('#graph-side');
    side.innerHTML = `<div class="entity-card"><b>totals</b><div class="hint mono">${ins.totals.entities} entities · ${ins.totals.relations} relations · ${ins.totals.mentions} mentions</div></div>`;
    if (ins.hubs.length) {
      side.innerHTML += `<div class="entity-card"><b>hubs</b>${ins.hubs.map((h) => `<div class="hint">${esc(h.name)} — degree ${h.degree}</div>`).join('')}</div>`;
    }
    if (ins.isolated.length) {
      side.innerHTML += `<div class="entity-card"><b>isolated</b>${ins.isolated.map((h) => `<div class="hint">${esc(h.name)}</div>`).join('')}</div>`;
    }
    side.innerHTML += `<div class="entity-card"><b>types</b>${ins.typeCounts.map((t) => `<div class="hint">${esc(t.type)}: ${t.n}</div>`).join('')}</div>`;
  } catch (e) {
    toast(`insights failed: ${e.message}`);
  }
});

/* ------------------------------- traces -------------------------------- */

async function loadTraces() {
  const tbody = $('#traces-table tbody');
  tbody.innerHTML = '';
  try {
    const traces = await api('/api/traces');
    for (const t of traces) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(t.source)}</td><td class="mono">${esc(t.project ?? '-')}</td>
        <td class="mono">${esc((t.session_id ?? '').slice(0, 24))}</td>
        <td class="mono">${t.started_at ? new Date(t.started_at).toLocaleString() : '-'}</td>
        <td class="mono">${(t.bytes / 1024).toFixed(0)} KB</td>
        <td>${t.analyzed_at ? '✓' : ''}</td>`;
      tbody.appendChild(tr);
    }
    if (!traces.length) tbody.innerHTML = '<tr><td colspan="6" class="hint">no traces yet — run a Claude Code / Codex session, then sync.</td></tr>';
  } catch (e) {
    toast(`traces failed: ${e.message}`);
  }
}

$('#btn-trace-sync').addEventListener('click', async () => {
  toast('syncing traces…', 30000);
  try {
    const s = await api('/api/traces/sync', { method: 'POST' });
    toast(`synced: ${s.copied} traces, ${s.skills} skill files`);
    loadTraces();
    loadStats();
  } catch (e) {
    toast(`sync failed: ${e.message}`);
  }
});

/* -------------------------------- dream -------------------------------- */

async function loadSuggestions() {
  const el = $('#suggestions');
  el.innerHTML = '';
  try {
    const [stats, suggestions] = await Promise.all([api('/api/stats'), api('/api/suggestions')]);
    if (stats.lastDream) {
      $('#dream-info').textContent = `last dream: ${new Date(stats.lastDream.at).toLocaleString()} over ${stats.lastDream.sessions} sessions → ${stats.lastDream.report}`;
    }
    if (!suggestions.length) {
      el.innerHTML = '<p class="hint">no suggestions yet — press “dream now” after a few agent sessions.</p>';
      return;
    }
    for (const s of suggestions) {
      const div = document.createElement('div');
      div.className = `suggestion ${s.status}`;
      const evidence = (s.evidence ?? []).map((e) => `<div>${esc(e)}</div>`).join('');
      div.innerHTML = `<span class="skind ${s.kind}">${s.kind}</span> <span class="hint mono">${s.status} · ${new Date(s.created_at).toLocaleDateString()}</span>
        <div class="stitle">${esc(s.title)}</div>
        <div class="sbody markdown">${renderMd(s.body)}</div>
        ${evidence ? `<div class="evidence">${evidence}</div>` : ''}
        <div class="sactions">
          ${s.status === 'pending' ? `<button data-act="accepted">accept</button><button data-act="rejected">reject</button>` : ''}
          ${s.report_path ? `<button data-report="${esc(s.report_path)}">report</button>` : ''}
        </div>`;
      div.querySelectorAll('button[data-act]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api(`/api/suggestions/${s.id}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.act }) });
          loadSuggestions();
        }),
      );
      const rb = div.querySelector('button[data-report]');
      if (rb) rb.addEventListener('click', () => {
        document.querySelector('#tabs button[data-tab="files"]').click();
        openFile(rb.dataset.report);
      });
      el.appendChild(div);
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">failed: ${esc(e.message)}</p>`;
  }
}

$('#btn-dream').addEventListener('click', async () => {
  toast('dreaming… this can take a minute', 90000);
  try {
    const res = await api('/api/dream', { method: 'POST' });
    toast(`dream complete: ${res.suggestions.length} suggestions (${res.sessions} sessions)`);
    loadSuggestions();
    loadStats();
  } catch (e) {
    toast(`dream failed: ${e.message}`);
  }
});

/* -------------------------------- boot ---------------------------------- */

loadTree().then(() => openFile('wiki/index.md')).catch(() => {});
