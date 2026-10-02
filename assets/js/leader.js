// Leader desk: review queue (confirm / reject / modify step 2, check step 3), answer questions, export records.
import { Scene } from './viewer.js';
import { append, tableSync } from './api.js';
import { loadSites, loadPeriods, latestByScene, fmtDate, fmtTime, stepThree, decodeCells, sameGeom, imageBefore, dayGap } from './store.js';
import { SITE_ORDER, CHANGE_TAGS, QUALITY_NAME, OVERALL_NAME } from './config.js';

const $ = id => document.getElementById(id);
const TAG = Object.fromEntries(CHANGE_TAGS.map(t => [t.key, t.label]));
const KIND_NAME = { quality: '第一步', compare: '第二步', precise: '第三步' };
const LEAD3 = { wait: '第二步待确认', rejected: '不是变化', open: '等同学做第三步', done: '第三步待检查', returned: '第三步已退回', checked: '第三步已通过' };
const STEP3_TYPES = ['confirm2', 'check3', 'open3', 'returned3', 'checked3'];
const TYPE_STATE = { confirm2: 'wait', check3: 'done', open3: 'open', returned3: 'returned', checked3: 'checked' };
const clone = x => JSON.parse(JSON.stringify(x));
const PSEUDO = ['color', 'clarity', 'shift', 'cloud', 'shadow', 'season', 'watercolor'];
const isBlurry = q => q && (q.clear === 'blurry' || (q.clear === 'partial' && q.also_blurry));
let sites, periods = {}, rows = [], reviews = [], questions = [], answers = [];
let latest = {}, cur = null, curS3 = null, work = null, imgKind = 'tc', showPaint = true;
let scene = null, va = null, vb = null;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function decName(r) {
  if (r.kind === 'precise') return ({ confirmed: '第三步没问题', returned: '退回第三步', note: '批注' })[r.decision] || r.decision;
  const s = r.kind === 'quality' ? '第一步' : '第二步';
  return ({ confirmed: `确认${s}`, modified: `修改并确认${s}`, rejected: '不是变化', note: '只加批注' })[r.decision] || r.decision;
}

const sync = { readings: tableSync('readings'), reviews: tableSync('reviews'), questions: tableSync('questions'), answers: tableSync('answers') };
async function loadAll() {
  [rows, reviews, questions, answers] = await Promise.all([sync.readings.pull(), sync.reviews.pull(), sync.questions.pull(), sync.answers.pull()]);
  latest = {};
  for (const c of SITE_ORDER) latest[c] = latestByScene(rows.filter(r => r.site === c));
  $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  const answered = new Set(answers.map(a => a.question_id));
  $('qCount').textContent = questions.filter(q => !answered.has(q.id)).length;
}

function reviewsOf(code, sceneId) { return reviews.filter(r => r.site === code && r.scene_id === sceneId); }
const s3Of = (code, p) => stepThree(p, latest[code][p.scene_id] || {}, reviewsOf(code, p.scene_id));

function summary(code, p) {
  const l = latest[code][p.scene_id] || {};
  const s3 = s3Of(code, p);
  const q = l.quality?.data, c = s3.two.data;
  const bits = [];
  if (q && q.clear !== 'yes') bits.push(QUALITY_NAME[q.clear] || q.clear);
  if (c?.status === 'changes') bits.push(`${c.boxes?.length || 0} 处变化`);
  if (c?.status === 'none') bits.push('没有明显不同');
  if (c?.status === 'uncomparable') bits.push('没法比较');
  if (s3.state) bits.push(LEAD3[s3.state]);
  return bits.join(' · ') || (q ? '能看清' : '未开始');
}

