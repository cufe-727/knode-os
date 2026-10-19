/* knode-os graph view — the canvas behind Knowledge → Graph.
 *
 * web/app.js fetches the data and owns the DOM around the canvas (legend,
 * caption, settings, side panel); this draws. Layout, zoom and drag come
 * from d3 (/vendor/d3.js): a force simulation that settles and sleeps, a
 * zoomable, pannable canvas, nodes that can be dragged and pinned, hover
 * that isolates a neighbourhood, labels that fade in with zoom, the way
 * Obsidian's graph view behaves. Without d3 the class still exists but
 * `KnodeGraph.available` is false, so the app can say so instead of breaking. */
'use strict';

class KnodeGraph {
  /** Display preferences, persisted by the app; the force values are shared with the Mac app's simulation. */
  static DEFAULTS = Object.freeze({
    limit: 150, hiddenTypes: [], hideOrphans: false, cooccur: true, minWeight: 0,
    nodeSize: 1, linkWidth: 1, textFade: 1, arrows: false, pin: false,
    center: 0.06, repel: 180, linkDistance: 90,
  });
  static FORCE_KEYS = ['center', 'repel', 'linkDistance'];
  static FILTER_KEYS = ['hiddenTypes', 'hideOrphans', 'cooccur', 'minWeight'];
  static available = typeof d3 !== 'undefined' && d3 !== null;

  /** How far from a node's centre, in screen pixels, a pointer still counts as on it. */
  static HIT_PX = 18;
  static DIM = 0.12;
  static ZOOM_EXTENT = [0.15, 8];

