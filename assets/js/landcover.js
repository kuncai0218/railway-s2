// 地物精标台（2026-10-06）：逐期标 5 类地物（水体、植被、耕地、裸露、建成）+ 看不清，AI 预标打底，人工逐期改、存，组长复核。
// 左：期次队列（测点、筛选、进度）；中：同一期两张同步缩放的图（左只看影像，右叠标注，两边都能涂）；右：这一期的统计、保存、复核、AI 说明。
// 一期的标注从哪来（先找到的为准）：这台电脑上没保存的草稿（IndexedDB）→ 数据库 landcover 表里这一期最新的标注 → AI 预标（prefill_lc/）。
// 保存：正式模式写 landcover 表（kind = label；组长复核 kind = review）；演示模式只存在这台电脑。数据库里还没有 landcover 表时只能用演示模式。
// 存的格式：data = { v: 'lc1', enc: 'gz' | 'raw', map: base64, meta }；map 解开是 65536 个字节，一个字节一格（行优先）：
//   低 3 位 = 类别（0—4，7 = 看不清），bit3 = 拿不准，bit4 = 人动过，bit5 = 待看，bit6 = 云影遮挡，bit7 = 整期质量自动屏蔽（低3位仍为7，旧解码器仍读255）。
//   整期质量写 meta.quality；旧记录没有此字段时保持未评定。草稿按 demo/live 分开。
import { append, uuid, clientId } from './api.js';
import { SUPABASE_URL, SUPABASE_KEY, APP_VERSION, SITE_ORDER } from './config.js';
import { loadSites, loadPeriods, loadReadings, latestByScene, fmtDate, fmtTime } from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtN = n => Number(n || 0).toLocaleString('zh-CN');
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');

const SIZE = 256, N = SIZE * SIZE, NONE = 255, UNSURE = 100, SHADOW = 101;
const QUALITY = { yes: '清楚', blurry: '整体模糊，但还能认出地物', partial: '局部看不清，其余能标', no: '基本看不清，整期不可判' };
const REASONS = { cloud: '云', cloud_shadow: '云影', haze: '雾 / 霾', terrain_shadow: '山影 / 阴影', missing: '黑块 / 缺测', stripe: '条纹', brightness: '太亮 / 太暗', blur: '模糊' };
const SITE_NAME = { ZZ: '株洲南', HY: '衡阳北', SG: '韶关南' };
const CLS = [
  { v: 0, name: '水体', rgb: [40, 110, 220], key: '1' },
  { v: 1, name: '植被', rgb: [40, 150, 60], key: '2' },
  { v: 2, name: '耕地', rgb: [230, 200, 60], key: '3' },
  { v: 3, name: '裸露', rgb: [190, 120, 70], key: '4' },
  { v: 4, name: '建成', rgb: [220, 40, 40], key: '5' },
  { v: NONE, name: '看不清', rgb: [150, 156, 168], key: '6' },
];
const RGB = {}; for (const c of CLS) RGB[c.v] = c.rgb;
const TABLE = 'landcover';
const MODE_KEY = 'rs2_lc_mode', SITE_KEY = 'rs2_lc_site', FILTER_KEY = 'rs2_lc_filter', NAME_KEY = 'rs2_lc_name';
const FILL_ALPHA = [118, 58, 0];   // 涂色：浓 / 淡 / 只描边
const FILL_NAME = ['涂色：浓', '涂色：淡', '只描边'];
const GRID_MIN_SCALE = 6;

let mode = 'demo', site = 'ZZ', filter = 'anchor', who = '';
try {
  mode = localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'demo';
  site = localStorage.getItem(SITE_KEY) || 'ZZ';
  filter = localStorage.getItem(FILTER_KEY) || 'anchor';
  who = localStorage.getItem(NAME_KEY) || '';
} catch { /* storage blocked */ }
if (!SITE_ORDER.includes(site)) site = 'ZZ';

let sites = null, AIX = null, QAI = null;
const P = {};
let liveRows = [], demoRows = [], tableReady = null;
let LAT = {};                      // 'code|scene_id' → { label, review }
const drafts = new Set();          // 'code|scene_id'：这台电脑上有没保存的修改
const dataCache = {};              // 记录 id → data（含 map）
let W = null;                      // 当前这一期的工作副本
let openSeq = 0;
let switching = false;
const changeQualities = new Map(); // 原变化判读的人工第一步，只读；与地物质量分别保存
async function loadChangeQuality(code, refresh = false) {
  const prior = changeQualities.get(code);
  if (prior?.loading) return prior.loading;
  if (prior && !refresh) return prior;
  const state = { latest: prior?.latest || {}, online: prior?.online, loading: null };
  changeQualities.set(code, state);
  state.loading = (async () => {
    try {
      const result = await loadReadings(code);
      state.latest = latestByScene(result.rows);
      state.online = result.online;
    } catch { state.online = false; }
    finally { state.loading = null; }
    return state;
  })();
  return state.loading;
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
function err(msg) { $('err').textContent = msg || ''; }

// ---------------------------------------------------------------- 本机存储（IndexedDB；不能用时退回内存，只在这次打开有效）
const mem = new Map();
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise(res => {
    try {
      const r = indexedDB.open('rs2_landcover', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  });
  return dbp;
}
async function kvGet(k) {
  const db = await idb();
  if (!db) return mem.get(k);
  return new Promise(res => {
    try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); } catch { res(mem.get(k)); }
  });
}
async function kvSet(k, v) {
  const db = await idb();
  if (!db) { mem.set(k, v); return true; }
  return new Promise(res => {
    try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); } catch { mem.set(k, v); res(true); }
  });
}
async function kvDel(k) {
  const db = await idb();
  if (!db) { mem.delete(k); return; }
  return new Promise(res => {
    try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => res(); } catch { mem.delete(k); res(); }
  });
}
async function kvKeys() {
  const db = await idb();
  if (!db) return [...mem.keys()];
  return new Promise(res => {
    try { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch { res([]); }
  });
}

// ---------------------------------------------------------------- 压缩和编码
async function gz(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunz(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) { const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
function packMap(w) {
  const a = new Uint8Array(N);
  for (let i = 0; i < N; i++) a[i] = (w.quality?.status === 'no' || w.shadow?.[i] || w.whole?.[i] || w.lab[i] === NONE ? 7 : w.lab[i]) | (w.uns[i] << 3) | (w.tch[i] << 4) | ((w.todo[i] && !w.tch[i] ? 1 : 0) << 5) | ((w.shadow?.[i] ? 1 : 0) << 6) | ((w.whole?.[i] ? 1 : 0) << 7);
  return a;
}
function unpackMap(a) {
  if (a.length !== N) throw new Error('标注格数不对，应为256×256');
  const lab = new Uint8Array(N), uns = new Uint8Array(N), tch = new Uint8Array(N), todo = new Uint8Array(N), shadow = new Uint8Array(N), whole = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = a[i] & 7;
    if (v === 5 || v === 6) throw new Error('标注含不支持的地物类别');
    shadow[i] = (a[i] >> 6) & 1;
    whole[i] = (a[i] >> 7) & 1;
    lab[i] = v === 7 || shadow[i] || whole[i] ? NONE : v;
    uns[i] = (a[i] >> 3) & 1; tch[i] = (a[i] >> 4) & 1; todo[i] = (a[i] >> 5) & 1;
  }
  return { lab, uns, tch, todo, shadow, whole, quality: null };
}
async function encodeMap(w) {
  const raw = packMap(w);
  const z = await gz(raw).catch(() => null);
  return z ? { enc: 'gz', map: b64(z) } : { enc: 'raw', map: b64(raw) };
}
async function decodeMap(d) {
  if (!d || d.v !== 'lc1' || !['gz', 'raw'].includes(d.enc) || typeof d.map !== 'string') throw new Error('不是支持的lc1标注文件');
  const bytes = unb64(d.map);
  const w = unpackMap(d.enc === 'gz' ? await gunz(bytes) : bytes);
  w.quality = normaliseQuality(d.meta?.quality);
  w.legacyWhole = !!d.meta?.legacy_whole;
  migrateWholeMask(w, d.meta?.whole_mask_v);
  return w;
}

function migrateWholeMask(w, version) {
  // 兼容本轮未发布的早期整期no格式：全图255+tch没有逐格自动屏蔽位。
  // 这类记录只有云影范围可追溯；普通255的原人工范围需重评时重新核对。
  if (w.quality?.status === 'no' && !version && !w.whole.some(Boolean) && w.lab.every(v => v === NONE) && w.tch.every(Boolean)) {
    for (let i = 0; i < N; i++) if (!w.shadow[i]) { w.whole[i] = 1; w.tch[i] = 0; }
    w.legacyWhole = true;
  }
}

function normaliseQuality(q) {
  if (!q || !Object.hasOwn(QUALITY, q.status)) return null;
  const out = { status: q.status, reasons: [...new Set((Array.isArray(q.reasons) ? q.reasons : []).filter(r => Object.hasOwn(REASONS, r)))], note: String(q.note || '').slice(0, 500), by: q.by || null, reviewed_at: q.reviewed_at || null };
  if (q.suggestion && Object.hasOwn(QUALITY, q.suggestion.status)) {
    out.suggestion = { version: String(q.suggestion.version || '').slice(0, 120), source: ['full_frame', 'change_quality'].includes(q.suggestion.source) ? q.suggestion.source : 'prefill_fallback', status: q.suggestion.status };
    if (out.suggestion.source === 'change_quality') {
      out.suggestion.reading_id = String(q.suggestion.reading_id || '').slice(0, 100);
      out.suggestion.scope = q.suggestion.scope === 'aoi' ? 'aoi' : 'full_frame';
    }
  }
  return out;
}
function qualityReady(w = W) { return !switching && !!w?.quality && !w.qEditing && (!w.mode || w.mode === mode); }
function requireQuality() {
  if (qualityReady()) return true;
  err('先看整幅影像，确认这一期的质量，再开始标注或保存。');
  $('qualitySec').scrollIntoView({ block: 'nearest' }); $('qualityStatus').focus();
  return false;
}
function draftKey(key, m = mode) { return `draft|${m}|${key}`; }
async function loadDraftKeys() {
  drafts.clear();
  const m = mode, prefix = `draft|${m}|`;
  for (const k of await kvKeys()) {
    if (typeof k !== 'string') continue;
    if (k.startsWith(prefix)) drafts.add(k.slice(prefix.length));
    else if (m === 'demo' && /^draft\|(ZZ|HY|SG)\|/.test(k)) drafts.add(k.slice(6)); // 无模式旧草稿只在演示里恢复
  }
}
function trainingMask(w) {
  const a = new Uint8Array(N).fill(NONE);
  if (!qualityReady(w) || w.quality.status === 'no') return a;
  for (let i = 0; i < N; i++) if (!w.shadow[i] && !w.uns[i] && !(w.todo[i] && !w.tch[i]) && w.lab[i] <= 4) a[i] = w.lab[i];
  return a;
}

// ---------------------------------------------------------------- 数据库（只读；保存时追加）
const H = { apikey: SUPABASE_KEY };
const META_SELECT = 'id,created_at,site,scene_id,kind,client_id,meta:data->meta';
async function dbList() {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const qs = new URLSearchParams({ select: META_SELECT, order: 'created_at.asc', limit: '1000', offset: String(off) });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?${qs}`, { headers: H });
    if (!r.ok) {
      const e = new Error(`读取失败（${r.status}）`);
      e.status = r.status; e.text = await r.text().catch(() => '');
      throw e;
    }
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function dbData(id) {
  const qs = new URLSearchParams({ select: 'data', id: `eq.${id}` });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?${qs}`, { headers: H });
  if (!r.ok) throw new Error(`读取失败（${r.status}）`);
  const rows = await r.json();
  return rows[0]?.data || null;
}
async function pullRows() {
  try {
    const rows = await dbList();
    const fresh = liveRows.filter(r => r._fresh && !rows.some(x => x.id === r.id));   // 刚存、服务器还没返回的
    liveRows = [...rows, ...fresh];
    tableReady = true;
  } catch (e) {
    if (e.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(e.text || '')) { tableReady = false; liveRows = []; }
    else throw e;
  }
}
async function labelData(row) {
  if (!row) return null;
  if (row.data) return row.data;
  if (dataCache[row.id]) return dataCache[row.id];
  const d = await dbData(row.id);
  if (d) dataCache[row.id] = d;
  return d;
}
const rowsNow = () => (mode === 'demo' ? [...liveRows, ...demoRows] : liveRows);
function recompute() {
  LAT = {};
  const rs = rowsNow().slice().sort((a, b) => (!!a._demo - !!b._demo) || (!!a._fresh - !!b._fresh) || String(a.created_at).localeCompare(String(b.created_at)));
  for (const r of rs) {
    const key = `${r.site}|${r.scene_id}`;
    const s = LAT[key] || (LAT[key] = { label: null, review: null });
    if (r.kind === 'label') { s.label = r; s.review = null; }
    else if (r.kind === 'review' && s.label && r.meta?.label_id === s.label.id) s.review = r;
  }
}
function stateOf(code, p) {
  const key = `${code}|${p.scene_id}`;
  if (drafts.has(key)) return 'draft';
  const s = LAT[key];
  if (!s?.label) return 'todo';
  const d = s.review?.meta?.decision;
  return d === 'confirmed' ? 'ok' : d === 'returned' ? 'back' : 'saved';
}
const ST_TEXT = { todo: '○', draft: '✎', saved: '●', back: '↩', ok: '✓' };
const ST_TITLE = { todo: '还没标', draft: '这台电脑上改过、还没保存', saved: '已保存，等组长看', back: '组长退回', ok: '组长通过' };

// ---------------------------------------------------------------- AI 预标（prefill_lc/）和变化检测 AI 精标（prefill/）
function loadPixels(url) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      res(ctx.getImageData(0, 0, SIZE, SIZE).data);
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}
const aiCache = new Map();
function aiOf(code, date) {
  const key = `${code}|${date}`;
  if (aiCache.has(key)) { const v = aiCache.get(key); aiCache.delete(key); aiCache.set(key, v); return v; }
  const pr = (async () => {
    if (!AIX?.[code]?.dates?.includes(date)) return null;
    const v = encodeURIComponent(AIX.version || '');
    const ocInfo = AIX.occlusion;
    const ocUrl = ocInfo?.encoding === 'R=20+40*id' && ocInfo.suffix === '_oc.png' ? `prefill_lc/${code}/${date}${ocInfo.suffix}?v=${v}` : null;
    const [a, b, o] = await Promise.all([loadPixels(`prefill_lc/${code}/${date}_lc.png?v=${v}`), loadPixels(`prefill_lc/${code}/${date}_sp.png?v=${v}`), ocUrl ? loadPixels(ocUrl) : null]);
    if (!a) return null;
    // 分档编码（见 landcover_fine_20261006/脚本/lc_web.py），读图时差几个色阶也不影响
    const cls = new Uint8Array(N), conf = new Uint8Array(N), unc = new Uint8Array(N), shadow = new Uint8Array(N);
    let occlusion = o ? new Uint8Array(N) : null;
    if (o) for (let i = 0; i < N; i++) {
      const id = Math.round((o[i * 4] - 20) / 40);
      if (id < 0 || id > 4 || Math.abs(o[i * 4] - (20 + 40 * id)) > 8) { occlusion = null; break; }
      occlusion[i] = id;
    }
    for (let i = 0; i < N; i++) {
      const r = a[i * 4];
      cls[i] = r >= 230 ? NONE : Math.min(4, Math.floor(r / 40));
      conf[i] = Math.min(4, Math.floor(a[i * 4 + 1] / 50)) * 25;
      unc[i] = a[i * 4 + 2] > 127 ? 1 : 0;
      if (occlusion) {
        shadow[i] = occlusion[i] === 3 ? 1 : 0;
        if (hardOcclusion(occlusion[i])) { cls[i] = NONE; unc[i] = 0; conf[i] = 0; }
      }
    }
    let sp = null;
    if (b) { sp = new Uint16Array(N); for (let i = 0; i < N; i++) sp[i] = (b[i * 4] >> 4) * 256 + (b[i * 4 + 1] >> 4) * 16 + (b[i * 4 + 2] >> 4); }
    return { cls, conf, unc, sp, occlusion, shadow, occlusionMissing: !!ocUrl && !occlusion };
  })();
  aiCache.set(key, pr);
  while (aiCache.size > 24) aiCache.delete(aiCache.keys().next().value);
  return pr;
}
const hardOcclusion = id => id === 1 || id === 3 || id === 4;
let cdIndex = null;
async function cdMap(code, date) {
  cdIndex = cdIndex || fetch('prefill/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  const info = (await cdIndex)?.[code];
  if (!info || !(info.dates || []).includes(date)) return null;
  const d = await loadPixels(`prefill/${code}/${date}.png?v=${encodeURIComponent(info.version || '')}`);
  if (!d) return null;
  const m = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const v = d[i * 4]; m[i] = v < 50 ? 0 : v < 150 ? 1 : 2; }
  return m;
}
// 超像素索引：编号 k 的像元 = list[start[k] .. start[k+1])
function spIndex(sp) {
  let max = 0;
  for (let i = 0; i < N; i++) if (sp[i] > max) max = sp[i];
  const start = new Int32Array(max + 2);
  for (let i = 0; i < N; i++) start[sp[i] + 1]++;
  for (let k = 1; k < start.length; k++) start[k] += start[k - 1];
  const list = new Int32Array(N), fill = start.slice(0, max + 1);
  for (let i = 0; i < N; i++) list[fill[sp[i]]++] = i;
  return { start, list };
}
const spPixels = (w, id) => w.spx.list.subarray(w.spx.start[id], w.spx.start[id + 1]);

