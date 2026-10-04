// 精标台（2026-10-04）：组长逐框检查、修改第三步的逐格标注（AI 精标 10-04 版；10-04 晚第三轮复核后为 10-04b，换版时本机没手改的确认作废）。
// 左：框的队列（测点、筛选、进度）；中：这个框的前图和这一期，同步缩放，标注叠在两张图上，直接涂改；
// 右：类别、前后日期、红黄格数、AI 精标说明，确认 / 恢复 / 保存。
// 一个框的标注从哪来（先找到的为准）：这台电脑上改过、确认过的（草稿）→ 数据库里这一期最新的第三步记录（框的位置没变）→ AI 精标（prefill/<测点>/<日期>.png）。
// 保存按期：正式模式写 readings（kind = precise，格式同判读页第三步，另记 by = leader、prefill = 版本）和 reviews（kind = precise，decision = confirmed）；
// 演示模式只存在这台电脑。一期的框都确认了自动保存。
import { Scene } from './viewer.js';
import { append, tableSync, uuid } from './api.js';
import { loadSites, loadPeriods, latestByScene, fmtDate, stepThree, canStep3, decodeCells, encodeCells, countCells, cellRange,
  sameGeom, isAfter, imageBefore, boxBefore, dayGap } from './store.js';
import { SITE_ORDER, CHANGE_TAGS } from './config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const TAG = { farm: '农田', ...Object.fromEntries(CHANGE_TAGS.map(t => [t.key, t.label.replace(/ /g, '')])) };
const FARM_WORDS = ['农田', '收割', '返青', '翻耕', '灌水', '插秧', '稻'];
const MODE_KEY = 'rs2_label_mode', SITE_KEY = 'rs2_label_site', FILTER_KEY = 'rs2_label_filter';
const STATE_KEY = 'rs2_label_v1';      // 框 → { c0, r0, w, h, rle, ok, chg, at, saved: { demo, live } }：这台电脑上改过、确认过、保存过的框
const DEMO_KEY = 'rs2_label_demo_v1';  // 演示模式下“保存”的记录（readings、reviews 两种）
const KEY_STORE = 'rs2_ai_key';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const SITE_NAME = { ZZ: '株洲南', HY: '衡阳北', SG: '韶关南' };

let mode = 'demo', site = 'ZZ', fType = 'todo', fTag = '';
try {
  mode = localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'demo';
  site = localStorage.getItem(SITE_KEY) || 'ZZ';
  fType = localStorage.getItem(FILTER_KEY) || 'todo';
} catch { /* storage blocked */ }
if (!SITE_ORDER.includes(site)) site = 'ZZ';

let sites, P = {}, rows = [], reviews = [], latest = {};
const pre = {};       // code → { info: { version, dates, note }, maps: { date: Promise<Uint8Array|null> } }
const notes = {};     // code → { version, boxes: { 'date|id': { text, tags, before, after, n1, n2, n } } } | null
let items = [];       // 全部测点能做第三步的框
let cur = null;       // 当前的框
const work = {};      // 'code|scene_id' → { code, k, p, boxes: [bx] }
const befCache = {};  // 框 → 前图序号
let imgKind = 'tc', brush = 1, size = 1, aiShow = false, blink = false, fillOn = true;

const scene = new Scene();
const va = scene.addViewer($('vA'));
const vb = scene.addViewer($('vB'));
scene.mode = 'paint';
const sync = { readings: tableSync('readings'), reviews: tableSync('reviews') };

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800); }

// ---------------------------------------------------------------- 本机记录
function readState() { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch { return {}; } }
let ST = readState();
function writeState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(ST)); } catch { toast('这台电脑存不下修改记录（浏览器存储已满或被禁用）'); } }
function demoRows(table) { try { return (JSON.parse(localStorage.getItem(DEMO_KEY)) || {})[table] || []; } catch { return []; } }
function saveDemo(table, row) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(DEMO_KEY)) || {}; } catch { /* ignore */ }
  const full = { ...row, id: uuid(), created_at: new Date().toISOString(), _demo: true, _fresh: true };
  (all[table] = all[table] || []).push(full);
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(all)); } catch { toast('这台电脑不能保存演示记录'); }
  return full;
}

// ---------------------------------------------------------------- 数据库（只读，保存时追加）
function recompute() {
  const rs = mode === 'demo' ? [...rows, ...demoRows('readings')] : rows;
  latest = {};
  for (const c of SITE_ORDER) latest[c] = latestByScene(rs.filter(r => r.site === c));
}
const slotOf = (code, sid) => latest[code]?.[sid] || {};
function rvsOf(code, sid) {
  const live = reviews.filter(r => r.site === code && r.scene_id === sid);
  return mode === 'demo' ? [...live, ...demoRows('reviews').filter(r => r.site === code && r.scene_id === sid)] : live;
}
const s3Of = (code, p) => stepThree(p, slotOf(code, p.scene_id), rvsOf(code, p.scene_id));
const latestOf = code => sid => slotOf(code, sid);