function matches(code, p, type) {
  const l = latest[code][p.scene_id] || {};
  const q = l.quality?.data, c = l.compare?.data;
  if (!q && !c) return false;
  if (TYPE_STATE[type]) return s3Of(code, p).state === TYPE_STATE[type];
  if (type === 'changes') return c?.status === 'changes';
  if (type === 'partial') return q?.clear === 'partial';
  if (type === 'blurry') return isBlurry(q);
  if (type === 'overall') return (c?.overall || []).some(o => PSEUDO.includes(o));
  if (type === 'full') return q?.clear === 'no' || c?.status === 'uncomparable';
  if (type === 'none') return c?.status === 'none';
  if (type === 'other') return !!(q?.other || c?.other || (c?.boxes || []).some(b => b.tags.includes('unclear') || b.note));
  if (type === 'reviewed') return reviewsOf(code, p.scene_id).length > 0;
  return true;
}
function isReviewed(code, p) {
  const l = latest[code][p.scene_id] || {};
  const lastRead = [l.quality, l.compare, l.precise].filter(Boolean).map(r => r.created_at).sort().pop();
  const rv = reviewsOf(code, p.scene_id).map(r => r.created_at).sort().pop();
  return !!rv && (!lastRead || rv >= lastRead);
}

function listItems() {
  const site = $('fSite').value, type = $('fType').value;
  const only = $('fUnreviewed').checked && type !== 'reviewed' && !STEP3_TYPES.includes(type);
  const out = [];
  for (const code of SITE_ORDER) {
    if (site && site !== code) continue;
    periods[code].forEach((p, i) => { if (matches(code, p, type) && (!only || !isReviewed(code, p))) out.push({ code, p, i }); });
  }
  return out;
}

// Pending work counts in the filter and on the tab.
function updateCounts() {
  const site = $('fSite').value;
  const n = { wait: 0, done: 0 };
  for (const code of SITE_ORDER) {
    if (site && site !== code) continue;
    for (const p of periods[code]) { const s = s3Of(code, p).state; if (s in n) n[s]++; }
  }
  $('fType').querySelector('[value="confirm2"]').textContent = `第二步待确认（有局部变化）· ${n.wait} 期`;
  $('fType').querySelector('[value="check3"]').textContent = `第三步待检查 · ${n.done} 期`;
  $('todoCount').textContent = n.wait + n.done;
}

function renderList(items = listItems()) {
  const box = $('rqList');
  $('fCount').textContent = `共 ${items.length} 期`;
  box.innerHTML = items.length ? '' : '<p class="tiny">没有符合条件的期。</p>';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = cur && cur.code === it.code && cur.i === it.i ? 'cur' : '';
    const rv = isReviewed(it.code, it.p) ? '<span class="badge ok">已复核</span>' : '';
    b.innerHTML = `<span class="dot" style="background:${sites[it.code].color}"></span> ${sites[it.code].name} 第 ${it.i} 期 ${rv}<small>${it.p.date} · ${summary(it.code, it.p)}</small>`;
    b.onclick = () => { cur = it; renderList(items); openReview(); };
    box.appendChild(b);
  }
}

