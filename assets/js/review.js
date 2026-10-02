// AI 辅助复核台：左边待复核队列，中间两期影像（同步缩放），右边 AI 对每个框的结论、依据、漏标提醒和建议的决定。
// 决定写入 reviews 表，格式与组长台完全一致（kind compare / quality，decision confirmed / modified / rejected / note；
// “改为没法比较”= modified，data.status = 'uncomparable'）。演示模式下不写数据库，只存在这台电脑。
// AI 数据（ai/ai_<测点>.json、ai/changemap/<测点>/<日期>.png）只放在本机，不上传网站；没有 AI 数据时本页仍可当组长台用。
import { Scene } from './viewer.js';
import { append, tableSync, uuid } from './api.js';
import { loadSites, loadPeriods, latestByScene, fmtDate, fmtTime, stepThree, stepTwo, decodeCells, sameGeom, cellRange, isAfter,
  imageBefore, boxBefore, boxSeen, dayGap } from './store.js';
import { SITE_ORDER, CHANGE_TAGS, QUALITY_NAME, OVERALL_NAME, OVERALL } from './config.js';

const $ = id => document.getElementById(id);
const TAGS = CHANGE_TAGS.some(t => t.key === 'farm') ? CHANGE_TAGS
  : [...CHANGE_TAGS.filter(t => t.key !== 'unclear'), { key: 'farm', label: '农田（收割 / 翻耕 / 灌水 / 返青）' }, ...CHANGE_TAGS.filter(t => t.key === 'unclear')];
const TAG = Object.fromEntries(TAGS.map(t => [t.key, t.label]));
const clone = x => JSON.parse(JSON.stringify(x ?? null));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MODE_KEY = 'rs2_review_mode', DEMO_KEY = 'rs2_review_demo_v1', SITE_KEY = 'rs2_review_site';
const DEC_NAME = { confirm: '确认', modify: '修改', reject: '不是变化', uncomparable: '没法比较', none: '未判' };
const DEC_SHORT = { confirm: '确', modify: '改', reject: '否', uncomparable: '云', none: '·' };
const GROUP_CLASS = { 其他真实变化: 'real', 农田变化: 'farm', 云或云影: 'pseudo', 其他伪变化: 'pseudo', 水面或稻田反光: 'pseudo', 水色变化: 'water', 季节性变化: 'season' };
const OV_HINT = { cloud: '勾“云或云影的位置不同”', season: '勾“植被整体变绿或变黄”', watercolor: '勾“水的颜色变了”并写明原因', color: '勾“整体颜色或亮度变了”', clarity: '勾“清晰程度不一样”', shadow: '勾“山的阴影不一样”' };
const OV_CHOICES = OVERALL.filter(o => !['none', 'local'].includes(o.key));
// 组长对每个框、每条漏标提醒的标记和留言：存成 reviews 里的一条 decision = 'note'、data.kind = 'leader_feedback' 的记录（comment 为空，同学看不到）
const FB_BOX = [['cat', '类别不对'], ['unsure', '我也拿不准'], ['ai', 'AI 判错']];
const FB_MISS = [['ai', '提醒不对'], ['unsure', '拿不准']];
const FB_NAME_BOX = Object.fromEntries(FB_BOX), FB_NAME_MISS = Object.fromEntries(FB_MISS);
const isFb = r => r.decision === 'note' && r.data?.kind === 'leader_feedback';
let fb = { boxes: {}, misses: {}, note: '' };

let sites, periods = {}, ai = {}, rows = [], reviews = [], latest = {};
let site = 'ZZ', cur = null, items = [], view = 'mine', imgKind = 'tc', showMap = true, showPaint = true;
let mine = null, prop = null, curS3 = null, blink = false;
let refDate = null, curPrevQ = [];   // 左图临时换成的“最近一张清楚影像”（10-01 夜分歧复核）
let curBef = null;                    // 这一对的前图（2026-10-03）：上一期被挡住时自动换成最近一张看得清的（store.js imageBefore）
const latestFb = (code, sid) => reviewsOf(code, sid).filter(isFb).sort((a, b) => (isAfter(a, b) ? 1 : -1)).pop() || null;
let mode = 'demo';
try { mode = localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'demo'; site = localStorage.getItem(SITE_KEY) || 'ZZ'; } catch { /* storage blocked */ }

const scene = new Scene();
const va = scene.addViewer($('vA'));
const vb = scene.addViewer($('vB'));
const sync = { readings: tableSync('readings'), reviews: tableSync('reviews') };

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------------------------------------------------------------- 数据
function demoRows() { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || []; } catch { return []; } }
function saveDemo(row) {
  const all = demoRows();
  all.push({ ...row, id: uuid(), created_at: new Date().toISOString(), _demo: true, _fresh: true });
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(all)); } catch { toast('这台电脑不能保存演示记录'); }
}
function reviewsOf(code, sid) {
  const live = reviews.filter(r => r.site === code && r.scene_id === sid);
  return mode === 'demo' ? [...live, ...demoRows().filter(r => r.site === code && r.scene_id === sid)] : live;
}
const aiOf = (code, p) => ai[code]?.periods?.[p.scene_id] || null;
const aiDec = (code, p) => aiOf(code, p)?.suggest?.decision || 'none';

// ---------------- 线上加密的 AI 数据
const KEY_STORE = 'rs2_ai_key';
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);   // 本机才找明文 ai/，线上直接用加密数据
let aiKeyState = 'none';            // none 没有钥匙 / ok 已解锁 / bad 钥匙不对 / plain 本机明文
function b64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function keyText() {
  const m = location.hash.match(/(?:^#|&)k=([A-Za-z0-9_-]{20,})/);
  if (m) {
    try { localStorage.setItem(KEY_STORE, m[1]); } catch { /* 存不了就只用这一次 */ }
    history.replaceState(null, '', location.pathname + location.search);   // 钥匙不留在地址栏里
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
async function decryptFile(path) {
  const key = await aiKey();
  if (!key) return null;
  let r;
  try { r = await fetch(path, { cache: 'no-cache' }); } catch { return null; }
  if (!r.ok) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12))); }
  catch { aiKeyState = 'bad'; return null; }
}
async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function loadAI(code) {
  if (LOCAL) {
    try {
      const r = await fetch(`ai/ai_${code}.json`, { cache: 'no-cache' });
      if (r.ok) { aiKeyState = 'plain'; return await r.json(); }
    } catch { /* 本机没有明文，试加密数据 */ }
  }
  const b = await decryptFile(`ai_enc/ai_${code}.bin`);
  if (!b) return null;
  if (aiKeyState !== 'bad') aiKeyState = 'ok';
  return JSON.parse(new TextDecoder().decode(await gunzip(b)));
}
const packs = {};
function mapPack(code) {
  if (!packs[code]) packs[code] = decryptFile(`ai_enc/map_${code}.bin`).then(b => {
    if (!b) return null;
    const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0);
    return { index: JSON.parse(new TextDecoder().decode(b.slice(4, 4 + n))), body: b.subarray(4 + n) };
  });
  return packs[code];
}
function unlockForm(where) {
  const box = document.createElement('div');
  box.className = 'keybox';
  box.innerHTML = `<b>${aiKeyState === 'bad' ? '钥匙不对，' : ''}要看 AI 建议，请用带钥匙的链接打开，或在这里粘贴钥匙：</b>
    <div class="row"><input class="input" id="keyInput" placeholder="钥匙（一串字母、数字、- 和 _）" autocomplete="off"><button class="btn sm primary" id="keyGo">解锁</button></div>
    <div class="tiny">钥匙只存在这个浏览器里。没有钥匙也能照常复核，只是看不到 AI 结论和 AI 变化图。</div>`;
  where.prepend(box);
  box.querySelector('#keyGo').onclick = () => {
    const v = box.querySelector('#keyInput').value.trim();
    if (!/^[A-Za-z0-9_-]{20,}$/.test(v)) { toast('钥匙格式不对'); return; }
    try { localStorage.setItem(KEY_STORE, v); } catch { /* ignore */ }
    location.reload();
  };
}
async function loadAll() {
  [rows, reviews] = await Promise.all([sync.readings.pull(), sync.reviews.pull()]);
  latest = {};
  for (const c of SITE_ORDER) latest[c] = latestByScene(rows.filter(r => r.site === c));
  $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

// 第三步 AI 预标（prefill/<测点>/<日期>.png，和同学判读页同一份；index.json 列出有预标的期）：检查第三步时和同学涂的逐格比
let prefillIx = null;
const prefillIndex = () => prefillIx || (prefillIx = fetch('prefill/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null));
const preCache = {};
function loadPrefill(code, date) {
  const key = `${code}/${date}`;
  if (!preCache[key]) preCache[key] = prefillIndex().then(ix => {
    const info = ix?.[code];
    if (!info || !info.dates.includes(date)) return null;
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
      img.src = `prefill/${code}/${date}.png?v=${encodeURIComponent(info.version)}`;
    });
  });
  return preCache[key];
}
const mapCache = {};
function loadMap(code, date) {
  const key = `${code}/${date}`;
  if (!mapCache[key]) mapCache[key] = new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const cells = new Uint8Array(65536);
      for (let n = 0; n < 65536; n++) { const v = d[n * 4]; cells[n] = v < 50 ? 0 : v < 150 ? 1 : 2; }
      res(cells);
    };
    img.onerror = async () => {
      // 本机没有明文变化图：从加密的打包文件里取
      const pk = await mapPack(code).catch(() => null);
      const at = pk?.index?.[date];
      if (!at) { res(null); return; }
      const url = URL.createObjectURL(new Blob([pk.body.subarray(at[0], at[0] + at[1])], { type: 'image/png' }));
      img.onerror = () => res(null);
      img.src = url;
    };
    if (LOCAL) img.src = `ai/changemap/${code}/${date}.png`;
    else img.onerror();
  });
  return mapCache[key];
}

