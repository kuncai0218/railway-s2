// Live board: progress, a colour strip per site, a map of every recorded change, and recent activity.
import { tableSync } from './api.js';
import { loadSites, loadPeriods, latestByScene, periodState, progress, fmtDate, fmtTime, stepThree, reviewsByScene } from './store.js';
import { SITE_ORDER, CHANGE_TAGS, OVERALL_NAME } from './config.js';

const $ = id => document.getElementById(id);
const TAG = Object.fromEntries(CHANGE_TAGS.map(t => [t.key, t.label]));
const STATE_NAME = { todo: '未开始', half: '只做了第一步', done: '没有局部变化', changes: '有局部变化', uncomparable: '没法比较' };
const S3_NAME = { wait: '第三步：等组长确认第二步', rejected: '组长认为不是变化', open: '第三步：待做', returned: '第三步：被退回，待修改', done: '第三步：等组长检查', checked: '第三步：已通过' };
let sites, periods = {}, built = false;

function boxRects(boxes, color = '#FF4D4F', attrs = '') {
  return boxes.map(b => `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="rgba(255,77,79,.12)" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" ${attrs}/>`).join('');
}

function showPair(code, p, prev, data) {
  $('pmTitle').textContent = `${sites[code].name} · ${fmtDate(prev.date)} → ${fmtDate(p.date)}`;
  $('pmA').src = prev.tc; $('pmB').src = p.tc;
  $('pmLa').textContent = `上一期 ${prev.date}`; $('pmLb').textContent = `这一期 ${p.date}`;
  $('pmSa').innerHTML = boxRects(data.boxes); $('pmSb').innerHTML = boxRects(data.boxes);
  const idx = periods[code].indexOf(p);
  $('pmOpen').href = `work.html?site=${code}#${idx}`;
  $('pmInfo').innerHTML = data.boxes.map(b => `<div style="margin:4px 0"><b style="color:#d9363e">框 ${b.id}</b>：${b.tags.map(t => TAG[t] || t).join('、') || '未选类别'}${b.note ? `；${b.note}` : ''}</div>`).join('')
    + ((data.overall || []).filter(o => o !== 'local').length ? `<div>不同点：${data.overall.filter(o => o !== 'local').map(o => OVERALL_NAME[o] || o).join('、')}</div>` : '') + (data.other ? `<div>其他：${data.other}</div>` : '');
  $('pairModal').classList.add('show');
}

