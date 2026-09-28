// Learning page: atlas cards, practice link, and FAQ (built-in answers plus answers the leader marked for the FAQ).
import { selectAll } from './api.js';
import { loadPeriods } from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const FAQ = [
  ['这一期局部有云，还要和上一期比较吗？', '要。第一步选“有些地方看不清”，把云框出来；第二步在其他看得清的地方照常比较。只有“基本看不清”才不用比较。'],
  ['整幅都有点模糊，还能标吗？', '能。第一步选“整体模糊，但还能看”，照常比较。只记你能确定的不同，拿不准的选“有差别，但说不清是什么”。'],
  ['上一期那里有云，这一期看得清，能说是新出现的吗？', '不能确定。上一期那里看不见，就没法知道是不是新出现的。可以画框，选“有差别，但说不清是什么”，写一句“上一期那里有云”。'],
  ['庄稼返青、收割这种季节变化要不要记？', '要记。选“植被 增加”或“植被 减少”，可以写一句“可能是季节变化”。我们先把看到的都记下来，后面再统一分析。'],
  ['整幅颜色变了，算不算变化？', '在第二步的“不同点”里勾“整体颜色或亮度变了”，不用画框。地面上某个具体的东西变了，才需要画框。'],
  ['放大以后看到一个个方格，是不是图坏了？', '不是。一个方格就是地面上 10 米 × 10 米，卫星影像本来就是这样，放大不会更清楚。'],
  ['拿不准是什么变化怎么办？', '画框，选“有差别，但说不清是什么”，在框下面写一句你看到的样子，比如“绿色变浅了一块”。也可以点判读页右下角的“有疑问，提问”。'],
  ['做错了能改吗？', '能。回到那一期重新选、重新保存就行。旧记录会保留，组长能看到修改历史，不用担心。'],
  ['网断了怎么办？', '照常做。记录会先存在你的电脑上，右上角显示“等待上传”，联网后自动上传。这段时间不要清浏览器缓存。'],
  ['“看不清”和“没有明显不同”有什么区别？', '看不清是“没法判断”，没有明显不同是“看清了，确实没变”。两者意思完全不同，不能混用。'],
  ['一天要做多少期？', '按自己的节奏来，认真看比做得快重要。每一期都要把观察范围完整看一遍。'],
];

function card(it) {
  const two = it.images.length > 1;
  return `<article class="card acard"><div class="imgs${two ? '' : ' one'}">${it.images.map(im => `<img src="${im.src}" alt="${esc(im.label)}" title="${esc(im.label)}">`).join('')}</div>
    <div class="ab"><b>${esc(it.title)}</b> <span class="tiny">${two ? `${esc(it.site_name)} · ` : ''}${it.images.map(im => esc(im.label)).join(' → ')}</span>
    <p>${esc(it.desc)}</p><div class="how">怎么记：${esc(it.how)}</div></div></article>`;
}

async function main() {
  const atlas = await fetch('data/atlas.json').then(r => r.json());
  $('atlasQ').innerHTML = atlas.quality.map(card).join('');
  $('atlasC').innerHTML = atlas.changes.map(card).join('');
  const hy = await loadPeriods('HY');
  const i = hy.findIndex(p => p.date === '2023-09-29');
  if (i > 0) $('practiceBtn').href = `work.html?site=HY&practice=1#${i}`;
  let extra = [];
  try {
    const [qs, as] = await Promise.all([selectAll('questions'), selectAll('answers')]);
    const byId = Object.fromEntries(qs.map(q => [q.id, q]));
    extra = as.filter(a => a.add_to_faq && byId[a.question_id]).map(a => [byId[a.question_id].text, a.text]);
  } catch { /* the built-in list still shows */ }
  $('faqList').innerHTML = [...extra, ...FAQ].map(([q, a]) => `<details style="border-bottom:1px solid var(--line);padding:10px 0"><summary style="cursor:pointer;font-weight:600">${esc(q)}</summary><p style="margin:8px 0 0">${esc(a)}</p></details>`).join('');
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}
main();