// ---------------------------------------------------------------- 队列
function stuData(code, p) { return stepTwo(latest[code][p.scene_id] || {}, reviewsOf(code, p.scene_id)).data; }
// 10-01 复核（季节类结论、暴雨后滑坡误判为涨水等）：AI 结论更新（recheck.at）之前你已做的决定，若和新结论对不上（新结论要保留的框你删了、要删的框你留了、
// 或原结论是删/留而新结论改成“请看图定”），就返回这些框，这一期按“没复核”重新进入待复核队列
const ACT_KEEP = new Set(['keep', 'retag']);
function boxIoU(b, g) {
  const ix = Math.max(0, Math.min(b.x1, g[2]) - Math.max(b.x0, g[0])), iy = Math.max(0, Math.min(b.y1, g[3]) - Math.max(b.y0, g[1]));
  const inter = ix * iy, ua = (b.x1 - b.x0) * (b.y1 - b.y0) + (g[2] - g[0]) * (g[3] - g[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}
function recheckConflicts(code, p) {
  const a = aiOf(code, p);
  if (!a?.recheck?.items?.length) return [];
  const rv = reviewsOf(code, p.scene_id).filter(r => r.kind !== 'precise' && ['confirmed', 'modified', 'rejected'].includes(r.decision))
    .sort((x, y) => (isAfter(x, y) ? 1 : -1));
  const last = rv.pop();
  if (!last || new Date(last.created_at) >= new Date(a.recheck.at)) return [];
  let boxes = [];
  if (last.decision === 'modified') boxes = last.data?.status === 'uncomparable' ? [] : (last.data?.boxes || []);
  else if (last.decision === 'confirmed') boxes = (latest[code][p.scene_id] || {}).compare?.data?.boxes || [];
  return a.recheck.items.filter(it => {
    const kept = boxes.some(b => boxIoU(b, it.geom) > 0.5);
    if (ACT_KEEP.has(it.new_action)) return !kept;
    if (it.new_action === 'delete') return kept;
    return it.old_action !== 'check';
  });
}
// 10-01 夜分歧复核（组长与 AI 意见不同，讨论里第二、三、四部分的期）：again.at 之前做的决定先不算，这一期回到待复核队列；
// 之后重新做一次决定（确认、按我的决定、不是变化、没法比较都算）就消失
function againPending(code, p) {
  const a = aiOf(code, p);
  if (!a?.again?.items?.length) return false;
  const rv = reviewsOf(code, p.scene_id).filter(r => r.kind !== 'precise' && ['confirmed', 'modified', 'rejected'].includes(r.decision));
  return rv.length > 0 && !rv.some(r => new Date(r.created_at) >= new Date(a.again.at));
}
function isReviewed(code, p) {
  if (recheckConflicts(code, p).length || againPending(code, p)) return false;
  const l = latest[code][p.scene_id] || {};
  const lastRead = [l.quality, l.compare, l.precise].filter(Boolean).sort((a, b) => (isAfter(a, b) ? 1 : -1)).pop();
  const rv = reviewsOf(code, p.scene_id).filter(r => r.kind !== 'precise' && r.decision !== 'note');
  return rv.some(r => !lastRead || isAfter(r, lastRead));
}
function matches(code, p, type) {
  if (p.role !== 'task') return false;
  const l = latest[code][p.scene_id] || {};
  const q = l.quality?.data, c = l.compare?.data;
  if (!q && !c) return false;
  const a = aiOf(code, p);
  // 10-01 复核改过结论的期也留在“要处理的”队列里：改完之后建议可能变成“确认无误”，不能让它从你正在走的队列里消失
  if (type === 'ai-act') return ['modify', 'reject', 'uncomparable'].includes(a?.suggest?.decision) || !!a?.recheck?.items?.length || !!a?.again?.items?.length;
  if (type === 'again') return !!a?.again?.items?.length;
  if (type === 'ai-miss') return !!a?.misses?.length;
  if (type === 'recheck') return !!a?.recheck?.items?.length;
  if (type === 'ai-confirm') return a?.suggest?.decision === 'confirm' && !!c?.boxes?.length;
  if (type === 'changes') return c?.status === 'changes';
  if (type === 'none') return c?.status === 'none';
  if (type === 'uncomparable') return c?.status === 'uncomparable' || q?.clear === 'no';
  if (type === 'check3') return stepThree(p, l, reviewsOf(code, p.scene_id)).state === 'done';
  if (type === 'fb') return !!latestFb(code, p.scene_id);
  if (type === 'reply') return !!a?.again?.items?.some(x => x.sec === '留言答复');
  return true;
}
function buildItems() {
  const type = $('fType').value, only = $('fOnly').checked && type !== 'check3' && type !== 'fb';
  const all = [], out = [];
  periods[site].forEach((p, i) => { if (matches(site, p, type)) { all.push({ code: site, p, i }); if (!only || !isReviewed(site, p)) out.push({ code: site, p, i }); } });
  const done = all.filter(it => isReviewed(it.code, it.p)).length;
  $('progBar').style.width = all.length ? `${(100 * done / all.length).toFixed(1)}%` : '0';
  $('progText').textContent = `这一类 ${all.length} 期，已复核 ${done} 期${only ? `，还剩 ${out.length} 期` : ''}`;
  return out;
}
function renderList(keep = false) {
  if (!keep) items = buildItems();
  const box = $('qList');
  box.innerHTML = items.length ? '' : '<p class="tiny">没有符合条件的期。</p>';
  for (const it of items) {
    const b = document.createElement('button');
    const a = aiOf(it.code, it.p), c = (latest[it.code][it.p.scene_id] || {}).compare?.data;
    const dec = a?.suggest?.decision || 'none';
    b.className = cur && cur.code === it.code && cur.i === it.i ? 'cur' : '';
    const stu = c ? ({ changes: `${c.boxes?.length || 0} 框`, none: '无变化', uncomparable: '没法比较' })[c.status] || '' : '';
    const miss = a?.misses?.length ? ` · 漏${a.misses.length}` : '';
    const rcx = recheckConflicts(it.code, it.p).length || againPending(it.code, it.p);
    b.innerHTML = `<span class="sg ${dec}">${DEC_SHORT[dec]}</span>第 ${it.i} 期 ${it.p.date}${isReviewed(it.code, it.p) ? '<span class="done">✓</span>' : ''}${rcx ? '<span class="rck">重看</span>' : (a?.recheck?.items?.length ? '<span class="rcs">复</span>' : '')}${a?.again?.items?.length && !rcx ? `<span class="agm">${a.again.items.every(x => x.info) ? '答' : '议'}</span>` : ''}${latestFb(it.code, it.p.scene_id) ? '<span class="fbm">言</span>' : ''}<small>同学：${stu}${miss}${a?.suggest?.summary ? ` · ${esc(a.suggest.summary.slice(0, 26))}` : ''}</small>`;
    b.onclick = () => open(it);
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- AI 建议 → 一份完整的第二步数据
const geomClose = (g, b) => !!g && Math.abs(g[0] - b.x0) < 0.6 && Math.abs(g[1] - b.y0) < 0.6 && Math.abs(g[2] - b.x1) < 0.6 && Math.abs(g[3] - b.y1) < 0.6;
function aiBox(a, b) {
  // 放回复核的期（10-02 起）：对组长已保存的框直接给结论和动作，按框号和范围对上，优先于原结论（原结论只针对同学的框）
  const op = (a?.again?.ops || []).find(o => o.box === b.id && geomClose(o.geom, b));
  if (op) return { id: b.id, geom: op.geom, verdict: op.verdict, group: op.group, action: op.action, suggest_tags: op.tags || null, overall: op.overall || null,
    reason: `${op.src ? `${op.src}：` : ''}${op.reason || ''}`, confidence: op.confidence || null, seen: '看图', stale: false, note: op.note ?? null };
  const v = (a?.boxes || []).find(x => x.id === b.id);
  if (!v) return null;
  // 只是框号相同、位置完全不同的框（组长删掉同学的框后，新加的框用了同一个号）不套用 AI 结论（10-02 晚：2025-06-17 新框被建议删除）
  if (v.geom && boxIoU(b, v.geom) < 0.3) return null;
  const [x0, y0, x1, y1] = v.geom || [];
  return { ...v, stale: !(Math.abs(x0 - b.x0) < 0.6 && Math.abs(y0 - b.y0) < 0.6 && Math.abs(x1 - b.x1) < 0.6 && Math.abs(y1 - b.y1) < 0.6) };
}
function proposal(code, p, sd) {
  const a = aiOf(code, p);
  if (!a) return null;
  const sboxes = sd?.boxes || [];
  const keep = [], del = [];
  const ov = new Set((sd?.overall || []).filter(o => o !== 'none' && o !== 'local'));
  for (const b of sboxes) {
    const v = aiBox(a, b);
    if (v?.action === 'delete' && !v.stale) { del.push(b); if (v.overall) ov.add(v.overall); continue; }   // 框改动过，AI 结论针对旧框：不自动删
    const nb = clone(b);
    if (v?.suggest_tags) nb.tags = [...v.suggest_tags];
    if (v?.note != null) nb.note = v.note;
    keep.push(nb);
  }
  let next = sboxes.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
  const adds = (a.misses || []).map(m => ({ id: next++, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, tags: [...(m.suggest_tags || [])], note: `AI 提醒：${m.type}`, _miss: m.id,
    ...(m.before ? { before: m.before } : {}) }));
  // 置信度低于 CONF_MIN 的提醒照样显示，但不进“采用 AI 建议”（与整体建议的算法一致），看图后可以单独点“加入我的决定”
  const strong = new Set((a.misses || []).filter(m => (m.conf_p == null || m.conf_p >= CONF_MIN) && !m.no_adopt).map(m => m.id));
  // 组长已经加过的提醒（框还在，或放回复核建议删掉）不再加一次（2026-04-26：按过 A 之后再按 A，同一条提醒被加了两次）
  const have = b => keep.some(x => sameGeom(x, b)) || del.some(x => sameGeom(x, b));
  const boxes = [...keep, ...adds.filter(b => strong.has(b._miss) && !have(b))];
  const unc = a.suggest?.decision === 'uncomparable';
  const status = unc ? 'uncomparable' : boxes.length ? 'changes' : 'none';
  const o = [...ov];
  const data = unc ? { status, overall: [], other: sd?.other || '', boxes: [] }
    : { status, overall: boxes.length ? [...o, 'local'] : (o.length ? o : ['none']), other: sd?.other || '', boxes };
  return { data, del, adds, decision: a.suggest?.decision, comment: a.suggest?.comment || '' };
}
function packMine() {
  const boxes = mine.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags, note: b.note || '', ...(b.before ? { before: b.before } : {}) }));
  const rest = (mine.overall || []).filter(o => o !== 'none' && o !== 'local');
  const out = { status: boxes.length ? 'changes' : 'none', overall: boxes.length ? [...rest, 'local'] : rest.length ? rest : ['none'], other: mine.other || '', boxes };
  if (curBef?.moved && cur) { const bp = periods[cur.code][curBef.i]; out.before = { scene_id: bp.scene_id, date: bp.date, why: curBef.why }; }
  return out;
}
const sameData = (a, b) => JSON.stringify(normD(a)) === JSON.stringify(normD(b));
function normD(d) {
  if (!d) return null;
  return { s: d.status, o: [...(d.overall || [])].sort(), b: (d.boxes || []).map(b => [b.id, +b.x0.toFixed(1), +b.y0.toFixed(1), +b.x1.toFixed(1), +b.y1.toFixed(1), [...(b.tags || [])].sort(), b.note || '', b.before || '']) };
}

// ---------------------------------------------------------------- 打开一期
async function open(it, keepWork = false) {
  cur = it;
  blink = false; $('blinkBtn').classList.remove('on'); $('blinkBtn').textContent = '右图看上一期';
  refDate = null;
  const { code, p, i } = it;
  const per = periods[code], prev = per[i - 1];
  const l = latest[code][p.scene_id] || {}, pl = prev ? latest[code][prev.scene_id] || {} : {};
  const rvs = reviewsOf(code, p.scene_id);
  const s3 = curS3 = stepThree(p, l, rvs);
  const sd = s3.two.data;
  const a = aiOf(code, p);
  if (!keepWork) {
    mine = sd && sd.status !== 'uncomparable' ? clone(sd) : { status: 'none', overall: [], other: sd?.other || '', boxes: [] };
    mine.boxes = mine.boxes || [];
    mine.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
    linkMisses(a);
    $('comment').value = '';
    $('err').textContent = '';
    const last = latestFb(code, p.scene_id);
    fb = last ? { boxes: clone(last.data.boxes || {}), misses: clone(last.data.misses || {}), note: last.data.note || '' } : { boxes: {}, misses: {}, note: '' };
    $('innote').value = fb.note;
  }
  prop = proposal(code, p, sd);
  $('emptyMsg').hidden = true;
  $('content').hidden = false;
  { const at = items.findIndex(x => x.code === it.code && x.i === it.i); $('navPos').textContent = at >= 0 ? `队列第 ${at + 1} / ${items.length} 期` : '（不在当前队列里）'; }
  renderList(true);
  $('pTitle').textContent = `${sites[code].name} 第 ${i} 期 · ${fmtDate(p.date)}`;
  curBef = imageBefore(per, i, sid => latest[code][sid]);
  const bp = curBef.i != null ? per[curBef.i] : prev;
  $('pSub').innerHTML = curBef.moved
    ? `<b>前图 ${bp.date}（${bp.orbit}）</b>→ 这一期 ${p.date}（${p.orbit}），相隔 ${dayGap(p.date, bp.date)} 天 · ${esc(curBef.why)}，左图已换成最近一张看得清的 <button class="btn sm ghost" id="befBtn">看一眼上一期原图</button>`
    : `上一期 ${prev.date}（${prev.orbit}）→ 这一期 ${p.date}（${p.orbit}），相隔 ${p.gap_days} 天${curBef.stuck ? ` · <span style="color:#b45309">${esc(curBef.why)}</span>` : ''}`;
  const befBtn = $('befBtn');
  if (befBtn) befBtn.onclick = () => { const on = refDate === bp.date; setRef(on ? null : bp.date); befBtn.textContent = on ? '回到前图' : '看一眼上一期原图'; };
  const cd = a?.cond;
  const conds = [];
  if (cd) {
    const g = (x, y) => (x == null ? '—' : `${Math.round(x)}°`) + ' / ' + (y == null ? '—' : `${Math.round(y)}°`);
    conds.push(`<span class="badge ${Math.min(cd.glint_prev ?? 99, cd.glint_cur ?? 99) < 18 ? 'warn' : ''}">耀斑角 ${g(cd.glint_prev, cd.glint_cur)}</span>`);
    conds.push(`<span class="badge ${Math.max(cd.cloud_prev, cd.cloud_cur) > 0.3 ? 'warn' : ''}">云 ${Math.round(cd.cloud_prev * 100)}% / ${Math.round(cd.cloud_cur * 100)}%</span>`);
    if (cd.hazy_prev || cd.hazy_cur) conds.push(`<span class="badge warn">薄雾 ${cd.hazy_prev ? '上一期' : ''}${cd.hazy_prev && cd.hazy_cur ? '、' : ''}${cd.hazy_cur ? '这一期' : ''}</span>`);
    conds.push(`<span class="badge ${(cd.rain72_cur || 0) >= 50 ? 'warn' : ''}">72 小时降雨 ${Math.round(cd.rain72_prev || 0)} / ${Math.round(cd.rain72_cur || 0)} 毫米</span>`);
  }
  $('pConds').innerHTML = conds.join('');
  // 建议卡
  const dec = a?.suggest?.decision || 'none';
  $('sugCard').className = `rv-sug ${a ? dec : 'none'}`;
  const rcItems = a?.recheck?.items || [];
  const rcBad = new Set(recheckConflicts(code, p).map(x => x.box));
  const ACTN = { keep: '保留', retag: '保留并改类别', delete: '删除', check: '请看图定' };
  const rcSrc = [...new Set(rcItems.map(x => x.src || '10-01 复核'))].join('、');
  const rcHtml = rcItems.length ? `<div class="recheck${rcBad.size ? ' bad' : ''}"><b>${esc(rcSrc)}更新了这期的 AI 结论</b>${rcBad.size ? '：你在更新前做的决定和新结论对不上，请重看标红的框' : ''}
    ${rcItems.map(x => {
      const same = x.old === x.new && x.old_action === x.new_action;
      const head = same ? `框${x.box}：复核后维持 <b>${esc(x.new)}</b>（${ACTN[x.new_action] || x.new_action}）`
        : `框${x.box}：${esc(x.old)}（${ACTN[x.old_action] || x.old_action}）→ <b>${esc(x.new)}</b>（${ACTN[x.new_action] || x.new_action}）`;
      return `<div class="rci${rcBad.has(x.box) ? ' bad' : ''}">${head}<div class="tiny">${esc(x.ev)}</div></div>`;
    }).join('')}</div>` : '';
  const agItems = a?.again?.items || [];
  const agPend = againPending(code, p);
  const SEC = { 二: '10-01 夜分歧复核 · AI 可能对，再看一眼', 三: '10-01 夜分歧复核 · 薄云期判法要统一', 四: '10-01 夜分歧复核 · 要修的记录',
    反光复核: '10-02 反光复核', 像元复核: '10-02 像元标注时发现', 留言答复: '10-02 晚 · 答复你的留言', 前图规则: '10-03 前图规则' };
  const lastDec = reviewsOf(code, p.scene_id).filter(r => r.kind !== 'precise' && ['confirmed', 'modified', 'rejected'].includes(r.decision))
    .sort((x, y) => (isAfter(x, y) ? 1 : -1)).pop();
  const doneIt = x => !!lastDec && !!x.at && !!(lastDec._fresh || lastDec._pending || new Date(lastDec.created_at) >= new Date(x.at));
  const agOne = x => `<div class="agi${x.info ? ' info' : ''}"><span class="sec">${esc(SEC[x.sec] || x.sec)}</span>${x.info ? '<span class="sec ok">只是答复，不用重判</span>' : ''}<div class="tt">${esc(x.title)}</div><div>${esc(x.text)}</div><div class="sug">建议：${esc(x.sug)}</div>${x.ref ? `<button class="btn sm" data-ref="${esc(x.ref)}">左图换成 ${esc(x.ref)}（最近一张清楚影像）</button>` : ''}</div>`;
  const agLive = agItems.filter(x => !doneIt(x)), agOld = agItems.filter(doneIt);
  const agHtml = agItems.length ? `<div class="again${agPend ? ' bad' : ''}"><b>${!agPend && agLive.length && agLive.every(x => x.info) ? 'AI 答复你的留言' : '放回复核的说明'}</b>${agPend ? '：你之前在这期做的决定先不算，看完下面的说明后重新做一次决定' : agLive.length ? '' : '：都已重判过'}
    ${agLive.map(agOne).join('')}${agOld.length ? `<details class="agold"><summary>之前放回、你已重判过的说明（${agOld.length} 条）</summary>${agOld.map(agOne).join('')}</details>` : ''}</div>` : '';
  $('sugCard').innerHTML = a
    ? `${agHtml}${rcHtml}<div class="t">${esc(a.suggest.title)}</div>${a.suggest.summary ? `<div class="s">${esc(a.suggest.summary)}</div>` : ''}
       ${a.flags?.length ? `<div class="flags">${a.flags.map(esc).join('<br>')}</div>` : ''}
       <div class="row"><button class="btn sm primary" id="adoptBtn" title="A">采用 AI 建议</button><button class="btn sm" id="resetBtn">恢复同学原样</button></div>`
    : '<div class="t">这一期没有 AI 数据</div><div class="s">本机没有找到 ai/ai_' + code + '.json，可以照常复核。</div>';
  if (a) { $('adoptBtn').onclick = adoptAI; $('resetBtn').onclick = () => { open(cur); toast('已恢复同学原样'); }; }
  $('sugCard').querySelectorAll('[data-ref]').forEach(btn => { btn.onclick = () => setRef(refDate === btn.dataset.ref ? null : btn.dataset.ref); });
  // 同学的判读
  const q = l.quality?.data, pq = pl.quality?.data;
  const qt = d => !d ? '还没做' : `${QUALITY_NAME[d.clear] || d.clear}${d.clear !== 'yes' && d.reasons?.length ? `（${d.reasons.join('、')}）` : ''}`;
  let ct = '还没做';
  if (sd) ct = sd.status === 'uncomparable' ? '没法比较' : `${(sd.overall || []).map(o => OVERALL_NAME[o] || o).join('、') || '—'}${sd.other ? `；${esc(sd.other)}` : ''}${s3.two.source === 'leader' ? '〔组长修改后〕' : ''}`;
  const verdict = s3.two.verdict ? `<br><span class="badge ok">已复核：${({ confirmed: '确认', modified: '修改并确认', rejected: '不是变化' })[s3.two.verdict.decision]}${s3.two.verdict._demo ? '（演示）' : ''}</span>` : '';
  $('stuText').innerHTML = `第一步：上一期 ${qt(pq)}；这一期 ${qt(q)}<br>第二步：${ct}${verdict}`;
  // 影像
  va.setImage(prev[imgKind], `上一期 ${prev.date}`);
  vb.setImage(p[imgKind], `这一期 ${p.date}`);
  scene.aoi = sites[code].aoi ? sites[code].aoi.ring : null;
  scene.rail = sites[code].railway.lines;
  curPrevQ = clone(pq?.boxes || []);
  scene.setLayer('prevQ', clone(curPrevQ), { style: 'quality', viewer: 0, labels: false });
  scene.setLayer('curQ', clone(q?.boxes || []), { style: 'quality', viewer: 1, labels: false });
  const pb = (s3.precise?.data?.boxes || []).map(m => ({ id: m.id, c0: m.c0, r0: m.r0, w: m.w, h: m.h, cells: decodeCells(m.rle, m.w * m.h), ai: m.ai || null }));
  scene.setPaint(pb.length ? { boxes: pb, current: null, brush: 1, size: 1, editable: false, show: showPaint, grid: false } : null);
  setLayers();
  if (curBef?.moved) setRef(per[curBef.i].date);
  renderBoxes();
  renderMisses();
  renderOverall();
  renderS3(pb);
  renderHist(code, p, rvs);
  $('decConfirm').textContent = sd?.status === 'changes' ? '确认同学结果（开放第三步）' : '确认同学结果';
  requestAnimationFrame(() => { if (!scene._fitted) { scene.fit(); scene._fitted = true; } else scene.render(); });
  const cells = await loadMap(code, p.date);
  if (cur !== it) return;
  const hl = (a?.misses || []).map(m => [m.x0, m.y0, m.x1, m.y1]);
  scene.setAiMap(cells ? { cells, show: showMap, viewer: 1, highlight: hl, fadeOthers: true } : null);
  $('mapBtn').disabled = !cells;
  $('mapBtn').classList.toggle('on', !!cells && showMap);
  const pre = pb.some(m => m.ai) ? await loadPrefill(code, p.date) : null;
  if (cur !== it) return;
  if (pb.length && (cells || pre)) renderS3(pb, cells, pre);
}

function setLayers() {
  for (const n of ['boxes', 'del', 'miss']) delete scene.layers[n];
  const a = cur ? aiOf(cur.code, cur.p) : null;
  const sd = curS3?.two?.data;
  if (view === 'student') {
    scene.setLayer('boxes', clone(sd?.boxes || []), { style: 'change' });
  } else if (view === 'ai' && prop) {
    scene.setLayer('del', clone(prop.del), { style: 'ghost' });
    scene.setLayer('boxes', clone(prop.data.boxes.filter(b => !b._miss)), { style: 'change' });
    scene.setLayer('miss', prop.adds.map(b => ({ ...b, label: missLabel(a, b) })), { style: 'ai' });
  } else {
    scene.setLayer('boxes', mine.boxes, { style: 'change', editable: true });
    const added = new Set(mine.boxes.map(b => b._miss).filter(Boolean));
    scene.setLayer('miss', (prop?.adds || []).filter(b => !added.has(b._miss)).map(b => ({ ...b, label: missLabel(a, b) })), { style: 'ai' });
  }
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  scene.render();
}
function setView(v) {
  view = v;
  if (v !== 'mine' && scene.mode === 'draw') scene.setMode('pan');
  setLayers();
  $('boxHint').textContent = v === 'mine' ? '（在“我的决定”里编辑）' : v === 'ai' ? '（正在看 AI 建议，切回“我的决定”才能编辑）' : '（正在看同学原样）';
}

// ---------------------------------------------------------------- 右栏：框
function aiBlock(v) {
  if (!v) return '<div class="ai"><span class="g doubt">没有 AI 结论</span><div class="why">这个框是复核之后才画或改的，请看图定。</div></div>';
  const g = GROUP_CLASS[v.group] || 'doubt';
  let act = '';
  if (v.action === 'delete') act = `建议：删除这个框${v.overall ? `，${OV_HINT[v.overall] || ''}` : ''}`;
  else if (v.action === 'retag') act = `建议：类别改为 ${v.suggest_tags.map(t => TAG[t] || t).join('、')}`;
  else if (v.action === 'keep') act = v.soft ? '建议：保留，可加上“农田”类别' : '建议：保留';
  else act = '建议：请你看图定';
  return `<div class="ai"><span class="g ${g}">${esc(v.group)}</span>${esc(v.verdict)}${v.confidence ? ` <span class="tiny">把握：${esc(v.confidence)}</span>` : ''}${v.seen === '看图' ? ' <span class="tiny">· 看过图</span>' : ''}
    ${v.reason ? `<div class="why">${esc(v.reason)}</div>` : ''}${v.stale ? '<div class="why" style="color:#b45309">同学在复核之后改动过这个框，AI 结论针对旧框。</div>' : ''}<div class="act">${act}</div></div>`;
}
function renderBoxes() {
  const list = $('boxList');
  list.innerHTML = '';
  const code = cur.code, a = aiOf(code, cur.p);
  const sd = curS3?.two?.data;
  const sboxes = sd?.boxes || [];
  const ids = new Set(sboxes.map(b => b.id));
  const entries = [...sboxes.map(b => ({ b, stu: true })), ...mine.boxes.filter(b => !ids.has(b.id)).map(b => ({ b, stu: false }))];
  if (!entries.length) list.innerHTML = '<p class="tiny">同学这一期没有画框。</p>';
  for (const { b, stu } of entries) {
    const m = mine.boxes.find(x => x.id === b.id);
    const v = stu ? aiBox(a, b) : null;
    const item = document.createElement('div');
    item.className = 'boxitem' + (m ? '' : ' gone') + (scene.selected === b.id && m ? ' sel' : '');
    const tagsNow = (m || b).tags || [];
    const chips = m && view === 'mine' ? `<div class="chips" style="margin-top:8px">${TAGS.map(t => `<button class="chip${tagsNow.includes(t.key) ? ' on' : ''}" data-tag="${t.key}">${t.label}</button>`).join('')}</div>` : '';
    const stuLine = stu ? `同学：${esc(b.tags.map(t => TAG[t] || t).join('、') || '未选类别')}${b.note ? `；${esc(b.note)}` : ''}` : `我加的框${b.note ? `：${esc(b.note)}` : ''}`;
    item.innerHTML = `<div class="bh"><span class="num">${b.id}</span><span class="small">${stuLine}</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button>${scene.selected === b.id && m ? '<button class="btn sm ghost" data-act="unsel">取消选中</button>' : ''}
      ${view === 'mine' ? (m ? `${v && v.action !== 'check' ? '<button class="btn sm ghost" data-act="ai">按 AI</button>' : ''}<button class="btn sm ghost danger" data-act="del">删除</button>` : '<button class="btn sm ghost" data-act="restore">恢复</button>') : ''}</div>
      ${stu ? aiBlock(v) : ''}${chips}${fbRow(fb.boxes[b.id], FB_BOX, '对这个框的留言（存数据库，同学看不到）')}`;
    bindFb(item, fb.boxes, b.id);
    item.addEventListener('click', e => {
      if (e.target.dataset.fb || e.target.dataset.fbt) return;
      const act = e.target.dataset.act, tag = e.target.dataset.tag;
      if (act === 'focus') { scene.focusBox(b); if (m) scene.select(b.id); return; }
      if (act === 'unsel') { scene.select(null); return; }
      if (view !== 'mine') return;
      if (act === 'del' && m) { mine.boxes.splice(mine.boxes.indexOf(m), 1); scene.selected = null; afterEdit(); return; }
      if (act === 'restore') { mine.boxes.push(clone(b)); mine.boxes.sort((x, y) => x.id - y.id); afterEdit(); return; }
      if (act === 'ai' && m && v) {
        if (v.action === 'delete') { mine.boxes.splice(mine.boxes.indexOf(m), 1); if (v.overall && !mine.overall.includes(v.overall)) mine.overall.push(v.overall); }
        else if (v.suggest_tags) m.tags = [...v.suggest_tags];
        afterEdit(); return;
      }
      if (tag && m) { const k = m.tags.indexOf(tag); if (k >= 0) m.tags.splice(k, 1); else m.tags.push(tag); afterEdit(); return; }
      if (m) scene.select(b.id);
    });
    list.appendChild(item);
    if (m && view === 'mine') annotateBoxR(item, m);
  }
}
async function annotateBoxR(item, m) {
  const it = cur, per = periods[it.code], latestOf = sid => latest[it.code][sid];
  const host = document.createElement('div');
  host.className = 'tiny boxbefore';
  item.appendChild(host);
  if (m.before) {
    const j = per.findIndex(x => x.scene_id === m.before);
    if (j < 0) return;
    host.innerHTML = `这个框和 <b>${per[j].date}</b> 比（前图在这里看不清）。<button class="btn sm ghost" data-b="see">左图换成这一张</button><button class="btn sm ghost" data-b="clr">改回和前图比</button>`;
    host.querySelector('[data-b="see"]').onclick = e => { e.stopPropagation(); setRef(per[j].date); };
    host.querySelector('[data-b="clr"]').onclick = e => { e.stopPropagation(); delete m.before; afterEdit(); };
    return;
  }
  const start = curBef?.i ?? it.i - 1;
  const s0 = await boxSeen(per[start], m, latestOf);
  if (cur !== it || s0.ok) return;
  const r = await boxBefore(per, it.i, start, m, latestOf);
  if (cur !== it) return;
  const why = s0.glint ? '前图是反光影像，水面范围量不准' : `这个框在前图里被挡住 ${Math.round(s0.frac * 100)}%`;
  if (r.i == null) { host.innerHTML = `<span class="warnt">${why}，往前 120 天也没有这里看得清的影像。</span>`; return; }
  host.innerHTML = `<span class="warnt">${why}。</span><button class="btn sm" data-b="use">改和 ${per[r.i].date} 比（隔 ${dayGap(it.p.date, per[r.i].date)} 天）</button>`;
  host.querySelector('[data-b="use"]').onclick = e => { e.stopPropagation(); m.before = per[r.i].scene_id; setRef(per[r.i].date); afterEdit(); };
}
const CONF_MIN = 0.5;
function missLabel(a, b) {
  const m = (a?.misses || []).find(x => x.id === b._miss);
  return m?.conf_p != null ? `${b._miss} ${Math.round(m.conf_p * 100)}%` : b._miss;
}
const CONF_CLS = { 高: 'c-hi', 较高: 'c-mh', 中: 'c-md', 低: 'c-lo' };
function confBadge(m) {
  if (m.conf_p == null) return '';
  return `<span class="cbadge ${CONF_CLS[m.conf_level] || ''}" title="是真实变化的概率（多种方法的证据按看图样本校准）">置信度 ${m.conf_p.toFixed(2)} · ${esc(m.conf_level)}</span>`;
}
function confEvidence(m) {
  const e = m.conf_ev;
  if (!e) return '';
  const chip = (v, name) => `<span class="ev ${v === true ? 'ok' : v === false ? 'no' : 'na'}" title="${v === true ? '支持' : v === false ? '不支持' : '算不了'}">${v === true ? '✓' : v === false ? '✗' : '–'} ${name}</span>`;
  const ind = e.ind == null ? chip(null, '独立指数') : `<span class="ev ${e.ind >= 2 ? 'ok' : e.ind === 1 ? 'mid' : 'no'}" title="换检测没用到的波段（红边、NBR、B12 或 NDWI、B8A、B12），三个里支持的个数">独立指数 ${e.ind}/3</span>`;
  return `<div class="evs">${ind}${chip(e.def, '检测指数强')}${chip(e.ts, '时序断点')}${chip(e.orb, '两轨道一致')}${chip(e.seg, '分割对象')}${chip(e.mad, 'IR-MAD')}${m.conf_vis ? `<span class="ev vis">看图：${esc(m.conf_vis)}</span>` : ''}</div>`;
}
function renderMisses() {
  const a = aiOf(cur.code, cur.p);
  const adds = prop?.adds || [];
  $('missSec').hidden = !adds.length;
  const list = $('missList');
  list.innerHTML = '';
  for (const b of adds) {
    const m = (a.misses || []).find(x => x.id === b._miss);
    const added = mine.boxes.some(x => x._miss === b._miss);
    const item = document.createElement('div');
    const low = m.conf_p != null && m.conf_p < CONF_MIN;
    const note = /^（(不对|已移到|说明)/.test(m.type || '');
    item.className = 'boxitem miss' + (added ? ' added' : '') + (low ? ' lowconf' : '') + (note ? ' corr' : '');
    item.innerHTML = `<div class="bh"><span class="num">${b._miss}</span><span class="small"><b>${esc(m.type)}</b>${m.rail_m != null ? ` · 距铁路约 ${m.rail_m} 米` : ''}${m.area_ha ? ` · ${m.area_ha} 公顷` : ''}</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button>${view === 'mine' ? (added ? '<button class="btn sm ghost" data-act="undo">撤回</button>' : note ? '<span class="tiny notetag">更正说明，不用加</span>' : '<button class="btn sm" data-act="add">加入我的决定</button>') : ''}</div>
      <div class="ai">${!note && confBadge(m) ? `<div class="cline">${confBadge(m)}</div>` : ''}<span class="g ${note ? 'corr' : m.type.includes('水') ? 'water' : 'real'}">${note ? '更正' : '漏标'}</span>${esc(m.reason)}<div class="why">来源：${esc(m.source || '')}${m.confidence ? ` · 原把握：${esc(m.confidence)}` : ''} ${note ? '' : ` · 建议类别：${(m.suggest_tags || []).map(t => TAG[t] || t).join('、')}`}</div>${note ? '' : confEvidence(m)}${m.conf_note ? `<div class="why">${esc(m.conf_note)}</div>` : ''}${low && !note ? `<div class="why lowtip">置信度低于 ${CONF_MIN}：不计入 AI 整体建议，“采用 AI 建议”也不会加入；看图觉得是，就点“加入我的决定”。</div>` : ''}${m.no_adopt && !note ? `<div class="why lowtip">${esc(m.no_adopt_why || '“采用 AI 建议”不会加入这条，要加就点“加入我的决定”。')}</div>` : ''}</div>
      ${fbRow(fb.misses[b._miss], FB_MISS, '对这条提醒的留言（存数据库）')}`;
    bindFb(item, fb.misses, b._miss);
    item.addEventListener('click', e => {
      if (e.target.dataset.fb || e.target.dataset.fbt) return;
      const act = e.target.dataset.act;
      if (act === 'focus') { scene.focusBox(b); return; }
      if (act === 'add') {
        const dup = mine.boxes.find(x => sameGeom(x, b));
        if (dup) { toast(`这条提醒已经在你的决定里了（框 ${dup.id}）`); return; }
        const nb = clone(b); nb.id = scene.nextId(); mine.boxes.push(nb); afterEdit(); toast(`已加入：框 ${nb.id}`);
      }
      if (act === 'undo') { const k = mine.boxes.findIndex(x => x._miss === b._miss); if (k >= 0) mine.boxes.splice(k, 1); afterEdit(); }
    });
    list.appendChild(item);
  }
}
function fbRow(x, opts, ph) {
  x = x || { flags: [], text: '' };
  return `<div class="fbrow"><span class="tiny">我的标记</span>${opts.map(([k, l]) => `<button class="chip fb${(x.flags || []).includes(k) ? ' on' : ''}" data-fb="${k}">${l}</button>`).join('')}
    <input class="input fbtext" data-fbt="1" maxlength="300" placeholder="${ph}" value="${esc(x.text || '')}"></div>`;
}
function bindFb(item, store, key) {
  const get = () => (store[key] = store[key] || { flags: [], text: '' });
  item.querySelectorAll('[data-fb]').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    const x = get(), k = btn.dataset.fb, i = x.flags.indexOf(k);
    if (i >= 0) x.flags.splice(i, 1); else x.flags.push(k);
    btn.classList.toggle('on', i < 0);
  });
  const inp = item.querySelector('[data-fbt]');
  inp.onclick = e => e.stopPropagation();
  inp.oninput = () => { get().text = inp.value.trim(); };
}
const fbClean = o => Object.fromEntries(Object.entries(o || {}).filter(([, x]) => (x.flags || []).length || x.text));
function fbPack() {
  return { kind: 'leader_feedback', version: 1, boxes: fbClean(fb.boxes), misses: fbClean(fb.misses), note: ($('innote').value || '').trim(), ai_decision: aiDec(cur.code, cur.p) };
}
const fbIsEmpty = d => !d.note && !Object.keys(d.boxes).length && !Object.keys(d.misses).length;
const fbSame = (d, r) => !!r && JSON.stringify([d.boxes, d.misses, d.note]) === JSON.stringify([fbClean(r.data.boxes), fbClean(r.data.misses), r.data.note || '']);
function fbText(d) {
  const part = (o, pre, names) => Object.entries(o || {}).map(([k, x]) => `${pre}${k}：${[...(x.flags || []).map(f => names[f] || f), x.text ? `“${x.text}”` : ''].filter(Boolean).join('、')}`);
  return [...part(d.boxes, '框', FB_NAME_BOX), ...part(d.misses, '提醒 ', FB_NAME_MISS), d.note ? `备注“${d.note}”` : ''].filter(Boolean).join('；');
}

