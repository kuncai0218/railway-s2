// Reading workbench: step 1 = is this image readable, step 2 = what changed since the previous image,
// step 3 = paint exactly which 10 m cells changed inside the boxes the leader confirmed.
import { Scene } from './viewer.js';
import { append, onQueueChange, pendingRows, uuid, tableSync } from './api.js';
import { loadSites, loadPeriods, loadReadings, latestByScene, periodState, progress, fmtDate, fmtTime, stable,
  stepTwo, stepThree, STEP3_NAME, canStep3, cellRange, sameGeom, encodeCells, decodeCells, countCells,
  imageBefore, boxBefore, boxSeen, dayGap } from './store.js';
import { QUALITY_REASONS, CHANGE_TAGS, QUALITY_LEVELS, OVERALL, QUALITY_NAME, OVERALL_NAME } from './config.js';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const code = (query.get('site') || 'HY').toUpperCase();
const practice = query.get('practice') === '1';   // practice mode: nothing leaves this browser
const PRACTICE_KEY = `rs2_practice_${code}`;
// “农田”是组长复核时加的类别（第二步的选项里没有），第三步的框上要能显示
const TAG = { farm: '农田', ...Object.fromEntries(CHANGE_TAGS.map(t => [t.key, t.label])) };
const clone = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const emptyQ = () => ({ clear: null, reasons: [], other: '', boxes: [], also_blurry: false });
const emptyC = () => ({ overall: [], other: '', boxes: [] });
const HINT12 = '滚轮放大 · 按住拖动 · 双击复原 · 画框时按住空格可临时拖动';
const HINT3 = '滚轮放大 · 在框里按住涂格子 · 框外按住拖动（或按住空格 / 右键）· H 隐藏涂色 · Ctrl+Z 撤销';
const TODO3 = ['open', 'returned'];
const CARD3 = { wait: '等组长确认第二步', open: '待做', done: '已保存，等组长检查', returned: '被组长退回', checked: '组长已检查通过' };

let site, periods, rows = [], latest = {}, reviews = [];
const reviewSync = tableSync('reviews', { site: `eq.${code}` });
let editing = false;   // the open period was already finished: saving keeps you on it
let k = 0, step = 1, q = emptyQ(), c = emptyC(), imgKind = 'tc';
let pz = null;                  // step 3 working copy of the open period
// 前图（2026-10-03）：上一期被云挡住过半或第一步“基本看不清”时，左图换成最近一张看得清的（store.js imageBefore）
let bef = null;                 // { i, prev, why, moved, stuck }
let leftOverride = null;        // 临时换的左图（看上一期原图、某个框的前图）；换期时清掉
let brush = 1, brushSize = 1;   // kept from period to period
let aiShow = true;              // 第三步：AI 预标（prefill/index.json 里列出的期才有；10-03 起株洲南、衡阳北都有，10-03 晚起韶关南也有）
const aiMaps = {};
let prefillInfo = null;         // 本测点的预标说明 { version, dates, note }；没有预标时为 null
const prefillReady = fetch('prefill/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  .then(ix => { prefillInfo = ix?.[code] || null; return prefillInfo; });
// 预标图 256×256：0 不涂、100 变化、200 拿不准（只在组长确认的框里有值）
function loadAiMap(date) {
  if (!aiMaps[date]) aiMaps[date] = prefillReady.then(info => (!info || !(info.dates || []).includes(date)) ? null : new Promise(res => {
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
    img.src = `prefill/${code}/${date}.png?v=${encodeURIComponent(info.version || '')}`;
  }));
  return aiMaps[date];
}

const scene1 = new Scene();
const scene2 = new Scene();
const scene3 = new Scene();
const v1 = scene1.addViewer($('v1'));
const v2a = scene2.addViewer($('v2a'));
const v2b = scene2.addViewer($('v2b'));
const v3a = scene3.addViewer($('v3a'));
const v3b = scene3.addViewer($('v3b'));
const scenes = [scene1, scene2, scene3];
const active = () => scenes[step - 1];

// ---------- helpers ----------
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}
const cur = () => periods[k];
const prevPeriod = () => periods[k - 1] || null;
const latestOf = sid => latest[sid];
function computeBefore() { bef = cur().role === 'task' ? imageBefore(periods, k, latestOf) : null; }
// 这一对的前图（存进记录、决定能不能比）；左图现在显示的那张（可能临时换成上一期原图或某个框的前图）
const pairBefore = () => (bef && bef.i != null ? periods[bef.i] : prevPeriod());
const leftPeriod = () => (leftOverride != null ? periods[leftOverride] : pairBefore());
const draftKey = kind => `rs2_${practice ? 'pdraft' : 'draft'}_${code}_${cur().scene_id}_${kind}`;
// Only the step being edited keeps a draft, so a finished step never looks "unsaved".
function saveDraft() {
  try {
    if (step === 1) localStorage.setItem(draftKey('quality'), JSON.stringify(q));
    else if (step === 2 && cur().role === 'task') localStorage.setItem(draftKey('compare'), JSON.stringify(c));
    else if (step === 3 && pz) localStorage.setItem(draftKey('precise'), JSON.stringify({ boxes: pz.boxes.map(packBox) }));
  } catch { /* storage full or blocked: the server copy is the real record */ }
}
function readDraft(kind) { try { return JSON.parse(localStorage.getItem(draftKey(kind))); } catch { return null; } }
function clearDraft(kind) { try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ } }

function recompute() { latest = latestByScene(rows); }
function stateOf(p) { return periodState(p, latest); }

// This period's reviews, oldest first. Practice mode has no leader: a saved step 2 counts as confirmed, so step 3 can be tried.
function reviewsOf(p = cur()) {
  if (!practice) return reviews.filter(r => r.scene_id === p.scene_id);
  const cmp = latest[p.scene_id]?.compare;
  return cmp ? [{ id: `practice-${cmp.id}`, scene_id: p.scene_id, kind: 'compare', decision: 'confirmed', created_at: cmp.created_at, _fresh: cmp._fresh, _pending: cmp._pending }] : [];
}
const three = (p = cur()) => stepThree(p, latest[p.scene_id] || {}, reviewsOf(p));
const todo3 = () => periods.map((p, i) => i).filter(i => TODO3.includes(three(periods[i]).state));

