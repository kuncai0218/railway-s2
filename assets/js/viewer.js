// Synced image viewers: wheel zoom, drag to pan, an editable box layer drawn in original-pixel coordinates,
// and (step 3) painting single 10 m cells inside fixed boxes.
const SIZE = 256;
const SVGNS = 'http://www.w3.org/2000/svg';
let uid = 0;

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const PAINT_RGBA = { 1: [255, 64, 64, 110], 2: [255, 196, 0, 125] };
const PAINT_LINE = { 1: '#FF5A5A', 2: '#FFC400' };
const GRID_MIN_SCALE = 5;   // screen pixels per cell before the cell grid is drawn

// Edges between cells of value v and anything else, as one SVG path in image pixels.
function outlinePath(bx, v) {
  const { c0, r0, w, h, cells } = bx;
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? -1 : cells[j * w + i]);
  let d = '';
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (cells[j * w + i] !== v) continue;
    const x = c0 + i, y = r0 + j;
    if (at(i, j - 1) !== v) d += `M${x},${y}h1`;
    if (at(i, j + 1) !== v) d += `M${x},${y + 1}h1`;
    if (at(i - 1, j) !== v) d += `M${x},${y}v1`;
    if (at(i + 1, j) !== v) d += `M${x + 1},${y}v1`;
  }
  return d;
}
const round1 = v => Math.round(v * 10) / 10;
export function normBox(b) {
  return { ...b, x0: round1(Math.min(b.x0, b.x1)), y0: round1(Math.min(b.y0, b.y1)), x1: round1(Math.max(b.x0, b.x1)), y1: round1(Math.max(b.y0, b.y1)) };
}

export class Scene {
  constructor() {
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.viewers = [];
    this.layers = {};          // name -> { boxes, style, editable, label }
    this.selected = null;      // id of the selected box in the editable layer
    this.mode = 'pan';         // 'pan' | 'draw' | 'paint'
    this.aoi = null;           // ring [[x, y], ...] in pixels
    this.rail = [];            // polylines in pixels
    this.showAoi = true;
    this.showRail = true;
    this.bare = false;         // 只看原图：隐藏框、观察范围、铁路、涂色、AI 变化图
    this.onChange = () => {};
    this.onSelect = () => {};
    this.onMode = () => {};
    // step 3: { boxes: [{ id, c0, r0, w, h, cells: Uint8Array(w*h) }], current, brush (0 erase, 1 changed, 2 unsure), size, editable, show, grid }
    this.paint = null;
    this.paintVersion = 0;
    // AI 变化图（复核台和第三步用）：{ cells: Uint8Array(256*256)，0 没变 1 变化 2 拿不准, show, viewer: 只画在第几个窗口（null = 都画） }
    this.aiMap = null;
    this.aiMapVersion = 0;
    this.onPaint = () => {};      // a stroke, fill or undo finished
    this.onPickBox = () => {};    // clicked another box while painting
    this.onPaintView = () => {};  // paint shown / hidden with the keyboard
    this.hover = null;            // pointer position in image pixels, shown in every viewer
    this._undo = [];
    this._spaceDown = false;
    this.active = true;        // only the visible scene reacts to the keyboard
    window.addEventListener('keydown', e => this._key(e, true));
    window.addEventListener('keyup', e => this._key(e, false));
  }

  addViewer(container, { label = '' } = {}) {
    const v = new Viewer(this, container, label);
    this.viewers.push(v);
    return v;
  }

  // viewer: index of the only viewer that shows this layer (null = all viewers)
  setLayer(name, boxes, { style = 'change', editable = false, viewer = null, labels = true } = {}) {
    this.layers[name] = { boxes, style, editable, viewer, labels };
    this.render();
  }
  editableLayer() { return Object.values(this.layers).find(l => l.editable) || null; }
  setMode(mode) { this.mode = mode; this.viewers.forEach(v => v.updateCursor()); this.onMode(mode); }
  select(id) { this.selected = id; this.render(); this.onSelect(id); }