// ---------------------------------------------------------------- AI 精标（预标图）和说明
const prefillIndex = fetch('prefill/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
const aiVer = {};     // code → 现在的 AI 精标版本（prefill/index.json 的 version，如 ZZ-AI-20261004b）
// AI 精标换了版本：这台电脑上“确认了、没手改”的框作废（新版标注不一样了，要按新版再看）；手改过的保留你的修改，框里提示 AI 已更新
async function dropStale() {
  const ix = await prefillIndex;
  for (const c of SITE_ORDER) aiVer[c] = ix?.[c]?.version || '';
  let n = 0;
  for (const [k, s] of Object.entries(ST)) {
    const v = aiVer[k.split('|')[0]];
    if (!s || !v || (s.v || '') === v) continue;
    if (!s.chg) { delete ST[k]; n++; } else s.aiOld = true;
  }
  if (n) { writeState(); toast(`AI 精标更新到新版：这台电脑上 ${n} 个确认过、没改过的框改回“还没确认”，请按新版再看`); }
}
function aiMap(code, date) {
  const S = pre[code] || (pre[code] = { info: null, maps: {} });
  if (!S.maps[date]) S.maps[date] = prefillIndex.then(ix => {
    S.info = ix?.[code] || null;
    if (!S.info || !(S.info.dates || []).includes(date)) return null;
    return new Promise(res => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas'); cv.width = cv.height = 256;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, 256, 256).data, cells = new Uint8Array(65536);
        for (let n = 0; n < 65536; n++) { const v = d[n * 4]; cells[n] = v < 50 ? 0 : v < 150 ? 1 : 2; }
        res(cells);
      };
      img.onerror = () => res(null);
      img.src = `prefill/${code}/${date}.png?v=${encodeURIComponent(S.info.version || '')}`;
    });
  });
  return S.maps[date];
}
// 说明：本机（复核台目录）读明文 ai/fine_<测点>.json；线上读加密的 ai_enc/fine_<测点>.bin（钥匙和复核台相同）
function b64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function keyText() {
  const m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{20,})/);
  if (m) {
    try { localStorage.setItem(KEY_STORE, m[1]); } catch { /* 存不了就只用这一次 */ }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1];
  }
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
}
let keyPromise = null;
function aiKey() {
  if (!keyPromise) {
    const t = keyText();
    keyPromise = t && crypto?.subtle ? crypto.subtle.importKey('raw', b64url(t), 'AES-GCM', false, ['decrypt']).catch(() => null) : Promise.resolve(null);
  }
  return keyPromise;
}
async function loadNotes(code) {
  if (code in notes) return notes[code];
  notes[code] = null;
  if (LOCAL) {
    try { const r = await fetch(`ai/fine_${code}.json`, { cache: 'no-cache' }); if (r.ok) return (notes[code] = await r.json()); } catch { /* 试加密数据 */ }
  }
  try {
    const key = await aiKey();
    if (!key) return null;
    const r = await fetch(`ai_enc/fine_${code}.bin`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12)));
    const s = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    notes[code] = JSON.parse(new TextDecoder().decode(new Uint8Array(await new Response(s).arrayBuffer())));
  } catch { notes[code] = null; }
  return notes[code];
}