function renderOverall() {
  const box = $('overallChips');
  box.innerHTML = OV_CHOICES.map(o => `<button class="chip${(mine.overall || []).includes(o.key) ? ' on' : ''}" data-ov="${o.key}" ${view !== 'mine' ? 'disabled' : ''}>${o.label}</button>`).join('');
  box.querySelectorAll('[data-ov]').forEach(b => b.onclick = () => {
    const k = b.dataset.ov, ov = mine.overall = (mine.overall || []).filter(x => x !== 'none' && x !== 'local');
    const j = ov.indexOf(k); if (j >= 0) ov.splice(j, 1); else ov.push(k);
    afterEdit();
  });
}
function afterEdit() {
  setLayers();
  renderBoxes();
  renderMisses();
  renderOverall();
  const changed = !sameData(packMine(), curS3?.two?.data && curS3.two.data.status !== 'uncomparable' ? curS3.two.data : null);
  $('decModify').classList.toggle('primary', changed);
}
// 已经加进决定的提醒：按范围认回来（_miss 不存进数据库），提醒上显示“撤回”，不会再加一次（2026-04-26 同一条提醒加了两次）
function linkMisses(a) {
  for (const m of a?.misses || []) { const hit = mine.boxes.find(x => !x._miss && sameGeom(x, m)); if (hit) hit._miss = m.id; }
}
function adoptAI() {
  if (!prop) return;
  if (prop.decision === 'uncomparable') { toast('AI 建议改为“没法比较”：直接点“改为没法比较”（U）'); $('comment').value = prop.comment; return; }
  mine = clone(prop.data);
  mine.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
  linkMisses(aiOf(cur.code, cur.p));
  mine.overall = (mine.overall || []).filter(o => o !== 'none' && o !== 'local');
  if (!$('comment').value.trim()) $('comment').value = prop.comment;
  setView('mine');
  afterEdit();
  toast(prop.decision === 'reject' ? 'AI 建议“不是变化”：框都已按 AI 删除，可直接点“不是变化”（R）' : '已采用 AI 建议，看一下再点“按我的决定保存”（S）');
}

