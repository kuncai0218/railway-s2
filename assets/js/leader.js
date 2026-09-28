// Leader desk: review queue (confirm / reject / modify boxes), answer questions, export records.
import { Scene } from './viewer.js';
import { append, selectAll } from './api.js';
import { loadSites, loadPeriods, latestByScene, fmtDate, fmtTime } from './store.js';
import { SITE_ORDER, CHANGE_TAGS, QUALITY_NAME, OVERALL_NAME } from './config.js';

const $ = id => document.getElementById(id);
const TAG = Object.fromEntries(CHANGE_TAGS.map(t => [t.key, t.label]));
const DEC = { confirmed: '已确认', rejected: '不是变化', modified: '组长已修改', note: '有批注' };
const clone = x => JSON.parse(JSON.stringify(x));
const PSEUDO = ['color', 'clarity', 'shift', 'cloud', 'shadow', 'season', 'watercolor'];
const isBlurry = q => q && (q.clear === 'blurry' || (q.clear === 'partial' && q.also_blurry));
let sites, periods = {}, rows = [], reviews = [], questions = [], answers = [];
let latest = {}, cur = null, work = null, imgKind = 'tc';
let scene = null, va = null, vb = null;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2400); }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function loadAll() {
  [rows, reviews, questions, answers] = await Promise.all([selectAll('readings'), selectAll('reviews'), selectAll('questions'), selectAll('answers')]);
  latest = {};
  for (const c of SITE_ORDER) latest[c] = latestByScene(rows.filter(r => r.site === c));
  $('updated').textContent = `数据更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  const answered = new Set(answers.map(a => a.question_id));
  $('qCount').textContent = questions.filter(q => !answered.has(q.id)).length;
}

function reviewsOf(code, sceneId) { return reviews.filter(r => r.site === code && r.scene_id === sceneId); }
function lastReview(code, sceneId, kind) { const rs = reviewsOf(code, sceneId).filter(r => r.kind === kind); return rs[rs.length - 1] || null; }

function summary(code, p) {
  const l = latest[code][p.scene_id] || {};
  const q = l.quality?.data, c = l.compare?.data;
  const bits = [];
  if (q && q.clear !== 'yes') bits.push(QUALITY_NAME[q.clear] || q.clear);
  if (c?.status === 'changes') bits.push(`${c.boxes?.length || 0} 处变化`);
  if (c?.status === 'none') bits.push('没有明显不同');
  if (c?.status === 'uncomparable') bits.push('没法比较');
  return bits.join(' · ') || (q ? '能看清' : '未开始');
}

function matches(code, p, type) {
  const l = latest[code][p.scene_id] || {};
  const q = l.quality?.data, c = l.compare?.data;
  if (!q && !c) return false;
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
  const lastRead = [l.quality, l.compare].filter(Boolean).map(r => r.created_at).sort().pop();
  const rv = reviewsOf(code, p.scene_id).map(r => r.created_at).sort().pop();
  return !!rv && (!lastRead || rv >= lastRead);
}

function listItems() {
  const site = $('fSite').value, type = $('fType').value, only = $('fUnreviewed').checked && type !== 'reviewed';
  const out = [];
  for (const code of SITE_ORDER) {
    if (site && site !== code) continue;
    periods[code].forEach((p, i) => { if (matches(code, p, type) && (!only || !isReviewed(code, p))) out.push({ code, p, i }); });
  }
  return out;
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
      <button class="btn sm" id="rvDraw">画框（修改用）</button><a class="btn sm" id="rvOpen" target="_blank">在判读页打开</a></div>
    <div class="rq-pair"><div class="vbox" id="rvA"></div><div class="vbox" id="rvB"></div></div>
    <div class="rq-detail">
      <div><div id="rvAnswers" class="small"></div><div class="boxlist" id="rvBoxes"></div></div>
      <div><label class="small" for="rvComment"><b>批注（可以不填）</b></label><textarea class="input" id="rvComment" maxlength="2000" placeholder="写给同学的意见，比如：框 2 是收割，不算施工"></textarea>
        <div class="actions" style="flex-wrap:wrap"><button class="btn" data-dec="confirmed">确认无误</button><button class="btn" data-dec="rejected">不是变化</button>
          <button class="btn primary" data-dec="modified">保存我的修改</button><button class="btn ghost" data-dec="note">只加批注</button></div>
        <div class="err" id="rvErr"></div><h3 style="font-size:14px;margin-top:14px">历史记录</h3><div class="hist" id="rvHist"></div></div>
    </div>`;
  scene = new Scene();
  va = scene.addViewer($('rvA'));
  vb = scene.addViewer($('rvB'));
  scene.onChange = () => renderBoxes();
  scene.onSelect = () => renderBoxes();
  scene.onMode = m => { $('rvDraw').textContent = m === 'draw' ? '画框中…' : '画框（修改用）'; };
  $('rvDraw').onclick = () => scene.setMode(scene.mode === 'draw' ? 'pan' : 'draw');
  $('rqView').querySelectorAll('[data-img]').forEach(b => b.onclick = () => {
    imgKind = b.dataset.img;
    $('rqView').querySelectorAll('[data-img]').forEach(x => x.classList.toggle('on', x === b));
    openReview(true);
  });
  $('rqView').querySelectorAll('[data-dec]').forEach(b => b.onclick = () => saveReview(b.dataset.dec));
}