// ---------------------------------------------------------------- 框的队列
function kindOf(b) {
  const t = b.tags || [];
  if (t.includes('farm') || FARM_WORDS.some(w => (b.note || '').includes(w))) return 'farm';
  if (!t.length || t.every(x => x === 'unclear')) return 'unclear';
  if (t.some(x => x.startsWith('water'))) return 'water';
  if (t.some(x => x.startsWith('road') || x.startsWith('building'))) return 'road';
  if (t.some(x => x.startsWith('bare'))) return 'bare';
  return 'veg';
}
function buildItems() {
  items = [];
  for (const code of SITE_ORDER) {
    (P[code] || []).forEach((p, k) => {
      const s3 = s3Of(code, p);
      if (!canStep3(s3)) return;
      for (const b of s3.boxes) items.push({ code, k, p, b, key: `${code}|${p.date}|${b.id}`, pkey: `${code}|${p.scene_id}` });
    });
  }
}
// 框的状态：sv 已保存（当前模式）/ ok 确认了还没保存 / ed 改过还没确认 / todo
function statusOf(it) {
  const s = ST[it.key];
  if (s && s.saved?.[mode] && s.saved[mode] >= (s.at || '')) return 'sv';
  if (s?.ok) return 'ok';
  if (s?.rle && s.chg) return 'ed';   // 改过又撤销回 AI 精标原样的，仍算“还没确认”
  if (!s) {   // 本机没记录：数据库里组长已经保存过（正式模式）
    const s3 = s3Of(it.code, it.p);
    if (s3.precise?.data?.by === 'leader' && s3.state === 'checked' && (s3.precise.data.boxes || []).some(m => m.id === it.b.id && sameGeom(m, it.b))) return 'sv';
  }
  return 'todo';
}
const ST_TEXT = { sv: '✓', ok: '●', ed: '✎', todo: '○' };
const ST_TITLE = { sv: '已保存', ok: '已确认，还没保存', ed: '改过，还没确认', todo: '还没确认' };
function countsOf(it) {
  const s = ST[it.key];
  if (s?.rle) { const c = countCells(decodeCells(s.rle, s.w * s.h)); return { ...c, n: s.w * s.h }; }
  const nb = notes[it.code]?.boxes?.[`${it.p.date}|${it.b.id}`];
  if (nb) return { n1: nb.n1, n2: nb.n2, n: nb.n };
  const c = it._cnt;
  return c || null;
}
function passFilter(it) {
  if (fTag && kindOf(it.b) !== fTag) return false;
  const st = statusOf(it);
  if (fType === 'todo') return st === 'todo' || st === 'ed';
  if (fType === 'unsure') { const c = countsOf(it); return !!c && c.n2 > 0; }
  if (fType === 'ask') return !!notes[it.code]?.boxes?.[`${it.p.date}|${it.b.id}`]?.ask;
  if (fType === 'edited') return (ST[it.key]?.chg || 0) > 0;
  if (fType === 'done') return st === 'ok' || st === 'sv';
  if (fType === 'unsaved') return items.some(o => o.pkey === it.pkey && statusOf(o) === 'ok');
  return true;
}
const siteItems = () => items.filter(it => it.code === site);
function renderSites() {
  $('siteTabs').innerHTML = SITE_ORDER.map(c => {
    const all = items.filter(it => it.code === c), done = all.filter(it => ['ok', 'sv'].includes(statusOf(it))).length;
    return `<button data-site="${c}" class="${c === site ? 'on' : ''}"><span class="nm"><i style="background:${sites[c].color}"></i>${SITE_NAME[c]}</span><span class="tiny">${done} / ${all.length}</span></button>`;
  }).join('');
  $('siteTabs').querySelectorAll('button').forEach(b => { b.onclick = () => setSite(b.dataset.site); });
}
function renderList() {
  const all = siteItems(), shown = all.filter(passFilter);
  const done = all.filter(it => ['ok', 'sv'].includes(statusOf(it))).length, saved = all.filter(it => statusOf(it) === 'sv').length;
  $('progBar').style.width = all.length ? `${(done / all.length) * 100}%` : '0';
  $('progText').textContent = `${SITE_NAME[site]}：确认 ${done} / ${all.length} 个框，已保存 ${saved}${mode === 'demo' ? '（演示）' : ''}；列表 ${shown.length} 个`;
  const L = $('qList');
  if (!shown.length) { L.innerHTML = `<div class="tiny" style="padding:8px">${all.length ? '这个筛选下没有框了。' : '这个测点还没有能做第三步的框。'}</div>`; return; }
  let html = '', lastDate = '';
  for (const it of shown) {
    if (it.p.date !== lastDate) { html += `<div class="grp">${fmtDate(it.p.date)}（第 ${it.k} 期）</div>`; lastDate = it.p.date; }
    const st = statusOf(it), c = countsOf(it);
    const tags = (it.b.tags || []).map(t => TAG[t] || t).join('、') || '没选类别';
    const cnt = c ? `<b>红 ${c.n1}</b> · <em>黄 ${c.n2}</em> / ${c.n} 格` : '';
    const chg = ST[it.key]?.chg ? ` · 改 ${ST[it.key].chg}` : '';
    html += `<button data-key="${esc(it.key)}" class="${cur?.key === it.key ? 'cur' : ''}"><span class="t">框 ${it.b.id} · ${esc(tags)}</span>`
      + `<span class="st ${st}" title="${ST_TITLE[st]}">${ST_TEXT[st]}</span><small>${cnt}${chg}</small></button>`;
  }
  L.innerHTML = html;
  L.querySelectorAll('button[data-key]').forEach(b => { b.onclick = () => open(items.find(it => it.key === b.dataset.key)); });
  const c = L.querySelector('button.cur');
  if (c) c.scrollIntoView({ block: 'nearest' });
}
function setSite(c) {
  site = c;
  try { localStorage.setItem(SITE_KEY, c); } catch { /* ignore */ }
  prepareSite(c).then(() => {
    renderSites(); renderList();
    const first = siteItems().find(passFilter) || siteItems()[0];
    if (first && (!cur || cur.code !== c)) open(first);
  });
}
// 打开一个测点前：读这个测点的预标图（列表里的红黄格数要用）和说明
async function prepareSite(code) {
  await loadNotes(code);
  const its = items.filter(it => it.code === code);
  await Promise.all([...new Set(its.map(it => it.p.date))].map(d => aiMap(code, d)));
  for (const it of its) {
    if (it._cnt) continue;
    const m = await aiMap(code, it.p.date);
    if (!m) continue;
    const r = cellRange(it.b);
    let n1 = 0, n2 = 0;
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) { const v = m[(r.r0 + j) * 256 + r.c0 + i]; if (v === 1) n1++; else if (v === 2) n2++; }
    it._cnt = { n1, n2, n: r.w * r.h };
  }
}

