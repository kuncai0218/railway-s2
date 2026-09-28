// Synced image viewers: wheel zoom, drag to pan, and an editable box layer drawn in original-pixel coordinates.
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
    this.mode = 'pan';         // 'pan' | 'draw'
    this.aoi = null;           // ring [[x, y], ...] in pixels
    this.rail = [];            // polylines in pixels
    this.showAoi = true;
    this.showRail = true;
    this.onChange = () => {};
    this.onSelect = () => {};
    this.onMode = () => {};
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
  focusBox(b) {
    const v = this.viewers[0];
    if (!v) return;
    const r = v.box.getBoundingClientRect();
    const w = Math.max(b.x1 - b.x0, 8), h = Math.max(b.y1 - b.y0, 8);
    const s = Math.min(r.width / (w * 3), r.height / (h * 3), this.fitScale() * 12);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    this.setView(s, r.width / 2 - cx * s, r.height / 2 - cy * s);
  }

  render() { this.viewers.forEach(v => v.render()); }

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
    this.svg = el('svg', { class: 'viewer-svg', viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
    const defs = el('defs', {}, this.svg);
    const pat = el('pattern', { id: `hatch${this.id}`, width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 4, height: 4, fill: 'rgba(20,24,32,0.35)' }, pat);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: 'rgba(255,255,255,0.75)', 'stroke-width': 1.2 }, pat);
    this.gAoi = el('g', {}, this.svg);
    this.gRail = el('g', {}, this.svg);
    this.gBoxes = el('g', {}, this.svg);
    this.stage.appendChild(this.svg);
    box.appendChild(this.stage);
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
    if (sc._spaceDown) c = 'grab';
    if (this.drag?.type === 'pan') c = 'grabbing';
    if (p && !sc._spaceDown) {
      const h = this.hit(p);
      if (h) c = h.handle ? ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' })[h.handle] : 'move';
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
    box.addEventListener('dblclick', ev => { if (!this.hit(this.toImage(ev))) this.scene.fit(); });
    box.addEventListener('contextmenu', ev => ev.preventDefault());
    box.addEventListener('pointerdown', ev => {
      const sc = this.scene;
      const p = this.toImage(ev);
      box.setPointerCapture(ev.pointerId);
      const panWanted = ev.button === 1 || ev.button === 2 || sc._spaceDown;
      const h = panWanted ? null : this.hit(p);
      const layer = sc.editableLayer();
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
      if (!d) { this.updateCursor(p); return; }
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
    this.gBoxes.innerHTML = '';
    const fs = 12 / scale;
    for (const layer of Object.values(sc.layers)) {
      if (layer.viewer != null && layer.viewer !== this.index) continue;
      for (const b0 of layer.boxes) {
        const b = normBox(b0);
        const w = b.x1 - b.x0, h = b.y1 - b.y0;
        const sel = layer.editable && sc.selected === b0.id;
        if (layer.style === 'quality') {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: `url(#hatch${this.id})`, stroke: '#F1F3F5', 'stroke-width': sel ? 2.5 : 1.5, 'stroke-dasharray': '5 3', 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        } else {
          el('rect', { x: b.x0, y: b.y0, width: w, height: h, fill: sel ? 'rgba(255,77,79,0.14)' : 'rgba(255,77,79,0.06)', stroke: '#FF4D4F', 'stroke-width': sel ? 3 : 2, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
        }
        if (layer.labels === false) continue;
        const lab = String(b0.id);
        const lw = (lab.length * 7 + 8) / scale, lh = 16 / scale;
        el('rect', { x: b.x0, y: b.y0 - lh, width: lw, height: lh, rx: 2 / scale, fill: layer.style === 'quality' ? '#495057' : '#FF4D4F' }, this.gBoxes);
        const t = el('text', { x: b.x0 + 4 / scale, y: b.y0 - 4 / scale, 'font-size': fs, fill: '#fff', 'font-family': 'Arial, sans-serif', 'font-weight': 'bold' }, this.gBoxes);
        t.textContent = lab;
        if (sel) {
          const hs = 6 / scale;
          const xs = [b.x0, (b.x0 + b.x1) / 2, b.x1], ys = [b.y0, (b.y0 + b.y1) / 2, b.y1];
          for (const hx of xs) for (const hy of ys) {
            if (hx === xs[1] && hy === ys[1]) continue;
            el('rect', { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#FF4D4F', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, this.gBoxes);
          }
        }
      }
    }
  }
}