// ---------- header ----------
function renderHeader() {
  const p = cur();
  const pr = progress(periods, latest);
  $('siteName').textContent = site.name;
  $('siteColor').style.background = site.color;
  document.title = `${site.name} 判读 · 三测点逐期判读`;
  if (p.role === 'baseline') {
    $('periodTitle').textContent = '第 0 期';
    $('periodDate').textContent = `${fmtDate(p.date)} · ${p.satellite} ${p.orbit}`;
    $('periodGap').textContent = '最早的一期，只看能否看清';
  } else {
    $('periodTitle').textContent = `第 ${k} / ${site.n_tasks} 期`;
    $('periodDate').textContent = `${fmtDate(p.date)} · ${p.satellite} ${p.orbit}`;
    $('periodGap').textContent = p.gap_days === 0 ? '和上一期同一天拍摄，只差约 10 分钟' : `距上一期 ${p.gap_days} 天`;
  }
  $('progBar').style.width = `${Math.round(pr.finished / pr.total * 100)}%`;
  $('progText').textContent = `已完成 ${pr.finished} / ${pr.total} 期`;
  $('btnPrev').disabled = k === 0;
  $('btnNext').disabled = k === periods.length - 1;
  const t3 = todo3();
  $('btnP3').hidden = !t3.length;
  $('btnP3').textContent = `第三步待做 ${t3.length} 期`;
}

function setSaveBadge(n) {
  const b = $('saveState');
  if (n > 0) { b.className = 'badge warn'; b.textContent = `有 ${n} 条等待上传，联网后自动上传`; }
  else { b.className = 'badge ok'; b.textContent = '✓ 全部已保存'; }
}
onQueueChange(setSaveBadge);

// ---------- images ----------
function label(p, role) { return `${role} ${fmtDate(p.date)}`; }
function leftRole(i) {
  if (i === k - 1) return leftOverride != null && bef?.moved ? '上一期（被挡住的原图）' : '上一期';
  if (i === bef?.i && leftOverride == null) return '前图（上一期被挡住，换成最近一张看得清的）';
  return '对照';
}
function renderImages() {
  const p = cur();
  v1.setImage(p[imgKind], label(p, '这一期'));
  computeBefore();
  const lp = leftPeriod();
  if (lp) {
    const li = periods.indexOf(lp);
    v2a.setImage(lp[imgKind], label(lp, leftRole(li)));
    v2b.setImage(p[imgKind], label(p, `这一期 · 隔 ${dayGap(p.date, lp.date)} 天`));
    v3a.setImage(lp[imgKind], label(lp, leftRole(li)));
    v3b.setImage(p[imgKind], label(p, '这一期'));
    if (step === 3 && pz) setLeft3(pz.boxes.find(b => b.id === scene3.paint?.current));
  }
}

// ---------- step switching ----------
function setStep(n) {
  step = n;
  scenes.forEach((s, i) => { s.active = i === n - 1; });
  for (const i of [1, 2, 3]) { $(`views${i}`).hidden = n !== i; $(`panel${i}`).hidden = n !== i; }
  renderTabs();
  $('segPaint').hidden = n !== 3;
  $('modeDraw').textContent = n === 3 ? '涂格子' : '画框';
  $('hint').textContent = n === 3 ? HINT3 : HINT12;
  active().setMode(n === 3 ? 'paint' : 'pan');
  if (n !== 3) requestAnimationFrame(() => { if (!active()._fitted) { active().fit(); active()._fitted = true; } else active().render(); });
  if (n === 1) renderPanel1(); else if (n === 2) renderPanel2(); else renderPanel3();
}

function renderTabs() {
  const p = cur();
  const l = latest[p.scene_id] || {};
  const task = p.role === 'task';
  const s3 = three();
  $('stepTab1').className = step === 1 ? 'on' : l.quality ? 'done' : '';
  $('stepTab2').className = step === 2 ? 'on' : l.compare ? 'done' : '';
  const t3 = $('stepTab3');
  t3.className = step === 3 ? 'on' : !canStep3(s3) ? 'lock' : TODO3.includes(s3.state) ? 'todo' : 'done';
  t3.title = s3.state ? STEP3_NAME[s3.state] : '这一期没有局部变化，不用做第三步';
  $('stepTab2').style.visibility = task ? 'visible' : 'hidden';
  t3.style.visibility = task ? 'visible' : 'hidden';
}

// ---------- step 1 ----------
function renderPanel1() {
  const p = cur();
  document.querySelectorAll('[data-clear]').forEach(b => b.classList.toggle('on', q.clear === b.dataset.clear));
  $('unclearBlock').hidden = !q.clear || q.clear === 'yes';
  $('reasonChips').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', q.reasons.includes(b.dataset.reason)));
  $('qOther').value = q.other || '';
  const needBoxes = q.clear === 'partial';
  $('qBoxField').hidden = !needBoxes;
  $('qAlso').checked = !!q.also_blurry;
  scene1.setLayer('quality', q.boxes, { style: 'quality', editable: needBoxes });
  renderQBoxList();
  let lab = '下一步：和上一期比';
  if (p.role === 'baseline') lab = '保存，进入下一期';
  else if (q.clear === 'no') lab = '保存（这一期没法比较），进入下一期';
  $('save1').textContent = lab;
  $('err1').textContent = '';
}