// ---------------------------------------------------------------- 画布
class Scene {
  constructor() {
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.viewers = [];
    this.ver = 0; this.detVer = 0;
    this.tool = 'sp'; this.brush = 1; this.size = 1;
    this.showLab = true; this.fill = 0; this.onlyTodo = false; this.aiLeft = false; this.showRail = true; this.grid = true; this.bare = false;
    this.rail = [];
    this.hover = null; this.spaceDown = false; this.lasso = null; this.flash = null; this.jumpAt = -1;
    window.addEventListener('keydown', e => this._space(e, true));
    window.addEventListener('keyup', e => this._space(e, false));
    window.addEventListener('resize', () => this.render());
  }
  _space(e, down) {
    if (e.code !== 'Space' || typing()) return;
    this.spaceDown = down;
    if (down) e.preventDefault();
    this.viewers.forEach(v => v.updateCursor());
  }
  add(box, labels) { const v = new Viewer(this, box, labels); this.viewers.push(v); return v; }
  main() { return this.viewers.find(v => v.box.clientWidth > 0 && v.box.clientHeight > 0) || this.viewers[0]; }   // 算缩放用看得见的那个窗口
  fitScale() { const r = this.main()?.box.getBoundingClientRect(); return r ? Math.max(0.1, Math.min(r.width, r.height) / SIZE) : 1; }
  fit() {
    const v = this.main();
    if (!v) return;
    const r = v.box.getBoundingClientRect(), s = this.fitScale();
    this.setView(s, (r.width - SIZE * s) / 2, (r.height - SIZE * s) / 2);
  }
  setView(scale, tx, ty) {
    const v = this.main();
    if (v) {
      const r = v.box.getBoundingClientRect(), fs = this.fitScale();
      scale = clamp(scale, fs * 0.8, fs * 30);
      tx = clamp(tx, -SIZE * scale + r.width * 0.3, r.width * 0.7);
      ty = clamp(ty, -SIZE * scale + r.height * 0.3, r.height * 0.7);
    }
    this.view = { scale, tx, ty };
    if (this.hover) this.hover = { ...this.hover, x: (this.hover.mx - tx) / scale, y: (this.hover.my - ty) / scale };
    this.render();
  }
  zoomAt(f, mx, my) { const { scale, tx, ty } = this.view, ns = scale * f; this.setView(ns, mx - (mx - tx) * (ns / scale), my - (my - ty) * (ns / scale)); }
  focusRect(c0, r0, c1, r1) {
    const v = this.main();
    if (!v) return;
    const r = v.box.getBoundingClientRect();
    const w = Math.max(c1 - c0, 20), h = Math.max(r1 - r0, 20);
    const s = Math.min(r.width / (w * 1.8), r.height / (h * 1.8));
    this.setView(s, r.width / 2 - ((c0 + c1) / 2) * s, r.height / 2 - ((r0 + r1) / 2) * s);
  }
  render() { this.viewers.forEach(v => v.render()); }
  changed(light = false) { this.ver++; if (!light) this.detVer++; this.render(); }
  setHover(p) { this.hover = p; this.viewers.forEach(v => v.renderCursor()); }
}

