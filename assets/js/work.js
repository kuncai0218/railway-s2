// Reading workbench: step 1 = is this image readable, step 2 = what changed since the previous image.
import { Scene } from './viewer.js';
import { append, onQueueChange, pendingRows, uuid } from './api.js';
import { loadSites, loadPeriods, loadReadings, latestByScene, periodState, progress, fmtDate } from './store.js';
import { QUALITY_REASONS, CHANGE_TAGS } from './config.js';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const code = (query.get('site') || 'HY').toUpperCase();
const practice = query.get('practice') === '1';   // practice mode: nothing leaves this browser
const PRACTICE_KEY = `rs2_practice_${code}`;
const clone = x => JSON.parse(JSON.stringify(x));
const emptyQ = () => ({ clear: null, extent: null, reasons: [], other: '', boxes: [] });
const emptyC = () => ({ overall: [], other: '', boxes: [] });

let site, periods, rows = [], latest = {};
let k = 0, step = 1, q = emptyQ(), c = emptyC(), imgKind = 'tc';

const scene1 = new Scene();
const scene2 = new Scene();
const v1 = scene1.addViewer($('v1'));
const v2a = scene2.addViewer($('v2a'));
const v2b = scene2.addViewer($('v2b'));
const scenes = [scene1, scene2];
const active = () => (step === 1 ? scene1 : scene2);

// ---------- helpers ----------
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
const cur = () => periods[k];
const prevPeriod = () => periods[k - 1] || null;
const draftKey = kind => `rs2_${practice ? 'pdraft' : 'draft'}_${code}_${cur().scene_id}_${kind}`;
function saveDraft() {
  try {
    localStorage.setItem(draftKey('quality'), JSON.stringify(q));
    if (cur().role === 'task') localStorage.setItem(draftKey('compare'), JSON.stringify(c));
  } catch { /* storage full or blocked: the server copy is the real record */ }
}
function readDraft(kind) { try { return JSON.parse(localStorage.getItem(draftKey(kind))); } catch { return null; } }
function clearDraft(kind) { try { localStorage.removeItem(draftKey(kind)); } catch { /* ignore */ } }

function recompute() { latest = latestByScene(rows); }
function stateOf(p) { return periodState(p, latest); }

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
    $('periodGap').textContent = '2022 年最后一期，只看能否看清';
  } else {
    $('periodTitle').textContent = `第 ${k} / ${site.n_tasks} 期`;
    $('periodDate').textContent = `${fmtDate(p.date)} · ${p.satellite} ${p.orbit}`;
    $('periodGap').textContent = `距上一期 ${p.gap_days} 天`;
  }
  $('progBar').style.width = `${Math.round(pr.finished / pr.total * 100)}%`;
  $('progText').textContent = `已完成 ${pr.finished} / ${pr.total} 期`;
  $('btnPrev').disabled = k === 0;
  $('btnNext').disabled = k === periods.length - 1;
}

function setSaveBadge(n) {
  const b = $('saveState');
  if (n > 0) { b.className = 'badge warn'; b.textContent = `有 ${n} 条等待上传，联网后自动上传`; }
  else { b.className = 'badge ok'; b.textContent = '✓ 全部已保存'; }
}
onQueueChange(setSaveBadge);

// ---------- images ----------
function label(p, role) { return `${role} ${fmtDate(p.date)}`; }
function renderImages() {
  const p = cur();
  v1.setImage(p[imgKind], label(p, '这一期'));
  const pp = prevPeriod();
  if (pp) {
    v2a.setImage(pp[imgKind], label(pp, '上一期'));
    v2b.setImage(p[imgKind], label(p, `这一期 · 隔 ${p.gap_days} 天`));
  }
}

// ---------- step switching ----------
function setStep(n) {
  step = n;
  scene1.active = n === 1;
  scene2.active = n === 2;
  $('views1').hidden = n !== 1;
  $('views2').hidden = n !== 2;
  $('panel1').hidden = n !== 1;
  $('panel2').hidden = n !== 2;
  $('stepTab1').className = n === 1 ? 'on' : 'done';
  $('stepTab2').className = n === 2 ? 'on' : '';
  $('stepTab2').style.visibility = cur().role === 'baseline' ? 'hidden' : 'visible';
  active().setMode('pan');
  requestAnimationFrame(() => { if (!active()._fitted) { active().fit(); active()._fitted = true; } else active().render(); });
  if (n === 1) renderPanel1(); else renderPanel2();
}