  fitScale() {
    const v = this.viewers[0];
    if (!v) return 1;
    const r = v.box.getBoundingClientRect();
    return Math.max(0.1, Math.min(r.width, r.height) / SIZE);
  }
  fit() {
    const v = this.viewers[0];
    if (!v) return;
    const r = v.box.getBoundingClientRect();
    const s = this.fitScale();
    this.setView(s, (r.width - SIZE * s) / 2, (r.height - SIZE * s) / 2);
  }
  setView(scale, tx, ty) {
    const v = this.viewers[0];
    if (v) {
      const r = v.box.getBoundingClientRect();
      const fs = this.fitScale();
      scale = clamp(scale, fs * 0.8, fs * 24);
      tx = clamp(tx, -SIZE * scale + r.width * 0.3, r.width * 0.7);
      ty = clamp(ty, -SIZE * scale + r.height * 0.3, r.height * 0.7);
    }
    this.view = { scale, tx, ty };
    this.render();
  }
  zoomAt(factor, mx, my) {
    const { scale, tx, ty } = this.view;
    const ns = scale * factor;
    this.setView(ns, mx - (mx - tx) * (ns / scale), my - (my - ty) * (ns / scale));
  }
  zoomBy(factor) {
    const v = this.viewers[0];
    if (!v) return;
    const r = v.box.getBoundingClientRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }
  // pad: how many box widths fit across the view
  focusBox(b, pad = 3) {
    const v = this.viewers[0];
    if (!v) return;
    const r = v.box.getBoundingClientRect();
    const w = Math.max(b.x1 - b.x0, 8), h = Math.max(b.y1 - b.y0, 8);
    const s = Math.min(r.width / (w * pad), r.height / (h * pad), this.fitScale() * (pad < 3 ? 20 : 12));
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    this.setView(s, r.width / 2 - cx * s, r.height / 2 - cy * s);
  }

  render() { this.viewers.forEach(v => v.render()); }

  setAiMap(m) { this.aiMap = m; this.aiMapVersion++; this.render(); }
  toggleAiMap(show) { if (!this.aiMap) return; this.aiMap.show = show ?? !this.aiMap.show; this.aiMapVersion++; this.render(); }