// ---------------------------------------------------------------- 一期的工作副本
async function periodWork(it) {
  if (work[it.pkey]) return work[it.pkey];
  const { code, k, p } = it;
  const s3 = s3Of(code, p);
  const saved = s3.precise?.data?.boxes || [];
  const m = await aiMap(code, p.date);
  const boxes = s3.boxes.map(b => {
    const r = cellRange(b);
    const key = `${code}|${p.date}|${b.id}`;
    const aiCells = new Uint8Array(r.w * r.h);
    if (m) for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) aiCells[j * r.w + i] = m[(r.r0 + j) * 256 + r.c0 + i];
    const bx = { id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, ...r, key, tags: b.tags || [], note: b.note || '', before: b.before || null, aiCells, src: 'ai' };
    const s = ST[key];
    const sv = saved.find(x => x.id === b.id && sameGeom(x, b) && x.c0 === r.c0 && x.r0 === r.r0 && x.w === r.w && x.h === r.h);
    if (s?.rle && s.c0 === r.c0 && s.r0 === r.r0 && s.w === r.w && s.h === r.h) { bx.cells = decodeCells(s.rle, r.w * r.h); bx.src = 'local'; }
    else if (sv) { bx.cells = decodeCells(sv.rle, r.w * r.h); bx.src = 'saved'; }
    else { bx.cells = aiCells.slice(); bx.src = m ? 'ai' : 'none'; }
    return bx;
  });
  return (work[it.pkey] = { code, k, p, boxes });
}
const diffAi = bx => { let n = 0; for (let i = 0; i < bx.cells.length; i++) if (bx.cells[i] !== bx.aiCells[i]) n++; return n; };
function remember(bx, patch) {
  const prev = ST[bx.key] || {};
  ST[bx.key] = { ...prev, c0: bx.c0, r0: bx.r0, w: bx.w, h: bx.h, rle: encodeCells(bx.cells), chg: diffAi(bx), at: new Date().toISOString(),
    v: aiVer[bx.key.split('|')[0]] || '', aiOld: false, ...patch };
  writeState();
}

// 这个框的前图：第二步记的 before；没记的，整张前图在框里看不清时往前找（和判读页第三步相同，store.js boxBefore）
async function beforeIndex(it) {
  if (it.key in befCache) return befCache[it.key];
  const periods = P[it.code];
  let j = it.b.before ? periods.findIndex(x => x.scene_id === it.b.before) : -1;
  const ib = imageBefore(periods, it.k, latestOf(it.code));
  const start = ib.i ?? it.k - 1;
  if (j < 0) { const r = await boxBefore(periods, it.k, start, it.b, latestOf(it.code)); j = r.i ?? start; }
  befCache[it.key] = { j, start, ib };
  return befCache[it.key];
}