function buildView() {
  $('rqView').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><h3 style="margin:0" id="rvTitle"></h3><span class="tiny" id="rvSub"></span><span style="flex:1"></span>
      <div class="seg" style="background:#20242b"><button data-img="tc" class="on">真彩色</button><button data-img="fc">植被假彩色</button></div>
      <button class="btn sm" id="rvPaint" hidden></button>
      <button class="btn sm" id="rvDraw">画框（修改用）</button><a class="btn sm" id="rvOpen" target="_blank">在判读页打开</a></div>
    <div class="rq-pair"><div class="vbox" id="rvA"></div><div class="vbox" id="rvB"></div></div>
    <div class="rq-detail">
      <div><div id="rvAnswers" class="small"></div><div class="boxlist" id="rvBoxes"></div></div>
      <div><label class="small" for="rvComment"><b>批注（可以不填；退回第三步时必填）</b></label><textarea class="input" id="rvComment" maxlength="2000" placeholder="写给同学的意见，比如：框 2 是收割，不算施工"></textarea>
        <div class="rvblock"><div class="rvh">第二步复核 <span class="badge" id="rv2State"></span></div>
          <div class="actions" style="flex-wrap:wrap;margin-top:8px"><button class="btn" data-dec="confirmed" id="rvConfirm">确认无误</button><button class="btn" data-dec="rejected">不是变化</button>
            <button class="btn primary" data-dec="modified">保存修改并确认</button><button class="btn ghost" data-dec="note">只加批注</button></div>
          <div class="tiny" style="margin-top:6px">有局部变化的期，确认（或修改后确认）以后，同学就能做这一期的第三步。</div></div>
        <div class="rvblock" id="rv3Block" hidden><div class="rvh">第三步检查 <span class="badge" id="rv3State"></span></div>
          <div class="actions" style="flex-wrap:wrap;margin-top:8px"><button class="btn" data-dec3="confirmed">第三步没问题</button><button class="btn danger" data-dec3="returned">退回第三步</button></div></div>
        <div class="err" id="rvErr"></div><h3 style="font-size:14px;margin-top:14px">历史记录</h3><div class="hist" id="rvHist"></div></div>
    </div>`;
  scene = new Scene();
  va = scene.addViewer($('rvA'));
  vb = scene.addViewer($('rvB'));
  scene.onChange = () => renderBoxes();
  scene.onSelect = () => renderBoxes();
  scene.onMode = m => { $('rvDraw').textContent = m === 'draw' ? '画框中…' : '画框（修改用）'; };
  $('rvDraw').onclick = () => scene.setMode(scene.mode === 'draw' ? 'pan' : 'draw');
  $('rvPaint').onclick = () => {
    showPaint = !showPaint;
    if (scene.paint) { scene.paint.show = showPaint; scene.render(); }
    $('rvPaint').textContent = showPaint ? '隐藏第三步涂色' : '显示第三步涂色';
  };
  $('rqView').querySelectorAll('[data-img]').forEach(b => b.onclick = () => {
    imgKind = b.dataset.img;
    $('rqView').querySelectorAll('[data-img]').forEach(x => x.classList.toggle('on', x === b));
    openReview(true);
  });
  $('rqView').querySelectorAll('[data-dec]').forEach(b => b.onclick = () => saveReview(b.dataset.dec));
  $('rqView').querySelectorAll('[data-dec3]').forEach(b => b.onclick = () => saveCheck(b.dataset.dec3));
}

function openReview(keepWork = false) {
  if (!scene) buildView();
  const { code, p, i } = cur;
  const per = periods[code];
  const prev = per[i - 1] || null;
  const l = latest[code][p.scene_id] || {};
  const pl = prev ? latest[code][prev.scene_id] || {} : {};
  const rvs = reviewsOf(code, p.scene_id);
  const s3 = curS3 = stepThree(p, l, rvs);
  const two = s3.two;
  $('rvTitle').textContent = `${sites[code].name} 第 ${i} 期 · ${fmtDate(p.date)}`;
  const bef = prev ? imageBefore(per, i, sid => latest[code][sid]) : null;
  const bp = bef && bef.i != null ? per[bef.i] : prev;
  $('rvSub').textContent = !prev ? '第 0 期，只判断能否看清'
    : bef.moved ? `前图 ${bp.date}（${bef.why}，换成最近一张看得清的），相隔 ${dayGap(p.date, bp.date)} 天` : `上一期 ${prev.date}，相隔 ${p.gap_days} 天`;
  $('rvOpen').href = `work.html?site=${code}#${i}`;
  va.setImage((bp || p)[imgKind], bp ? (bef.moved ? `前图 ${bp.date}（上一期被挡住）` : `上一期 ${bp.date}`) : `这一期 ${p.date}`);
  vb.setImage(p[imgKind], `这一期 ${p.date}`);
  scene.aoi = sites[code].aoi ? sites[code].aoi.ring : null;
  scene.rail = sites[code].railway.lines;
  if (!keepWork) {
    work = two.data && two.data.status !== 'uncomparable' ? clone(two.data) : { status: 'none', overall: [], other: '', boxes: [] };
    work.boxes = work.boxes || [];
    work.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
    $('rvComment').value = '';
    $('rvErr').textContent = '';
  }
  scene.setLayer('prevQ', clone((bp ? latest[code][bp.scene_id]?.quality?.data?.boxes : pl.quality?.data?.boxes) || []), { style: 'quality', viewer: 0, labels: false });
  scene.setLayer('curQ', clone(l.quality?.data?.boxes || []), { style: 'quality', viewer: 1, labels: false });
  scene.setLayer('change', work.boxes, { style: 'change', editable: true });
  // the student's painted cells, read-only
  const pb = (s3.precise?.data?.boxes || []).map(m => ({ id: m.id, c0: m.c0, r0: m.r0, w: m.w, h: m.h, cells: decodeCells(m.rle, m.w * m.h) }));
  scene.setPaint(pb.length ? { boxes: pb, current: null, brush: 1, size: 1, editable: false, show: showPaint, grid: false } : null);
  $('rvPaint').hidden = !pb.length;
  $('rvPaint').textContent = showPaint ? '隐藏第三步涂色' : '显示第三步涂色';
  requestAnimationFrame(() => { if (!scene._fitted) { scene.fit(); scene._fitted = true; } else scene.render(); });

  const q = l.quality?.data, c = two.data;
  const qText = !q ? '第一步：还没做' : `第一步：${QUALITY_NAME[q.clear] || q.clear}${q.clear !== 'yes' ? ` · ${(q.reasons || []).join('、')}${q.other ? `；${esc(q.other)}` : ''}${q.also_blurry ? ' · 其余地方也有点模糊' : ''}` : ''}`;
  let cText = '第二步：还没做';
  if (c) cText = c.status === 'uncomparable' ? '第二步：没法比较' : `第二步：${(c.overall || []).map(o => OVERALL_NAME[o] || o).join('、') || (c.status === 'none' ? '没有明显不同' : '')}${c.boxes?.length ? `（${c.boxes.length} 个框）` : ''}${c.other ? `；${esc(c.other)}` : ''}${two.source === 'leader' ? '〔组长修改后〕' : ''}`;
  let tText = '';
  if (s3.state) tText = `<br>第三步：${LEAD3[s3.state]}${s3.state === 'open' && s3.precise ? '（框有改动或没涂完，等同学重新保存）' : ''}`;
  $('rvAnswers').innerHTML = `<div class="notice" style="margin-bottom:8px">${qText}<br>${cText}${tText}</div>`;

  $('rv2State').textContent = two.verdict ? ({ confirmed: '已确认', modified: '已修改并确认', rejected: '不是变化' })[two.verdict.decision] : l.compare ? '还没确认' : '';
  $('rv2State').className = `badge${two.verdict ? ' ok' : ''}`;
  $('rvConfirm').textContent = two.data?.status === 'changes' ? '确认无误，开放第三步' : '确认无误';
  const checkable = ['done', 'returned', 'checked'].includes(s3.state);
  $('rv3Block').hidden = !checkable;
  $('rv3State').textContent = checkable ? LEAD3[s3.state] : '';
  $('rv3State').className = `badge${s3.state === 'checked' ? ' ok' : s3.state === 'returned' ? ' danger' : ' warn'}`;
  renderBoxes();
  const hist = [
    ...rows.filter(r => r.site === code && r.scene_id === p.scene_id).map(r => ({ t: r.created_at, s: `${r.data?.deleted ? '删除了' : '保存了'}${KIND_NAME[r.kind] || r.kind}` })),
    ...rvs.map(r => ({ t: r.created_at, s: `组长：${decName(r)}${r.comment ? ` —— ${esc(r.comment)}` : ''}` })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  $('rvHist').innerHTML = hist.map(h => `<div>${fmtTime(h.t)}　${h.s}</div>`).join('') || '<div>暂无</div>';
}

function renderBoxes() {
  const list = $('rvBoxes');
  list.innerHTML = '';
  const painted = Object.fromEntries((curS3?.precise?.data?.boxes || []).map(m => [m.id, m]));
  for (const b of work.boxes) {
    const item = document.createElement('div');
    item.className = 'boxitem' + (scene.selected === b.id ? ' sel' : '');
    const chips = CHANGE_TAGS.map(t => `<button class="chip${b.tags.includes(t.key) ? ' on' : ''}" data-tag="${t.key}">${t.label}</button>`).join('');
    const m = painted[b.id];
    const cells = m => [m.n1 ? `变化 ${m.n1} 格` : '', m.n2 ? `拿不准 ${m.n2} 格` : ''].filter(Boolean).join(' · ');
    const t3 = !curS3?.precise ? '' : !m ? '第三步：没涂' : sameGeom(m, b) ? `第三步：${cells(m)}` : '第三步：框改过，要同学重涂';
    item.innerHTML = `<div class="bh"><span class="num">${b.id}</span><span>${b.note ? esc(b.note) : '框的类别'}</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button><button class="btn sm ghost danger" data-act="del">删除</button></div><div class="chips">${chips}</div>
      ${t3 ? `<div class="tiny" style="margin-top:6px">${t3}</div>` : ''}`;
    item.addEventListener('click', e => {
      const act = e.target.dataset.act, tag = e.target.dataset.tag;
      if (act === 'del') { work.boxes.splice(work.boxes.indexOf(b), 1); scene.selected = null; scene.render(); renderBoxes(); return; }
      if (tag) { const k = b.tags.indexOf(tag); if (k >= 0) b.tags.splice(k, 1); else b.tags.push(tag); e.target.classList.toggle('on'); }
      scene.select(b.id);
      if (act === 'focus') scene.focusBox(b);
    });
    list.appendChild(item);
  }
}

async function addReview(row, msg) {
  const res = await append('reviews', row);
  res.row._fresh = true;   // newer than anything read from the server
  sync.reviews.add(res.row);
  toast(msg);
  $('rvComment').value = '';
  renderList();
  updateCounts();
  openReview(true);
}

async function saveReview(decision) {
  const { code, p } = cur;
  const l = latest[code][p.scene_id] || {};
  const comment = $('rvComment').value.trim();
  if (decision === 'note' && !comment) { $('rvErr').textContent = '请先写批注。'; return; }
  const kind = l.compare ? 'compare' : 'quality';
  const reading = l[kind];
  let data = null;
  if (decision === 'modified') {
    const bad = work.boxes.find(b => !b.tags.length && !b.note);
    if (bad) { $('rvErr').textContent = `框 ${bad.id} 还没选类别。`; return; }
    const boxes = work.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags, note: b.note || '' }));
    const rest = (work.overall || []).filter(o => o !== 'none' && o !== 'local');
    data = { status: boxes.length ? 'changes' : 'none', overall: boxes.length ? [...rest, 'local'] : rest.length ? rest : ['none'], other: work.other || '', boxes };
  }
  $('rvErr').textContent = '';
  try {
    const opens = kind === 'compare' && (decision === 'confirmed' || decision === 'modified') && (data || curS3.two.data)?.status === 'changes';
    await addReview({ site: code, scene_id: p.scene_id, kind, reading_id: reading?.id || null, decision, data, comment: comment || null },
      `已保存：${decName({ kind, decision })}${opens ? '，第三步已开放' : ''}`);
  } catch (err) { $('rvErr').textContent = err.message; }
}