function renderQBoxList() {
  const list = $('qBoxList');
  list.innerHTML = '';
  if (!q.boxes.length) { list.innerHTML = '<div class="tiny">还没有框。</div>'; return; }
  for (const b of q.boxes) {
    const item = document.createElement('div');
    item.className = 'boxitem q' + (scene1.selected === b.id ? ' sel' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<div class="bh" style="margin:0"><span class="num">${b.id}</span><span>看不清的地方</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button><button class="btn sm ghost danger" data-act="del">删除</button></div>`;
    item.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'del') { q.boxes.splice(q.boxes.indexOf(b), 1); scene1.selected = null; scene1.render(); saveDraft(); renderQBoxList(); return; }
      scene1.select(b.id);
      if (act === 'focus') scene1.focusBox(b);
    });
    list.appendChild(item);
  }
}

function validateQ() {
  if (!q.clear) return '请先选这一期看得清的程度。';
  if (q.clear !== 'yes' && !q.reasons.length && !q.other.trim()) return '请至少选一个原因，或者在“其他原因”里写一句。';
  if (q.clear === 'partial' && !q.boxes.length) return '选了“有些地方看不清”，请在图上画框圈出看不清的地方。';
  return '';
}

function cleanQ() {
  const d = { clear: q.clear };
  if (q.clear !== 'yes') {
    d.reasons = q.reasons;
    d.other = q.other.trim();
  }
  if (q.clear === 'partial') {
    d.boxes = q.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
    d.also_blurry = !!q.also_blurry;
  }
  return d;
}

async function saveRow(kind, data) {
  const p = cur();
  // prev_scene_id 记这一对实际比的前图（上一期被挡住时是更早的那张）；第一步只看这一期，仍记上一期
  const row = { site: code, scene_id: p.scene_id, prev_scene_id: kind === 'quality' ? p.prev : (pairBefore()?.scene_id || p.prev), kind, data };
  let res;
  if (practice) {
    res = { row: { id: uuid(), created_at: new Date().toISOString(), ...row }, queued: false };
    try { const list = JSON.parse(localStorage.getItem(PRACTICE_KEY) || '[]'); list.push(res.row); localStorage.setItem(PRACTICE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  } else res = await append('readings', row);
  res.row._fresh = true;   // newer than anything read from the server, whatever this computer's clock says
  rows.push(res.row);
  recompute();
  clearDraft(kind);
  if (res.queued) toast('网络不稳，已先存在本机，联网后自动上传');
  return res;
}

async function onSave1() {
  const msg = validateQ();
  $('err1').textContent = msg;
  if (msg) return;
  const btn = $('save1');
  btn.disabled = true;
  try {
    const data = cleanQ();
    const p = cur();
    const l = latest[p.scene_id] || {};
    const same = !!l.quality && stable(data) === stable(l.quality.data);   // re-saving an unchanged step adds no version
    if (same) clearDraft('quality'); else await saveRow('quality', data);
    if (p.role === 'baseline') { toast(same ? '没有改动' : editing ? '已保存修改' : '已保存'); goTo(editing ? k : k + 1); return; }
    if (data.clear === 'no') {
      const unchanged = same && l.compare?.data?.status === 'uncomparable' && l.compare.data.reason === 'current_unclear';
      if (!unchanged) await saveRow('compare', { status: 'uncomparable', reason: 'current_unclear' });
      toast(unchanged ? '没有改动' : editing ? '已保存修改：这一期基本看不清，记为没法比较' : '已保存：这一期基本看不清，记为没法比较');
      goTo(editing ? k : k + 1);
      return;
    }
    renderHeader();
    setStep(2);
  } catch (err) {
    $('err1').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- step 2 ----------
function prevQuality() { const pp = pairBefore(); return pp ? latest[pp.scene_id]?.quality?.data || null : null; }
function leftQuality() { const pp = leftPeriod(); return pp ? latest[pp.scene_id]?.quality?.data || null : null; }

// Step 2 content that matters, in a fixed form, to tell whether a re-save changes anything.
function normC(d) {
  if (!d || d.status === 'uncomparable') return stable(d || null);
  const boxes = (d.boxes || []).map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: [...(b.tags || [])].sort(), note: (b.note || '').trim(), before: b.before || null }));
  const overall = [...new Set([...(d.overall || []).filter(o => o !== 'local'), ...(boxes.length ? ['local'] : [])])].sort();
  return stable({ overall, other: (d.other || '').trim(), boxes });
}

function renderPanel2() {
  const pq = prevQuality();
  const prevFull = pq && pq.clear === 'no';
  let note = '';
  if (!pq) note = `<div class="notice warn">${bef?.moved ? '左边这一期' : '上一期'}还没判断能不能看清。建议先回到那一期完成第一步。</div>`;
  if (prevFull) note = '<div class="notice warn">上一期基本看不清，往前 120 天也找不到看得清的影像，这一对没法比较。直接点“保存，进入下一期”即可。</div>';
  if (bef?.moved) {
    const bp = pairBefore();
    note = `<div class="notice">${esc(bef.why)}，左边换成了最近一张看得清的 <b>${fmtDate(bp.date)}</b>（和这一期隔 ${dayGap(cur().date, bp.date)} 天）。按左边这张比：看这一期和它比有没有变化。
      <button class="btn sm ghost" id="leftToggle">${leftOverride === k - 1 ? '回到前图' : '看一眼上一期原图'}</button></div>` + note;
  } else if (bef?.stuck && !prevFull) note = `<div class="notice warn">${esc(bef.why)}，只能和上一期比，被挡住的地方不画框。</div>` + note;
  const two = stepTwo(latest[cur().scene_id] || {}, reviewsOf());
  if (cur().gap_days === 0) note += '<div class="notice">这两景是同一天拍的，只差约 10 分钟（两颗卫星从不同方向看），地面不会真的变化。只在“不同点”里记整体差异（如颜色、水面发白发亮），一般不用画框。</div>';
  if (two.source === 'leader') note += '<div class="notice">下面是组长修改后的版本。</div>';
  if (!practice && two.verdict?.decision === 'rejected') note += `<div class="notice warn">组长认为这一期标的不是变化${two.verdict.comment ? `：${esc(two.verdict.comment)}` : ''}。</div>`;
  else if (!practice && two.verdict) note += '<div class="notice">组长已经确认了这一步。如果再改动并保存，要等组长重新确认，第三步会暂时关闭。</div>';
  $('pairNote').innerHTML = note;
  const lt = $('leftToggle');
  if (lt) lt.onclick = () => { leftOverride = leftOverride === k - 1 ? null : k - 1; renderImages(); renderPanel2(); };
  const blurry = x => x && (x.clear === 'blurry' || (x.clear === 'partial' && x.also_blurry));
  $('blurNote').innerHTML = !prevFull && (blurry(q) || blurry(pq))
    ? `<div class="notice warn">${blurry(q) && blurry(pq) ? '这两期' : blurry(q) ? '这一期' : '上一期'}整体偏模糊，只记你能确定的不同；拿不准的选“有差别，但说不清是什么”。</div>` : '';
  scene2.setLayer('prevQuality', clone((leftQuality() && leftQuality().boxes) || []), { style: 'quality', viewer: 0, labels: false });
  scene2.setLayer('curQuality', clone(q.boxes || []), { style: 'quality', viewer: 1, labels: false });
  scene2.setLayer('change', c.boxes, { style: 'change', editable: !prevFull });
  document.querySelectorAll('[data-overall]').forEach(b => { b.classList.toggle('on', c.overall.includes(b.dataset.overall)); b.disabled = prevFull; });
  $('cBoxList').closest('.field').style.opacity = prevFull ? 0.5 : 1;
  $('cOther').value = c.other || '';
  $('cOther').disabled = prevFull;
  $('cDraw').disabled = prevFull;
  renderCBoxList();
  $('err2').textContent = '';
}

function renderCBoxList() {
  const list = $('cBoxList');
  list.innerHTML = '';
  if (!c.boxes.length) { list.innerHTML = '<div class="tiny">还没有框。没有变化就选上面的“没有明显不同”。</div>'; return; }
  for (const b of c.boxes) {
    const item = document.createElement('div');
    item.className = 'boxitem' + (scene2.selected === b.id ? ' sel' : '');
    const chips = CHANGE_TAGS.map(t => `<button class="chip${b.tags.includes(t.key) ? ' on' : ''}" data-tag="${t.key}">${t.label}</button>`).join('');
    item.innerHTML = `<div class="bh"><span class="num">${b.id}</span><span>这一处是什么变化？</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button><button class="btn sm ghost danger" data-act="del">删除</button></div>
      <div class="chips">${chips}</div>
      <input class="input" style="margin-top:8px;height:34px" maxlength="200" placeholder="其他（自己写，可以不填）" value="${(b.note || '').replace(/"/g, '&quot;')}">`;
    item.addEventListener('click', e => {
      const act = e.target.dataset.act;
      const tag = e.target.dataset.tag;
      if (act === 'del') { c.boxes.splice(c.boxes.indexOf(b), 1); scene2.selected = null; scene2.render(); saveDraft(); renderCBoxList(); return; }
      if (tag) {
        const i = b.tags.indexOf(tag);
        if (i >= 0) b.tags.splice(i, 1); else b.tags.push(tag);
        e.target.classList.toggle('on');
        saveDraft();
      }
      if (e.target.tagName !== 'INPUT') scene2.select(b.id);
      if (act === 'focus') scene2.focusBox(b);
    });
    item.querySelector('input').addEventListener('input', e => { b.note = e.target.value; saveDraft(); });
    list.appendChild(item);
    if (pairBefore()) annotateBox(item, b);
  }
}