// ---------- step 1 ----------
function renderPanel1() {
  const p = cur();
  document.querySelectorAll('[data-clear]').forEach(b => b.classList.toggle('on', q.clear === b.dataset.clear));
  $('unclearBlock').hidden = q.clear !== 'no';
  document.querySelectorAll('[data-extent]').forEach(b => b.classList.toggle('on', q.extent === b.dataset.extent));
  $('reasonChips').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', q.reasons.includes(b.dataset.reason)));
  $('qOther').value = q.other || '';
  const needBoxes = q.clear === 'no' && q.extent === 'partial';
  $('qBoxField').hidden = !needBoxes;
  scene1.setLayer('quality', q.boxes, { style: 'quality', editable: needBoxes });
  renderQBoxList();
  let lab = '下一步：和上一期比';
  if (p.role === 'baseline') lab = '保存，进入下一期';
  else if (q.clear === 'no' && q.extent === 'full') lab = '保存（这一期没法比较），进入下一期';
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
  if (!q.clear) return '请先选“能看清”或“看不清”。';
  if (q.clear === 'no') {
    if (!q.extent) return '请选看不清的范围：一部分还是整幅。';
    if (!q.reasons.length && !q.other.trim()) return '请至少选一个原因，或者在“其他原因”里写一句。';
    if (q.extent === 'partial' && !q.boxes.length) return '选了“一部分”，请在图上画框圈出看不清的地方。';
  }
  return '';
}

function cleanQ() {
  const d = { clear: q.clear };
  if (q.clear === 'no') {
    d.extent = q.extent;
    d.reasons = q.reasons;
    d.other = q.other.trim();
    d.boxes = q.extent === 'partial' ? q.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })) : [];
  }
  return d;
}