async function saveCheck(decision) {
  const { code, p } = cur;
  const comment = $('rvComment').value.trim();
  if (!curS3?.precise) return;
  if (decision === 'returned' && !comment) { $('rvErr').textContent = '退回时请在批注里写明要改什么，同学会看到。'; return; }
  $('rvErr').textContent = '';
  try {
    await addReview({ site: code, scene_id: p.scene_id, kind: 'precise', reading_id: curS3.precise.id, decision, data: null, comment: comment || null },
      decision === 'confirmed' ? '已保存：第三步没问题' : '已退回第三步，同学会看到你的批注');
  } catch (err) { $('rvErr').textContent = err.message; }
}

// ---------- questions ----------
function renderQuestions() {
  const box = $('qaList');
  const byQ = {};
  for (const a of answers) (byQ[a.question_id] = byQ[a.question_id] || []).push(a);
  const sorted = [...questions].sort((a, b) => (!!byQ[a.id] - !!byQ[b.id]) || b.created_at.localeCompare(a.created_at));
  box.innerHTML = sorted.length ? '' : '<p class="muted">还没有人提问。</p>';
  for (const q of sorted) {
    const per = periods[q.site] || [];
    const i = per.findIndex(p => p.scene_id === q.scene_id);
    const card = document.createElement('div');
    card.className = 'card qa';
    card.innerHTML = `<div class="qh"><span class="dot" style="background:${sites[q.site].color}"></span><b style="color:var(--ink)">${sites[q.site].name}</b>
        <span>${i >= 0 ? `第 ${i} 期 ${per[i].date}` : ''}</span>${q.box ? `<span>附带框 ${q.box.id}（第${['', '一', '二', '三'][q.box.step] || '一'}步）</span>` : ''}<span>${fmtTime(q.created_at)}</span>
        <span style="flex:1"></span>${i >= 0 ? `<a class="btn sm" target="_blank" href="work.html?site=${q.site}#${i}">打开这一期</a>` : ''}</div>
      <div class="qt">${esc(q.text)}</div>
      ${(byQ[q.id] || []).map(a => `<div class="ans">${esc(a.text)}${a.add_to_faq ? ' <span class="badge ok">已加入常见问题</span>' : ''}</div>`).join('')}
      <div style="display:flex;gap:8px;align-items:flex-start;margin-top:8px"><textarea class="input" maxlength="4000" placeholder="写下回答" style="height:60px"></textarea>
        <div style="display:flex;flex-direction:column;gap:6px"><label class="small"><input type="checkbox"> 加入常见问题</label><button class="btn primary sm">回答</button></div></div>`;
    card.querySelector('button.primary').onclick = async () => {
      const text = card.querySelector('textarea').value.trim();
      if (!text) { toast('请先写回答'); return; }
      try {
        const res = await append('answers', { question_id: q.id, text, add_to_faq: card.querySelector('input[type=checkbox]').checked });
        sync.answers.add(res.row);
        toast('已回答');
        renderQuestions();
      } catch (err) { toast(err.message); }
    };
    box.appendChild(card);
  }
}