// 框在这一对的前图里被挡住两成以上（云、云影、第一步圈的看不清），或水的框遇上反光：提示，并可改和最近一张这里看得清的影像比（记在框上 before）
async function annotateBox(item, b) {
  const host = document.createElement('div');
  host.className = 'tiny boxbefore';
  item.appendChild(host);
  const kk = k;
  if (b.before) {
    const j = periods.findIndex(x => x.scene_id === b.before);
    if (j < 0) return;
    host.innerHTML = `这个框和 <b>${fmtDate(periods[j].date)}</b> 比（前图在这里看不清）。<button class="btn sm ghost" data-b="see">左图换成这一张</button><button class="btn sm ghost" data-b="clr">改回和前图比</button>`;
    host.querySelector('[data-b="see"]').onclick = e => { e.stopPropagation(); leftOverride = j; renderImages(); renderPanel2(); };
    host.querySelector('[data-b="clr"]').onclick = e => { e.stopPropagation(); delete b.before; leftOverride = null; renderImages(); saveDraft(); renderPanel2(); };
    return;
  }
  const start = bef?.i ?? k - 1;
  const s0 = await boxSeen(periods[start], b, latestOf);
  if (kk !== k || s0.ok) return;
  const r = await boxBefore(periods, k, start, b, latestOf);
  if (kk !== k) return;
  const why = s0.glint ? '前图是反光影像，水面范围量不准' : `这个框在前图里被挡住 ${Math.round(s0.frac * 100)}%`;
  if (r.i == null) { host.innerHTML = `<span class="warnt">${why}，往前 120 天也没有这里看得清的影像：这里先不画框，或选“有差别，但说不清是什么”。</span>`; return; }
  host.innerHTML = `<span class="warnt">${why}。</span><button class="btn sm" data-b="use">改和 ${fmtDate(periods[r.i].date)} 比（隔 ${dayGap(cur().date, periods[r.i].date)} 天）</button>`;
  host.querySelector('[data-b="use"]').onclick = e => { e.stopPropagation(); b.before = periods[r.i].scene_id; leftOverride = r.i; renderImages(); saveDraft(); renderPanel2(); };
}

function validateC() {
  const pq = prevQuality();
  if (pq && pq.clear === 'no') return '';
  const none = c.overall.includes('none');
  if (!c.overall.length && !c.boxes.length && !c.other.trim()) return '请在“不同点”里至少选一项；没有不同就选“没有明显不同”。';
  if (none && (c.boxes.length || c.overall.length > 1)) return '选了“没有明显不同”，就不能再选别的不同点或画框。';
  if (c.overall.includes('local') && !c.boxes.length) return '选了“地面有局部变化”，请在图上画框标出来。';
  const bad = c.boxes.find(b => !b.tags.length && !(b.note || '').trim());
  if (bad) return `框 ${bad.id} 还没选是什么变化（选一项，或者在它下面写一句）。`;
  return '';
}

async function onSave2() {
  const msg = validateC();
  $('err2').textContent = msg;
  if (msg) return;
  const btn = $('save2');
  btn.disabled = true;
  try {
    const pq = prevQuality();
    let data;
    if (pq && pq.clear === 'no') data = { status: 'uncomparable', reason: 'previous_unclear' };
    else {
      const boxes = c.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags, note: (b.note || '').trim(), ...(b.before ? { before: b.before } : {}) }));
      const overall = [...new Set([...c.overall, ...(boxes.length ? ['local'] : [])])];
      data = { status: boxes.length ? 'changes' : 'none', overall, other: c.other.trim(), boxes };
      if (bef?.moved) data.before = { scene_id: pairBefore().scene_id, date: pairBefore().date, why: bef.why };
    }
    // an unchanged re-save adds no version, so the leader's confirmation (and step 3) stays valid
    const now = stepTwo(latest[cur().scene_id] || {}, reviewsOf()).data;
    if (now && normC(data) === normC(now)) { clearDraft('compare'); toast('没有改动'); goTo(k); return; }
    await saveRow('compare', data);
    if (editing) { toast('已保存修改'); goTo(k); return; }
    toast(data.status === 'changes' ? `已保存，记录了 ${data.boxes.length} 处不同。组长确认后会开放第三步` : '已保存');
    goTo(k + 1);
  } catch (err) {
    $('err2').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- step 3 ----------
// ai：这个框用过 AI 预标（记预标版本），组长检查时会和预标逐格比
function packBox(bx) {
  return { id: bx.id, x0: bx.x0, y0: bx.y0, x1: bx.x1, y1: bx.y1, c0: bx.c0, r0: bx.r0, w: bx.w, h: bx.h, rle: encodeCells(bx.cells), ...countCells(bx.cells),
    ...(bx.ai ? { ai: bx.ai } : {}) };
}
const painted = bx => { const n = countCells(bx.cells); return n.n1 + n.n2 > 0; };

// Working copy: the confirmed boxes, with cells from this browser's draft or from the last save.
// If the leader moved or resized a box since, the cells that still fall inside it are kept.
function buildPaint() {
  const p = cur();
  const s3 = three();
  const src = readDraft('precise')?.boxes || s3.precise?.data?.boxes || [];
  const boxes = s3.boxes.map(b => {
    const r = cellRange(b);
    const bx = { id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags || [], note: b.note || '', before: b.before || null, ...r, cells: new Uint8Array(r.w * r.h), moved: false };
    const m = src.find(x => x.id === b.id);
    if (!m) return bx;
    const old = decodeCells(m.rle, m.w * m.h);
    if (m.c0 === r.c0 && m.r0 === r.r0 && m.w === r.w && m.h === r.h) bx.cells = old;
    else {
      for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
        const v = old[j * m.w + i];
        const cc = m.c0 + i - r.c0, rr = m.r0 + j - r.r0;
        if (v && cc >= 0 && rr >= 0 && cc < r.w && rr < r.h) bx.cells[rr * r.w + cc] = v;
      }
    }
    bx.moved = !sameGeom(m, b);
    if (m.ai) bx.ai = m.ai;
    return bx;
  });
  pz = { scene: p.scene_id, boxes };
  const first = boxes.find(b => !painted(b)) || boxes[0];
  scene3.setPaint({ boxes, current: first ? first.id : null, brush, size: brushSize, editable: true, show: true, grid: true });
  scene3.setLayer('targets', boxes, { style: 'target' });
  scene3.setLayer('prevQ', clone(leftQuality()?.boxes || []), { style: 'qline', viewer: 0, labels: false });
  scene3.setLayer('curQ', clone(q.boxes || []), { style: 'qline', viewer: 1, labels: false });
  if (first) requestAnimationFrame(() => scene3.focusBox(first, 1.6));
  setLeft3(first);
  scene3.setAiMap(null);
  $('aiBox3').hidden = true; $('toggleAi').hidden = true; $('wandBtn').hidden = true;
  const sid = p.scene_id;
  loadAiMap(p.date).then(cells => {
    if (!pz || pz.scene !== sid) return;
    if (!cells) { if (brush === 3) { brush = 1; if (scene3.paint) scene3.paint.brush = 1; renderBrushUI(); } return; }
    scene3.setAiMap({ cells, show: aiShow, viewer: null });
    $('aiBox3').hidden = false; $('toggleAi').hidden = false; $('wandBtn').hidden = false;
    $('aiNote3').textContent = prefillInfo?.note || '';
    $('toggleAi').classList.toggle('on', aiShow);
  });
}