  constructor(canvas, { colors = {}, settings = {} } = {}) {
    if (!KnodeGraph.available) throw new Error('d3 is not available');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = colors;
    this.settings = { ...KnodeGraph.DEFAULTS, ...settings };
    const css = getComputedStyle(document.documentElement);
    this.fg = css.getPropertyValue('--fg').trim() || '#d7dde6';
    this.halo = css.getPropertyValue('--bg2').trim() || '#161a21';
    this.accent = '92,200,255';

    this.all = { nodes: [], edges: [] };
    /** Every node object this view has ever placed, by id: a refilter keeps positions. */
    this.byId = new Map();
    this.nodes = [];
    this.links = [];
    this.adj = new Map();
    this.largest = new Set();
    this.hover = null;
    this.selected = null;
    this.matches = null;
    this.mode = 'overview';
    this.handlers = {};
    this.raf = null;
    this.t = d3.zoomIdentity;
    this.sized = false;

    this.sim = d3.forceSimulation([])
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .alphaMin(0.001)
      .force('charge', d3.forceManyBody().distanceMax(500).theta(0.9))
      .force('link', d3.forceLink([]))
      .force('x', d3.forceX(0))
      .force('y', d3.forceY(0))
      .force('collide', d3.forceCollide().iterations(1))
      .on('tick', () => this.invalidate())
      .stop();
    this.applyForces();

    // drag before zoom: a press on a node drags it, a press elsewhere pans
    this.drag = d3.drag()
      .container(canvas)
      .subject((ev) => {
        const n = this.nodeAt(ev.x, ev.y);
        // the subject lives in screen space, so d3's offsets stay in one coordinate system
        return n ? { node: n, x: this.t.applyX(n.x), y: this.t.applyY(n.y) } : null;
      })
      .on('start', (ev) => {
        if (!ev.active) this.sim.alphaTarget(0.3).restart();
        const n = ev.subject.node;
        n.fx = n.x;
        n.fy = n.y;
      })
      .on('drag', (ev) => {
        const n = ev.subject.node;
        n.fx = this.t.invertX(ev.x);
        n.fy = this.t.invertY(ev.y);
      })
      .on('end', (ev) => {
        if (!ev.active) this.sim.alphaTarget(0);
        if (!this.settings.pin) {
          ev.subject.node.fx = null;
          ev.subject.node.fy = null;
        }
      });
    this.zoom = d3.zoom()
      .scaleExtent(KnodeGraph.ZOOM_EXTENT)
      .on('zoom', (ev) => {
        this.t = ev.transform;
        this.invalidate();
      });
    this.sel = d3.select(canvas).call(this.drag).call(this.zoom).on('dblclick.zoom', null);

    this.onMove = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      if (n !== this.hover) this.setHover(n ? n.id : null);
    };
    this.onLeave = () => this.setHover(null);
    this.onClick = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      this.select(n ? n.id : null);
    };
    this.onDblClick = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      if (n) this.emit('open', n);
    };
    this.onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      this.setHover(null);
      this.select(null);
    };
    canvas.addEventListener('mousemove', this.onMove);
    canvas.addEventListener('mouseleave', this.onLeave);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('dblclick', this.onDblClick);
    canvas.addEventListener('keydown', this.onKey);

    // the tab is display:none until shown, so the first real size arrives here
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  /* ------------------------------- events ------------------------------- */

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }

  /* -------------------------------- data -------------------------------- */

  /** Show a graph read: nodes as the server ranked them, so hubs seed the centre. */
  load(nodes, edges, { mode = 'overview' } = {}) {
    this.mode = mode;
    this.all = { nodes: nodes.map((n, rank) => ({ ...n, rank })), edges: edges.map((e) => ({ ...e })) };
    this.byId.clear();
    this.hover = null;
    this.selected = null;
    this.matches = null;
    this.applyFilter(1);
    this.resetView();
  }

  /** The visible subset under the current filters; positions carry over, so a toggle does not scatter the view. */
  applyFilter(alpha = 0.3) {
    const s = this.settings;
    const hidden = new Set(s.hiddenTypes);
    const kept = this.all.nodes.filter((n) => !hidden.has(n.type));
    const ids = new Set(kept.map((n) => n.id));
    const edges = this.all.edges.filter((e) =>
      ids.has(e.source) && ids.has(e.target) && e.source !== e.target && (s.cooccur || e.type !== 'co_occurs') && e.weight >= s.minWeight);
    const linked = new Set();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    const shown = s.hideOrphans ? kept.filter((n) => linked.has(n.id)) : kept;
    this.nodes = shown.map((n) => {
      let o = this.byId.get(n.id);
      if (!o) {
        // a spiral by rank: the most mentioned sit in the middle from the first frame
        const a = n.rank * 2.39996;
        const r = 14 * Math.sqrt(n.rank);
        o = { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fx: null, fy: null };
        this.byId.set(n.id, o);
      }
      return o;
    });
    const objById = new Map(this.nodes.map((o) => [o.id, o]));
    this.links = edges.map((e) => ({
      source: objById.get(e.source), target: objById.get(e.target),
      type: e.type, weight: e.weight, description: e.description, co: e.type === 'co_occurs',
    }));
    this.adj = new Map();
    for (const o of this.nodes) o.inDegree = 0;
    for (const l of this.links) {
      l.source.inDegree++;
      l.target.inDegree++;
      (this.adj.get(l.source.id) ?? this.adj.set(l.source.id, new Map()).get(l.source.id)).set(l.target.id, l);
      (this.adj.get(l.target.id) ?? this.adj.set(l.target.id, new Map()).get(l.target.id)).set(l.source.id, l);
    }
    this.sizeNodes();
    if (this.selected && !objById.has(this.selected.id)) this.select(null);
    if (this.hover && !objById.has(this.hover.id)) this.hover = null;
    this.sim.nodes(this.nodes);
    this.sim.force('link').links(this.links);
    this.sim.alpha(alpha).restart();
    this.emit('stats', { nodes: this.nodes.length, edges: this.links.length });
  }

  /** Radius from links, the way Obsidian sizes nodes: the global typed degree when the server sent it, else what is in view. */
  sizeNodes() {
    const scale = this.settings.nodeSize;
    for (const o of this.nodes) {
      const degree = typeof o.degree === 'number' ? o.degree : o.inDegree;
      o.r = scale * Math.min(22, 3 + 2.2 * Math.sqrt(degree));
    }
    this.largest = new Set([...this.nodes].sort((a, b) => b.r - a.r).slice(0, 12).map((o) => o.id));
    this.sim.force('collide').radius((d) => d.r + 3);
  }

  applyForces() {
    const s = this.settings;
    this.sim.force('charge').strength(-s.repel);
    this.sim.force('link')
      .distance((l) => s.linkDistance * (l.co ? 1.5 : 1) / (0.6 + 0.4 * Math.min(1, l.weight / 3)))
      .strength((l) => (l.co ? 0.12 : 0.5) * Math.min(1, l.weight / 2 + 0.25));
    this.sim.force('x').strength(s.center);
    this.sim.force('y').strength(s.center);
  }

  /** Change preferences; only what changed is recomputed, and only a force change reheats the layout. */
  setSettings(partial) {
    const prev = this.settings;
    const next = { ...prev, ...partial };
    this.settings = next;
    const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
    if (KnodeGraph.FILTER_KEYS.some(changed)) this.applyFilter(0.3);
    else if (changed('nodeSize')) {
      this.sizeNodes();
      this.sim.alpha(0.2).restart();
    }
    if (KnodeGraph.FORCE_KEYS.some(changed)) {
      this.applyForces();
      this.sim.alpha(0.6).restart();
    }
    this.invalidate();
  }

  /** Highlight the nodes whose name holds the text; empty text clears it. */
  setQuery(text) {
    const q = String(text ?? '').trim().toLowerCase();
    this.matches = q ? new Set(this.nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.invalidate();
  }

  setHover(id) {
    const n = id ? this.byId.get(id) ?? null : null;
    if (n === this.hover) return;
    this.hover = n;
    this.canvas.classList.toggle('over', Boolean(n));
    this.emit('hover', n);
    this.invalidate();
  }

  select(id) {
    const n = id ? this.byId.get(id) ?? null : null;
    if (n === this.selected) return;
    this.selected = n;
    this.emit('select', n);
    this.invalidate();
  }

  /** A node's neighbours in view, strongest edge first. */
  neighbours(id) {
    const out = [];
    for (const [other, l] of this.adj.get(id) ?? []) {
      const node = this.byId.get(other);
      if (node) out.push({ node, weight: l.weight, type: l.type, co: l.co, out: l.source.id === id });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  counts() {
    return { nodes: this.nodes.length, edges: this.links.length };
  }

  clear() {
    this.sim.stop();
    this.all = { nodes: [], edges: [] };
    this.byId.clear();
    this.nodes = [];
    this.links = [];
    this.adj.clear();
    this.hover = null;
    this.selected = null;
    this.matches = null;
    this.sim.nodes([]);
    this.sim.force('link').links([]);
    this.invalidate();
  }

  destroy() {
    this.sim.stop();
    this.ro.disconnect();
    this.sel.on('.zoom', null).on('.drag', null);
    const c = this.canvas;
    c.removeEventListener('mousemove', this.onMove);
    c.removeEventListener('mouseleave', this.onLeave);
    c.removeEventListener('click', this.onClick);
    c.removeEventListener('dblclick', this.onDblClick);
    c.removeEventListener('keydown', this.onKey);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  /* -------------------------------- view -------------------------------- */

  resize() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    if (!this.sized) {
      this.sized = true;
      this.resetView();
    }
    this.invalidate();
  }

  /** The origin in the middle at scale 1: where a fresh layout grows from. */
  resetView() {
    const c = this.canvas;
    if (!c.clientWidth || !c.clientHeight) return;
    this.sel.call(this.zoom.transform, d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2));
  }

  /** Bring the whole visible graph into the canvas. */
  fit() {
    if (!this.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    const c = this.canvas;
    const k = Math.max(KnodeGraph.ZOOM_EXTENT[0], Math.min(KnodeGraph.ZOOM_EXTENT[1], 0.9 / Math.max((x1 - x0) / c.clientWidth, (y1 - y0) / c.clientHeight)));
    const t = d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    this.sel.transition().duration(400).call(this.zoom.transform, t);
  }

  /** Pan (and zoom in a little) to a node. */
  focus(id) {
    const n = this.byId.get(id);
    if (!n) return;
    const c = this.canvas;
    const k = Math.max(this.t.k, 1.2);
    const t = d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(k).translate(-n.x, -n.y);
    this.sel.transition().duration(400).call(this.zoom.transform, t);
  }

  /** The node under a screen point, or null. */
  nodeAt(sx, sy) {
    if (!this.nodes.length) return null;
    const [x, y] = this.t.invert([sx, sy]);
    return this.sim.find(x, y, KnodeGraph.HIT_PX / this.t.k) ?? null;
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  draw() {
    const { canvas: c, ctx, t } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.nodes.length) return;
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    const k = t.k;
    const s = this.settings;

    // the viewport in world units, so what is off screen costs nothing
    const x0 = -t.x / k, y0 = -t.y / k, x1 = (w - t.x) / k, y1 = (h - t.y) / k;
    const inView = (n) => n.x + n.r >= x0 && n.x - n.r <= x1 && n.y + n.r >= y0 && n.y - n.r <= y1;

    // what stands out: a hovered or selected node with its neighbours, else the search matches
    const focus = this.hover ?? this.selected;
    const hi = focus ? new Set([focus.id, ...(this.adj.get(focus.id)?.keys() ?? [])]) : this.matches;
    const lit = (l) => (focus ? l.source.id === focus.id || l.target.id === focus.id : hi.has(l.source.id) && hi.has(l.target.id));

    // edges, one stroke per style: thousands of strokes a frame became a few dozen
    const buckets = new Map();
    for (const l of this.links) {
      if (!inView(l.source) && !inView(l.target)) continue;
      let alpha = l.co ? 0.07 + 0.2 * Math.min(1, l.weight / 3) : 0.18 + 0.4 * Math.min(1, l.weight / 4);
      let color = '140,150,170';
      if (hi) {
        if (lit(l)) {
          color = this.accent;
          alpha = Math.max(alpha, 0.55);
        } else alpha *= KnodeGraph.DIM;
      }
      const a = Math.round(alpha * 20) / 20;
      const width = Math.round((s.linkWidth * (0.6 + Math.min(2, 0.3 * l.weight)) / Math.sqrt(k)) * 4) / 4;
      const key = `${l.co ? 'c' : 't'}|${color}|${a}|${width}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { co: l.co, color, alpha: a, width, links: [] }));
      b.links.push(l);
    }
    const order = [...buckets.values()].sort((p, q) => (p.co === q.co ? 0 : p.co ? -1 : 1));
    for (const b of order) {
      if (b.alpha <= 0) continue;
      ctx.beginPath();
      for (const l of b.links) {
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
      }
      ctx.strokeStyle = `rgba(${b.color},${b.alpha})`;
      ctx.lineWidth = b.width;
      ctx.setLineDash(b.co ? [4 / k, 4 / k] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (s.arrows && k >= 0.7) {
      ctx.fillStyle = 'rgba(140,150,170,0.7)';
      const size = 6 / k;
      for (const l of this.links) {
        if (l.co || !inView(l.target) || (hi && !lit(l))) continue;
        const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d;
        const tx = l.target.x - ux * (l.target.r + 1), ty = l.target.y - uy * (l.target.r + 1);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ux * size - uy * size * 0.5, ty - uy * size + ux * size * 0.5);
        ctx.lineTo(tx - ux * size + uy * size * 0.5, ty - uy * size - ux * size * 0.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    for (const n of this.nodes) {
      if (!inView(n)) continue;
      ctx.globalAlpha = hi && !hi.has(n.id) ? KnodeGraph.DIM : 1;
      ctx.fillStyle = this.colors[n.type] ?? this.colors.other ?? '#8b95a5';
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
      ctx.fill();
      if (this.selected && n.id === this.selected.id) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      } else if (n.fx != null) {
        ctx.lineWidth = 1.5 / k;
        ctx.strokeStyle = 'rgba(215,221,230,0.6)';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // labels fade in with zoom; far out, only the largest nodes and the highlight keep theirs
    const labelAlpha = Math.max(0, Math.min(1, (k - s.textFade) / 0.35));
    ctx.font = `${11 / k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const n of this.nodes) {
      if (!inView(n)) continue;
      const forced = (hi && hi.has(n.id)) || (this.selected && n.id === this.selected.id);
      if (hi && !forced) continue;
      const a = forced ? 1 : labelAlpha >= 0.05 ? labelAlpha : this.largest.has(n.id) ? 0.9 : 0;
      if (a <= 0) continue;
      ctx.globalAlpha = a;
      const text = n.name.length > 28 ? `${n.name.slice(0, 27)}…` : n.name;
      const x = n.x + n.r + 4 / k;
      ctx.lineWidth = 3 / k;
      ctx.strokeStyle = this.halo;
      ctx.strokeText(text, x, n.y);
      ctx.fillStyle = this.fg;
      ctx.fillText(text, x, n.y);
    }
    ctx.globalAlpha = 1;
  }
}

window.KnodeGraph = KnodeGraph;