// ---------- export ----------
function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const csv = rowsOut => '﻿' + rowsOut.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
const stamp = () => new Date().toISOString().slice(0, 10);

// Step 2 as it stands after the leader's review, the latest step 1/2 review, and step 3.
function effective(code, p) {
  const rvs = reviewsOf(code, p.scene_id);
  const s3 = stepThree(p, latest[code][p.scene_id] || {}, rvs);
  const rv = [...rvs].reverse().find(r => r.kind !== 'precise') || null;
  return { data: s3.two.data, source: s3.two.source === 'leader' ? '组长修改' : '同学', rv, s3 };
}
const paintedBox = (s3, b) => (s3.precise?.data?.boxes || []).find(m => m.id === b.id && sameGeom(m, b)) || null;

// 这一对的前图（2026-10-03）：上一期被挡住时是最近一张看得清的；框上记了 before 的，框用自己的前图
function pairBeforeOf(code, i) {
  const per = periods[code];
  if (i < 1) return null;
  const bef = imageBefore(per, i, sid => latest[code][sid]);
  return { p: per[bef.i ?? i - 1], why: bef.why, moved: bef.moved };
}
const boxBeforeDate = (code, b, pb) => (b.before ? periods[code].find(x => x.scene_id === b.before)?.date : null) || pb?.p?.date || '';