class Viewer {
  constructor(scene, box, labels) {
    this.scene = scene; this.box = box; this.labels = labels; this.index = scene.viewers.length;
    box.classList.add('viewer'); box.innerHTML = '';
    this.stage = document.createElement('div'); this.stage.className = 'viewer-stage';
    this.img = document.createElement('img'); this.img.className = 'viewer-img'; this.img.draggable = false; this.img.alt = '';
    this.lab = document.createElement('canvas'); this.lab.className = 'viewer-mask'; this.lab.width = this.lab.height = SIZE;
    this.det = document.createElement('canvas'); this.det.className = 'viewer-mask lc-det'; this.det.width = this.det.height = SIZE * 4;
    this.stage.append(this.img, this.lab, this.det);
    const NS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(NS, 'svg'); this.svg.setAttribute('class', 'viewer-svg'); this.svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
    this.gGrid = document.createElementNS(NS, 'g'); this.gRail = document.createElementNS(NS, 'g'); this.gFlash = document.createElementNS(NS, 'g');
    this.gCursor = document.createElementNS(NS, 'g'); this.gCursor.setAttribute('pointer-events', 'none');
    this.svg.append(this.gGrid, this.gRail, this.gFlash, this.gCursor);
    this.tag = document.createElement('div'); this.tag.className = 'viewer-tag';
    this.hoverTip = document.createElement('div'); this.hoverTip.className = 'lc-hover'; this.hoverTip.hidden = true;
    this.hoverTitle = document.createElement('strong'); this.hoverTitle.className = 'lc-hover-title';
    this.hoverNote = document.createElement('span'); this.hoverNote.className = 'lc-hover-note';
    this.hoverTip.append(this.hoverTitle, this.hoverNote);
    box.append(this.stage, this.svg, this.tag, this.hoverTip);
    this._labKey = ''; this._detKey = ''; this._svgKey = '';
    this.drag = null;
    this._bind();
  }
  setImage(src, label) { if (this.img.getAttribute('src') !== src) this.img.src = src; this.tag.textContent = label; }
  toImage(ev) {
    const r = this.box.getBoundingClientRect(), { scale, tx, ty } = this.scene.view;
    return { x: (ev.clientX - r.left - tx) / scale, y: (ev.clientY - r.top - ty) / scale, mx: ev.clientX - r.left, my: ev.clientY - r.top, viewer: this.index };
  }
  updateCursor(p) {
    const sc = this.scene;
    let c = 'crosshair';
    if (sc.spaceDown || sc.bare || !W) c = 'grab';
    if (this.drag?.type === 'pan') c = 'grabbing';
    if (p && (p.x < 0 || p.y < 0 || p.x >= SIZE || p.y >= SIZE)) c = 'grab';
    this.box.style.cursor = c;
  }
  _bind() {
    const box = this.box, sc = this.scene;
    box.addEventListener('wheel', ev => { ev.preventDefault(); const p = this.toImage(ev); sc.zoomAt(ev.deltaY < 0 ? 1.18 : 1 / 1.18, p.mx, p.my); }, { passive: false });
    box.addEventListener('contextmenu', ev => ev.preventDefault());
    box.addEventListener('pointerleave', () => sc.setHover(null));
    box.addEventListener('pointerdown', ev => {
      const p = this.toImage(ev);
      try { box.setPointerCapture(ev.pointerId); } catch { /* 合成事件、个别浏览器不支持 */ }
      const inside = p.x >= 0 && p.y >= 0 && p.x < SIZE && p.y < SIZE;
      const pan = ev.button !== 0 || sc.spaceDown || sc.bare || !W || !inside;
      if (pan) { this.drag = { type: 'pan', start: p, view: { ...sc.view } }; this.updateCursor(p); return; }
      if (saving || !requireQuality()) return;
      if (W.quality.status === 'no' && ![NONE, SHADOW].includes(sc.brush)) { err('这一期已记为基本看不清。能判读时先修改质量判断，再标地物。'); return; }
      if (sc.tool === 'lasso') { this.drag = { type: 'lasso', pts: [[p.x, p.y]] }; sc.lasso = this.drag.pts; return; }
      ops.begin();
      if (sc.tool === 'flood') { ops.flood(p.x, p.y); ops.end(); this.drag = null; return; }
      ops.stroke(p.x, p.y, null);
      this.drag = { type: 'paint', last: p };
      sc.setHover(p);
    });
    box.addEventListener('pointermove', ev => {
      const p = this.toImage(ev), d = this.drag;
      if (!d) { this.updateCursor(p); sc.setHover(p); return; }
      if (d.type === 'pan') { sc.hover = p; sc.setView(d.view.scale, d.view.tx + (p.mx - d.start.mx), d.view.ty + (p.my - d.start.my)); return; }
      if (d.type === 'paint') { ops.stroke(p.x, p.y, d.last); d.last = p; sc.setHover(p); return; }
      if (d.type === 'lasso') {
        const l = d.pts[d.pts.length - 1];
        if (Math.hypot(p.x - l[0], p.y - l[1]) > 0.35) d.pts.push([clamp(p.x, 0, SIZE), clamp(p.y, 0, SIZE)]);
        sc.setHover(p);
      }
    });
    const end = ev => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.type === 'paint') ops.end();
      if (d.type === 'lasso') {
        sc.lasso = null;
        if (d.pts.length >= 3) { ops.begin(); ops.polygon(d.pts); ops.end(); } else sc.setHover(sc.hover);
      }
      this.updateCursor(this.toImage(ev));
      sc.setHover(box.matches(':hover') ? this.toImage(ev) : null);
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }
  render() {
    const sc = this.scene, { scale, tx, ty } = sc.view;
    this.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    this.svg.style.transform = `translate(${tx}px, ${ty}px)`;
    this.svg.setAttribute('width', SIZE * scale);
    this.svg.setAttribute('height', SIZE * scale);
    this.lab.style.display = this.det.style.display = sc.bare ? 'none' : '';
    this._renderLab();
    this._renderDet();
    this._renderSvg();
    this.renderCursor();
  }
  // 类别涂色：一格一个画布像元
  _renderLab() {
    const sc = this.scene, w = W;
    const show = !sc.bare && w && (this.labels ? sc.showLab : sc.aiLeft && !!w.ai);
    const key = show ? `${sc.ver}|${this.labels}|${sc.fill}|${sc.onlyTodo}|${sc.aiLeft}|${sc.showLab}` : '';
    if (key === this._labKey) return;
    this._labKey = key;
    const ctx = this.lab.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (!show) return;
    const img = ctx.createImageData(SIZE, SIZE), d = img.data;
    const src = this.labels ? w.lab : w.ai.cls;
    const a0 = this.labels ? FILL_ALPHA[sc.fill] : 120;
    if (a0) for (let i = 0; i < N; i++) {
      const c = this.labels && w.shadow[i] ? [113, 91, 151] : RGB[src[i]] || RGB[NONE];
      let a = a0;
      if (this.labels && sc.onlyTodo && !(w.todo[i] && !w.tch[i])) a = Math.round(a0 * 0.22);
      d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
  }
  // 细节层（每格 4×4）：类别边界、待看（黄斜线）、拿不准（白斜线）
  _renderDet() {
    const sc = this.scene, w = W;
    const show = !sc.bare && w && ((this.labels && sc.showLab) || (!this.labels && sc.aiLeft && !!w.ai));
    const key = show ? `${sc.detVer}|${this.labels}|${sc.fill}|${sc.aiLeft}|${sc.showLab}` : '';
    if (key === this._detKey) return;
    this._detKey = key;
    const ctx = this.det.getContext('2d'), S4 = SIZE * 4;
    ctx.clearRect(0, 0, S4, S4);
    if (!show) return;
    const img = ctx.createImageData(S4, S4), u = new Uint32Array(img.data.buffer);
    const col = (r, g, b, a) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    const src = this.labels ? w.lab : w.ai.cls;
    const outline = this.labels && sc.fill === 2;
    const EDGE = col(15, 18, 24, 170), YEL = col(255, 214, 0, 235), WHT = col(255, 255, 255, 225), VIO = col(196, 181, 253, 240);
    const CC = {}; for (const c of CLS) CC[c.v] = col(c.rgb[0], c.rgb[1], c.rgb[2], 255);
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, v = src[i], base = (y * 4) * S4 + x * 4;
      if (this.labels) {
        const todo = w.todo[i] && !w.tch[i] && v !== NONE, uns = w.uns[i], shadow = w.shadow[i];
        if (todo || uns || shadow) for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
          if (shadow && (sx + sy) % 4 === 0) u[base + sy * S4 + sx] = VIO;
          else if (todo && (sx + sy) % 4 === 0) u[base + sy * S4 + sx] = YEL;
          else if (uns && (sx - sy + 4) % 4 === 0) u[base + sy * S4 + sx] = WHT;
        }
      }
      const ec = outline ? CC[v] : EDGE;
      if (x < SIZE - 1 && src[i + 1] !== v) for (let sy = 0; sy < 4; sy++) u[base + sy * S4 + 3] = ec;
      if (x > 0 && src[i - 1] !== v && outline) for (let sy = 0; sy < 4; sy++) u[base + sy * S4] = ec;
      if (y < SIZE - 1 && src[i + SIZE] !== v) for (let sx = 0; sx < 4; sx++) u[base + 3 * S4 + sx] = ec;
      if (y > 0 && src[i - SIZE] !== v && outline) for (let sx = 0; sx < 4; sx++) u[base + sx] = ec;
    }
    ctx.putImageData(img, 0, 0);
  }
  // 铁路、格线、闪一下的待看片
  _renderSvg() {
    const sc = this.scene, s = sc.view.scale;
    const gridOn = sc.grid && !sc.bare && s >= GRID_MIN_SCALE;
    const r = this.box.getBoundingClientRect();
    const vis = gridOn ? [Math.max(0, Math.floor(-sc.view.tx / s)), Math.max(0, Math.floor(-sc.view.ty / s)), Math.min(SIZE, Math.ceil((r.width - sc.view.tx) / s)), Math.min(SIZE, Math.ceil((r.height - sc.view.ty) / s))] : null;
    const key = `${sc.showRail && !sc.bare}|${sc.rail.length}|${vis}|${sc.flash?.d.length || 0}|${sc.bare}`;
    if (key === this._svgKey) return;
    this._svgKey = key;
    const NS = 'http://www.w3.org/2000/svg';
    const path = (g, d, attrs) => { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); g.appendChild(e); };
    this.gGrid.innerHTML = ''; this.gRail.innerHTML = ''; this.gFlash.innerHTML = '';
    if (vis) {
      let d = '';
      for (let x = vis[0]; x <= vis[2]; x++) d += `M${x},${vis[1]}V${vis[3]}`;
      for (let y = vis[1]; y <= vis[3]; y++) d += `M${vis[0]},${y}H${vis[2]}`;
      path(this.gGrid, d, { fill: 'none', stroke: 'rgba(255,255,255,.22)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' });
    }
    if (sc.showRail && !sc.bare) for (const line of sc.rail) {
      path(this.gRail, `M${line.map(p => p.join(',')).join('L')}`, { fill: 'none', stroke: '#FF922B', 'stroke-width': 2, 'stroke-dasharray': '10 5', 'vector-effect': 'non-scaling-stroke', opacity: 0.85 });
    }
    if (sc.flash && !sc.bare) {
      path(this.gFlash, sc.flash.d, { fill: 'none', stroke: 'rgba(0,0,0,.7)', 'stroke-width': 4, 'vector-effect': 'non-scaling-stroke' });
      path(this.gFlash, sc.flash.d, { fill: 'none', stroke: '#FFD600', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
    }
  }
  // 指针：当前窗口画画笔方块、超像素轮廓或套索；另一个窗口画小十字
  renderCursor() {
    this.renderHover();
    const sc = this.scene, p = sc.hover, g = this.gCursor;
    g.innerHTML = '';
    if (sc.bare || !p || !W) return;
    const NS = 'http://www.w3.org/2000/svg';
    const path = (d, attrs) => { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); g.appendChild(e); };
    const here = this.box.matches(':hover') || !!this.drag;
    if (sc.lasso && sc.lasso.length > 1) {
      path(`M${sc.lasso.map(q => q.join(',')).join('L')}Z`, { fill: 'rgba(255,255,255,.12)', stroke: '#fff', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke' });
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x >= SIZE || p.y >= SIZE) return;
    if (here) {
      let d = '';
      if (sc.tool === 'sp' && W.spx) d = spOutline(W, W.ai.sp[Math.floor(p.y) * SIZE + Math.floor(p.x)]);
      else if (sc.tool === 'brush' || (sc.tool === 'sp' && !W.spx)) {
        const s = sc.tool === 'brush' ? sc.size : 1, c = Math.floor(p.x - s / 2 + 0.5), r = Math.floor(p.y - s / 2 + 0.5);
        d = `M${c},${r}h${s}v${s}h${-s}Z`;
      }
      if (d) {
        path(d, { fill: 'none', stroke: 'rgba(0,0,0,.65)', 'stroke-width': 3.2, 'vector-effect': 'non-scaling-stroke' });
        path(d, { fill: 'none', stroke: '#fff', 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke' });
      }
      return;
    }
    const r = 7 / sc.view.scale;
    const d = `M${p.x - r},${p.y}h${2 * r}M${p.x},${p.y - r}v${2 * r}`;
    path(d, { stroke: 'rgba(0,0,0,.7)', 'stroke-width': 3.5, 'vector-effect': 'non-scaling-stroke' });
    path(d, { stroke: '#fff', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' });
  }
  renderHover() {
    const p = this.scene.hover, w = W, r = this.box.getBoundingClientRect();
    const { scale, tx, ty } = this.scene.view, xImage = p ? (p.mx - tx) / scale : -1, yImage = p ? (p.my - ty) / scale : -1;
    const inside = p && p.viewer === this.index && xImage >= 0 && yImage >= 0 && xImage < SIZE && yImage < SIZE && p.mx >= 0 && p.my >= 0 && p.mx < r.width && p.my < r.height;
    this.hoverTip.hidden = !inside || !w || switching;
    if (this.hoverTip.hidden) return;
    const i = Math.floor(yImage) * SIZE + Math.floor(xImage), cls = CLS.find(c => c.v === w.lab[i]) || CLS[5];
    const label = w.shadow[i] ? '云影 · 看不清' : w.whole[i] ? '看不清 · 整期不可判' : w.lab[i] === NONE && w.ai?.occlusion?.[i] === 1 ? '云遮挡 · 看不清' : cls.name;
    const marks = [w.uns[i] ? '拿不准' : '', w.todo[i] && !w.tch[i] && w.lab[i] !== NONE ? '待看' : ''].filter(Boolean);
    this.hoverTitle.textContent = `当前标注：${label}${marks.length ? ' · ' + marks.join(' · ') : ''}`;
    this.hoverTip.style.borderLeftColor = w.shadow[i] ? '#c4b5fd' : `rgb(${cls.rgb})`;
    this.hoverNote.textContent = `${fmtDate(w.p.date)}${!this.labels && blink && P[w.code][w.k - 1] ? ' · 当前期标签，上一期影像' : !this.labels && this.scene.aiLeft ? ' · 左图为AI预标' : ''}`;
    const width = this.hoverTip.offsetWidth, height = this.hoverTip.offsetHeight;
    const x = clamp(p.mx + 14, 6, Math.max(6, r.width - width - 6));
    const y = p.my + 14 + height > r.height - 6 ? Math.max(6, p.my - height - 12) : p.my + 14;
    this.hoverTip.style.left = `${x}px`; this.hoverTip.style.top = `${y}px`;
  }
}
// 一组像元的外轮廓（SVG 路径，像元坐标）
function maskOutline(isIn, pixels) {
  let d = '';
  for (const i of pixels) {
    const x = i % SIZE, y = (i / SIZE) | 0;
    if (y === 0 || !isIn(i - SIZE)) d += `M${x},${y}h1`;
    if (y === SIZE - 1 || !isIn(i + SIZE)) d += `M${x},${y + 1}h1`;
    if (x === 0 || !isIn(i - 1)) d += `M${x},${y}v1`;
    if (x === SIZE - 1 || !isIn(i + 1)) d += `M${x + 1},${y}v1`;
  }
  return d;
}
let spOutKey = '', spOutD = '';
function spOutline(w, id) {
  const k = `${w.code}|${w.k}|${id}`;
  if (k === spOutKey) return spOutD;
  const sp = w.ai.sp;
  spOutKey = k; spOutD = maskOutline(i => sp[i] === id, spPixels(w, id));
  return spOutD;
}

// ---------------------------------------------------------------- 编辑
const scene = new Scene();
const va = scene.add($('vA'), false);
const vb = scene.add($('vB'), true);

const ops = {
  n: 0, spDone: null,
  begin() {
    if (!W) return;
    W.undo.push({ lab: W.lab.slice(), uns: W.uns.slice(), tch: W.tch.slice(), todo: W.todo.slice(), shadow: W.shadow.slice(), whole: W.whole.slice(), legacyWhole: W.legacyWhole, quality: W.quality, qEditing: W.qEditing, qPending: W.qPending, src: W.src });
    if (W.undo.length > 30) W.undo.shift();
    this.n = 0; this.spDone = new Set();
  },
  set(i) {
    const w = W;
    if (saving || !qualityReady(w) || (w.quality.status === 'no' && ![NONE, SHADOW].includes(scene.brush))) return;
    if (scene.brush === UNSURE) w.uns[i] = 1;
    else { w.lab[i] = scene.brush === SHADOW ? NONE : scene.brush; w.shadow[i] = scene.brush === SHADOW ? 1 : 0; w.whole[i] = 0; w.uns[i] = 0; w.todo[i] = 0; }
    w.tch[i] = 1;
    this.n++;
  },
  square(px, py, s) {
    const c0 = Math.floor(px - s / 2 + 0.5), r0 = Math.floor(py - s / 2 + 0.5);
    for (let r = Math.max(0, r0); r < Math.min(SIZE, r0 + s); r++) for (let c = Math.max(0, c0); c < Math.min(SIZE, c0 + s); c++) this.set(r * SIZE + c);
  },
  stroke(x, y, last) {
    if (!W) return;
    const pts = [];
    if (last) { const k = Math.max(1, Math.ceil(Math.hypot(x - last.x, y - last.y) / 0.5)); for (let t = 1; t <= k; t++) pts.push([last.x + (x - last.x) * t / k, last.y + (y - last.y) * t / k]); }
    else pts.push([x, y]);
    for (const [px, py] of pts) {
      if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue;
      if (scene.tool === 'sp' && W.spx) {
        const id = W.ai.sp[Math.floor(py) * SIZE + Math.floor(px)];
        if (this.spDone.has(id)) continue;
        this.spDone.add(id);
        for (const i of spPixels(W, id)) this.set(i);
      } else this.square(px, py, scene.tool === 'brush' ? scene.size : 1);
    }
    scene.changed(true);
  },
  // 整片：和点到的那格类别相同、四邻相连的一片
  flood(x, y) {
    if (!W) return;
    const i0 = Math.floor(y) * SIZE + Math.floor(x), v0 = W.lab[i0], s0 = W.shadow[i0];
    const seen = new Uint8Array(N), st = [i0];
    seen[i0] = 1;
    const hit = [];
    while (st.length) {
      const i = st.pop(); hit.push(i);
      const cx = i % SIZE;
      for (const j of [i - SIZE, i + SIZE, cx > 0 ? i - 1 : -1, cx < SIZE - 1 ? i + 1 : -1]) {
        if (j < 0 || j >= N || seen[j] || W.lab[j] !== v0 || W.shadow[j] !== s0) continue;
        seen[j] = 1; st.push(j);
      }
    }
    for (const i of hit) this.set(i);
    if (hit.length > 2000) toast(`整片改了 ${fmtN(hit.length)} 格（Ctrl+Z 可以撤销）`);
  },
  polygon(pts) {
    if (!W) return;
    let x0 = SIZE, y0 = SIZE, x1 = 0, y1 = 0;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let r = Math.max(0, Math.floor(y0)); r < Math.min(SIZE, Math.ceil(y1)); r++) {
      const cy = r + 0.5, xs = [];
      for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
        const [xa, ya] = pts[k], [xb, yb] = pts[j];
        if ((ya > cy) !== (yb > cy)) xs.push(xa + (cy - ya) * (xb - xa) / (yb - ya));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        for (let c = Math.max(0, Math.ceil(xs[q] - 0.5)); c <= Math.min(SIZE - 1, Math.floor(xs[q + 1] - 0.5)); c++) this.set(r * SIZE + c);
      }
    }
  },
  end() {
    if (!W) return;
    if (!this.n) { W.undo.pop(); scene.changed(); return; }
    W.dirty = true;
    scene.changed();
    afterEdit();
  },
};
function undo() {
  if (saving || switching) return;
  if (!W?.undo.length) { toast('没有可以撤销的'); return; }
  const u = W.undo.pop();
  W.lab.set(u.lab); W.uns.set(u.uns); W.tch.set(u.tch); W.todo.set(u.todo); W.shadow.set(u.shadow); W.whole.set(u.whole); W.legacyWhole = u.legacyWhole; W.quality = u.quality; W.qEditing = u.qEditing; W.qPending = u.qPending; W.src = u.src;
  W.dirty = true;
  scene.changed();
  renderQuality();
  afterEdit();
}
let draftTimer = null, listTimer = null;
function afterEdit() {
  renderCounts();
  renderSrc();
  clearTimeout(draftTimer);
  const w = W;
  draftTimer = setTimeout(() => saveDraft(w), 700);
}
async function saveDraft(w) {
  if (!w || !w.dirty) return;
  const key = `${w.code}|${w.p.scene_id}`;
  const dk = draftKey(key, w.mode);
  await kvSet(dk, { map: packMap(w), quality: w.quality, whole_mask_v: 1, legacyWhole: w.legacyWhole, qEditing: w.qEditing, qPending: w.qPending, src: w.src, baseId: w.baseId || null, at: new Date().toISOString() });
  if (!w.dirty) { await kvDel(dk); return; }   // 存草稿的时候正好保存了
  if (mode === w.mode && !drafts.has(key)) { drafts.add(key); renderListSoon(); }
}
function renderListSoon() { clearTimeout(listTimer); listTimer = setTimeout(() => { renderSites(); renderList(); }, 250); }
function flushDraft() { if (W?.dirty) { clearTimeout(draftTimer); return saveDraft(W); } return Promise.resolve(); }

// ---------------------------------------------------------------- 打开一期
function blankWork() { return { lab: new Uint8Array(N).fill(NONE), uns: new Uint8Array(N), tch: new Uint8Array(N), todo: new Uint8Array(N), shadow: new Uint8Array(N), whole: new Uint8Array(N), quality: null }; }
async function openPeriod(code, k, { fit = false, duringModeSwitch = false } = {}) {
  if (switching && !duringModeSwitch) return;
  if (saving) { toast('正在保存，请稍等再换期。'); return; }
  scene.setHover(null); $('qualityAiSec').hidden = true;
  const openMode = mode;
  const seq = ++openSeq;
  await flushDraft();
  const p = P[code][k];
  const qualityRead = loadChangeQuality(code);
  const key = `${code}|${p.scene_id}`;
  const ai = await aiOf(code, p.date);
  let w = null, src = 'ai', baseId = null, savedRow = null;
  const dr = await kvGet(draftKey(key, openMode)) || (openMode === 'demo' ? await kvGet(`draft|${key}`) : null);
  if (dr?.map) { w = unpackMap(dr.map); w.quality = normaliseQuality(dr.quality); w.legacyWhole = dr.legacyWhole; migrateWholeMask(w, dr.whole_mask_v); w.qEditing = dr.qEditing; w.qPending = dr.qPending; src = dr.src || 'draft'; baseId = dr.baseId; drafts.add(key); }
  else {
    drafts.delete(key);
    savedRow = LAT[key]?.label || null;
    if (savedRow) {
      try { const d = await labelData(savedRow); if (d) { w = await decodeMap(d); src = 'saved'; baseId = savedRow.id; } } catch (e) { toast(`读不到这一期已保存的标注：${e.message}`); }
    }
  }
  if (!w) {
    w = blankWork();
    if (ai) { w.lab.set(ai.cls); w.todo.set(ai.unc); w.shadow.set(ai.shadow); }
    src = 'ai';
  }
  if (seq !== openSeq || openMode !== mode) return;
  const sameSite = W && W.code === code;
  W = { ...w, mode: openMode, qEditing: w.qEditing ?? !w.quality, code, k, p, ai, spx: ai?.sp ? spIndex(ai.sp) : null, src, baseId, undo: [], dirty: false, fromDraft: !!dr?.map, draftAt: dr?.at || null };
  scene.rail = sites[code].railway?.lines || [];
  scene.jumpAt = -1; scene.flash = null;
  setImages();
  scene.changed();
  if (fit || !sameSite) requestAnimationFrame(() => scene.fit());
  $('emptyMsg').hidden = true; $('perPanel').hidden = false;
  err('');
  renderPanel();
  renderSites();
  renderList();
  const opened = W;
  qualityRead.then(() => { if (W === opened && seq === openSeq && openMode === mode) renderQualitySuggestion(); });
}
let imgKind = 'tc', blink = false, blinkPinned = false;
function setImages() {
  if (!W) return;
  const { code, k, p } = W;
  const prev = P[code][k - 1];
  if (blink && prev) va.setImage(prev[imgKind], `上一期 ${fmtDate(prev.date)} · 对照`);
  else va.setImage(p[imgKind], `这一期 ${fmtDate(p.date)}${scene.aiLeft ? ' · AI 原预标' : ''}`);
  vb.setImage(p[imgKind], `这一期 ${fmtDate(p.date)} · 标注`);
  scene.setHover(scene.hover);
}

// ---------------------------------------------------------------- 统计和右栏
function countsOf(w) {
  const n = [0, 0, 0, 0, 0, 0];
  let uns = 0, tch = 0, todo = 0, edited = 0, shadow = 0;
  for (let i = 0; i < N; i++) {
    const v = w.lab[i];
    n[v === NONE ? 5 : v]++;
    if (w.uns[i]) uns++;
    if (w.shadow[i]) shadow++;
    if (w.tch[i]) tch++;
    if (w.todo[i] && !w.tch[i] && v !== NONE) todo++;
    if (w.ai && w.ai.cls[i] !== v) edited++;
  }
  return { n, uns, tch, todo, edited, shadow };
}
function renderCounts() {
  if (!W) return;
  const c = countsOf(W), valid = N - c.n[5];
  $('pBars').innerHTML = CLS.map((k, j) => {
    const m = c.n[j], frac = j < 5 ? (valid ? m / valid : 0) : m / N;
    return `<div class="row"><span><i class="sw" style="background:rgb(${k.rgb})"></i> ${k.name}</span><span class="bar"><i style="width:${(frac * 100).toFixed(1)}%;background:rgb(${k.rgb})"></i></span>`
      + `<span class="num">${(frac * 100).toFixed(1)}%</span></div>`;
  }).join('');
  $('pCount').innerHTML = `<span class="todo"><b>待看 ${fmtN(c.todo)}</b> 格</span><span class="uns">拿不准 ${fmtN(c.uns)}</span>`
    + `<span>云影遮挡 ${fmtN(c.shadow)} 格（${pct(c.shadow, N)}）</span>`
    + `<span class="tiny">比 AI 预标改了 ${fmtN(c.edited)} 格 · 你动过 ${fmtN(c.tch)} 格</span>`;
  renderPalette(c);
  renderOcclusionSuggestion();
}
function occlusionStats(w = W) {
  if (!w?.ai?.occlusion) return null;
  let masked = 0, hardConflicts = 0, softReview = 0, kept = 0;
  for (let i = 0; i < N; i++) {
    const id = w.ai.occlusion[i], hard = hardOcclusion(id);
    if (!hard && id !== 2) continue;
    if (hard) masked++;
    if (w.tch[i]) { kept++; continue; }
    if (hard && (w.lab[i] !== NONE || w.shadow[i] !== w.ai.shadow[i] || w.uns[i] || w.todo[i] || w.whole[i])) hardConflicts++;
    if (id === 2 && w.lab[i] <= 4 && !w.todo[i]) softReview++;
  }
  return { masked, hardConflicts, softReview, conflicts: hardConflicts + softReview, kept };
}
function renderOcclusionSuggestion() {
  const s = occlusionStats(), sec = $('occlusionSec');
  sec.hidden = !s;
  if (!s) return;
  $('occlusionSummary').textContent = `云、云影及缺测共 ${fmtN(s.masked)} 格，其中待修正 ${fmtN(s.hardConflicts)} 格；薄云 / 疑似遮挡需补待看 ${fmtN(s.softReview)} 格；保留 ${fmtN(s.kept)} 格人工标注。`;
  $('occlusionApplyBtn').disabled = saving || switching || W.mode !== mode || !s.conflicts;
}
function applyOcclusionSuggestion() {
  if (!W || saving || switching || W.mode !== mode) return false;
  const s = occlusionStats();
  if (!s?.conflicts) return false;
  ops.begin();
  for (let i = 0; i < N; i++) if (!W.tch[i]) {
    if (hardOcclusion(W.ai.occlusion[i])) { W.lab[i] = NONE; W.shadow[i] = W.ai.shadow[i]; W.uns[i] = 0; W.todo[i] = 0; W.whole[i] = 0; }
    else if (W.ai.occlusion[i] === 2 && W.lab[i] <= 4) W.todo[i] = 1;
  }
  ops.n = s.conflicts; ops.end();
  toast(`已修正 ${fmtN(s.hardConflicts)} 格硬遮挡，补 ${fmtN(s.softReview)} 格待看；保留 ${fmtN(s.kept)} 格人工标注。Ctrl+Z 可撤销；检查后保存。`);
  return true;
}
function renderPalette(c) {
  const valid = c ? N - c.n[5] : 0;
  const items = [...CLS.map((k, j) => ({ v: k.v, name: k.name, key: k.key, sw: `background:rgb(${k.rgb})`, pct: c ? (j < 5 ? pct(c.n[j], valid) : pct(c.n[5], N)) : '' })),
    { v: UNSURE, name: '拿不准', key: '7', cls: 'lc-unsure', pct: c ? fmtN(c.uns) : '' },
    { v: SHADOW, name: '云影', key: '8', cls: 'lc-shadow', pct: c ? pct(c.shadow, N) : '' }];
  $('palette').innerHTML = items.map(t => `<button data-v="${t.v}" class="${scene.brush === t.v ? 'on' : ''}" title="快捷键 ${t.key}"><i class="sw ${t.cls || ''}" style="${t.sw || ''}"></i>${t.name}<kbd>${t.key}</kbd><span class="pct">${t.pct}</span></button>`).join('');
  $('palette').querySelectorAll('button').forEach(b => { b.onclick = () => setBrush(Number(b.dataset.v)); });
}
function srcText() {
  if (!W) return '';
  const s = W.src || '';
  const base = s === 'ai' ? `AI 预标（${esc(AIX?.version || '')}）` : s === 'saved' ? '数据库里已保存的' : s.startsWith('prev:') ? `沿用 ${fmtDate(s.slice(5))} 的标注` : '这台电脑上的草稿';
  const key = `${W.code}|${W.p.scene_id}`;
  const lab = LAT[key]?.label;
  const savedNote = lab ? `；这一期已保存过（${esc(lab.meta?.by || '没留名')}，${fmtTime(lab.created_at)}）` : '';
  const draftNote = drafts.has(key) ? '；<b class="draft">这台电脑上有没保存的修改</b>' : '';
  return `打底：${base}${savedNote}${draftNote}`;
}
function renderSrc() { if (W) $('pSrc').innerHTML = srcText(); }
function renderPanel() {
  if (!W) return;
  const { code, k, p } = W;
  const info = AIX?.[code]?.periods?.[p.date] || {};
  const anchor = (AIX?.[code]?.anchors || []).includes(p.date);
  $('pTitle').textContent = `${SITE_NAME[code]} · ${fmtDate(p.date)}（第 ${k} 期）`;
  const tags = [`${p.satellite || ''} ${p.orbit || ''}`.trim()];
  if (anchor) tags.push('★ 锚定期');
  if (p.hazy) tags.push('有雾');
  if ((p.glint ?? 99) < 18) tags.push('水面反光');
  if (info.none != null) tags.push(`看不清 ${Math.round(info.none * 100)}%`);
  $('pTags').innerHTML = tags.map(t => `<span class="badge${t.startsWith('★') ? ' warn' : ''}">${esc(t)}</span>`).join('');
  renderSrc();
  renderQuality();
  renderCounts();
  const banner = [];
  if (tableReady === false) banner.push('数据库里还没有地物标注的表（landcover），现在只能用演示模式：标注只存在这台电脑。组长在 Supabase 运行 supabase_landcover.sql 后刷新，就能用正式模式。');
  if (!W.ai) banner.push('这一期没有 AI 预标，只能从空白开始标。');
  if (W.ai?.occlusionMissing) banner.push('这一期的云遮挡建议图暂未加载，当前标注保持原样；刷新页面后重试。');
  $('banner').hidden = !banner.length;
  $('banner').innerHTML = banner.map(esc).join('<br>');
  renderReview();
  const rules = Object.entries(info.rules || {}).map(([k2, v]) => `${k2} ${fmtN(v)} 格`).join('；');
  $('pAi').innerHTML = `这一期 AI 预标：拿不准 ${info.unc != null ? Math.round(info.unc * 100) + '%' : '—'}，看不清 ${info.none != null ? Math.round(info.none * 100) + '%' : '—'}。`
    + (rules ? `<br>按这一期光谱和多年用途改过的：${esc(rules)}。` : '')
    + (info.flick ? `<br>单期跳变清理 ${fmtN(info.flick)} 格（前后两期一致、只有这一期不同，改成前后的类别，标成拿不准）。` : '')
    + (info.sp ? `<br>超像素统一 ${fmtN(info.sp)} 格（这一期共 ${fmtN(info.nsp)} 块）。` : '')
    + `<br><span class="tiny">${esc(AIX?.note || '')}。当前预标主要依据本期光谱、多年用途及道路铁路位置；9月Swin模型只作兜底。预标仍需逐期看图核对，尤其注意村内树木、沙洲和窄路。</span>`;
  $('modeNote').innerHTML = mode === 'demo' ? '演示模式：保存、复核都只存在这台电脑，不写数据库。右上角可以换成正式模式。'
    : '正式模式：保存会把这一期写进数据库（landcover 表），旧版本保留，同一期取最新一条。';
  $('whoInput').value = who;
}
function qualityFormValue() {
  const q = { status: $('qualityStatus').value, reasons: [...document.querySelectorAll('input[name="qualityReason"]:checked')].map(i => i.value), note: $('qualityNote').value.trim().slice(0, 500) };
  if (W?.qPending?.suggestion) q.suggestion = W.qPending.suggestion;
  return q;
}
function machineQualitySuggestion(w = W) {
  if (!w) return null;
  const rec = QAI?.[w.code]?.[w.p.date];
  if (QAI?.scope === 'full_frame' && rec?.scene_id === w.p.scene_id && Object.hasOwn(QUALITY, rec.status)) {
    const q = normaliseQuality(rec);
    return { ...q, version: String(QAI.version || '').slice(0, 120), source: 'full_frame', basis: (Array.isArray(rec.basis) ? rec.basis : []).map(s => String(s).slice(0, 300)).slice(0, 8), metrics: rec.metrics || {}, skip: rec.status === 'no' && rec.skip !== false };
  }
  const info = AIX?.[w.code]?.periods?.[w.p.date] || {}, none = Number.isFinite(info.none) ? info.none : null, hazy = !!(w.p.hazy || info.hazy);
  if (none === null && !hazy) return null;
  const status = none > .8 ? 'no' : none >= .02 ? 'partial' : hazy ? 'blurry' : 'yes';
  const basis = none !== null ? [`地物预标有${Math.round(none * 100)}%格记为看不清（云、云影、缺测合并）`] : [];
  if (hazy) basis.push('本期有雾标记，需看图确认地物是否仍能辨认');
  return { status, reasons: hazy ? ['haze'] : [], note: basis.join('；'), version: String(AIX?.version || '').slice(0, 120), source: 'prefill_fallback', basis, metrics: {}, skip: status === 'no' };
}
function changeQualityFor(w = W) {
  if (!w) return null;
  const row = changeQualities.get(w.code)?.latest[w.p.scene_id]?.quality, q = row?.data;
  if (!q || !Object.hasOwn(QUALITY, q.clear)) return null;
  const keys = { '云': 'cloud', '云影': 'cloud_shadow', '雾 / 霾': 'haze', '阴影': 'terrain_shadow', '黑块 / 缺失': 'missing', '条纹': 'stripe', '太亮 / 太暗': 'brightness', '模糊': 'blur' };
  const originalReasons = Array.isArray(q.reasons) ? q.reasons : [];
  const reasons = [...new Set(originalReasons.map(r => keys[r] || (Object.hasOwn(REASONS, r) ? r : null)).filter(Boolean))];
  if (q.also_blurry && !reasons.includes('blur')) reasons.push('blur');
  const scope = sites?.[w.code]?.aoi ? 'aoi' : 'full_frame';
  const scopeText = scope === 'aoi' ? '观察范围（黄色线以内）' : '整幅';
  const when = row.created_at ? new Date(row.created_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '保存时间未记录';
  const basis = [`原变化判读第一步人工记录：${QUALITY[q.clear]}；${scopeText}，${when}保存${row._pending ? '，本机待上传' : ''}`];
  if (scope === 'aoi') basis.push('原判读只看观察范围；地物标注看整幅，范围以外的云、云影也需核对。');
  if (q.boxes?.length) basis.push(`原记录圈了${q.boxes.length}处看不清；请在本台核对并涂出遮挡格。`);
  if (q.also_blurry) basis.push('原记录注明其余地方也有点模糊。');
  const note = [q.other, originalReasons.filter(r => !keys[r] && !Object.hasOwn(REASONS, r)).join('、')].filter(Boolean).join('；') || '沿用原第一步同档建议，请看整幅后由地物台再次确认。';
  return { status: q.clear, reasons, note, version: `change-quality:${row.id || row.created_at || w.p.scene_id}`, source: 'change_quality', basis, metrics: {}, skip: q.clear === 'no', reading_id: row.id || '', scope, scopeText, when, pending: !!row._pending };
}
function qualitySuggestionFor(w = W) {
  const prior = changeQualityFor(w), machine = machineQualitySuggestion(w);
  if (!prior) return machine;
  const basis = [...prior.basis];
  if (machine?.status === 'no' && prior.status !== 'no') basis.push(`需复核差异：原第一步为“${QUALITY[prior.status]}”，整幅机器质检建议“基本看不清”。请检查整幅后修改或确认质量。`);
  else if (prior.status === 'no' && machine && machine.status !== 'no') basis.push(`原第一步判基本看不清；整幅机器质检为“${QUALITY[machine.status]}”。请看图复核，仍由你确认是否跳过。`);
  return { ...prior, basis, metrics: machine?.metrics || {}, conflict: machine?.status === 'no' && prior.status !== 'no' };
}
function renderQualitySuggestion() {
  const sec = $('qualityAiSec'), s = qualitySuggestionFor(), machine = machineQualitySuggestion(), prior = changeQualityFor();
  sec.hidden = !W || switching;
  if (sec.hidden) return;
  sec.classList.toggle('warn', s?.status === 'no' || s?.status === 'partial' || !!s?.conflict);
  $('qualityAiTitle').textContent = s?.source === 'change_quality' ? '原变化判读质量 · 待再次确认' : 'AI 整期质量建议';
  const state = changeQualities.get(W.code);
  $('changeQualityLine').textContent = prior ? `变化判读第一步：${QUALITY[prior.status]}（${prior.scopeText}，${prior.when}保存${prior.pending ? '，本机待上传' : ''}）` : state?.loading ? '变化判读第一步：正在只读获取。' : state?.online === false ? '变化判读第一步：暂未取到原记录，可先参考整幅质检。' : '变化判读第一步：这期尚无原记录。';
  $('qualityAiVerdict').textContent = s ? s.status === 'no' ? '整体看不清，建议跳过这一期' : s.status === 'blurry' ? '整体模糊，建议先看整幅' : `建议：${QUALITY[s.status]}` : '暂无整期机器质检，请人工判断。';
  $('qualityAiNote').textContent = s?.note || '';
  $('qualityAiBasis').innerHTML = (s?.basis || []).map(b => `<li>${esc(b)}</li>`).join('');
  const metrics = s?.metrics || {}, parts = [];
  for (const [key, name] of [['cloud', '云'], ['thin', '薄云 / 疑似遮挡'], ['shadow', '云影'], ['missing', '缺测']]) if (Number.isFinite(metrics[key])) parts.push(`${name} ${Math.round(metrics[key] * 1000) / 10}%`);
  $('qualityAiMetrics').textContent = `${machine?.source === 'full_frame' ? '整幅机器质检' : machine ? '预标统计建议' : ''}${parts.length ? ' · ' + parts.join(' / ') : ''}`;
  $('qualityMachineDetail').hidden = !prior || !machine;
  $('qualityMachineDetail').textContent = prior && machine ? `整幅机器质检：${QUALITY[machine.status]}。${machine.note || ''}\n${machine.basis.join('；')}` : '';
  $('qualityRefreshBtn').disabled = saving || switching || !!state?.loading;
  $('qualityAdoptBtn').disabled = !s || saving || switching;
  $('qualitySkipBtn').hidden = !s?.skip;
  $('qualitySkipBtn').disabled = saving || switching;
}
function adoptQualitySuggestion() {
  if (!W || saving || switching || W.mode !== mode) return false;
  const s = qualitySuggestionFor();
  if (!s) return false;
  ops.begin();
  W.qEditing = true;
  W.qPending = { status: s.status, reasons: [...s.reasons], note: s.note || s.basis.join('；').slice(0, 500), suggestion: { version: s.version, source: s.source, status: s.status, ...(s.source === 'change_quality' ? { reading_id: s.reading_id, scope: s.scope } : {}) } };
  ops.n = 1; ops.end(); renderQuality(); err('');
  $('qualityStatus').focus();
  toast('建议已填入，请看整幅并确认质量；确认前标注保持原样。');
  return true;
}
async function skipSuggestedQuality() {
  if (!W || saving || switching || W.mode !== mode || !qualitySuggestionFor()?.skip) return false;
  if (W.quality?.status !== 'no' || W.qEditing) {
    if ((!W.qEditing || $('qualityStatus').value !== 'no') && !adoptQualitySuggestion()) return false;
    confirmQuality();
  }
  if (!qualityReady() || W.quality.status !== 'no') return false;
  return savePeriod(true);
}
function renderQuality() {
  if (!W) return;
  renderQualitySuggestion();
  const q = W.quality, pending = !qualityReady();
  $('qualitySec').classList.toggle('pending', pending);
  $('qualitySummary').textContent = q ? `${pending ? '正在修改 · 上次：' : '已评定：'}${QUALITY[q.status]}${q.reasons.length ? '\n原因：' + q.reasons.map(r => REASONS[r]).join('、') : ''}${q.note ? '\n' + q.note : ''}` : '未评定。先看整幅影像，再确认质量。';
  $('qualityForm').hidden = !pending;
  $('qualityEditBtn').hidden = pending;
  const form = W.qPending || q;
  $('qualityStatus').value = form?.status || '';
  $('qualityNote').value = form?.note || '';
  document.querySelectorAll('input[name="qualityReason"]').forEach(i => { i.checked = !!form?.reasons?.includes(i.value); });
  $('inheritBtn').disabled = $('resetBtn').disabled = pending || q?.status === 'no';
}
function editQuality() {
  if (!W || saving || switching || W.mode !== mode) return;
  ops.begin(); W.qEditing = true; W.qPending = W.quality ? { ...W.quality, reasons: [...W.quality.reasons] } : null; ops.n = 1; ops.end();
  renderQuality(); scene.fit(); $('qualityStatus').focus();
}
function confirmQuality() {
  if (!W || saving || switching || W.mode !== mode) return;
  const q = qualityFormValue();
  if (!Object.hasOwn(QUALITY, q.status)) { err('请选择整期影像质量。'); return; }
  if (q.status !== 'yes' && !q.reasons.length && !q.note) { err('请选影响原因，或补充一句说明。'); return; }
  ops.begin();
  let restored = false;
  if (q.status === 'no') {
    for (let i = 0; i < N; i++) {
      if (!(W.shadow[i] || (W.lab[i] === NONE && W.tch[i]))) { W.whole[i] = 1; W.tch[i] = 0; }
      W.lab[i] = NONE; W.uns[i] = 0; W.todo[i] = 0;
    }
  } else if (W.whole.some(Boolean)) {
    for (let i = 0; i < N; i++) if (W.whole[i]) {
      W.lab[i] = W.ai?.cls[i] ?? NONE; W.todo[i] = W.ai?.unc[i] ?? 0; W.shadow[i] = W.ai?.shadow?.[i] ?? 0; W.uns[i] = 0; W.tch[i] = 0; W.whole[i] = 0;
    }
    restored = true;
  }
  W.quality = { ...q, by: who || null, reviewed_at: new Date().toISOString() };
  W.qEditing = false; W.qPending = null;
  ops.n = 1; ops.end(); renderQuality(); err('');
  if (restored && W.legacyWhole) { err('旧整期不可判记录未区分普通人工遮挡。已保留云影、恢复其余预标；请重新核对“看不清”范围。'); W.legacyWhole = false; }
  toast(q.status === 'no' ? '已记录整期不可判，训练掩膜全部为255；可撤销或修改质量。' : restored ? `整期屏蔽已撤，人工遮挡保留，其余恢复${W.ai ? '本期AI预标' : '空白'}。请重新检查后保存。` : q.status === 'partial' ? '质量已确认。用云影或看不清标出遮挡范围，再保存。' : '质量已确认，可以开始标注。');
}
function validateWork(w = W) {
  if (!requireQuality()) return false;
  if (w.quality.status === 'partial' && countsOf(w).n[5] === 0) { err('局部看不清：请先用“云影 8”或“看不清 6”涂出遮挡范围。'); return false; }
  return true;
}
async function payloadOf(w) {
  const c = countsOf(w), quality = w.quality, from = w.src, by = who || null, enc = await encodeMap(w);
  const meta = { n: c.n, uns: c.uns, tch: c.tch, todo: c.todo, edited: c.edited, cloud_shadow: c.shadow, whole_mask_v: 1, legacy_whole: !!w.legacyWhole, quality, ai: AIX?.version || null, from, by, date: w.p.date };
  return { v: 'lc1', enc: enc.enc, map: enc.map, meta };
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function maskPng(mask) {
  // 真正的8位单通道PNG，避免canvas输出RGBA掩膜。
  const raw = new Uint8Array(N + SIZE);
  for (let y = 0; y < SIZE; y++) raw.set(mask.subarray(y * SIZE, (y + 1) * SIZE), y * (SIZE + 1) + 1);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const chunk = (name, data) => {
    const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < out.length - 4; i++) { crc ^= out[i]; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
    return out;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, SIZE); view.setUint32(4, SIZE); header[8] = 8; // color type 0，8位灰度
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())], { type: 'image/png' });
}
async function exportLabel(maskOnly = false) {
  if (!W || !validateWork()) return;
  const w = W, name = `${w.code}_${w.p.date}_landcover`;
  if (!maskOnly) {
    const data = await payloadOf(w);
    download(new Blob([JSON.stringify({ site: w.code, scene_id: w.p.scene_id, data }, null, 2)], { type: 'application/json' }), `${name}.json`);
  } else {
    const mask = trainingMask(w);
    if (typeof CompressionStream !== 'undefined') download(await maskPng(mask), `${name}_mask.png`);
    else {
      const lines = []; for (let y = 0; y < SIZE; y++) lines.push(mask.subarray(y * SIZE, (y + 1) * SIZE).join(','));
      download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${name}_mask.csv`);
    }
    toast('已导出掩膜：地物0—4；云影、看不清、拿不准、未查看的待看格为255。');
  }
}
async function importLabel(file) {
  if (!W || !file || saving || switching || W.mode !== mode) return;
  const w = W;
  try {
    if (file.size > 250000) throw new Error('标注文件过大');
    const obj = JSON.parse(await file.text()), data = obj.data || obj;
    if ((obj.site && obj.site !== w.code) || (obj.scene_id && obj.scene_id !== w.p.scene_id) || (data.meta?.date && data.meta.date !== w.p.date)) throw new Error('这份标注属于其他测点或日期，请先打开对应期次');
    const imported = await decodeMap(data);
    if (W !== w || switching || saving || w.mode !== mode) throw new Error('期次或模式已切换，请在对应期次重新导入');
    ops.begin();
    for (const k of ['lab', 'uns', 'tch', 'todo', 'shadow', 'whole']) w[k].set(imported[k]);
    w.legacyWhole = imported.legacyWhole;
    w.quality = imported.quality; w.qEditing = !w.quality; w.qPending = null;
    if (w.quality?.status === 'no') { w.lab.fill(NONE); w.uns.fill(0); w.todo.fill(0); }
    w.src = 'import'; ops.n = 1; ops.end(); renderQuality(); err('');
    toast(w.quality ? '已导入为本机草稿，检查后再保存。' : '已导入旧标注，尚无整期质量；请先补评。');
  } catch (e) { err(`导入失败：${e.message}`); }
}
function renderReview() {
  if (!W) return;
  const key = `${W.code}|${W.p.scene_id}`, s = LAT[key];
  $('rvSec').hidden = !s?.label;
  if (!s?.label) return;
  const m = s.review?.meta;
  $('rvState').innerHTML = !m ? '（等组长看）'
    : m.decision === 'confirmed' ? `<span class="rv-state-ok">（通过：${esc(m.by || '组长')}，${fmtTime(s.review.created_at)}）</span>`
      : `<span class="rv-state-back">（退回：${esc(m.comment || '')}）</span>`;
}

// ---------------------------------------------------------------- 队列
function periodsShown(code = site) {
  const anchors = new Set(AIX?.[code]?.anchors || []);
  return (P[code] || []).map((p, k) => ({ p, k })).filter(({ p }) => {
    const st = stateOf(code, p);
    if (filter === 'anchor') return anchors.has(p.date);
    if (filter === 'todo') return st === 'todo' || st === 'draft';
    if (filter === 'all') return true;
    return st === filter;
  });
}
function renderSites() {
  $('siteTabs').innerHTML = SITE_ORDER.map(c => {
    const all = P[c] || [], done = all.filter(p => ['saved', 'ok', 'back'].includes(stateOf(c, p))).length;
    return `<button data-site="${c}" class="${c === site ? 'on' : ''}"><span class="nm"><i style="background:${sites[c].color}"></i>${SITE_NAME[c]}</span><span class="tiny">${done} / ${all.length}</span></button>`;
  }).join('');
  $('siteTabs').querySelectorAll('button').forEach(b => { b.onclick = () => setSite(b.dataset.site); });
}
function renderList() {
  const all = P[site] || [], shown = periodsShown();
  const saved = all.filter(p => ['saved', 'ok', 'back'].includes(stateOf(site, p))).length, ok = all.filter(p => stateOf(site, p) === 'ok').length;
  $('progBar').style.width = all.length ? `${(saved / all.length) * 100}%` : '0';
  $('progText').textContent = `${SITE_NAME[site]}：已保存 ${saved} / ${all.length} 期，组长通过 ${ok}${mode === 'demo' ? '（演示）' : ''}；列表 ${shown.length} 期`;
  const L = $('qList');
  if (!shown.length) { L.innerHTML = '<div class="tiny" style="padding:8px">这个筛选下没有期了。</div>'; return; }
  const anchors = new Set(AIX?.[site]?.anchors || []);
  let html = '', lastY = '';
  for (const { p, k } of shown) {
    const y = p.date.slice(0, 4);
    if (y !== lastY) { html += `<div class="grp">${y} 年</div>`; lastY = y; }
    const st = stateOf(site, p), info = AIX?.[site]?.periods?.[p.date] || {};
    const lab = LAT[`${site}|${p.scene_id}`]?.label;
    const q = normaliseQuality(lab?.meta?.quality);
    const sub = lab ? `${esc(lab.meta?.by || '没留名')} · ${q ? QUALITY[q.status] : '质量未评'} · 改 ${fmtN(lab.meta?.edited)} 格${lab.meta?.todo ? ` · 留黄 ${fmtN(lab.meta.todo)}` : ''}`
      : `AI 拿不准 ${info.unc != null ? Math.round(info.unc * 100) : '—'}% · 看不清 ${info.none != null ? Math.round(info.none * 100) : '—'}%`;
    html += `<button data-k="${k}" class="${W && W.code === site && W.k === k ? 'cur' : ''}"><span class="t">${fmtDate(p.date).slice(5)}${anchors.has(p.date) ? '<span class="star">★</span>' : ''}${p.hazy ? ' · 雾' : ''}</span>`
      + `<span class="st ${st}" title="${ST_TITLE[st]}">${ST_TEXT[st]}</span><small>${sub}</small></button>`;
  }
  L.innerHTML = html;
  L.querySelectorAll('button[data-k]').forEach(b => { b.onclick = () => openPeriod(site, Number(b.dataset.k)); });
  const c = L.querySelector('button.cur');
  if (c) c.scrollIntoView({ block: 'nearest' });
}
function setSite(c) {
  if (switching || saving) return;
  site = c;
  try { localStorage.setItem(SITE_KEY, c); } catch { /* ignore */ }
  renderSites(); renderList();
  const first = periodsShown()[0] || { k: 0 };
  if (!W || W.code !== c) openPeriod(c, first.k, { fit: true });
}
function step(dir) {
  if (!W || switching) return;
  const list = periodsShown(W.code);
  let target = null;
  if (dir > 0) target = list.find(x => x.k > W.k); else target = [...list].reverse().find(x => x.k < W.k);
  if (!target) { toast(dir > 0 ? '列表里后面没有了' : '列表里前面没有了'); return; }
  openPeriod(W.code, target.k);
}

// ---------------------------------------------------------------- 整期操作
async function inheritPrev() {
  if (!W || saving || !requireQuality() || W.quality.status === 'no') return;
  const w = W;
  const { code, k } = W;
  let j = -1;
  for (let q = k - 1; q >= 0; q--) if (LAT[`${code}|${P[code][q].scene_id}`]?.label) { j = q; break; }
  if (j < 0) { toast('前面还没有保存过的期，不能沿用（先标锚定期）'); return; }
  const pp = P[code][j];
  let prev;
  try { prev = await decodeMap(await labelData(LAT[`${code}|${pp.scene_id}`].label)); } catch (e) { err(`读不到 ${pp.date} 的标注：${e.message}`); return; }
  const [aiPrev, cd] = await Promise.all([aiOf(code, pp.date), cdMap(code, w.p.date)]);
  if (W !== w || saving || !qualityReady(w)) return;
  const ai = W.ai;
  if (!ai) { toast('这一期没有 AI 预标，不能按“AI 认为变了”沿用'); return; }
  ops.begin();
  let nChg = 0, nCopy = 0;
  for (let i = 0; i < N; i++) {
    if (W.shadow[i] || (W.lab[i] === NONE && W.tch[i])) continue; // 当前期人标遮挡不能被上一期/预标填补
    const a1 = ai.cls[i], a0 = aiPrev ? aiPrev.cls[i] : NONE, h0 = prev.lab[i];
    W.tch[i] = 0; W.uns[i] = 0; W.shadow[i] = ai.shadow[i];
    if (a1 === NONE) { W.lab[i] = NONE; W.todo[i] = 0; continue; }
    const changed = (a0 !== NONE && a1 !== a0) || (!!cd && cd[i] > 0);
    if (changed || h0 === NONE) { W.lab[i] = a1; W.todo[i] = changed || ai.unc[i] ? 1 : 0; if (changed) nChg++; }
    else { W.lab[i] = h0; W.todo[i] = 0; W.uns[i] = prev.uns[i]; nCopy++; }
  }
  ops.n = 1;
  W.src = `prev:${pp.date}`;
  ops.end();
  toast(`已沿用 ${fmtDate(pp.date)}：照搬 ${fmtN(nCopy)} 格；AI 认为变了的 ${fmtN(nChg)} 格换成这一期的预标并标黄${cd ? '（含变化检测标了变化的格）' : ''}。Ctrl+Z 可以撤销`);
}
function resetAi() {
  if (!W || saving || !requireQuality() || W.quality.status === 'no') return;
  if (!W?.ai) { toast('这一期没有 AI 预标'); return; }
  ops.begin();
  for (let i = 0; i < N; i++) {
    if (W.shadow[i] || (W.lab[i] === NONE && W.tch[i])) continue;
    W.lab[i] = W.ai.cls[i]; W.shadow[i] = W.ai.shadow[i]; W.uns[i] = 0; W.tch[i] = 0; W.todo[i] = W.ai.unc[i];
  }
  ops.n = 1; W.src = 'ai';
  ops.end();
  toast('已恢复 AI 预标，保留这一期人标的遮挡范围（Ctrl+Z 可以撤销）');
}
async function dropDraft() {
  if (!W || saving || switching) return;
  const key = `${W.code}|${W.p.scene_id}`;
  if (!drafts.has(key) && !W.dirty) { toast('这一期在这台电脑上没有没保存的修改'); return; }
  clearTimeout(draftTimer);
  W.dirty = false;
  await kvDel(draftKey(key, W.mode));
  if (W.mode === 'demo') await kvDel(`draft|${key}`);
  drafts.delete(key);
  const { code, k } = W;
  W = null;
  await openPeriod(code, k);
  toast('已放弃这台电脑上的修改，回到已保存的（没保存过就是 AI 预标）');
}
// 下一片待看：黄斜线（还没动过）按八邻相连分片，从上到下、从左到右一片一片放大
function nextTodo() {
  if (!W) return;
  const w = W, m = new Uint8Array(N);
  let any = 0;
  for (let i = 0; i < N; i++) if (w.todo[i] && !w.tch[i] && w.lab[i] !== NONE) { m[i] = 1; any++; }
  if (!any) { toast('这一期没有待看的格子了，可以保存'); return; }
  const seen = new Uint8Array(N), comps = [];
  for (let i = 0; i < N; i++) {
    if (!m[i] || seen[i]) continue;
    const st = [i], pix = [];
    seen[i] = 1;
    let c0 = SIZE, r0 = SIZE, c1 = 0, r1 = 0;
    while (st.length) {
      const q = st.pop(); pix.push(q);
      const x = q % SIZE, y = (q / SIZE) | 0;
      c0 = Math.min(c0, x); c1 = Math.max(c1, x + 1); r0 = Math.min(r0, y); r1 = Math.max(r1, y + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
        const j = yy * SIZE + xx;
        if (m[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
    comps.push({ first: i, c0, r0, c1, r1, pix });
  }
  const big = comps.filter(c => c.pix.length >= 4), list = big.length ? big : comps;
  const c = list.find(x => x.first > scene.jumpAt) || list[0];
  scene.jumpAt = c.first;
  const cm = new Uint8Array(N);
  for (const i of c.pix) cm[i] = 1;
  scene.flash = { d: maskOutline(i => cm[i] === 1, c.pix) };
  scene.focusRect(c.c0, c.r0, c.c1, c.r1);
  clearTimeout(nextTodo.t);
  nextTodo.t = setTimeout(() => { scene.flash = null; scene.render(); }, 1800);
  toast(`待看还有 ${list.length} 片（${fmtN(any)} 格）；这一片 ${fmtN(c.pix.length)} 格。对的用同一类点一下，错的改掉`);
}

// ---------------------------------------------------------------- 保存和复核
let saving = false;
function renderBusy() {
  for (const id of ['saveBtn', 'saveNextBtn', 'rvOk', 'rvBack', 'importBtn', 'modeBtn', 'qualityConfirmBtn', 'qualityEditBtn', 'qualityAdoptBtn', 'qualitySkipBtn', 'occlusionApplyBtn', 'qualityRefreshBtn']) $(id).disabled = saving || switching;
  renderOcclusionSuggestion();
  if (!saving && !switching && W) renderQualitySuggestion();
}
async function savePeriod(goNext = false) {
  if (!W || saving || switching) return false;
  if (W.mode !== mode || !validateWork()) return false;
  if (mode === 'live' && !tableReady) { err('数据库里还没有 landcover 表，正式模式存不了。先用演示模式，或请组长运行 supabase_landcover.sql。'); return false; }
  const w = W, key = `${w.code}|${w.p.scene_id}`;
  let completed = false;
  saving = true;
  renderBusy();
  try {
    const c = countsOf(w);
    const data = await payloadOf(w), meta = data.meta;
    if (JSON.stringify(data).length > 110000) { err('这一期涂得太零碎，记录太大存不下（上限约 11 万字符）。'); return false; }
    const row = { site: w.code, scene_id: w.p.scene_id, kind: 'label', data, app_version: APP_VERSION };
    let saved, queued = false;
    if (mode === 'live') {
      const res = await append(TABLE, row);
      saved = { ...res.row, meta, _fresh: true };
      delete saved.data;
      dataCache[saved.id] = data;
      liveRows.push(saved);
      queued = res.queued;
    } else {
      saved = { ...row, id: uuid(), created_at: new Date().toISOString(), client_id: clientId(), meta, _demo: true };
      demoRows.push(saved);
      await kvSet('demo|rows', demoRows);
    }
    clearTimeout(draftTimer);
    w.dirty = false; w.src = 'saved'; w.baseId = saved.id; w.fromDraft = false;
    await kvDel(draftKey(key, w.mode));
    if (w.mode === 'demo') await kvDel(`draft|${key}`);
    drafts.delete(key);
    recompute();
    toast(`已保存 ${fmtDate(w.p.date)}${mode === 'demo' ? '（演示模式，只存在这台电脑）' : '到数据库'}${c.todo ? `；还有 ${fmtN(c.todo)} 格待看没动过，已一并记下` : ''}${queued ? '；网络不稳，已先存在本机，联网后自动上传' : ''}`);
    renderPanel(); renderSites(); renderList();
    completed = true;
    return true;
  } catch (e) {
    err(`保存失败：${e.message}`);
    return false;
  } finally {
    saving = false;
    renderBusy();
    if (completed && goNext) step(1);
  }
}
async function review(decision) {
  if (!W || saving || switching || W.mode !== mode) return;
  const key = `${W.code}|${W.p.scene_id}`, s = LAT[key];
  if (!s?.label) return;
  if (decision === 'confirmed' && (!normaliseQuality(s.label.meta?.quality) || W.dirty || W.qEditing)) { err('请先补评整期质量并保存当前修改，再通过这份标注。'); return; }
  if (mode === 'live' && !tableReady) { err('数据库里还没有 landcover 表，正式模式存不了。'); return; }
  const comment = $('rvText').value.trim();
  if (decision === 'returned' && !comment) { err('退回请写一句原因。'); return; }
  const meta = { label_id: s.label.id, decision, comment: comment || null, by: who || null };
  const row = { site: W.code, scene_id: W.p.scene_id, kind: 'review', data: { meta }, app_version: APP_VERSION };
  saving = true; renderBusy();
  try {
    if (mode === 'live') { const res = await append(TABLE, row); liveRows.push({ ...res.row, meta, _fresh: true }); }
    else { demoRows.push({ ...row, id: uuid(), created_at: new Date().toISOString(), client_id: clientId(), meta, _demo: true }); await kvSet('demo|rows', demoRows); }
    $('rvText').value = '';
    recompute(); renderReview(); renderSites(); renderList();
    toast(decision === 'confirmed' ? '已记为组长通过' : '已退回');
  } catch (e) { err(`保存失败：${e.message}`); }
  finally { saving = false; renderBusy(); }
}

// ---------------------------------------------------------------- 按钮和快捷键
function setBrush(v) { scene.brush = v; renderPalette(W ? countsOf(W) : null); }
function setTool(t) { scene.tool = t; document.querySelectorAll('#toolSeg button').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); scene.setHover(scene.hover); }
const SIZES = [1, 3, 5, 9];
function setSize(v) { scene.size = v; document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === v)); if (scene.tool !== 'brush') setTool('brush'); scene.setHover(scene.hover); }
function setImg(kind) { imgKind = kind; document.querySelectorAll('#imgSeg button').forEach(b => b.classList.toggle('on', b.dataset.img === kind)); setImages(); }
function toggle(id, on) { const b = $(id); const v = on ?? !b.classList.contains('on'); b.classList.toggle('on', v); return v; }
function toggleBare(on = !scene.bare) { scene.bare = on; $('bareBtn').classList.toggle('on', on); $('bareBtn').textContent = on ? '原图（按 V 恢复）' : '原图'; scene.render(); }

document.querySelectorAll('#imgSeg button').forEach(b => { b.onclick = () => setImg(b.dataset.img); });
document.querySelectorAll('#toolSeg button').forEach(b => { b.onclick = () => setTool(b.dataset.tool); });
document.querySelectorAll('#sizeSeg button').forEach(b => { b.onclick = () => setSize(Number(b.dataset.size)); });
$('undoBtn').onclick = undo;
$('labBtn').onclick = () => { scene.showLab = toggle('labBtn'); scene.changed(); };
$('fillBtn').onclick = () => { scene.fill = (scene.fill + 1) % 3; $('fillBtn').textContent = FILL_NAME[scene.fill]; scene.changed(); };
$('todoBtn').onclick = () => { scene.onlyTodo = toggle('todoBtn'); scene.changed(); };
$('aiBtn').onclick = () => { scene.aiLeft = toggle('aiBtn'); setImages(); scene.changed(); };
$('railBtn').onclick = () => { scene.showRail = toggle('railBtn'); scene.render(); };
$('gridBtn').onclick = () => { scene.grid = toggle('gridBtn'); scene.render(); };
$('bareBtn').onclick = () => toggleBare();
$('jumpBtn').onclick = nextTodo;
$('fitBtn').onclick = () => scene.fit();
$('blinkBtn').onclick = () => { blinkPinned = toggle('blinkBtn'); blink = blinkPinned; setImages(); };
$('qualityEditBtn').onclick = editQuality;
$('qualityConfirmBtn').onclick = confirmQuality;
$('qualityAdoptBtn').onclick = adoptQualitySuggestion;
$('qualitySkipBtn').onclick = () => skipSuggestedQuality().catch(e => err(`保存失败：${e.message}`));
$('occlusionApplyBtn').onclick = applyOcclusionSuggestion;
$('qualityRefreshBtn').onclick = async () => {
  if (!W || saving || switching || W.mode !== mode) return;
  const w = W, reading = loadChangeQuality(w.code, true);
  renderQualitySuggestion();
  await reading;
  if (W === w && w.mode === mode) { renderQualitySuggestion(); toast(changeQualities.get(w.code)?.online === false ? '暂未取到原第一步记录，保留整幅质检建议。' : '已只读同步原变化判读第一步；人工质量表单保持原样。'); }
};
const qualityChanged = () => { if (!W || saving || switching || W.mode !== mode) return; W.qPending = qualityFormValue(); W.qEditing = true; W.dirty = true; afterEdit(); };
$('qualityStatus').onchange = qualityChanged;
$('qualityNote').oninput = qualityChanged;
document.querySelectorAll('input[name="qualityReason"]').forEach(i => { i.onchange = qualityChanged; });
$('exportBtn').onclick = () => exportLabel().catch(e => err(`导出失败：${e.message}`));
$('maskExportBtn').onclick = () => exportLabel(true).catch(e => err(`导出失败：${e.message}`));
$('importBtn').onclick = () => { if (!saving && !switching && W?.mode === mode) $('importFile').click(); };
$('importFile').onchange = async e => { await importLabel(e.target.files?.[0]); e.target.value = ''; };
$('saveBtn').onclick = () => savePeriod(false);
$('saveNextBtn').onclick = () => savePeriod(true);
$('prevBtn').onclick = () => step(-1);
$('nextBtn').onclick = () => step(1);
$('inheritBtn').onclick = inheritPrev;
$('resetBtn').onclick = resetAi;
$('dropBtn').onclick = dropDraft;
$('rvOk').onclick = () => review('confirmed');
$('rvBack').onclick = () => review('returned');
$('whoInput').onchange = e => { who = e.target.value.trim().slice(0, 20); try { localStorage.setItem(NAME_KEY, who); } catch { /* ignore */ } };
$('fType').value = filter;
$('fType').onchange = e => { filter = e.target.value; try { localStorage.setItem(FILTER_KEY, filter); } catch { /* ignore */ } renderList(); };
$('helpBtn').onclick = () => $('helpModal').classList.add('show');
$('helpClose').onclick = () => $('helpModal').classList.remove('show');
$('guideBtn').onclick = () => $('guideModal').classList.add('show');
$('guideClose').onclick = () => $('guideModal').classList.remove('show');
function renderMode() { const b = $('modeBtn'); b.className = `mode-btn ${mode}`; b.textContent = mode === 'live' ? '正式模式' : '演示模式'; }
$('modeBtn').onclick = () => {
  if (saving || switching) return;
  if (mode === 'live') { setMode('demo'); toast('已切换到演示模式：保存只存在这台电脑'); return; }
  if (tableReady === false) { toast('数据库里还没有 landcover 表，暂时不能用正式模式'); return; }
  $('modeModal').classList.add('show');
};
$('modeCancel').onclick = () => $('modeModal').classList.remove('show');
$('modeOk').onclick = () => { $('modeModal').classList.remove('show'); setMode('live'); toast('已切换到正式模式：保存会写入数据库'); };
async function setMode(m) {
  if (saving || switching) { toast('正在保存或切换模式，请稍等。'); return; }
  if (!['demo', 'live'].includes(m) || m === mode) return;
  switching = true; renderBusy();
  scene.setHover(null); $('qualityAiSec').hidden = true;
  try {
    await flushDraft();
    ++openSeq;
    mode = m;
    await loadDraftKeys();
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
    recompute(); renderMode(); renderSites(); renderList();
    if (W) { const { code, k } = W; W = null; await openPeriod(code, k, { duringModeSwitch: true }); }
  } finally { switching = false; renderBusy(); if (W) renderQuality(); }
}

window.addEventListener('keydown', e => {
  if (typing()) return;
  if (document.querySelector('.modal-back.show')) { if (e.key === 'Escape') document.querySelectorAll('.modal-back.show').forEach(m => m.classList.remove('show')); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); savePeriod(false); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); savePeriod(true); return; }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); return; }
  const cls = CLS.find(c => c.key === k);
  if (cls) { setBrush(cls.v); return; }
  if (k === '7') { setBrush(UNSURE); return; }
  if (k === '8') { setBrush(SHADOW); return; }
  if (k === 's') setTool('sp');
  else if (k === 'd') setTool('brush');
  else if (k === 'f') setTool('flood');
  else if (k === 'l') setTool('lasso');
  else if (k === '[') setSize(SIZES[Math.max(0, SIZES.indexOf(scene.size) - 1)]);
  else if (k === ']') setSize(SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(scene.size) + 1)]);
  else if (k === 'j') nextTodo();
  else if (k === 'p') inheritPrev();
  else if (k === 'h') $('labBtn').click();
  else if (k === 'o') $('fillBtn').click();
  else if (k === 'y') $('todoBtn').click();
  else if (k === 'a') $('aiBtn').click();
  else if (k === 't') setImg(imgKind === 'tc' ? 'fc' : 'tc');
  else if (k === 'g') $('gridBtn').click();
  else if (k === 'v') toggleBare();
  else if (k === 'b' && !e.repeat && !blink) { blink = true; setImages(); }
});
window.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'b' && blink) { blink = blinkPinned; setImages(); } });
window.addEventListener('beforeunload', () => { if (W?.dirty) saveDraft(W); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });

// 本机测试用的入口（只在 localhost 打开时挂上，线上没有）
if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  window.__lc = { get W() { return W; }, get LAT() { return LAT; }, get mode() { return mode; }, get tableReady() { return tableReady; }, get demoRows() { return demoRows; }, get QAI() { return QAI; }, get AIX() { return AIX; },
    scene, ops, va, vb, openPeriod, savePeriod, inheritPrev, resetAi, nextTodo, undo, setBrush, setTool, countsOf, packMap, unpackMap, encodeMap, decodeMap, aiOf, P, drafts, kvKeys, kvDel,
    trainingMask, maskPng, normaliseQuality, qualityReady, confirmQuality, editQuality, payloadOf, importLabel, exportLabel, setMode, review, draftKey, loadDraftKeys, flushDraft, qualitySuggestionFor, renderQualitySuggestion, adoptQualitySuggestion, skipSuggestedQuality, occlusionStats, renderOcclusionSuggestion, applyOcclusionSuggestion, machineQualitySuggestion, changeQualityFor, loadChangeQuality };
}

// ---------------------------------------------------------------- 启动
async function init() {
  renderMode();
  renderPalette(null);
  sites = await loadSites();
  for (const c of SITE_ORDER) P[c] = await loadPeriods(c);
  [AIX, QAI] = await Promise.all(['prefill_lc/index.json', 'prefill_lc/quality.json'].map(path => fetch(path, { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null)));
  demoRows = (await kvGet('demo|rows')) || [];
  await loadDraftKeys();
  try { await pullRows(); } catch (e) {
    $('qList').innerHTML = `<div class="err" style="padding:8px">读不到数据库：${esc(e.message)}。请检查网络后刷新。</div>`;
    return;
  }
  if (tableReady === false && mode === 'live') { mode = 'demo'; await loadDraftKeys(); renderMode(); }
  $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  recompute();
  renderSites();
  renderList();
  const first = periodsShown()[0] || { k: 0 };
  await openPeriod(site, first.k, { fit: true });
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try { await pullRows(); recompute(); renderSites(); renderList(); renderReview(); $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`; } catch { /* 下次再试 */ }
  }, 120000);
}
init();