// ---------------------------------------------------------------- 第三步检查
function renderS3(pb, cells, pre) {
  const st = curS3?.state;
  const show = ['done', 'returned', 'checked'].includes(st);
  $('s3Sec').hidden = !show;
  if (!show) return;
  $('s3State').textContent = { done: '待检查', returned: '已退回', checked: '已通过' }[st];
  const lines = [];
  for (const m of pb) {
    let n1 = 0, both = 0, ai1 = 0;
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
      const s = m.cells[j * m.w + i] === 1, a = cells ? cells[(m.r0 + j) * 256 + m.c0 + i] === 1 : false;
      if (s) n1++; if (a) ai1++; if (s && a) both++;
    }
    const iou = cells && n1 + ai1 - both > 0 ? `，与 AI 变化图重合 ${Math.round(100 * both / (n1 + ai1 - both))}%` : '';
    let used = '';
    if (m.ai) {   // 同学用了第三步的 AI 预标：和预标逐格比，看改了多少（一格没改的要特别看一眼）
      let diff = 0;
      if (pre) for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.cells[j * m.w + i] !== pre[(m.r0 + j) * 256 + m.c0 + i]) diff++;
      used = pre ? `（用了 AI 预标，改了 ${diff} 格${diff ? '' : '，<b>一格没改</b>'}）` : '（用了 AI 预标）';
    }
    lines.push(`框 ${m.id}：同学涂“变化” ${n1} 格${used}${cells ? `，AI 认为变化 ${ai1} 格${iou}` : ''}`);
  }
  $('s3Text').innerHTML = lines.join('<br>') || '同学还没涂。';
}
$('s3Toggle').onclick = () => { showPaint = !showPaint; if (scene.paint) { scene.paint.show = showPaint; scene.render(); } $('s3Toggle').textContent = showPaint ? '隐藏同学涂色' : '显示同学涂色'; };
document.querySelectorAll('[data-dec3]').forEach(b => b.onclick = () => saveCheck(b.dataset.dec3));