function render(rows, reviews, questions, answers) {
  const box = $('sites');
  if (!built) { box.innerHTML = ''; }
  for (const code of SITE_ORDER) {
    const s = sites[code];
    const per = periods[code];
    const rs = rows.filter(r => r.site === code);
    const latest = latestByScene(rs);
    const rvs = reviewsByScene(reviews.filter(r => r.site === code));
    const s3 = per.map(p => stepThree(p, latest[p.scene_id] || {}, rvs[p.scene_id] || []));
    const n3 = s => s3.filter(x => x.state === s).length;
    const pr = progress(per, latest);
    const qOf = p => latest[p.scene_id]?.quality?.data;
    const unclear = per.filter(p => ['partial', 'no'].includes(qOf(p)?.clear)).length;
    const blurry = per.filter(p => qOf(p)?.clear === 'blurry').length;
    let sec = document.getElementById(`sec-${code}`);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'card board-site';
      sec.id = `sec-${code}`;
      box.appendChild(sec);
      const anchor = document.createElement('a');
      anchor.id = code;
      sec.prepend(anchor);
    }
    const cells = per.map((p, i) => {
      const st = periodState(p, latest);
      return `<a class="${st}${p.role === 'baseline' ? ' base' : ''}" href="work.html?site=${code}#${i}" title="${i === 0 ? '第 0 期' : `第 ${i} 期`} ${p.date}：${STATE_NAME[st]}"></a>`;
    }).join('');
    const cells3 = per.map((p, i) => {
      const st = s3[i].state;
      return `<a class="${st || ''}" href="work.html?site=${code}#${i}" title="${i === 0 ? '第 0 期' : `第 ${i} 期`} ${p.date}：${S3_NAME[st] || '不用做第三步'}"></a>`;
    }).join('');
    const ref = per.find(p => p.date === ({ ZZ: '2023-03-05', HY: '2023-11-20', SG: '2023-11-20' })[code]) || per[1];
    // step 2 as it stands after the leader's review; boxes the leader rejected are left out
    const changeRows = per.map((p, i) => ({ p, c: s3[i].two.data && s3[i].two.verdict?.decision !== 'rejected' ? { data: s3[i].two.data } : null })).filter(x => x.c?.data?.status === 'changes');
    const rects = changeRows.map(({ p, c }) => (c.data.boxes || []).map(b =>
      `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="rgba(255,77,79,.18)" stroke="#FF4D4F" stroke-width="2" vector-effect="non-scaling-stroke" data-scene="${p.scene_id}"><title>${p.date}：${b.tags.map(t => TAG[t] || t).join('、')}</title></rect>`).join('')).join('');
    const counts = {};
    for (const { c } of changeRows) for (const b of c.data.boxes || []) for (const t of b.tags) counts[t] = (counts[t] || 0) + 1;
    const stats = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span>${TAG[t] || t}<b>${n}</b></span>`).join('') || '<span class="tiny">还没有记录变化</span>';
    const feed = rs.filter(r => r.kind === 'compare' || r.kind === 'precise').slice(-12).reverse().map(r => {
      const i = per.findIndex(p => p.scene_id === r.scene_id);
      const p = per[i];
      const d = r.data;
      let what = d.deleted ? '删除了这一期的标注' : d.status === 'changes' ? `记录 ${d.boxes?.length || 0} 处不同` : d.status === 'uncomparable' ? '没法比较' : '没有明显不同';
      if (r.kind === 'precise') what = d.deleted ? '删除了第三步' : `完成第三步，涂了 ${(d.boxes || []).reduce((s, b) => s + (b.n1 || 0), 0)} 格变化`;
      return `<div class="it"><time>${fmtTime(r.created_at)}</time><span>第 ${i} 期 ${p ? p.date : ''} · ${what}</span></div>`;
    }).join('') || '<div class="tiny">还没有动态</div>';
    const mid = per[Math.floor(per.length / 2)];
    sec.innerHTML = `<a id="${code}"></a>
      <div class="bs-head"><h2><i style="background:${s.color}"></i>${s.name}</h2>
        <div class="progress"><i style="width:${Math.round(pr.finished / pr.total * 100)}%;background:${s.color}"></i></div>
        <div class="bs-nums"><span>已完成 <b>${pr.finished}</b> / ${pr.total} 期</span><span>有变化 <b>${pr.changes}</b> 期</span><span>整体模糊 <b>${blurry}</b> 期</span><span>有地方看不清 <b>${unclear}</b> 期</span></div>
        <a class="btn sm" href="work.html?site=${code}">进入判读</a></div>
      <div class="timeline">${cells}</div>
      <div class="timeline t3">${cells3}</div>
      <div class="tl-axis"><span>${per[0].date}</span><span>${mid.date}</span><span>${per[per.length - 1].date}</span></div>
      <div class="s3nums"><span>第三步（精确标注）：</span><span>已通过 <b>${n3('checked')}</b></span><span>等组长检查 <b>${n3('done')}</b></span>
        <span>待做 <b>${n3('open') + n3('returned')}</b></span><span>等组长确认第二步 <b>${n3('wait')}</b></span></div>
      <div class="bs-body">
        <div class="cmap"><img src="${ref.tc}" alt="${s.name}"><svg viewBox="0 0 256 256" preserveAspectRatio="none">${rects}</svg></div>
        <div><h3 style="font-size:15px">各类变化</h3><div class="tagstats">${stats}</div>
          <h3 style="font-size:15px;margin-top:16px">最新动态</h3><div class="feed">${feed}</div></div>
      </div>`;
    sec.querySelectorAll('rect[data-scene]').forEach(r => r.addEventListener('click', () => {
      const p = per.find(x => x.scene_id === r.dataset.scene);
      const prev = per[per.indexOf(p) - 1];
      showPair(code, p, prev, s3[per.indexOf(p)].two.data);
    }));
  }
  built = true;
  const answered = new Set(answers.map(a => a.question_id));
  $('qLink').textContent = `待回答的问题：${questions.filter(q => !answered.has(q.id)).length}`;
  $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

const sync = { readings: tableSync('readings'), reviews: tableSync('reviews'), questions: tableSync('questions'), answers: tableSync('answers') };
async function refresh() {
  if (document.hidden && built) return;      // nobody is looking: skip this round
  try {
    const [rows, reviews, questions, answers] = await Promise.all([sync.readings.pull(), sync.reviews.pull(), sync.questions.pull(), sync.answers.pull()]);
    render(rows, reviews, questions, answers);
  } catch (err) {
    if (!built) render([], [], [], []);
    $('updated').textContent = '暂时连不上数据库，稍后自动重试';
  }
}

async function main() {
  sites = await loadSites();
  for (const c of SITE_ORDER) periods[c] = await loadPeriods(c);
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.modal-back').classList.remove('show'));
  $('pairModal').addEventListener('click', e => { if (e.target === $('pairModal')) $('pairModal').classList.remove('show'); });
  await refresh();
  if (location.hash) document.getElementById(`sec-${location.hash.slice(1)}`)?.scrollIntoView();
  setInterval(refresh, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
main();