function exportPeriods() {
  const out = [['测点', '期序', '日期', '卫星', '轨道', '距上一期天数', '上一期日期', '前图日期', '前图说明', '看得清程度', '看不清原因', '看不清其他说明', '看不清框数', '其余也模糊',
    '对比结果', '不同点', '变化框数', '变化类别汇总', '其他说明', '结果来源', '复核结论', '复核批注', '第三步状态', '第三步变化格数', '第三步拿不准格数']];
  for (const code of SITE_ORDER) periods[code].forEach((p, i) => {
    const l = latest[code][p.scene_id] || {};
    const q = l.quality?.data;
    const { data: c, source, rv, s3 } = effective(code, p);
    const tagCount = {};
    for (const b of c?.boxes || []) for (const t of b.tags) tagCount[TAG[t] || t] = (tagCount[TAG[t] || t] || 0) + 1;
    const cells = s3.boxes.map(b => paintedBox(s3, b)).filter(Boolean);
    const pb = pairBeforeOf(code, i);
    out.push([sites[code].name, i, p.date, p.satellite, p.orbit, p.gap_days ?? '', periods[code][i - 1]?.date || '', pb?.p?.date || '', pb?.moved ? pb.why : '',
      q ? (QUALITY_NAME[q.clear] || q.clear) : '', (q?.reasons || []).join('、'), q?.other || '', q?.boxes?.length || '', q?.also_blurry ? '是' : '',
      c ? ({ none: '没有局部变化', changes: '有局部变化', uncomparable: '没法比较' })[c.status] : '', (c?.overall || []).map(o => OVERALL_NAME[o] || o).join('、'),
      c?.boxes?.length ?? '', Object.entries(tagCount).map(([t, n]) => `${t}×${n}`).join('；'), c?.other || '', c ? source : '', rv ? decName(rv) : '', rv?.comment || '',
      s3.state ? LEAD3[s3.state] : '', cells.length ? cells.reduce((s, m) => s + m.n1, 0) : '', cells.length ? cells.reduce((s, m) => s + m.n2, 0) : '']);
  });
  download(`判读结果_每一期_${stamp()}.csv`, csv(out));
}