function renderHist(code, p, rvs) {
  const KN = { quality: '第一步', compare: '第二步', precise: '第三步' };
  const DN = r => isFb(r) ? `内部留言：${esc(fbText(r.data))}` : (r.kind === 'precise' ? ({ confirmed: '第三步没问题', returned: '退回第三步' })[r.decision] : ({ confirmed: '确认', modified: r.data?.status === 'uncomparable' ? '改为没法比较' : '修改并确认', rejected: '不是变化', note: '批注' })[r.decision]) || r.decision;
  const h = [
    ...rows.filter(r => r.site === code && r.scene_id === p.scene_id).map(r => ({ t: r.created_at, s: `同学${r.data?.deleted ? '删除了' : '保存了'}${KN[r.kind] || r.kind}` })),
    ...rvs.map(r => ({ t: r.created_at, s: `组长${r._demo ? '（演示）' : ''}：${DN(r)}${r.comment ? ` —— ${esc(r.comment)}` : ''}` })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  $('hist').innerHTML = h.map(x => `<div>${fmtTime(x.t)}　${x.s}</div>`).join('') || '<div>暂无</div>';
}

// ---------------------------------------------------------------- 保存决定
async function writeReview(row, msg) {
  if (mode === 'live') {
    const res = await append('reviews', row);
    res.row._fresh = true;
    sync.reviews.add(res.row);
  } else saveDemo(row);
  if (msg) toast(msg + (mode === 'demo' ? '（演示模式，没有写入数据库）' : ''));
}
// 先存留言（有改动才存），再存决定：这样同学那边看到的最新一条仍是组长的决定
async function saveFeedback(code, p, kind, reading) {
  const d = fbPack();
  const last = latestFb(code, p.scene_id);
  if ((fbIsEmpty(d) && !last) || fbSame(d, last)) return false;
  await writeReview({ site: code, scene_id: p.scene_id, kind, reading_id: reading?.id || null, decision: 'note', data: d, comment: null }, '');
  return true;
}
async function decide(dec) {
  if (!cur) return;
  const { code, p } = cur;
  const l = latest[code][p.scene_id] || {};
  const kind = l.compare ? 'compare' : 'quality';
  const reading = l[kind];
  const comment = $('comment').value.trim();
  let decision = dec, data = null, msg = '';
  if (dec === 'fbonly') {
    try {
      const saved = await saveFeedback(code, p, kind, reading);
      toast(saved ? `已保存留言和标记，这一期仍留在待复核队列${mode === 'demo' ? '（演示模式，没有写入数据库）' : ''}` : '没有新的留言或标记');
      if (saved) { renderList(true); open(cur, true); }
    } catch (err) { $('err').textContent = err.message; }
    return;
  }
  if (dec === 'note' && !comment) { $('err').textContent = '请先写批注。'; return; }
  // 批注和决定要对得上（10-01 夜：有 8 期批注写着“判没法比较”或“漏标”，决定却是无变化或没法比较，同学看得到）
  if (comment && dec !== 'note') {
    const say = { confirmed: '确认同学结果', modified: '按我的决定保存', rejected: '不是变化' }[dec];
    if (dec !== 'uncomparable' && /没法比较/.test(comment)
      && !confirm(`批注里写着“没法比较”，但这次保存的是“${say}”。同学会看到这条批注。\n\n仍要这样保存吗？（取消后可以改批注，或按 U 改为没法比较）`)) return;
    if (dec === 'uncomparable' && /漏标/.test(comment)
      && !confirm('批注里写着“漏标”，但这次保存的是“没法比较”（框和漏标都不算）。同学会看到这条批注。\n\n仍要这样保存吗？')) return;
    if (dec === 'modified' || dec === 'confirmed') {
      // 批注里每一句“漏标：X”都要有一个从提醒加进来的框（框的备注是“AI 提醒：X……”）；确认同学结果时漏标一个也加不进去
      const head = t => t.replace(/^AI 提醒：/, '').split('（')[0].trim();
      const kept = dec === 'modified' ? mine.boxes : (curS3?.two?.data?.boxes || []);   // 确认时保留的是第二步现在的框（组长改过的就是组长的框）
      const lack = [];
      for (const t of new Set([...comment.matchAll(/漏标：([^（；;\n]+)/g)].map(x => x[1].trim()))) {
        const said = comment.split(`漏标：${t}`).length - 1;
        const have = kept.filter(b => (b.note || '').startsWith('AI 提醒：') && head(b.note) === t).length;
        if (said > have) lack.push(t);
      }
      if (lack.length && !confirm(`批注里写着“漏标：${lack.join('、')}”，但${dec === 'confirmed' ? '这次是“确认同学结果”，现在的框里没有对应的框，漏标不会加进去' : '决定里没有对应的框'}。同学会看到这条批注。\n\n仍要这样保存吗？（取消后可以删掉批注里的这几句，或在提醒上点“加入我的决定”）`)) return;
    }
  }
  if (dec === 'modified') {
    const dup = mine.boxes.find((x, k) => mine.boxes.some((y, j) => j < k && sameGeom(x, y)));
    if (dup && !confirm(`框 ${dup.id} 和另一个框范围完全一样，重复了。\n\n仍要这样保存吗？（取消后删掉一个再保存）`)) return;
  }
  if (dec === 'modified') {
    const bad = mine.boxes.find(b => !b.tags.length && !b.note);
    if (bad) { $('err').textContent = `框 ${bad.id} 还没选类别。`; return; }
    data = packMine();
    msg = `已保存：按你的决定（${data.boxes.length} 个框）${data.status === 'changes' && kind === 'compare' ? '，第三步已开放' : ''}`;
  } else if (dec === 'uncomparable') {
    decision = 'modified';
    data = { status: 'uncomparable', overall: [], other: curS3?.two?.data?.other || '', boxes: [] };
    msg = '已保存：改为没法比较';
  } else msg = { confirmed: `已确认同学结果${curS3?.two?.data?.status === 'changes' && kind === 'compare' ? '，第三步已开放' : ''}`, rejected: '已保存：不是变化', note: '已加批注' }[dec];
  $('err').textContent = '';
  try {
    const savedFb = await saveFeedback(code, p, kind, reading);
    await writeReview({ site: code, scene_id: p.scene_id, kind, reading_id: reading?.id || null, decision, data, comment: comment || null }, msg + (savedFb ? '，留言已一起保存' : ''));
    next(1, true);
  } catch (err) { $('err').textContent = err.message; }
}
async function saveCheck(decision) {
  if (!cur || !curS3?.precise) return;
  const comment = $('comment').value.trim();
  if (decision === 'returned' && !comment) { $('err').textContent = '退回时请在批注里写明要改什么，同学会看到。'; return; }
  try {
    await writeReview({ site: cur.code, scene_id: cur.p.scene_id, kind: 'precise', reading_id: curS3.precise.id, decision, data: null, comment: comment || null },
      decision === 'confirmed' ? '已保存：第三步没问题' : '已退回第三步');
    next(1, true);
  } catch (err) { $('err').textContent = err.message; }
}
function next(step, afterSave = false) {
  if (!items.length) return;
  const at = cur ? items.findIndex(it => it.code === cur.code && it.i === cur.i) : -1;
  if (afterSave) {
    const was = cur;
    items = buildItems();
    const k = items.findIndex(it => it.i > was.i);
    renderList(true);
    if (k >= 0) open(items[k]); else { open(was, true); toast('这一类已经复核完了'); }
    return;
  }
  const k = Math.min(items.length - 1, Math.max(0, at + step));
  open(items[k]);
  const L = $('qList'), el = L.children[k];
  if (el && (el.offsetTop < L.scrollTop || el.offsetTop + el.offsetHeight > L.scrollTop + L.clientHeight)) L.scrollTop = el.offsetTop - L.clientHeight / 3;
}

// ---------------------------------------------------------------- 模式、工具栏、键盘
function renderMode() {
  const b = $('modeBtn');
  b.textContent = mode === 'live' ? '正式模式（写入数据库）' : '演示模式（不写数据库）';
  b.className = `mode-btn ${mode === 'live' ? 'live' : 'demo'}`;
}
$('modeBtn').onclick = () => {
  if (mode === 'live') { mode = 'demo'; try { localStorage.setItem(MODE_KEY, 'demo'); } catch { /* ignore */ } renderMode(); renderList(); if (cur) open(cur, true); toast('已切换到演示模式'); return; }
  $('modeModal').classList.add('show');
};
$('modeCancel').onclick = () => $('modeModal').classList.remove('show');
$('modeOk').onclick = () => { mode = 'live'; try { localStorage.setItem(MODE_KEY, 'live'); } catch { /* ignore */ } $('modeModal').classList.remove('show'); renderMode(); renderList(); if (cur) open(cur, true); toast('已切换到正式模式：决定会写入数据库'); };
$('helpBtn').onclick = () => $('helpModal').classList.add('show');
$('helpClose').onclick = () => $('helpModal').classList.remove('show');
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => setView(b.dataset.view));
document.querySelectorAll('#imgSeg button').forEach(b => b.onclick = () => setImg(b.dataset.img));
function setImg(k) {
  imgKind = k;
  document.querySelectorAll('#imgSeg button').forEach(x => x.classList.toggle('on', x.dataset.img === k));
  if (cur) {
    const prev = periods[cur.code][cur.i - 1], rp = refDate ? periods[cur.code].find(x => x.date === refDate) : null;
    va.setImage((rp || prev)[k]); vb.setImage(blink ? prev[k] : cur.p[k]);
  }
}
function setRef(d) {
  if (!cur) return;
  const per = periods[cur.code], prev = per[cur.i - 1];
  const rp = d ? per.find(x => x.date === d) : null;
  refDate = rp ? d : null;
  if (rp) {
    const auto = curBef?.moved && per[curBef.i]?.date === d;
    va.setImage(rp[imgKind], auto ? `前图 ${rp.date}（上一期被挡住，换成最近一张看得清的）` : `对照 ${rp.date}（不是上一期）`);
    scene.setLayer('prevQ', clone(latest[cur.code][rp.scene_id]?.quality?.data?.boxes || []), { style: 'quality', viewer: 0, labels: false });   // 这张影像自己的“看不清”框
  } else {
    va.setImage(prev[imgKind], `上一期 ${prev.date}`);
    scene.setLayer('prevQ', clone(curPrevQ), { style: 'quality', viewer: 0, labels: false });
  }
  scene.render();
  document.querySelectorAll('#sugCard [data-ref]').forEach(b => {
    const on = b.dataset.ref === refDate;
    b.classList.toggle('on', on);
    b.textContent = on ? '左图回到上一期' : `左图换成 ${b.dataset.ref}（最近一张清楚影像）`;
  });
}
function setBlink(on) {
  if (!cur) return;
  blink = on;
  const prev = refDate ? periods[cur.code].find(x => x.date === refDate) : periods[cur.code][cur.i - 1];
  if (on) vb.setImage(prev[imgKind], `${prev.date}（右图正在看左图那一期）`);
  else vb.setImage(cur.p[imgKind], `这一期 ${cur.p.date}`);
  $('blinkBtn').classList.toggle('on', on);
  $('blinkBtn').textContent = on ? '右图回到这一期' : '右图看上一期';
}
$('blinkBtn').onclick = () => setBlink(!blink);
$('prevBtn').onclick = () => next(-1);
$('nextBtn').onclick = () => next(1);
function toggleBare(on = !scene.bare) {
  scene.bare = on;
  scene.render();
  $('bareBtn').classList.toggle('on', on);
  $('bareBtn').textContent = on ? '原图（按 H 恢复）' : '原图';
}
$('bareBtn').onclick = () => toggleBare();
$('clearMine').onclick = () => {
  if (view !== 'mine') setView('mine');
  if (!mine.boxes.length) { toast('“我的决定”里已经没有框了'); return; }
  mine.boxes.splice(0, mine.boxes.length);
  scene.selected = null;
  afterEdit();
  toast('已清空“我的决定”里的框：按 D 自己画框，选好类别后按 S 保存');
};
$('mapBtn').onclick = () => { showMap = !showMap; scene.toggleAiMap(showMap); $('mapBtn').classList.toggle('on', showMap && !!scene.aiMap); };
$('drawBtn').onclick = () => { if (view !== 'mine') setView('mine'); if (scene.bare) toggleBare(false); scene.setMode(scene.mode === 'draw' ? 'pan' : 'draw'); };
$('fitBtn').onclick = () => scene.fit();
scene.onMode = m => $('drawBtn').classList.toggle('on', m === 'draw');
scene.onChange = () => { if (view === 'mine') afterEdit(); };
scene.onSelect = () => renderBoxes();
document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => decide(b.dataset.dec));
$('skipBtn').onclick = () => next(1);
$('fType').onchange = () => renderList();
$('fOnly').onchange = () => renderList();