// 用 AI 预标填一个框的格子（1 变化、2 拿不准、0 不涂），可以撤销
function fillFromAI(bx) {
  const cells = scene3.aiMap?.cells;
  if (!cells) return false;
  scene3.pushUndo(bx);
  for (let j = 0; j < bx.h; j++) for (let i = 0; i < bx.w; i++) {
    const v = cells[(bx.r0 + j) * 256 + bx.c0 + i];
    bx.cells[j * bx.w + i] = v === 1 ? 1 : v === 2 ? 2 : 0;
  }
  bx.ai = prefillInfo?.version || 'ai';
  return true;
}

function renderPanel3() {
  if (!pz || pz.scene !== cur().scene_id) buildPaint();
  const s3 = three();
  let note = '';
  if (s3.check?.decision === 'returned') note += `<div class="notice warn">组长退回了第三步${s3.check.comment ? `：${esc(s3.check.comment)}` : ''}。改好后重新保存。</div>`;
  else if (s3.state === 'checked') note += '<div class="notice">组长已经检查通过。还要修改的话，改完重新保存，会再交给组长检查。</div>';
  else if (s3.state === 'done') note += '<div class="notice">已经保存过，等组长检查。还可以修改后重新保存。</div>';
  if (pz.boxes.some(b => b.moved)) note += '<div class="notice warn">标了 ! 的框在第二步里改过位置或大小，原来涂的格子已经尽量保留，请再检查一遍。</div>';
  if (practice) note += '<div class="notice">练习模式：正式判读时，第三步要等组长确认第二步以后才会开放。</div>';
  $('p3Note').innerHTML = note;
  renderBrushUI();
  renderPaintToggles();
  renderPBoxList();
  $('err3').textContent = '';
}

function renderBrushUI() {
  document.querySelectorAll('[data-brush]').forEach(b => b.classList.toggle('on', Number(b.dataset.brush) === brush));
  document.querySelectorAll('[data-size]').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === brushSize));
}
function renderPaintToggles() {
  $('togglePaint').classList.toggle('on', !!scene3.paint?.show);
  $('toggleGrid').classList.toggle('on', !!scene3.paint?.grid);
}

function renderPBoxList() {
  const list = $('pBoxList');
  list.innerHTML = '';
  const curId = scene3.paint?.current;
  for (const bx of pz.boxes) {
    const { n1, n2 } = countCells(bx.cells);
    const item = document.createElement('div');
    item.className = 'boxitem p' + (bx.id === curId ? ' sel' : '');
    const st = n1 + n2 ? `<span class="pst ok">✓ ${[n1 ? `变化 ${n1} 格` : '', n2 ? `拿不准 ${n2} 格` : ''].filter(Boolean).join(' · ')}</span>` : '<span class="pst todo">还没涂</span>';
    const tags = esc(bx.tags.map(t => TAG[t] || t).join('、') || '未选类别');
    item.innerHTML = `<div class="bh" style="margin:0"><span class="num">${bx.id}</span><span class="ptags">${tags}${bx.moved ? ' <span class="moved" title="组长调整过这个框">!</span>' : ''}</span><span class="sp"></span>${st}</div>
      ${bx.note ? `<div class="tiny" style="margin-top:4px">${esc(bx.note)}</div>` : ''}
      ${bx.id === curId ? '<div class="pbtns"><button class="btn sm ghost" data-act="focus">定位</button><button class="btn sm ghost" data-act="fill">整框涂成变化</button><button class="btn sm ghost danger" data-act="clear">清空这个框</button></div>' : ''}`;
    item.addEventListener('click', e => {
      const act = e.target.dataset.act;
      if (act === 'fill' || act === 'clear') { fillBox(bx, act === 'fill' ? 1 : 0); return; }
      pickBox(bx.id, act === 'focus' || bx.id !== curId);
    });
    list.appendChild(item);
  }
}

function pickBox(id, focus) {
  if (!scene3.paint || !pz) return;
  scene3.paint.current = id;
  scene3.paintChanged();
  const bx = pz.boxes.find(b => b.id === id);
  if (focus && bx) scene3.focusBox(bx, 1.6);
  setLeft3(bx);
  renderPBoxList();
}

// 第三步：涂哪个框，左图就是那个框的前图（第二步记的 before；没记的，前图在框里看不清时自动往前找）
async function setLeft3(bx) {
  if (!bx) return;
  const kk = k;
  let j = bx.before ? periods.findIndex(x => x.scene_id === bx.before) : -1;
  const start = bef?.i ?? k - 1;
  if (j < 0) { const r = await boxBefore(periods, k, start, bx, latestOf); j = r.i ?? start; }
  if (kk !== k || j < 0) return;
  const bp = periods[j];
  v3a.setImage(bp[imgKind], label(bp, j === start ? leftRole(j) : `框 ${bx.id} 的前图（整张前图在这里看不清）`));
  scene3.setLayer('prevQ', clone(latest[bp.scene_id]?.quality?.data?.boxes || []), { style: 'qline', viewer: 0, labels: false });
  scene3.render();
}

function fillBox(bx, v) {
  if (bx.cells.every(x => x === v)) return;
  scene3.pushUndo(bx);
  bx.cells.fill(v);
  scene3.paintChanged();
  saveDraft();
  renderPBoxList();
  if (!v) toast(`已清空框 ${bx.id}，点“撤销”可以恢复`);
}