// ---------------------------------------------------------------- 打开一个框
let openSeq = 0;
async function open(it) {
  if (!it) return;
  const seq = ++openSeq;
  if (it.code !== site) { site = it.code; renderSites(); }
  const samePeriod = cur && cur.pkey === it.pkey && scene.paint;
  cur = it;
  const w = await periodWork(it);
  const bf = await beforeIndex(it);
  if (seq !== openSeq) return;
  const periods = P[it.code];
  scene.rail = sites[it.code].railway?.lines || [];
  scene.aoi = null;
  if (samePeriod && scene.paint.boxes === w.boxes) { scene.paint.current = it.b.id; scene.paintChanged(); }
  else scene.setPaint({ boxes: w.boxes, current: it.b.id, brush, size, editable: true, show: $('paintBtn').classList.contains('on'), grid: $('gridBtn').classList.contains('on'),
    dimOthers: true, fill: fillOn });
  scene.setLayer('targets', w.boxes, { style: 'target' });
  const m = await aiMap(it.code, it.p.date);
  scene.setAiMap(m ? { cells: m, show: aiShow, viewer: null } : null);
  setImages();
  const bx = w.boxes.find(b => b.id === it.b.id);
  requestAnimationFrame(() => scene.focusBox(bx, 1.7));
  $('emptyMsg').hidden = true; $('boxPanel').hidden = false;
  renderPanel();
  renderList();
  renderSites();
}
function curBox() { return cur ? work[cur.pkey]?.boxes.find(b => b.id === cur.b.id) || null : null; }
function setImages() {
  if (!cur) return;
  const bf = befCache[cur.key];
  const periods = P[cur.code];
  const bp = bf && bf.j >= 0 ? periods[bf.j] : periods[cur.k - 1];
  const lab = `前图 ${fmtDate(bp.date)}`;
  va.setImage(bp[imgKind], lab);
  if (blink) vb.setImage(bp[imgKind], `${lab}（按住 B 时）`);
  else vb.setImage(cur.p[imgKind], `这一期 ${fmtDate(cur.p.date)}`);
}
function renderPanel() {
  const it = cur, bx = curBox();
  if (!it || !bx) return;
  const periods = P[it.code];
  const bf = befCache[it.key];
  const bp = periods[bf.j];
  $('bTitle').textContent = `${SITE_NAME[it.code]} · ${fmtDate(it.p.date)}（第 ${it.k} 期）· 框 ${bx.id}`;
  $('bTags').innerHTML = (bx.tags.length ? bx.tags.map(t => `<span class="badge blue">${esc(TAG[t] || t)}</span>`).join('') : '<span class="badge">没选类别</span>');
  $('bNote').textContent = bx.note || '';
  let why = '';
  if (bf.j !== it.k - 1) {
    if (bf.j !== bf.start) why = `这个框在整张前图（${fmtDate(periods[bf.start].date)}）里看不清，换成更早一张看得清的`;
    else if (bf.ib?.why) why = bf.ib.why;
  }
  const nb0 = notes[it.code]?.boxes?.[`${it.p.date}|${bx.id}`];
  if (nb0?.before && nb0.before !== bp.date) why = (why ? why + '；' : '') + `注意：AI 精标是按前图 ${fmtDate(nb0.before)} 标的，和这里的前图不同，红黄格子可能对不上，请按这里两张图重新看`;
  $('bPair').innerHTML = `左：前图 <b>${fmtDate(bp.date)}</b>（${bp.orbit}${bp.hazy ? '，有雾' : ''}${(bp.glint ?? 99) < 18 ? '，反光' : ''}）<br>右：这一期 <b>${fmtDate(it.p.date)}</b>（${it.p.orbit}${it.p.hazy ? '，有雾' : ''}${(it.p.glint ?? 99) < 18 ? '，反光' : ''}），隔 ${dayGap(it.p.date, bp.date)} 天`
    + (why ? `<div class="why">${esc(why)}</div>` : '');
  renderCount();
  const nb = notes[it.code]?.boxes?.[`${it.p.date}|${bx.id}`];
  $('bAsk').hidden = !nb?.ask;
  $('bAsk').innerHTML = nb?.ask ? `<b>要你定：</b>${esc(nb.ask)}` : '';
  $('bAi').textContent = nb ? nb.text : (notes[it.code] === null && !LOCAL ? '要看 AI 精标说明，请用复核台的带钥匙链接打开一次（钥匙存在浏览器里，两个页面通用）。' : '（这个框没有说明）');
  renderPeriod();
  $('modeNote').innerHTML = mode === 'demo' ? '演示模式：确认、修改、保存都只存在这台电脑，不写数据库。右上角可以换成正式模式。'
    : '正式模式：保存会把这一期的逐格标注写进数据库（第三步，记为组长标的），并记“第三步没问题”。';
  $('err').textContent = '';
}
function renderCount() {
  const bx = curBox();
  if (!bx) return;
  const { n1, n2 } = countCells(bx.cells), d = diffAi(bx);
  const src = { local: '这台电脑上改过的', saved: '数据库里已保存的', ai: 'AI 精标', none: '没有预标' }[bx.src] || '';
  $('bCount').innerHTML = `<span><b class="r">红 ${n1}</b> 格</span><span><b class="y">黄 ${n2}</b> 格</span><span class="tiny">共 ${bx.w * bx.h} 格 · 来自${src}</span>`
    + (d ? `<span class="chg">比 AI 精标改了 ${d} 格</span>` : '')
    + (bx.src === 'local' && ST[bx.key]?.aiOld ? '<span class="chg">AI 精标已更新到新版，这里仍是你在这台电脑上改过的；按 A 对照新版，按 R 换成新版</span>' : '');
}
function renderPeriod() {
  const w = work[cur.pkey];
  const its = items.filter(o => o.pkey === cur.pkey);
  const sts = its.map(statusOf);
  $('perState').textContent = sts.every(s => s === 'sv') ? '（已保存）' : sts.every(s => s === 'ok' || s === 'sv') ? '（都确认了，还没保存）' : `（确认 ${sts.filter(s => s === 'ok' || s === 'sv').length} / ${its.length}）`;
  $('perList').innerHTML = its.map((o, i) => {
    const bx = w.boxes.find(b => b.id === o.b.id);
    const { n1, n2 } = bx ? countCells(bx.cells) : { n1: 0, n2: 0 };
    return `<button data-key="${esc(o.key)}" class="${o.key === cur.key ? 'cur' : ''}"><b>框 ${o.b.id}</b><span>${esc((o.b.tags || []).map(t => TAG[t] || t).join('、') || '没选类别')}</span><span class="sp"></span>`
      + `<span class="tiny">红 ${n1} · 黄 ${n2}</span><span class="st ${sts[i]}" title="${ST_TITLE[sts[i]]}">${ST_TEXT[sts[i]]}</span></button>`;
  }).join('');
  $('perList').querySelectorAll('button').forEach(b => { b.onclick = () => open(items.find(o => o.key === b.dataset.key)); });
}