  // ---------- step 3 painting ----------
  setPaint(p) { this.paint = p; this._undo = []; this.paintChanged(); }
  paintChanged() { this.paintVersion++; this.render(); }
  paintBox(id = this.paint?.current) { return this.paint?.boxes.find(b => b.id === id) || null; }
  inBox(bx, x, y) { return x >= bx.c0 && x < bx.c0 + bx.w && y >= bx.r0 && y < bx.r0 + bx.h; }
  pushUndo(bx) {
    this._undo.push({ id: bx.id, cells: bx.cells.slice() });
    if (this._undo.length > 80) this._undo.shift();
  }
  undo() {
    const u = this._undo.pop();
    if (!u) return false;
    const bx = this.paintBox(u.id);
    if (bx) bx.cells.set(u.cells);
    this.paintChanged();
    this.onPaint();
    return true;
  }
  // top-left cell of the brush square centred on image point (x, y)
  brushOrigin(x, y) { const s = this.paint.size; return { c: Math.floor(x - s / 2 + 0.5), r: Math.floor(y - s / 2 + 0.5), s }; }
  applyBrush(bx, x, y) {
    const { c, r, s } = this.brushOrigin(x, y);
    const v = this.paint.brush;
    let changed = false;
    for (let rr = r; rr < r + s; rr++) for (let cc = c; cc < c + s; cc++) {
      const i = cc - bx.c0, j = rr - bx.r0;
      if (i < 0 || j < 0 || i >= bx.w || j >= bx.h) continue;
      const n = j * bx.w + i;
      if (bx.cells[n] !== v) { bx.cells[n] = v; changed = true; }
    }
    return changed;
  }
  // 魔棒（brush 3）：点一下，把框内与这一格相连、AI 认为变化的格子都涂成“变化”；点在 AI 没标的格子上只涂这一格
  wandFill(bx, x, y) {
    const M = this.aiMap?.cells;
    const i0 = Math.floor(x) - bx.c0, j0 = Math.floor(y) - bx.r0;
    if (i0 < 0 || j0 < 0 || i0 >= bx.w || j0 >= bx.h) return false;
    const isAi = (i, j) => !!M && M[(bx.r0 + j) * SIZE + bx.c0 + i] === 1;
    if (!isAi(i0, j0)) { bx.cells[j0 * bx.w + i0] = 1; return true; }
    const seen = new Uint8Array(bx.w * bx.h), st = [[i0, j0]];
    seen[j0 * bx.w + i0] = 1;
    while (st.length) {
      const [i, j] = st.pop();
      bx.cells[j * bx.w + i] = 1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if ((!di && !dj) || a < 0 || b < 0 || a >= bx.w || b >= bx.h) continue;
        const n = b * bx.w + a;
        if (seen[n] || !isAi(a, b)) continue;
        seen[n] = 1; st.push([a, b]);
      }
    }
    return true;
  }
  setHover(p) { this.hover = p; this.viewers.forEach(v => v.renderCursor()); }

  nextId() {
    const l = this.editableLayer();
    return (l ? l.boxes.reduce((m, b) => Math.max(m, b.id || 0), 0) : 0) + 1;
  }
  deleteSelected() {
    const layer = this.editableLayer();
    if (!layer || this.selected == null) return;
    const i = layer.boxes.findIndex(b => b.id === this.selected);
    if (i >= 0) layer.boxes.splice(i, 1);
    this.selected = null;
    this.render();
    this.onChange();
    this.onSelect(null);
  }
  _key(e, down) {
    if (!this.active) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.code === 'Space' && !typing) {
      this._spaceDown = down;
      this.viewers.forEach(v => v.updateCursor());
      if (down) e.preventDefault();
    }
    if (!down || typing) return;
    if (this.paint?.editable) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) { this.paint.show = !this.paint.show; this.render(); this.onPaintView(); return; }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected != null) { e.preventDefault(); this.deleteSelected(); }
    if (e.key === 'Escape') this.select(null);
  }
}