async function onSave3() {
  const s3 = three();
  if (!canStep3(s3)) { $('err3').textContent = '这一期的第三步现在不能保存：组长还没确认第二步。'; return; }
  const bad = pz.boxes.find(b => !painted(b));
  if (bad) {
    $('err3').textContent = `框 ${bad.id} 还没涂。整个框都拿不准的话，用“拿不准”把它涂满。`;
    pickBox(bad.id, true);
    return;
  }
  const l = latest[cur().scene_id] || {};
  const data = { compare_id: l.compare?.id || null, review_id: s3.two.verdict?.id || null, boxes: pz.boxes.map(packBox),
    ...(pz.boxes.some(b => b.ai) ? { prefill: prefillInfo?.version || 'ai' } : {}) };
  if (JSON.stringify(data).length > 55000) { $('err3').textContent = '涂得太零碎，记录太大存不下。请把零散的单个格子整理一下再保存。'; return; }
  const btn = $('save3');
  btn.disabled = true;
  try {
    await saveRow('precise', data);
    const left = todo3().length;
    toast(left ? `第三步已保存。还有 ${left} 期第三步待做，点右上角“第三步待做”继续` : '第三步已保存，等组长检查');
    goTo(k, 3);
  } catch (err) {
    $('err3').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- navigation ----------
function loadForms() {
  const p = cur();
  const l = latest[p.scene_id] || {};
  q = readDraft('quality') || (l.quality ? clone(l.quality.data) : emptyQ());
  q = { ...emptyQ(), ...q };
  const base = stepTwo(l, reviewsOf(p)).data;   // the leader's modified version when it is newer
  c = readDraft('compare') || (base && base.status !== 'uncomparable' ? clone(base) : emptyC());
  c = { ...emptyC(), ...c };
  c.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
}

// want = 3: open step 3 when it is available
function goTo(n, want = 0) {
  if (n >= periods.length) {
    $('bannerArea').innerHTML = '<div class="notice">这一站的全部期次都做完了，辛苦了！可以到“实时看板”看看整体情况。</div>';
    toast('这一站全部完成了');
    return;
  }
  k = Math.max(0, Math.min(periods.length - 1, n));
  leftOverride = null;
  history.replaceState(null, '', `?site=${code}${practice ? '&practice=1' : ''}#${k}`);
  scenes.forEach(s => s.select(null));
  pz = null;
  loadForms();
  renderHeader();
  renderImages();
  const p = cur();
  const st = stateOf(p);
  const l = latest[p.scene_id] || {};
  const s3 = three();
  editing = st !== 'todo' && st !== 'half';
  renderDoneCard();
  const canStep2 = p.role === 'task' && l.quality && l.quality.data.clear !== 'no';
  const drafts12 = readDraft('quality') || readDraft('compare');
  let start = 1;
  if (canStep2 && !readDraft('quality') && (!l.compare || (editing && l.compare.data.status !== 'uncomparable'))) start = 2;
  if (canStep3(s3) && (want === 3 || (!drafts12 && (TODO3.includes(s3.state) || readDraft('precise'))))) start = 3;
  setStep(start);
}

function describeQ(d) {
  if (!d) return '还没做';
  let t = QUALITY_NAME[d.clear] || d.clear;
  if (d.clear !== 'yes') t += `（${[...(d.reasons || []), d.other].filter(Boolean).join('、') || '未写原因'}）`;
  if (d.boxes?.length) t += `，圈了 ${d.boxes.length} 处`;
  return t;
}
function describeC(d) {
  if (!d) return '还没做';
  if (d.status === 'uncomparable') return '没法比较';
  const parts = (d.overall || []).filter(o => o !== 'local').map(o => OVERALL_NAME[o] || o);
  if (d.boxes?.length) parts.unshift(`${d.boxes.length} 处局部变化`);
  return parts.join('、') || '没有明显不同';
}
function decText(r) {
  if (r.kind === 'precise') return r.decision === 'returned' ? '退回了第三步' : r.decision === 'confirmed' ? '检查通过了第三步' : '写了批注';
  const s = r.kind === 'quality' ? '第一步' : '第二步';
  return ({ confirmed: `确认了${s}`, modified: `修改并确认了${s}`, rejected: '认为标的不是变化', note: '写了批注' })[r.decision] || '';
}

// Card shown on a finished period: what was saved, who reviewed it, and buttons to change it.
function renderDoneCard() {
  const box = $('bannerArea');
  if (!editing) { box.innerHTML = ''; return; }
  const p = cur();
  const l = latest[p.scene_id] || {};
  const s3 = three();
  const versions = rows.filter(r => r.scene_id === p.scene_id).length;
  const lastAt = [l.quality, l.compare, l.precise].filter(Boolean).map(r => r.created_at).sort().pop();
  // step 3 feedback is already in its own line
  const rv = practice ? null : [...reviewsOf(p)].reverse().find(r => r.kind !== 'precise' && !(r.decision === 'note' && r.data?.kind === 'leader_feedback'));
  const line3 = s3.state && s3.state !== 'rejected'
    ? `<div class="dl"><span>第三步</span>${CARD3[s3.state]}${s3.check?.decision === 'returned' && s3.check.comment ? `：${esc(s3.check.comment)}` : ''}</div>` : '';
  const btn3 = canStep3(s3) ? `<button class="btn sm${TODO3.includes(s3.state) ? ' primary' : ''}" data-edit="3">${TODO3.includes(s3.state) ? '做第三步' : '修改第三步'}</button>` : '';
  box.innerHTML = `<div class="donecard">
    <div class="dh"><span class="badge ok">已完成</span><span class="tiny">最后保存 ${lastAt ? fmtTime(lastAt) : ''} · 共保存 ${versions} 次</span></div>
    <div class="dl"><span>第一步</span>${describeQ(l.quality?.data)}</div>
    ${p.role === 'task' ? `<div class="dl"><span>第二步</span>${describeC(s3.two.data || l.compare?.data)}${s3.two.source === 'leader' ? '（组长修改后）' : ''}</div>` : ''}
    ${line3}
    ${rv ? `<div class="dl rv"><span>组长</span>${decText(rv)}${rv.comment ? `：${esc(rv.comment)}` : ''}</div>` : ''}
    <div class="db">${btn3}<button class="btn sm" data-edit="1">修改第一步</button>${p.role === 'task' && l.quality?.data.clear !== 'no' ? '<button class="btn sm" data-edit="2">修改第二步</button>' : ''}
      <button class="btn sm ghost" data-next>下一个没做的期 ›</button><button class="btn sm ghost danger" data-del>删除这一期的标注</button></div>
    <div class="tiny" style="margin-top:6px">改完点下面的保存按钮就行，旧记录会保留。</div></div>`;
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => setStep(Number(b.dataset.edit)));
  box.querySelector('[data-del]').onclick = deletePeriod;
  box.querySelector('[data-next]').onclick = () => {
    const after = periods.findIndex((x, i) => i > k && ['todo', 'half'].includes(stateOf(x)));
    const any = periods.findIndex(x => ['todo', 'half'].includes(stateOf(x)));
    const n = after >= 0 ? after : any;
    if (n >= 0) goTo(n); else toast('这一站全部做完了');
  };
}

// Deleting appends a "deleted" version for each step; the old versions stay in the database.
async function deletePeriod() {
  const p = cur();
  if (!confirm(`确定删除第 ${k} 期（${p.date}）的标注吗？\n删除后这一期会变回“未开始”，需要重新判读。`)) return;
  const l = latest[p.scene_id] || {};
  try {
    for (const kind of ['quality', 'compare', 'precise']) {
      if (l[kind]) await saveRow(kind, { deleted: true });
      clearDraft(kind);
    }
    toast('已删除这一期的标注');
    goTo(k);
  } catch (err) { toast(err.message); }
}

function clearBoxes(which) {
  const list = which === 1 ? q.boxes : c.boxes;
  if (!list.length) return;
  if (!confirm('确定清空这一步的所有框吗？')) return;
  list.splice(0, list.length);
  const sc = which === 1 ? scene1 : scene2;
  sc.selected = null;
  sc.render();
  saveDraft();
  if (which === 1) renderQBoxList(); else renderCBoxList();
}

function firstOpen() {
  const hash = parseInt(location.hash.slice(1), 10);
  if (!Number.isNaN(hash) && hash >= 0 && hash < periods.length) return hash;
  const i = periods.findIndex(p => { const s = stateOf(p); return s === 'todo' || s === 'half'; });
  return i >= 0 ? i : periods.length - 1;
}

function renderList() {
  const box = $('plist');
  box.innerHTML = '';
  const names = { todo: '未开始', half: '只做了第一步', done: '已完成', changes: '有变化', uncomparable: '没法比较' };
  const short3 = { wait: '等组长确认', open: '第三步待做', returned: '第三步退回', done: '第三步已交', checked: '第三步通过' };
  $('listLegend').innerHTML = Object.entries(names).map(([s, n]) => `<span style="margin-right:10px"><span class="dot st-${s}"></span> ${n}</span>`).join('');
  periods.forEach((p, i) => {
    const s = stateOf(p);
    const s3 = three(p).state;
    const b = document.createElement('button');
    b.className = i === k ? 'cur' : '';
    b.innerHTML = `<span class="dot st-${s}"></span> ${i === 0 ? '第 0 期' : `第 ${i} 期`}<small>${p.date} · ${names[s]}${short3[s3] ? ` · <span class="s3">${short3[s3]}</span>` : ''}</small>`;
    b.onclick = () => { $('listModal').classList.remove('show'); goTo(i, TODO3.includes(s3) ? 3 : 0); };
    box.appendChild(b);
  });
}

// The leader may confirm step 2 while the page is open: refresh the reviews now and then.
async function refreshReviews() {
  if (document.hidden) return;
  try { reviews = await reviewSync.pull(); } catch { return; }
  renderHeader();
  renderTabs();
  if (editing) renderDoneCard();
}

// ---------- wiring ----------
function wire() {
  $('qLevels').innerHTML = QUALITY_LEVELS.map(l => `<button class="qopt l-${l.key}" data-clear="${l.key}"><b>${l.label}</b><span>${l.hint}</span></button>`).join('');
  $('reasonChips').innerHTML = QUALITY_REASONS.map(r => `<button class="chip" data-reason="${r}">${r}</button>`).join('');
  $('overallChips').innerHTML = OVERALL.map(o => `<button class="chip" data-overall="${o.key}">${o.label}</button>`).join('');
  document.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => {
    q.clear = b.dataset.clear;
    saveDraft();
    renderPanel1();
    if (q.clear === 'partial' && !q.boxes.length) scene1.setMode('draw');
  });
  $('qAlso').addEventListener('change', e => { q.also_blurry = e.target.checked; saveDraft(); });
  $('reasonChips').addEventListener('click', e => {
    const r = e.target.dataset.reason;
    if (!r) return;
    const i = q.reasons.indexOf(r);
    if (i >= 0) q.reasons.splice(i, 1); else q.reasons.push(r);
    saveDraft();
    renderPanel1();
  });
  $('qOther').addEventListener('input', e => { q.other = e.target.value; saveDraft(); });
  $('qDraw').onclick = () => scene1.setMode(scene1.mode === 'draw' ? 'pan' : 'draw');
  $('cDraw').onclick = () => scene2.setMode(scene2.mode === 'draw' ? 'pan' : 'draw');
  document.querySelectorAll('[data-overall]').forEach(b => b.onclick = () => {
    const o = b.dataset.overall;
    const i = c.overall.indexOf(o);
    if (i >= 0) c.overall.splice(i, 1);
    else if (o === 'none') c.overall = ['none'];
    else { c.overall = c.overall.filter(x => x !== 'none'); c.overall.push(o); }
    saveDraft();
    renderPanel2();
    if (o === 'local' && c.overall.includes('local') && !c.boxes.length) scene2.setMode('draw');
  });
  $('cOther').addEventListener('input', e => { c.other = e.target.value; saveDraft(); });
  $('save1').onclick = onSave1;
  $('save2').onclick = onSave2;
  $('back2').onclick = () => setStep(1);

  scene1.onChange = () => { saveDraft(); renderQBoxList(); };
  scene1.onSelect = () => renderQBoxList();
  scene2.onChange = () => {
    if (c.boxes.length) {
      c.overall = c.overall.filter(x => x !== 'none');
      if (!c.overall.includes('local')) c.overall.push('local');
      document.querySelectorAll('[data-overall]').forEach(b => b.classList.toggle('on', c.overall.includes(b.dataset.overall)));
    }
    saveDraft();
    renderCBoxList();
  };
  scene2.onSelect = id => {
    renderCBoxList();
    const item = [...$('cBoxList').children].find(n => n.querySelector('.num')?.textContent === String(id));
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // step 3
  document.querySelectorAll('[data-brush]').forEach(b => b.onclick = () => {
    brush = Number(b.dataset.brush);
    if (scene3.paint) scene3.paint.brush = brush;
    scene3.setMode('paint');
    renderBrushUI();
  });
  document.querySelectorAll('[data-size]').forEach(b => b.onclick = () => {
    brushSize = Number(b.dataset.size);
    if (scene3.paint) scene3.paint.size = brushSize;
    renderBrushUI();
  });
  $('togglePaint').onclick = () => { if (!scene3.paint) return; scene3.paint.show = !scene3.paint.show; scene3.render(); renderPaintToggles(); };
  $('toggleGrid').onclick = () => { if (!scene3.paint) return; scene3.paint.grid = !scene3.paint.grid; scene3.render(); renderPaintToggles(); };
  $('toggleAi').onclick = () => { aiShow = !aiShow; scene3.toggleAiMap(aiShow); $('toggleAi').classList.toggle('on', aiShow); };
  $('aiFill1').onclick = () => {
    const bx = pz?.boxes.find(b => b.id === scene3.paint?.current);
    if (!bx || !fillFromAI(bx)) return;
    scene3.paintChanged(); saveDraft(); renderPBoxList();
    const { n1, n2 } = countCells(bx.cells);
    toast(n1 + n2 ? `框 ${bx.id} 已按 AI 预标（变化 ${n1} 格、拿不准 ${n2} 格），请检查修改` : `AI 在框 ${bx.id} 里没看出变化，请自己涂`);
  };
  $('aiFillAll').onclick = () => {
    if (!pz || !scene3.aiMap) return;
    let empty = 0;
    for (const bx of pz.boxes) { fillFromAI(bx); const { n1, n2 } = countCells(bx.cells); if (!n1 && !n2) empty++; }
    scene3.paintChanged(); saveDraft(); renderPBoxList();
    toast(`所有框已按 AI 预标${empty ? `，其中 ${empty} 个框 AI 没看出变化，要自己涂` : ''}；请逐框检查`);
  };
  $('undo3').onclick = () => { if (!scene3.undo()) toast('没有可以撤销的操作'); };
  $('next3').onclick = () => {
    if (!pz) return;
    if (pz.boxes.length === 1) { toast('这一期只有 1 个框，涂完就可以保存了'); return; }
    const i = pz.boxes.findIndex(b => b.id === scene3.paint.current);
    pickBox(pz.boxes[(i + 1) % pz.boxes.length].id, true);
  };
  $('back3').onclick = () => setStep(2);
  $('save3').onclick = onSave3;
  scene3.onPaint = () => { saveDraft(); renderPBoxList(); };
  scene3.onPickBox = id => pickBox(id, false);
  scene3.onPaintView = renderPaintToggles;

  const modeUI = mode => {
    $('modePan').classList.toggle('on', mode === 'pan');
    $('modeDraw').classList.toggle('on', mode !== 'pan');
    const t = mode === 'draw' ? '画框中…（画完一个自动停止）' : '开始画框';
    $('qDraw').textContent = t;
    $('cDraw').textContent = t;
  };
  scenes.forEach(s => { s.onMode = modeUI; });
  $('modePan').onclick = () => active().setMode('pan');
  $('modeDraw').onclick = () => active().setMode(step === 3 ? 'paint' : 'draw');
  document.querySelectorAll('#segImg button').forEach(b => b.onclick = () => {
    imgKind = b.dataset.img;
    document.querySelectorAll('#segImg button').forEach(x => x.classList.toggle('on', x === b));
    renderImages();
  });
  document.querySelectorAll('#segShow button').forEach(b => b.onclick = () => {
    const key = b.dataset.show === 'aoi' ? 'showAoi' : 'showRail';
    const val = !scene1[key];
    scenes.forEach(s => { s[key] = val; s.render(); });
    b.classList.toggle('on', val);
  });
  $('zin').onclick = () => active().zoomBy(1.4);
  $('zout').onclick = () => active().zoomBy(1 / 1.4);
  $('zfit').onclick = () => active().fit();
  window.addEventListener('resize', () => {
    const bx = step === 3 ? scene3.paintBox() : null;
    if (bx) scene3.focusBox(bx, 1.6); else active().fit();
  });
  $('qClear').onclick = () => clearBoxes(1);
  $('cClear').onclick = () => clearBoxes(2);
  $('stepTab1').onclick = () => { if (step !== 1) setStep(1); };
  $('stepTab2').onclick = () => {
    const l = latest[cur().scene_id] || {};
    if (step === 2 || cur().role !== 'task') return;
    if (!l.quality || l.quality.data.clear === 'no') { toast('先完成第一步，并且这一期要能看清一部分'); return; }
    setStep(2);
  };
  $('stepTab3').onclick = () => {
    if (step === 3 || cur().role !== 'task') return;
    const s3 = three();
    if (canStep3(s3)) { setStep(3); return; }
    toast(({ wait: '第二步要等组长确认以后，才能做第三步', rejected: '组长认为这一期标的不是变化，不用做第三步' })[s3.state] || '这一期没有局部变化，不用做第三步');
  };
  $('btnP3').onclick = () => {
    const list = todo3();
    if (!list.length) return;
    goTo(list.find(i => i > k) ?? list[0], 3);
  };
  $('btnPrev').onclick = () => goTo(k - 1);
  $('btnNext').onclick = () => goTo(k + 1);
  $('btnList').onclick = () => { renderList(); $('listModal').classList.add('show'); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal-back').classList.remove('show'));
  document.querySelectorAll('.modal-back').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  $('btnAsk').onclick = () => { if (practice) { toast('练习模式不能提问，正式判读时再用'); return; } $('askErr').textContent = ''; $('askModal').classList.add('show'); $('askText').focus(); };
  $('askSend').onclick = async () => {
    const text = $('askText').value.trim();
    if (!text) { $('askErr').textContent = '请先写下你的问题。'; return; }
    let b = null;
    if (step === 3) b = scene3.paintBox();
    else { const sc = active(); b = sc.editableLayer()?.boxes.find(x => x.id === sc.selected) || null; }
    try {
      await append('questions', { site: code, scene_id: cur().scene_id, prev_scene_id: step >= 2 ? cur().prev : null, box: b ? { id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, step } : null, text });
      $('askText').value = '';
      $('askModal').classList.remove('show');
      toast('问题已发送给组长');
    } catch (err) { $('askErr').textContent = err.message; }
  };
}

async function init() {
  const sites = await loadSites();
  site = sites[code];
  if (!site) { document.body.innerHTML = '<p style="padding:40px">找不到这个测点。请从首页进入。</p>'; return; }
  periods = await loadPeriods(code);
  scenes.forEach(s => { s.aoi = site.aoi ? site.aoi.ring : null; s.rail = site.railway.lines; });
  if (!site.aoi) document.querySelector('[data-show="aoi"]').style.display = 'none';
  wire();
  if (practice) {
    try { rows = JSON.parse(localStorage.getItem(PRACTICE_KEY) || '[]'); } catch { rows = []; }
    recompute();
    const b = $('saveState'); b.className = 'badge blue'; b.textContent = '练习模式：不会保存到数据库';
    onQueueChange(() => {});
    document.querySelector('.wbar').insertAdjacentHTML('afterend', '<div class="notice warn" style="margin:0;border-radius:0;text-align:center">练习模式：这里的记录只存在你的浏览器里，不会算进正式结果。练完请回首页，进入你负责的测点。 <a href="#" id="resetPractice">清空练习记录</a></div>');
    $('resetPractice').onclick = e => { e.preventDefault(); Object.keys(localStorage).filter(x => x.startsWith('rs2_pdraft_') || x === PRACTICE_KEY).forEach(x => localStorage.removeItem(x)); location.reload(); };
  } else {
    const res = await loadReadings(code);
    rows = res.rows;
    try { reviews = await reviewSync.pull(); } catch { reviews = []; }
    recompute();
    if (!res.online) { const b = $('saveState'); b.className = 'badge danger'; b.textContent = '连不上服务器，记录会先存在本机'; }
    else setSaveBadge(pendingRows().length);
    setInterval(refreshReviews, 60000);
  }
  goTo(firstOpen());
}
init();