// ---------------------------------------------------------------- 编辑
scene.onPaint = () => {
  const bx = curBox();
  if (!bx) return;
  if (scene.bare) toggleBare(false);   // 在原图上涂了：先把标注显示回来
  bx.src = 'local';
  remember(bx, { ok: false });
  renderCount(); renderPeriod(); renderList(); renderSites();
};
scene.onPickBox = id => { const o = items.find(x => x.pkey === cur?.pkey && x.b.id === id); if (o) open(o); };
scene.onPaintView = () => $('paintBtn').classList.toggle('on', !!scene.paint?.show);

function editBox(fn, msg) {
  const bx = curBox();
  if (!bx) return;
  scene.pushUndo(bx);
  fn(bx);
  scene.paintChanged();
  scene.onPaint();
  if (msg) toast(msg);
}
function setBrush(v) { brush = v; if (scene.paint) scene.paint.brush = v; document.querySelectorAll('#brushSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.brush) === v)); }
function setSize(v) { size = Math.max(1, Math.min(3, v)); if (scene.paint) scene.paint.size = size; document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === size)); }
function setImg(kind) { imgKind = kind; document.querySelectorAll('#imgSeg button').forEach(b => b.classList.toggle('on', b.dataset.img === kind)); setImages(); }
function toggle(id, on) { const b = $(id); const v = on ?? !b.classList.contains('on'); b.classList.toggle('on', v); return v; }

// 下一个：当前测点按日期、框号的顺序，往后找第一个符合筛选的（不含当前的）；dir = -1 往前
function step(dir = 1) {
  const all = siteItems();
  let i = all.findIndex(it => it.key === cur?.key);
  for (let n = 0; n < all.length; n++) {
    i += dir;
    if (i < 0 || i >= all.length) break;
    if (passFilter(all[i])) return open(all[i]);
  }
  toast(dir > 0 ? '后面没有符合筛选的框了' : '前面没有符合筛选的框了');
}
async function confirmBox() {
  const bx = curBox();
  if (!bx) return;
  const { n1, n2 } = countCells(bx.cells);
  if (!n1 && !n2) { $('err').textContent = '这个框一格都没涂。整框都看不出变化的话，点“整框涂成拿不准”。'; return; }
  remember(bx, { ok: true });
  const its = items.filter(o => o.pkey === cur.pkey);
  if (its.every(o => ['ok', 'sv'].includes(statusOf(o))) && its.some(o => statusOf(o) === 'ok')) await savePeriod(work[cur.pkey], true);
  renderPeriod(); renderSites();
  const keep = cur;
  step(1);
  if (cur === keep) { renderList(); renderPanel(); }
}