class Viewer {
  constructor(scene, box, label) {
    this.scene = scene;
    this.box = box;
    this.id = ++uid;
    this.index = scene.viewers.length;
    box.classList.add('viewer');
    box.innerHTML = '';
    this.stage = document.createElement('div');
    this.stage.className = 'viewer-stage';
    this.img = document.createElement('img');
    this.img.className = 'viewer-img';
    this.img.draggable = false;
    this.img.alt = label;
    this.stage.appendChild(this.img);
    this.aimap = document.createElement('canvas');
    this.aimap.className = 'viewer-mask viewer-aimap';
    this.aimap.width = SIZE;
    this.aimap.height = SIZE;
    this.stage.appendChild(this.aimap);
    this._aiKey = '';
    this.mask = document.createElement('canvas');
    this.mask.className = 'viewer-mask';
    this.mask.width = SIZE;
    this.mask.height = SIZE;
    this.stage.appendChild(this.mask);
    this._paintKey = '';
    this.svg = el('svg', { class: 'viewer-svg', viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
    const defs = el('defs', {}, this.svg);
    const pat = el('pattern', { id: `hatch${this.id}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 4, height: 4, fill: 'rgba(20,24,32,0.35)' }, pat);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: 'rgba(255,255,255,0.75)', 'stroke-width': 1.2 }, pat);
    this.gAoi = el('g', {}, this.svg);
    this.gRail = el('g', {}, this.svg);
    this.gPaint = el('g', {}, this.svg);
    this.gBoxes = el('g', {}, this.svg);
    this.gCursor = el('g', { 'pointer-events': 'none' }, this.svg);
    box.appendChild(this.stage);
    // the overlay sits outside the CSS-scaled stage and is sized to the zoom instead,
    // so non-scaling strokes, labels and handles keep their screen size
    box.appendChild(this.svg);
    this.tag = document.createElement('div');
    this.tag.className = 'viewer-tag';
    this.tag.textContent = label;
    box.appendChild(this.tag);
    this.drag = null;
    this._bind();
  }
  setImage(src, label) { this.img.src = src; if (label != null) { this.tag.textContent = label; this.img.alt = label; } }
  setTag(text) { this.tag.textContent = text; }

  toImage(ev) {
    const r = this.box.getBoundingClientRect();
    const { scale, tx, ty } = this.scene.view;
    return { x: (ev.clientX - r.left - tx) / scale, y: (ev.clientY - r.top - ty) / scale, mx: ev.clientX - r.left, my: ev.clientY - r.top };
  }

  hit(p) {
    const layer = this.scene.editableLayer();
    if (!layer) return null;
    const s = this.scene.view.scale;
    const hs = 7 / s;
    const sel = layer.boxes.find(b => b.id === this.scene.selected);
    if (sel) {
      const dx = sel.x1 + 10 / s, dy = sel.y0 - 10 / s;
      if (Math.hypot(p.x - dx, p.y - dy) <= 9 / s) return { box: sel, handle: 'del' };
      const xs = { w: sel.x0, c: (sel.x0 + sel.x1) / 2, e: sel.x1 };
      const ys = { n: sel.y0, m: (sel.y0 + sel.y1) / 2, s: sel.y1 };
      const handles = { nw: [xs.w, ys.n], n: [xs.c, ys.n], ne: [xs.e, ys.n], e: [xs.e, ys.m], se: [xs.e, ys.s], s: [xs.c, ys.s], sw: [xs.w, ys.s], w: [xs.w, ys.m] };
      for (const [k, [hx, hy]] of Object.entries(handles)) {
        if (Math.abs(p.x - hx) <= hs && Math.abs(p.y - hy) <= hs) return { box: sel, handle: k };
      }
    }
    for (let i = layer.boxes.length - 1; i >= 0; i--) {
      const b = layer.boxes[i];
      const pad = 3 / s;
      if (p.x >= b.x0 - pad && p.x <= b.x1 + pad && p.y >= b.y0 - pad && p.y <= b.y1 + pad) return { box: b, handle: null };
    }
    return null;
  }

  updateCursor(p) {
    const sc = this.scene;
    let c = sc.mode === 'draw' ? 'crosshair' : 'grab';
    if (sc.mode === 'paint' && sc.paint?.editable && p && !sc._spaceDown) {
      const bx = sc.paintBox();
      if (bx && sc.inBox(bx, p.x, p.y)) c = 'crosshair';
      else if (sc.paint.boxes.some(b => sc.inBox(b, p.x, p.y))) c = 'pointer';
    }
    if (sc._spaceDown) c = 'grab';
    if (this.drag?.type === 'pan') c = 'grabbing';
    if (p && !sc._spaceDown) {
      const h = this.hit(p);
      if (h?.handle === 'del') c = 'pointer';
      else if (h) c = h.handle ? ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' })[h.handle] : 'move';
    }
    this.box.style.cursor = c;
  }

  _bind() {
    const box = this.box;
    box.addEventListener('wheel', ev => {
      ev.preventDefault();
      const p = this.toImage(ev);
      this.scene.zoomAt(ev.deltaY < 0 ? 1.18 : 1 / 1.18, p.mx, p.my);
    }, { passive: false });
    box.addEventListener('dblclick', ev => { if (this.scene.mode !== 'paint' && !this.hit(this.toImage(ev))) this.scene.fit(); });
    box.addEventListener('pointerleave', () => { if (!this.drag) this.scene.setHover(null); });
    box.addEventListener('contextmenu', ev => ev.preventDefault());
    box.addEventListener('pointerdown', ev => {
      const sc = this.scene;
      const p = this.toImage(ev);
      box.setPointerCapture(ev.pointerId);
      const panWanted = ev.button === 1 || ev.button === 2 || sc._spaceDown;
      if (!panWanted && ev.button === 0 && sc.mode === 'paint' && sc.paint?.editable) {
        const bx = sc.paintBox();
        if (bx && sc.inBox(bx, p.x, p.y) && sc.paint.brush === 3) {
          sc.pushUndo(bx);
          sc.wandFill(bx, p.x, p.y);
          sc.paintChanged();
          sc.onPaint();
          this.drag = null;
          return;
        }
        if (bx && sc.inBox(bx, p.x, p.y)) {
          sc.pushUndo(bx);
          sc.applyBrush(bx, p.x, p.y);
          sc.paintChanged();
          this.drag = { type: 'paint', box: bx, last: p };
          sc.setHover(p);
          return;
        }
        const other = sc.paint.boxes.find(b => sc.inBox(b, p.x, p.y));
        if (other) { this.drag = null; sc.onPickBox(other.id); return; }
      }
      const h = panWanted ? null : this.hit(p);
      const layer = sc.editableLayer();
      if (h?.handle === 'del') {
        sc.selected = h.box.id;
        sc.deleteSelected();
        this.drag = null;
        return;
      }
      if (h) {
        sc.select(h.box.id);
        this.drag = { type: h.handle ? 'resize' : 'move', handle: h.handle, start: p, orig: { ...h.box }, box: h.box, moved: false };
      } else if (!panWanted && sc.mode === 'draw' && layer) {
        const b = { id: sc.nextId(), x0: clamp(p.x, 0, SIZE), y0: clamp(p.y, 0, SIZE), x1: clamp(p.x, 0, SIZE), y1: clamp(p.y, 0, SIZE) };
        if (layer.style === 'change') { b.tags = []; b.note = ''; }
        layer.boxes.push(b);
        sc.selected = b.id;
        this.drag = { type: 'new', box: b, start: p };
      } else {
        if (!panWanted) sc.select(null);
        this.drag = { type: 'pan', start: p, view: { ...sc.view } };
      }
      this.updateCursor(p);
    });
    box.addEventListener('pointermove', ev => {
      const p = this.toImage(ev);
      const d = this.drag;
      const sc = this.scene;
      if (!d) { this.updateCursor(p); sc.setHover(p); return; }
      if (d.type === 'paint') {
        // fill the cells between the last and this pointer position so fast strokes leave no gaps
        const n = Math.max(1, Math.ceil(Math.hypot(p.x - d.last.x, p.y - d.last.y) / 0.5));
        let changed = false;
        for (let t = 1; t <= n; t++) changed = sc.applyBrush(d.box, d.last.x + (p.x - d.last.x) * t / n, d.last.y + (p.y - d.last.y) * t / n) || changed;
        d.last = p;
        if (changed) sc.paintChanged();
        sc.setHover(p);
        return;
      }
      if (d.type === 'pan') {
        sc.setView(d.view.scale, d.view.tx + (p.mx - d.start.mx), d.view.ty + (p.my - d.start.my));
        return;
      }
      const x = clamp(p.x, 0, SIZE), y = clamp(p.y, 0, SIZE);
      if (d.type === 'new') { d.box.x1 = x; d.box.y1 = y; }
      if (d.type === 'move') {
        const w = d.orig.x1 - d.orig.x0, h = d.orig.y1 - d.orig.y0;
        const nx = clamp(d.orig.x0 + (p.x - d.start.x), 0, SIZE - w), ny = clamp(d.orig.y0 + (p.y - d.start.y), 0, SIZE - h);
        Object.assign(d.box, { x0: nx, y0: ny, x1: nx + w, y1: ny + h });
        d.moved = true;
      }
      if (d.type === 'resize') {
        if (d.handle.includes('w')) d.box.x0 = x;
        if (d.handle.includes('e')) d.box.x1 = x;
        if (d.handle.includes('n')) d.box.y0 = y;
        if (d.handle.includes('s')) d.box.y1 = y;
        d.moved = true;
      }
      sc.render();
    });
    const end = ev => {
      const d = this.drag;
      const sc = this.scene;
      this.drag = null;
      if (!d) return;
      if (d.type === 'paint') sc.onPaint();
      if (d.type === 'new' || d.type === 'move' || d.type === 'resize') {
        const layer = sc.editableLayer();
        const i = layer.boxes.indexOf(d.box);
        const nb = normBox(d.box);
        if (d.type === 'new' && (nb.x1 - nb.x0 < 1 || nb.y1 - nb.y0 < 1)) {
          layer.boxes.splice(i, 1);
          sc.selected = null;
          sc.render();
          sc.onSelect(null);
        } else {
          Object.assign(d.box, nb);
          sc.render();
          if (d.type === 'new' || d.moved) sc.onChange();
          sc.onSelect(d.box.id);
          if (d.type === 'new') sc.setMode('pan');
        }
      }
      this.updateCursor(this.toImage(ev));
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  render() {
    const sc = this.scene;
    const { scale, tx, ty } = sc.view;
    this.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    this.svg.style.transform = `translate(${tx}px, ${ty}px)`;
    this.svg.setAttribute('width', SIZE * scale);
    this.svg.setAttribute('height', SIZE * scale);
    this.aimap.style.display = sc.bare ? 'none' : '';
    this.mask.style.display = sc.bare ? 'none' : '';
    if (sc.bare) {
      for (const g of [this.gAoi, this.gRail, this.gPaint, this.gBoxes, this.gCursor]) g.innerHTML = '';
      return;
    }
    // observation area: dim outside, dashed outline
    this.gAoi.innerHTML = '';
    if (sc.aoi && sc.showAoi) {
      const pts = sc.aoi.map(p => p.join(',')).join(' ');
      el('path', { d: `M0,0H${SIZE}V${SIZE}H0Z M${sc.aoi.map(p => p.join(',')).join(' L')} Z`, fill: 'rgba(0,0,0,0.42)', 'fill-rule': 'evenodd' }, this.gAoi);
      el('polygon', { points: pts, fill: 'none', stroke: '#FFD43B', 'stroke-width': 2, 'stroke-dasharray': '6 4', 'vector-effect': 'non-scaling-stroke' }, this.gAoi);
    }
    this.gRail.innerHTML = '';
    if (sc.showRail) {
      for (const line of sc.rail) {
        el('polyline', { points: line.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#FF922B', 'stroke-width': 2, 'stroke-dasharray': '10 5', 'vector-effect': 'non-scaling-stroke', opacity: 0.9 }, this.gRail);
      }
    }
    this._renderAiMap();
    this._renderPaint();
    this.gBoxes.innerHTML = '';
    const fs = 12 / scale;
    const placed = [];   // 已放的编号标签，叠在一起的往右错开
    for (const layer of Object.values(sc.layers)) {
      if (layer.viewer != null && layer.viewer !== this.index) continue;
      for (const b0 of layer.boxes) {
        const b = normBox(b0);
        const w = b.x1 - b.x0, h = b.y1 - b.y0;
        const sel = layer.editable && sc.selected === b0.id;
        const target = layer.style === 'target' && sc.paint?.current === b0.id;
        if (layer.style === 'quality') {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: `url(#hatch${this.id})`, stroke: '#F1F3F5', 'stroke-width': sel ? 2.5 : 1.5, 'stroke-dasharray': '5 3', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else if (layer.style === 'qline') {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'none', stroke: 'rgba(241,243,245,.75)', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else if (layer.style === 'ai') {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'rgba(34,211,238,0.10)', stroke: 'rgba(0,0,0,.55)', 'stroke-width': 4, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'none', stroke: '#22D3EE', 'stroke-width': 2, 'stroke-dasharray': '7 4', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else if (layer.style === 'ghost') {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'rgba(120,120,120,0.10)', stroke: 'rgba(210,214,220,.85)', 'stroke-width': 1.6, 'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          el('line', { x1: b.x0, y1: b.y0, x2: b.x1, y2: b.y1, stroke: 'rgba(210,214,220,.7)', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else if (layer.style === 'target') {
          if (target) el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'none', stroke: 'rgba(0,0,0,.55)', 'stroke-width': 4.5, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: 'none', stroke: target ? '#fff' : 'rgba(255,255,255,.6)', 'stroke-width': target ? 2 : 1.3, 'stroke-dasharray': target ? '8 4' : '4 4', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: sel ? 'rgba(255,77,79,0.14)' : 'rgba(255,77,79,0.06)', stroke: '#FF4D4F', 'stroke-width': sel ? 3 : 2, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        }
        if (layer.labels === false) continue;
        const lab = String(b0.label ?? b0.id);
        const lw = (lab.length * 7 + 8) / scale, lh = 16 / scale;
        let lx = b.x0;
        for (let k = 0; k < 8 && placed.some(p => lx < p[0] + p[2] && lx + lw > p[0] && b.y0 - lh < p[1] + lh && b.y0 > p[1]); k++) lx += lw + 2 / scale;
        placed.push([lx, b.y0 - lh, lw]);
        const labFill = layer.style === 'quality' ? '#495057' : layer.style === 'target' ? (target ? '#2f6db5' : 'rgba(31,38,51,.8)')
          : layer.style === 'ai' ? '#0e7490' : layer.style === 'ghost' ? '#6b7280' : '#FF4D4F';
        el('rect', { x: lx, y: b.y0 - lh, width: lw, height: lh, rx: 2 / scale, fill: labFill }, this.gBoxes);
        const t = el('text', { x: lx + 4 / scale, y: b.y0 - 4 / scale, 'font-size': fs, fill: '#fff', 'font-family': 'Arial, sans-serif', 'font-weight': 'bold' }, this.gBoxes);
        t.textContent = lab;
        if (sel) {
          const cx = b.x1 + 10 / scale, cy = b.y0 - 10 / scale;
          el('circle', { cx, cy, r: 8 / scale, fill: '#FF4D4F', stroke: '#fff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          const x = el('text', { x: cx, y: cy + 4 / scale, 'font-size': 13 / scale, fill: '#fff', 'text-anchor': 'middle', 'font-family': 'Arial, sans-serif', 'font-weight': 'bold' }, this.gBoxes);
          x.textContent = '×';
          const hs = 6 / scale;
          const xs = [b.x0, (b.x0 + b.x1) / 2, b.x1], ys = [b.y0, (b.y0 + b.y1) / 2, b.y1];
          for (const hx of xs) for (const hy of ys) {
            if (hx === xs[1] && hy === ys[1]) continue;
            el('rect', { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#FF4D4F', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          }
        }
      }
    }
    this.renderCursor();
  }

  // AI 变化图：青色 = AI 认为变化，淡黄 = 拿不准（云、薄雾、反光水面等）。只在变化图、开关或窗口改变时重画。
  _renderAiMap() {
    const sc = this.scene, M = sc.aiMap;
    const on = !!(M && M.show && (M.viewer == null || M.viewer === this.index));
    const key = on ? `${sc.aiMapVersion}` : '';
    if (key === this._aiKey) return;
    this._aiKey = key;
    const ctx = this.aimap.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (!on) return;
    const img = ctx.createImageData(SIZE, SIZE);
    // highlight：漏标提醒框 [x0, y0, x1, y1]，框里的变化像元用品红突出；fadeOthers：其余变化像元调淡（复核台用；第三步保持原样）
    const HL = M.highlight || [];
    const inHL = n => { const x = (n % SIZE) + 0.5, y = Math.floor(n / SIZE) + 0.5; return HL.some(h => x >= h[0] && x <= h[2] && y >= h[1] && y <= h[3]); };
    const plain = M.fadeOthers ? [0, 229, 255, 70] : [0, 229, 255, 120];
    for (let n = 0; n < SIZE * SIZE; n++) {
      const v = M.cells[n];
      if (v === 1) img.data.set(HL.length && inHL(n) ? [255, 43, 214, 215] : plain, n * 4);
      else if (v === 2 && M.showUnsure !== false) img.data.set([255, 214, 102, 55], n * 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  // Painted cells (canvas, one canvas pixel per cell), their outlines and the cell grid of the current box.
  // Rebuilt only when the paint, the current box, the toggles or the grid visibility change.
  _renderPaint() {
    const sc = this.scene, P = sc.paint;
    const gridOn = !!(P && P.grid && sc.view.scale >= GRID_MIN_SCALE);
    const key = P ? `${sc.paintVersion}|${P.current}|${P.show}|${gridOn}` : '';
    if (key === this._paintKey) return;
    this._paintKey = key;
    const ctx = this.mask.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    this.gPaint.innerHTML = '';
    if (!P) return;
    if (P.show) {
      const img = ctx.createImageData(SIZE, SIZE);
      for (const bx of P.boxes) {
        for (let j = 0; j < bx.h; j++) for (let i = 0; i < bx.w; i++) {
          const v = bx.cells[j * bx.w + i];
          if (v) img.data.set(PAINT_RGBA[v], ((bx.r0 + j) * SIZE + bx.c0 + i) * 4);
        }
      }
      ctx.putImageData(img, 0, 0);
      for (const bx of P.boxes) for (const v of [1, 2]) {
        const d = outlinePath(bx, v);
        if (!d) continue;
        el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,.6)', 'stroke-width': 3.5, 'stroke-linecap': 'square', 'vector-effect': 'non-scaling-stroke' }, this.gPaint);
        el('path', { d, fill: 'none', stroke: PAINT_LINE[v], 'stroke-width': 1.6, 'stroke-linecap': 'square', 'vector-effect': 'non-scaling-stroke' }, this.gPaint);
      }
    }
    const bx = sc.paintBox();
    if (bx && gridOn) {
      let d = '';
      for (let x = bx.c0; x <= bx.c0 + bx.w; x++) d += `M${x},${bx.r0}v${bx.h}`;
      for (let y = bx.r0; y <= bx.r0 + bx.h; y++) d += `M${bx.c0},${y}h${bx.w}`;
      el('path', { d, fill: 'none', stroke: 'rgba(255,255,255,.28)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }, this.gPaint);
    }
  }

  // Where the pointer is: the brush square while painting, a small cross in the other viewers otherwise.
  renderCursor() {
    const sc = this.scene, p = sc.hover;
    this.gCursor.innerHTML = '';
    if (sc.bare) return;
    if (!p) return;
    const s = sc.view.scale;
    const bx = sc.mode === 'paint' && sc.paint?.editable && !sc._spaceDown ? sc.paintBox() : null;
    if (bx && sc.inBox(bx, p.x, p.y)) {
      const o = sc.brushOrigin(p.x, p.y);
      const fill = sc.paint.brush === 1 ? 'rgba(255,64,64,.35)' : sc.paint.brush === 2 ? 'rgba(255,196,0,.35)' : 'rgba(255,255,255,.2)';
      el('rect', { x: o.c, y: o.r, width: o.s, height: o.s, fill, stroke: 'rgba(0,0,0,.6)', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' }, this.gCursor);
      el('rect', { x: o.c, y: o.r, width: o.s, height: o.s, fill: 'none', stroke: '#fff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, this.gCursor);
      return;
    }
    if (sc.viewers.length < 2 || this.box.matches(':hover')) return;
    const r = 7 / s;
    const d = `M${p.x - r},${p.y}h${2 * r}M${p.x},${p.y - r}v${2 * r}`;
    el('path', { d, stroke: 'rgba(0,0,0,.7)', 'stroke-width': 3.5, 'vector-effect': 'non-scaling-stroke' }, this.gCursor);
    el('path', { d, stroke: '#fff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, this.gCursor);
  }
}