async function saveRow(kind, data) {
  const p = cur();
  const row = { site: code, scene_id: p.scene_id, prev_scene_id: p.prev, kind, data };
  let res;
  if (practice) {
    res = { row: { id: uuid(), created_at: new Date().toISOString(), ...row }, queued: false };
    try { const list = JSON.parse(localStorage.getItem(PRACTICE_KEY) || '[]'); list.push(res.row); localStorage.setItem(PRACTICE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  } else res = await append('readings', row);
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
    await saveRow('quality', data);
    const p = cur();
    if (p.role === 'baseline') { toast('已保存'); goTo(k + 1); return; }
    if (data.clear === 'no' && data.extent === 'full') {
      await saveRow('compare', { status: 'uncomparable', reason: 'current_unclear' });
      toast('已保存：这一期整幅看不清，记为没法比较');
      goTo(k + 1);
      return;
    }
    renderHeader();
    setStep(2);
  } catch (err) {
    $('err1').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- step 2 ----------
function prevQuality() { const pp = prevPeriod(); return pp ? latest[pp.scene_id]?.quality?.data || null : null; }

function renderPanel2() {
  const pq = prevQuality();
  const banner = $('bannerArea');
  banner.innerHTML = '';
  const prevFull = pq && pq.clear === 'no' && pq.extent === 'full';
  if (!pq) banner.innerHTML = '<div class="notice warn">上一期还没判断能不能看清。建议先回到上一期完成第一步。</div>';
  if (prevFull) banner.innerHTML = '<div class="notice warn">上一期整幅看不清，这一对没法比较。直接点“保存，进入下一期”即可。</div>';
  scene2.setLayer('prevQuality', clone((pq && pq.boxes) || []), { style: 'quality', viewer: 0, labels: false });
  scene2.setLayer('curQuality', clone(q.boxes || []), { style: 'quality', viewer: 1, labels: false });
  scene2.setLayer('change', c.boxes, { style: 'change', editable: !prevFull });
  document.querySelectorAll('[data-overall]').forEach(b => { b.classList.toggle('on', c.overall.includes(b.dataset.overall)); b.disabled = prevFull; });
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
  }
}

function validateC() {
  const pq = prevQuality();
  if (pq && pq.clear === 'no' && pq.extent === 'full') return '';
  const none = c.overall.includes('none');
  if (!c.overall.length && !c.boxes.length && !c.other.trim()) return '请选“没有明显不同”，或者画框标出不同的地方。';
  if (none && c.boxes.length) return '已经画了框，就不能再选“没有明显不同”。';
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
    if (pq && pq.clear === 'no' && pq.extent === 'full') data = { status: 'uncomparable', reason: 'previous_unclear' };
    else {
      const boxes = c.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags, note: (b.note || '').trim() }));
      const changed = boxes.length > 0 || c.overall.includes('color') || c.other.trim();
      data = { status: changed ? 'changes' : 'none', overall: c.overall, other: c.other.trim(), boxes };
    }
    await saveRow('compare', data);
    toast(data.status === 'changes' ? `已保存，记录了 ${data.boxes.length} 处不同` : '已保存');
    goTo(k + 1);
  } catch (err) {
    $('err2').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- navigation ----------
function loadForms() {
  const p = cur();
  const l = latest[p.scene_id] || {};
  q = readDraft('quality') || (l.quality ? clone(l.quality.data) : emptyQ());
  q = { ...emptyQ(), ...q };
  c = readDraft('compare') || (l.compare && l.compare.data.status !== 'uncomparable' ? clone(l.compare.data) : emptyC());
  c = { ...emptyC(), ...c };
  c.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
}

function goTo(n) {
  if (n >= periods.length) {
    $('bannerArea').innerHTML = '<div class="notice">这一站的全部期次都做完了，辛苦了！可以到“实时看板”看看整体情况。</div>';
    toast('这一站全部完成了');
    return;
  }
  k = Math.max(0, Math.min(periods.length - 1, n));
  history.replaceState(null, '', `?site=${code}${practice ? '&practice=1' : ''}#${k}`);
  scenes.forEach(s => s.select(null));
  loadForms();
  renderHeader();
  renderImages();
  const st = stateOf(cur());
  const l = latest[cur().scene_id] || {};
  $('bannerArea').innerHTML = '';
  if (st !== 'todo' && st !== 'half') $('bannerArea').innerHTML = '<div class="notice">这一期已经做过了。可以修改后重新保存，旧记录会保留。</div>';
  const startStep2 = cur().role === 'task' && l.quality && !l.compare && !readDraft('quality');
  setStep(startStep2 ? 2 : 1);
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
  $('listLegend').innerHTML = Object.entries(names).map(([s, n]) => `<span style="margin-right:10px"><span class="dot st-${s}"></span> ${n}</span>`).join('');
  periods.forEach((p, i) => {
    const s = stateOf(p);
    const b = document.createElement('button');
    b.className = i === k ? 'cur' : '';
    b.innerHTML = `<span class="dot st-${s}"></span> ${i === 0 ? '第 0 期' : `第 ${i} 期`}<small>${p.date} · ${names[s]}</small>`;
    b.onclick = () => { $('listModal').classList.remove('show'); goTo(i); };
    box.appendChild(b);
  });
}

// ---------- wiring ----------
function wire() {
  $('reasonChips').innerHTML = QUALITY_REASONS.map(r => `<button class="chip" data-reason="${r}">${r}</button>`).join('');
  document.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { q.clear = b.dataset.clear; if (q.clear === 'yes') { q.extent = null; } saveDraft(); renderPanel1(); });
  document.querySelectorAll('[data-extent]').forEach(b => b.onclick = () => {
    q.extent = b.dataset.extent;
    saveDraft();
    renderPanel1();
    if (q.extent === 'partial' && !q.boxes.length) scene1.setMode('draw');
  });
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
    if (i >= 0) c.overall.splice(i, 1); else c.overall.push(o);
    saveDraft();
    renderPanel2();
  });
  $('cOther').addEventListener('input', e => { c.other = e.target.value; saveDraft(); });
  $('save1').onclick = onSave1;
  $('save2').onclick = onSave2;
  $('back2').onclick = () => setStep(1);

  scene1.onChange = () => { saveDraft(); renderQBoxList(); };
  scene1.onSelect = () => renderQBoxList();
  scene2.onChange = () => {
    const i = c.overall.indexOf('none');
    if (i >= 0 && c.boxes.length) { c.overall.splice(i, 1); document.querySelector('[data-overall="none"]').classList.remove('on'); }
    saveDraft();
    renderCBoxList();
  };
  scene2.onSelect = id => {
    renderCBoxList();
    const item = [...$('cBoxList').children].find(n => n.querySelector('.num')?.textContent === String(id));
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const modeUI = mode => {
    document.querySelectorAll('#segMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    const t = mode === 'draw' ? '画框中…（画完一个自动停止）' : '开始画框';
    $('qDraw').textContent = t;
    $('cDraw').textContent = t;
  };
  scene1.onMode = modeUI;
  scene2.onMode = modeUI;
  document.querySelectorAll('#segMode button').forEach(b => b.onclick = () => active().setMode(b.dataset.mode));
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
  window.addEventListener('resize', () => active().fit());
  $('btnPrev').onclick = () => goTo(k - 1);
  $('btnNext').onclick = () => goTo(k + 1);
  $('btnList').onclick = () => { renderList(); $('listModal').classList.add('show'); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal-back').classList.remove('show'));
  document.querySelectorAll('.modal-back').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  $('btnAsk').onclick = () => { if (practice) { toast('练习模式不能提问，正式判读时再用'); return; } $('askErr').textContent = ''; $('askModal').classList.add('show'); $('askText').focus(); };
  $('askSend').onclick = async () => {
    const text = $('askText').value.trim();
    if (!text) { $('askErr').textContent = '请先写下你的问题。'; return; }
    const sc = active();
    const layer = sc.editableLayer();
    const box = layer?.boxes.find(b => b.id === sc.selected) || null;
    try {
      await append('questions', { site: code, scene_id: cur().scene_id, prev_scene_id: step === 2 ? cur().prev : null, box: box ? { id: box.id, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, step } : null, text });
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
    recompute();
    if (!res.online) { const b = $('saveState'); b.className = 'badge danger'; b.textContent = '连不上服务器，记录会先存在本机'; }
    else setSaveBadge(pendingRows().length);
  }
  goTo(firstOpen());
}
init();