function exportBoxes() {
  const out = [['测点', '期序', '日期', '上一期日期', '这个框的前图', '框号', '像元x0', '像元y0', '像元x1', '像元y1', 'UTM左上X', 'UTM左上Y', 'UTM右下X', 'UTM右下Y', '类别', '说明', '结果来源', '复核结论', '复核批注',
    '第三步状态', '第三步变化格数', '第三步拿不准格数']];
  for (const code of SITE_ORDER) {
    const [ox, oy] = sites[code].grid_origin;
    periods[code].forEach((p, i) => {
      const { data: c, source, rv, s3 } = effective(code, p);
      const pb = pairBeforeOf(code, i);
      for (const b of c?.status === 'changes' ? c.boxes : []) {
        const m = paintedBox(s3, b);
        out.push([sites[code].name, i, p.date, periods[code][i - 1]?.date || '', boxBeforeDate(code, b, pb), b.id, b.x0, b.y0, b.x1, b.y1,
          (ox + b.x0 * 10).toFixed(1), (oy - b.y0 * 10).toFixed(1), (ox + b.x1 * 10).toFixed(1), (oy - b.y1 * 10).toFixed(1),
          b.tags.map(t => TAG[t] || t).join('、'), b.note || '', source, rv ? decName(rv) : '', rv?.comment || '',
          s3.state ? LEAD3[s3.state] : '', m ? m.n1 : '', m ? m.n2 : '']);
      }
    });
  }
  download(`判读结果_变化框清单_${stamp()}.csv`, csv(out));
}