// ---------------------------------------------------------------- 保存一期
function packBox(bx) {
  return { id: bx.id, x0: bx.x0, y0: bx.y0, x1: bx.x1, y1: bx.y1, c0: bx.c0, r0: bx.r0, w: bx.w, h: bx.h, rle: encodeCells(bx.cells), ...countCells(bx.cells),
    ...(pre[cur.code]?.info?.version ? { ai: pre[cur.code].info.version } : {}), edited: diffAi(bx) };
}
async function savePeriod(w, auto = false) {
  const { code, k, p } = w;
  const s3 = s3Of(code, p);
  if (!canStep3(s3)) { $('err').textContent = '这一期的第三步现在不能保存：第二步还没有组长的确认。'; return false; }
  const bad = w.boxes.find(bx => { const c = countCells(bx.cells); return !c.n1 && !c.n2; });
  if (bad) { $('err').textContent = `框 ${bad.id} 一格都没涂，先涂（整框看不出就涂成拿不准）再保存。`; return false; }
  const slot = slotOf(code, p.scene_id);
  const data = { compare_id: slot.compare?.id || null, review_id: s3.two.verdict?.id || null, boxes: w.boxes.map(packBox),
    prefill: pre[code]?.info?.version || null, by: 'leader' };
  if (JSON.stringify(data).length > 55000) { $('err').textContent = '这一期涂得太零碎，记录太大存不下（上限约 5.5 万字符）。'; return false; }
  const ib = imageBefore(P[code], k, latestOf(code));
  const row = { site: code, scene_id: p.scene_id, prev_scene_id: (ib.i != null ? P[code][ib.i].scene_id : p.prev) || null, kind: 'precise', data };
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    let queued = false;
    if (mode === 'live') {
      const res = await append('readings', row);
      res.row._fresh = true; sync.readings.add(res.row); rows = sync.readings.rows;
      const rv = await append('reviews', { site: code, scene_id: p.scene_id, kind: 'precise', reading_id: res.row.id, decision: 'confirmed', data: null, comment: null });
      rv.row._fresh = true; sync.reviews.add(rv.row); reviews = sync.reviews.rows;
      queued = res.queued || rv.queued;
    } else {
      const r = saveDemo('readings', row);
      saveDemo('reviews', { site: code, scene_id: p.scene_id, kind: 'precise', reading_id: r.id, decision: 'confirmed', data: null, comment: null });
    }
    const now = new Date().toISOString();
    for (const bx of w.boxes) {
      const prev = ST[bx.key] || {};
      ST[bx.key] = { ...prev, c0: bx.c0, r0: bx.r0, w: bx.w, h: bx.h, rle: encodeCells(bx.cells), chg: diffAi(bx), ok: true, at: prev.at || now, saved: { ...(prev.saved || {}), [mode]: now } };
    }
    writeState();
    recompute();
    toast(`${auto ? '这一期的框都确认了，' : ''}已保存 ${fmtDate(p.date)} 的 ${w.boxes.length} 个框${mode === 'demo' ? '（演示模式，没有写入数据库）' : '到数据库'}${queued ? '；网络不稳，已先存在本机，联网后自动上传' : ''}`);
    return true;
  } catch (err) {
    $('err').textContent = `保存失败：${err.message}`;
    return false;
  } finally { btn.disabled = false; renderList(); renderSites(); if (cur) renderPeriod(); }
}