window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('.modal-back.show')) { if (e.key === 'Escape') document.querySelectorAll('.modal-back').forEach(m => m.classList.remove('show')); return; }
  const k = e.key.toLowerCase();
  if (k === 'b' && cur && !blink) { setBlink(true); return; }
  if (!cur && !['arrowright', 'j'].includes(k)) return;
  const act = { arrowright: () => next(1), j: () => next(1), arrowleft: () => next(-1), k: () => next(-1), a: adoptAI, c: () => decide('confirmed'), s: () => decide('modified'),
    r: () => decide('rejected'), u: () => decide('uncomparable'), n: () => decide('fbonly'), 1: () => setView('student'), 2: () => setView('ai'), 3: () => setView('mine'),
    t: () => setImg(imgKind === 'tc' ? 'fc' : 'tc'), m: () => $('mapBtn').click(), d: () => $('drawBtn').click(), f: () => scene.fit(), h: () => toggleBare() }[k];
  if (act) { e.preventDefault(); act(); }
});
window.addEventListener('keyup', e => {
  if (e.key.toLowerCase() === 'b' && blink) setBlink(false);
});

// ---------------------------------------------------------------- 启动
async function main() {
  renderMode();
  sites = await loadSites();
  for (const c of SITE_ORDER) periods[c] = await loadPeriods(c);
  const got = await Promise.all(SITE_ORDER.map(loadAI));
  SITE_ORDER.forEach((c, k) => { ai[c] = got[k]; });
  if (!SITE_ORDER.includes(site)) site = 'ZZ';
  const tabs = $('siteTabs');
  tabs.innerHTML = SITE_ORDER.map(c => `<button data-site="${c}" class="${c === site ? 'on' : ''}"><i style="background:${sites[c].color}"></i>${sites[c].name}</button>`).join('');
  tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
    site = b.dataset.site;
    try { localStorage.setItem(SITE_KEY, site); } catch { /* ignore */ }
    tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    cur = null; $('content').hidden = true; $('emptyMsg').hidden = false;
    renderList();
  });
  if (!SITE_ORDER.some(c => ai[c])) $('fType').value = 'changes';
  if (!SITE_ORDER.some(c => ai[c]) && aiKeyState !== 'plain') unlockForm($('emptyMsg'));
  for (const c of SITE_ORDER) latest[c] = {};
  try { await loadAll(); } catch { $('updated').textContent = '暂时连不上数据库'; }
  renderList();
  if (items.length) open(items[0]);
  setInterval(async () => {
    if (document.hidden) return;
    try { await loadAll(); } catch { return; }
    renderList(true);
  }, 90000);
}
main();
