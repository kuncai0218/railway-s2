// Home page: site cards with live progress and today's totals.
import { selectAll } from './api.js';
import { loadSites, loadPeriods, latestByScene, progress, stepThree, reviewsByScene } from './store.js';
import { SITE_ORDER, SITE_INFO } from './config.js';

const $ = id => document.getElementById(id);
const today = () => new Date().toDateString();

function aoiSvg(site) {
  if (!site.aoi) return '';
  const pts = site.aoi.ring.map(p => p.join(',')).join(' ');
  return `<svg viewBox="0 0 256 256" preserveAspectRatio="none"><path d="M0,0H256V256H0Z M${site.aoi.ring.map(p => p.join(',')).join(' L')} Z" fill="rgba(0,0,0,.45)" fill-rule="evenodd"/>
    <polygon points="${pts}" fill="none" stroke="#FFD43B" stroke-width="3" stroke-dasharray="8 5"/></svg>`;
}

async function main() {
  const sites = await loadSites();
  const periods = {};
  for (const c of SITE_ORDER) periods[c] = await loadPeriods(c);
  let rows = [], reviews = [], questions = [], answers = [], online = true;
  try {
    [rows, reviews, questions, answers] = await Promise.all([selectAll('readings'), selectAll('reviews'), selectAll('questions'), selectAll('answers')]);
  } catch { online = false; }

  const box = $('sites');
  box.innerHTML = '';
  for (const c of SITE_ORDER) {
    const s = sites[c];
    const info = SITE_INFO[c];
    const latest = latestByScene(rows.filter(r => r.site === c));
    const pr = progress(periods[c], latest);
    const rvs = reviewsByScene(reviews.filter(r => r.site === c));
    const todo3 = periods[c].filter(p => ['open', 'returned'].includes(stepThree(p, latest[p.scene_id] || {}, rvs[p.scene_id] || []).state)).length;
    const ref = periods[c].find(p => p.date === info.refDate) || periods[c][1];
    const pct = Math.round(pr.finished / pr.total * 100);
    const card = document.createElement('article');
    card.className = 'card scard';
    card.style.setProperty('--site', s.color);
    card.innerHTML = `
      <div class="photo" style="background-image:url('img/photos/${c}_overview.jpg')"></div>
      <div class="body">
        <h2><i></i>${s.name}</h2>
        <p class="concern">${info.concern}</p>
        <div class="mini">
          <div class="sat"><img src="${ref.tc}" alt="${s.name}卫星影像">${aoiSvg(s)}</div>
          <div class="stat">
            <span>负责：${info.person || '待定'}</span>
            <span><b>${pr.finished}</b> / ${pr.total} 期已完成</span>
            <span>记录变化 ${pr.changes} 期</span>
            ${todo3 ? `<span class="todo3">第三步待做 ${todo3} 期</span>` : ''}
            <span>${s.aoi ? '看河右侧：从河岸线到山上（黄线内）' : '看整幅影像'}</span>
          </div>
        </div>
        <div class="progress"><i style="width:${pct}%;background:${s.color}"></i></div>
        <div class="actions"><a class="btn primary" href="work.html?site=${c}">进入判读</a><a class="btn" href="board.html#${c}">看进度</a></div>
      </div>`;
    box.appendChild(card);
  }

  if (!online) {
    ['tDone', 'tChanges', 'tQuestions'].forEach(id => { $(id).textContent = '—'; });
    $('connState').textContent = ' · 暂时连不上数据库，进度显示可能不是最新。';
    return;
  }
  const todays = rows.filter(r => new Date(r.created_at).toDateString() === today());
  const doneToday = new Set(todays.filter(r => r.kind === 'compare' && !r.data?.deleted).map(r => r.site + r.scene_id));
  $('tDone').textContent = doneToday.size;
  $('tChanges').textContent = todays.filter(r => r.kind === 'compare' && r.data?.status === 'changes').reduce((n, r) => n + (r.data.boxes?.length || 0), 0);
  const answered = new Set(answers.map(a => a.question_id));
  $('tQuestions').textContent = questions.filter(q => !answered.has(q.id)).length;
}
main();