// ---------------------------------------------------------------- 按钮和快捷键
$('fType').value = fType;
$('fType').onchange = e => { fType = e.target.value; try { localStorage.setItem(FILTER_KEY, fType); } catch { /* ignore */ } renderList(); };
$('fTag').onchange = e => { fTag = e.target.value; renderList(); };
document.querySelectorAll('#imgSeg button').forEach(b => { b.onclick = () => setImg(b.dataset.img); });
document.querySelectorAll('#brushSeg button').forEach(b => { b.onclick = () => setBrush(Number(b.dataset.brush)); });
document.querySelectorAll('#sizeSeg button').forEach(b => { b.onclick = () => setSize(Number(b.dataset.size)); });
$('undoBtn').onclick = () => { if (!scene.undo()) toast('没有可以撤销的'); };
$('paintBtn').onclick = () => { const v = toggle('paintBtn'); if (scene.paint) { scene.paint.show = v; scene.paintChanged(); } };
$('gridBtn').onclick = () => { const v = toggle('gridBtn'); if (scene.paint) { scene.paint.grid = v; scene.paintChanged(); } };
$('aiBtn').onclick = () => { aiShow = toggle('aiBtn'); scene.toggleAiMap(aiShow); };
$('fitBtn').onclick = () => { const bx = curBox(); if (bx) scene.focusBox(bx, 1.7); };
// 原图：只看影像（scene.bare：隐藏框线、标注、铁路、AI 原标注），再按一次恢复
function toggleBare(on = !scene.bare) {
  scene.bare = on;
  scene.render();
  $('bareBtn').classList.toggle('on', on);
  $('bareBtn').textContent = on ? '原图（按 V 恢复）' : '原图';
}
$('bareBtn').onclick = () => toggleBare();
$('fillBtn').onclick = () => { fillOn = toggle('fillBtn'); if (scene.paint) { scene.paint.fill = fillOn; scene.paintChanged(); } };
$('blinkBtn').onclick = () => { blink = toggle('blinkBtn'); setImages(); };
$('okBtn').onclick = confirmBox;
$('prevBtn').onclick = () => step(-1);
$('nextBtn').onclick = () => step(1);
$('resetBtn').onclick = () => editBox(bx => bx.cells.set(bx.aiCells), '已恢复成 AI 精标（Ctrl+Z 可以撤销）');
$('allYelBtn').onclick = () => editBox(bx => bx.cells.fill(2));
$('redToYelBtn').onclick = () => editBox(bx => { for (let i = 0; i < bx.cells.length; i++) if (bx.cells[i] === 1) bx.cells[i] = 2; });
$('clearBtn').onclick = () => editBox(bx => bx.cells.fill(0), '已清空这个框（Ctrl+Z 可以撤销）');
$('saveBtn').onclick = () => { if (cur) savePeriod(work[cur.pkey]); };
$('helpBtn').onclick = () => $('helpModal').classList.add('show');
$('helpClose').onclick = () => $('helpModal').classList.remove('show');
function renderMode() {
  const b = $('modeBtn');
  b.className = `mode-btn ${mode}`;
  b.textContent = mode === 'live' ? '正式模式' : '演示模式';
}
$('modeBtn').onclick = () => {
  if (mode === 'live') { setMode('demo'); toast('已切换到演示模式：保存只存在这台电脑'); return; }
  $('modeModal').classList.add('show');
};
$('modeCancel').onclick = () => $('modeModal').classList.remove('show');
$('modeOk').onclick = () => { $('modeModal').classList.remove('show'); setMode('live'); toast('已切换到正式模式：保存会写入数据库'); };
function setMode(m) {
  mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  for (const k of Object.keys(work)) delete work[k];
  recompute(); buildItems(); renderMode(); renderSites(); renderList();
  if (cur) { const o = items.find(it => it.key === cur.key); cur = null; if (o) open(o); }
}

window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
  if (document.querySelector('.modal-back.show')) { if (e.key === 'Escape') document.querySelectorAll('.modal-back.show').forEach(m => m.classList.remove('show')); return; }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); if (cur) savePeriod(work[cur.pkey]); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); confirmBox(); return; }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); return; }
  if (k === '1') setBrush(1);
  else if (k === '2') setBrush(2);
  else if (k === '3' || k === 'e') setBrush(0);
  else if (k === '[') setSize(size - 1);
  else if (k === ']') setSize(size + 1);
  else if (k === 't') setImg(imgKind === 'tc' ? 'fc' : 'tc');
  else if (k === 'g') $('gridBtn').click();
  else if (k === 'a') $('aiBtn').click();
  else if (k === 'f') $('fitBtn').click();
  else if (k === 'o') $('fillBtn').click();
  else if (k === 'v') toggleBare();
  else if (k === 'r') $('resetBtn').click();
  else if (k === 'b' && !e.repeat && !blink) { blink = true; $('blinkBtn').classList.add('on'); setImages(); }
});
window.addEventListener('keyup', e => {
  if (e.key.toLowerCase() === 'b' && blink) { blink = false; $('blinkBtn').classList.remove('on'); setImages(); }
});

// ---------------------------------------------------------------- 启动
async function init() {
  renderMode();
  sites = await loadSites();
  for (const c of SITE_ORDER) P[c] = await loadPeriods(c);
  try {
    [rows, reviews] = await Promise.all([sync.readings.pull(), sync.reviews.pull()]);
  } catch (err) {
    $('qList').innerHTML = `<div class="err" style="padding:8px">读不到数据库：${esc(err.message)}。请检查网络后刷新。</div>`;
    return;
  }
  $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  recompute();
  await dropStale();
  buildItems();
  await prepareSite(site);
  renderSites();
  renderList();
  const first = siteItems().find(passFilter) || siteItems()[0];
  if (first) open(first);
  // 其余测点在后台准备好（切换时不用等）
  for (const c of SITE_ORDER) if (c !== site) prepareSite(c).then(() => renderSites());
}
init();