function openReview(keepWork = false) {
  if (!scene) buildView();
  const { code, p, i } = cur;
  const per = periods[code];
  const prev = per[i - 1] || null;
  const l = latest[code][p.scene_id] || {};
  const pl = prev ? latest[code][prev.scene_id] || {} : {};
  $('rvTitle').textContent = `${sites[code].name} 第 ${i} 期 · ${fmtDate(p.date)}`;
  $('rvSub').textContent = prev ? `上一期 ${prev.date}，相隔 ${p.gap_days} 天` : '第 0 期，只判断能否看清';
  $('rvOpen').href = `work.html?site=${code}#${i}`;
  va.setImage((prev || p)[imgKind], prev ? `上一期 ${prev.date}` : `这一期 ${p.date}`);
  vb.setImage(p[imgKind], `这一期 ${p.date}`);
  scene.aoi = sites[code].aoi ? sites[code].aoi.ring : null;
  scene.rail = sites[code].railway.lines;
  if (!keepWork) {
    const rv = lastReview(code, p.scene_id, 'compare');
    const base = rv?.decision === 'modified' && rv.data ? rv.data : l.compare?.data;
    work = base && base.status !== 'uncomparable' ? clone(base) : { status: 'none', overall: [], other: '', boxes: [] };
    work.boxes = work.boxes || [];
    work.boxes.forEach(b => { b.tags = b.tags || []; b.note = b.note || ''; });
    $('rvComment').value = '';
    $('rvErr').textContent = '';
  }
  scene.setLayer('prevQ', clone(pl.quality?.data?.boxes || []), { style: 'quality', viewer: 0, labels: false });
  scene.setLayer('curQ', clone(l.quality?.data?.boxes || []), { style: 'quality', viewer: 1, labels: false });
  scene.setLayer('change', work.boxes, { style: 'change', editable: true });
  requestAnimationFrame(() => { if (!scene._fitted) { scene.fit(); scene._fitted = true; } else scene.render(); });
  const q = l.quality?.data, c = l.compare?.data;
  const qText = !q ? '第一步：还没做' : `第一步：${QUALITY_NAME[q.clear] || q.clear}${q.clear !== 'yes' ? ` · ${(q.reasons || []).join('、')}${q.other ? `；${esc(q.other)}` : ''}${q.also_blurry ? ' · 其余地方也有点模糊' : ''}` : ''}`;
  let cText = '第二步：还没做';
  if (c) cText = c.status === 'uncomparable' ? '第二步：没法比较' : `第二步：${(c.overall || []).map(o => OVERALL_NAME[o] || o).join('、') || (c.status === 'none' ? '没有明显不同' : '')}${c.boxes?.length ? `（${c.boxes.length} 个框）` : ''}${c.other ? `；${esc(c.other)}` : ''}`;
  $('rvAnswers').innerHTML = `<div class="notice" style="margin-bottom:8px">${qText}<br>${cText}</div>`;
  renderBoxes();
  const hist = [
    ...rows.filter(r => r.site === code && r.scene_id === p.scene_id).map(r => ({ t: r.created_at, s: `同学保存${r.kind === 'quality' ? '第一步' : '第二步'}` })),
    ...reviewsOf(code, p.scene_id).map(r => ({ t: r.created_at, s: `组长：${DEC[r.decision]}${r.comment ? ` —— ${esc(r.comment)}` : ''}` })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  $('rvHist').innerHTML = hist.map(h => `<div>${fmtTime(h.t)}　${h.s}</div>`).join('') || '<div>暂无</div>';
}

function renderBoxes() {
  const list = $('rvBoxes');
  list.innerHTML = '';
  for (const b of work.boxes) {
    const item = document.createElement('div');
    item.className = 'boxitem' + (scene.selected === b.id ? ' sel' : '');
    const chips = CHANGE_TAGS.map(t => `<button class="chip${b.tags.includes(t.key) ? ' on' : ''}" data-tag="${t.key}">${t.label}</button>`).join('');
    item.innerHTML = `<div class="bh"><span class="num">${b.id}</span><span>${b.note ? esc(b.note) : '框的类别'}</span><span class="sp"></span>
      <button class="btn sm ghost" data-act="focus">定位</button><button class="btn sm ghost danger" data-act="del">删除</button></div><div class="chips">${chips}</div>`;
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
    data = { status: work.boxes.length ? 'changes' : 'none', overall: work.overall || [], other: work.other || '', boxes: work.boxes.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, tags: b.tags, note: b.note || '' })) };
  }
  try {
    const res = await append('reviews', { site: code, scene_id: p.scene_id, kind, reading_id: reading?.id || null, decision, data, comment: comment || null });
    reviews.push(res.row);
    toast(`已保存：${DEC[decision]}`);
    renderList();
    openReview(true);
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
        <span>${i >= 0 ? `第 ${i} 期 ${per[i].date}` : ''}</span>${q.box ? `<span>附带框 ${q.box.id}（第${q.box.step === 2 ? '二' : '一'}步）</span>` : ''}<span>${fmtTime(q.created_at)}</span>
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
        answers.push(res.row);
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

function effectiveCompare(code, p) {
  const l = latest[code][p.scene_id] || {};
  const rv = lastReview(code, p.scene_id, 'compare');
  if (rv?.decision === 'modified' && rv.data) return { data: rv.data, source: '组长修改', rv };
  return { data: l.compare?.data || null, source: '同学', rv };
}

function exportPeriods() {
  const out = [['测点', '期序', '日期', '卫星', '轨道', '距上一期天数', '上一期日期', '看得清程度', '看不清原因', '看不清其他说明', '看不清框数', '其余也模糊',
    '对比结果', '不同点', '变化框数', '变化类别汇总', '其他说明', '结果来源', '复核结论', '复核批注']];
  for (const code of SITE_ORDER) periods[code].forEach((p, i) => {
    const l = latest[code][p.scene_id] || {};
    const q = l.quality?.data;
    const { data: c, source, rv } = effectiveCompare(code, p);
    const tagCount = {};
    for (const b of c?.boxes || []) for (const t of b.tags) tagCount[TAG[t] || t] = (tagCount[TAG[t] || t] || 0) + 1;
    out.push([sites[code].name, i, p.date, p.satellite, p.orbit, p.gap_days ?? '', periods[code][i - 1]?.date || '',
      q ? (QUALITY_NAME[q.clear] || q.clear) : '', (q?.reasons || []).join('、'), q?.other || '', q?.boxes?.length || '', q?.also_blurry ? '是' : '',
      c ? ({ none: '没有局部变化', changes: '有局部变化', uncomparable: '没法比较' })[c.status] : '', (c?.overall || []).map(o => OVERALL_NAME[o] || o).join('、'),
      c?.boxes?.length ?? '', Object.entries(tagCount).map(([t, n]) => `${t}×${n}`).join('；'), c?.other || '', c ? source : '', rv ? DEC[rv.decision] : '', rv?.comment || '']);
  });
  download(`判读结果_每一期_${stamp()}.csv`, csv(out));
}

function exportBoxes() {
  const out = [['测点', '期序', '日期', '上一期日期', '框号', '像元x0', '像元y0', '像元x1', '像元y1', 'UTM左上X', 'UTM左上Y', 'UTM右下X', 'UTM右下Y', '类别', '说明', '结果来源', '复核结论', '复核批注']];
  for (const code of SITE_ORDER) {
    const [ox, oy] = sites[code].grid_origin;
    periods[code].forEach((p, i) => {
      const { data: c, source, rv } = effectiveCompare(code, p);
      for (const b of c?.status === 'changes' ? c.boxes : []) {
        out.push([sites[code].name, i, p.date, periods[code][i - 1]?.date || '', b.id, b.x0, b.y0, b.x1, b.y1,
          (ox + b.x0 * 10).toFixed(1), (oy - b.y0 * 10).toFixed(1), (ox + b.x1 * 10).toFixed(1), (oy - b.y1 * 10).toFixed(1),
          b.tags.map(t => TAG[t] || t).join('、'), b.note || '', source, rv ? DEC[rv.decision] : '', rv?.comment || '']);
      }
    });
  }
  download(`判读结果_变化框清单_${stamp()}.csv`, csv(out));
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
  ['fSite', 'fType', 'fUnreviewed'].forEach(id => $(id).addEventListener('change', () => renderList()));
  $('btnSample').onclick = () => {
    const items = listItems();
    for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
    renderList(items.slice(0, 5));
  };
  $('exPeriods').onclick = exportPeriods;
  $('exBoxes').onclick = exportBoxes;
  $('exJson').onclick = () => download(`判读记录_完整备份_${stamp()}.json`, JSON.stringify({ exported_at: new Date().toISOString(), readings: rows, reviews, questions, answers }, null, 1), 'application/json');
  for (const c of SITE_ORDER) latest[c] = {};
  try { await loadAll(); } catch { $('updated').textContent = '暂时连不上数据库'; }
  renderList();
  setInterval(async () => { try { await loadAll(); } catch { /* keep the last data */ } }, 60000);
}
main();