// Everything the label script needs, already resolved: step 2 after review, step 3 state and painted cells per pair.
function exportLabels() {
  const pairs = [];
  for (const code of SITE_ORDER) periods[code].forEach((p, i) => {
    if (p.role !== 'task') return;
    const prev = periods[code][i - 1];
    const l = latest[code][p.scene_id] || {};
    const pl = latest[code][prev.scene_id] || {};
    const { s3 } = effective(code, p);
    const pb = pairBeforeOf(code, i);
    const bl = latest[code][pb.p.scene_id] || {};
    pairs.push({
      site: code, index: i, scene_id: p.scene_id, date: p.date, prev_scene_id: prev.scene_id, prev_date: prev.date, gap_days: p.gap_days,
      before_scene_id: pb.p.scene_id, before_date: pb.p.date, before_reason: pb.moved ? pb.why : '', before_quality: bl.quality?.data || null,
      quality: l.quality?.data || null, prev_quality: pl.quality?.data || null,
      step2: s3.two.data, step2_source: s3.two.source, step2_verdict: s3.two.verdict?.decision || null,
      step3_state: s3.state, step3_boxes: s3.state ? s3.boxes.map(b => ({ ...b, before_date: boxBeforeDate(code, b, pb), cells: paintedBox(s3, b) })) : [], step3_check: s3.check?.decision || null,
    });
  });
  const meta = Object.fromEntries(SITE_ORDER.map(c => [c, { name: sites[c].name, grid_origin: sites[c].grid_origin, aoi_ring_px: sites[c].aoi ? sites[c].aoi.ring : null }]));
  download(`正式标注数据_${stamp()}.json`, JSON.stringify({
    exported_at: new Date().toISOString(), crs: 'EPSG:32649', pixel_m: 10, size: 256,
    cells: '每个框的 cells.rle：按行游程编码，"值+个数" 用点分隔；0 没变，1 变化，2 拿不准。c0/r0 是框左上格子的列/行，w/h 是格子数',
    before: '每一对的前图 before_*：上一期在观察范围里被云挡住过半或第一步“基本看不清”时，换成最近一张被挡住少于两成的（120 天内）；框上有 before 的，这个框和它比。'
      + '框在前图里被挡住两成以上（含第一步圈的看不清）而没有记 before 的，离线导出脚本 pair_consistency_20261002/脚本/export_pairs.py 会自动配前图并列清单',
    sites: meta, pairs,
  }, null, 1), 'application/json');
}

async function main() {
  sites = await loadSites();
  for (const c of SITE_ORDER) { periods[c] = await loadPeriods(c); $('fSite').insertAdjacentHTML('beforeend', `<option value="${c}">${sites[c].name}</option>`); }
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    for (const t of ['review', 'questions', 'export']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === 'questions') renderQuestions();
    if (b.dataset.tab === 'review' && scene) requestAnimationFrame(() => scene.fit());
  });
  ['fSite', 'fType', 'fUnreviewed'].forEach(id => $(id).addEventListener('change', () => { updateCounts(); renderList(); }));
  $('btnSample').onclick = () => {
    const items = listItems();
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    renderList(items.slice(0, 5));
  };
  $('exPeriods').onclick = exportPeriods;
  $('exBoxes').onclick = exportBoxes;
  $('exLabels').onclick = exportLabels;
  $('exJson').onclick = () => download(`判读记录_完整备份_${stamp()}.json`, JSON.stringify({ exported_at: new Date().toISOString(), readings: rows, reviews, questions, answers }, null, 1), 'application/json');
  for (const c of SITE_ORDER) latest[c] = {};
  try { await loadAll(); } catch { $('updated').textContent = '暂时连不上数据库'; }
  updateCounts();
  renderList();
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { try { await loadAll(); updateCounts(); renderList(); } catch { /* keep */ } } });
  setInterval(async () => {
    if (document.hidden) return;
    try { await loadAll(); } catch { return; }
    updateCounts();
    renderList();
    if (cur && !$('tab-review').hidden) openReview(true);
  }, 60000);
}
main();
