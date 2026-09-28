// Static site data + the latest reading per period, shared by every page.
import { selectAll, pendingRows } from './api.js';

const cache = {};
async function getJSON(path) {
  if (!cache[path]) cache[path] = fetch(path, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(path); return r.json(); });
  return cache[path];
}

export const loadSites = () => getJSON('data/sites.json');
export const loadPeriods = code => getJSON(`data/periods_${code}.json`);

// All readings of a site: server rows plus rows still waiting in this browser's upload queue.
export async function loadReadings(code) {
  let rows = [];
  let online = true;
  try { rows = await selectAll('readings', { site: `eq.${code}` }); } catch (err) { online = false; console.warn(err); }
  const seen = new Set(rows.map(r => r.id));
  for (const r of pendingRows('readings')) if (r.site === code && !seen.has(r.id)) rows.push({ ...r, _pending: true });
  // rows still waiting to upload carry this computer's clock: keep them after the server's rows
  rows.sort((a, b) => (!!a._pending - !!b._pending) || a.created_at.localeCompare(b.created_at));
  return { rows, online };
}

// latest[scene_id] = { quality: row, compare: row, precise: row }
export function latestByScene(rows) {
  const latest = {};
  for (const r of rows) {
    const slot = latest[r.scene_id] || (latest[r.scene_id] = {});
    slot[r.kind] = r.data?.deleted ? undefined : r;   // a deletion is stored as a new "deleted" version
  }
  return latest;
}

// One word per period for dots, filters and progress.
export function periodState(period, latest) {
  const l = latest[period.scene_id] || {};
  const q = l.quality?.data;
  if (period.role === 'baseline') return q ? 'done' : 'todo';
  const c = l.compare?.data;
  if (!q) return 'todo';
  if (!c) return 'half';
  if (c.status === 'uncomparable') return 'uncomparable';
  if (c.status === 'changes') return 'changes';
  return 'done';
}

export function progress(periods, latest) {
  const tasks = periods.filter(p => p.role === 'task');
  const baseline = periods.filter(p => p.role === 'baseline');
  const states = tasks.map(p => periodState(p, latest));
  const finished = states.filter(s => s !== 'todo' && s !== 'half').length;
  const baseDone = baseline.every(p => periodState(p, latest) === 'done');
  return { total: tasks.length, finished, baseDone, changes: states.filter(s => s === 'changes').length };
}

export function fmtDate(iso) { return iso ? iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日').replace(/年0/, '年').replace(/月0/, '月') : ''; }
export function fmtTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Same content, same text, whatever order the keys come back from the database in.
export function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).filter(k => x[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}

// ---------- step 2 after the leader's review, and step 3 (精确标注) ----------
// A row saved in this browser during this visit, or still waiting to upload, carries this computer's clock;
// it is newer than anything read from the server.
const fresh = r => !!(r && (r._fresh || r._pending));
export function isAfter(a, b) {
  if (!b) return true;
  if (fresh(a) !== fresh(b)) return fresh(a);
  return a.created_at >= b.created_at;
}

// What step 2 of one period currently says: the student's latest version, replaced by a later modification of the leader,
// and the leader's verdict (confirmed / modified / rejected) on that version. rvs: the period's reviews, oldest first.
export function stepTwo(slot, rvs) {
  const c = slot?.compare;
  if (!c) return { data: null, source: null, verdict: null };
  let data = c.data, source = 'student', verdict = null;
  for (const r of rvs) {
    if (r.kind !== 'compare' || !isAfter(r, c)) continue;
    if (r.decision === 'modified' && r.data) { data = r.data; source = 'leader'; }
    if (r.decision === 'confirmed' || r.decision === 'modified' || r.decision === 'rejected') verdict = r;
  }
  return { data, source, verdict };
}

// Step 3 of one period. state:
//   null       nothing to do (no local change, not a task period)
//   'wait'     the leader has not confirmed this version of step 2 yet
//   'rejected' the leader said the boxes are not changes
//   'open'     to do (or a box changed since the last save)
//   'done'     saved, waiting for the leader
//   'returned' the leader sent it back
//   'checked'  the leader passed it
export function stepThree(period, slot, rvs) {
  const two = stepTwo(slot, rvs);
  const out = { state: null, two, boxes: [], precise: null, check: null };
  if (period.role !== 'task' || two.data?.status !== 'changes' || !(two.data.boxes || []).length) return out;
  if (!two.verdict) return { ...out, state: 'wait' };
  if (two.verdict.decision === 'rejected') return { ...out, state: 'rejected' };
  out.boxes = two.data.boxes;
  const p = slot.precise || null;
  out.precise = p;
  if (p) for (const r of rvs) if (r.kind === 'precise' && (r.decision === 'confirmed' || r.decision === 'returned') && isAfter(r, p)) out.check = r;
  const complete = !!p && out.boxes.every(b => {
    const m = (p.data.boxes || []).find(x => x.id === b.id);
    return m && sameGeom(m, b) && m.n1 + m.n2 > 0;
  });
  out.state = !complete ? 'open' : !out.check ? 'done' : out.check.decision === 'confirmed' ? 'checked' : 'returned';
  return out;
}
export const STEP3_NAME = { wait: '等组长确认第二步', rejected: '组长认为不是变化', open: '第三步待做', done: '第三步已保存，等组长检查', returned: '第三步被组长退回', checked: '第三步已通过' };
export const canStep3 = s3 => ['open', 'done', 'returned', 'checked'].includes(s3?.state);

export function reviewsByScene(rvs) {
  const out = {};
  for (const r of rvs) (out[r.scene_id] = out[r.scene_id] || []).push(r);
  return out;
}

// Cells of a box: every 10 m pixel the box touches.
export function cellRange(b) {
  const c0 = Math.max(0, Math.floor(b.x0)), r0 = Math.max(0, Math.floor(b.y0));
  return { c0, r0, w: Math.max(1, Math.min(256, Math.ceil(b.x1)) - c0), h: Math.max(1, Math.min(256, Math.ceil(b.y1)) - r0) };
}
export const sameGeom = (a, b) => ['x0', 'y0', 'x1', 'y1'].every(key => Math.abs(a[key] - b[key]) < 0.05);

// A box's cells as run-length text, row by row: "015.13.02" = 15 cells of 0, then 3 of 1, then 2 of 0.
// 0 = not changed, 1 = changed, 2 = not sure.
export function encodeCells(cells) {
  const out = [];
  let v = cells[0], n = 0;
  for (const x of cells) {
    if (x === v) n++;
    else { out.push(`${v}${n}`); v = x; n = 1; }
  }
  out.push(`${v}${n}`);
  return out.join('.');
}
export function decodeCells(text, len) {
  const a = new Uint8Array(len);
  let i = 0;
  for (const t of String(text || '').split('.')) {
    if (!t) continue;
    const v = Number(t[0]), n = Number(t.slice(1));
    if (!(v >= 0 && v <= 2) || !(n > 0)) { console.warn('格子记录有误', text); return new Uint8Array(len); }
    a.fill(v, i, Math.min(len, i + n));
    i += n;
  }
  return a;
}
export function countCells(cells) {
  let n1 = 0, n2 = 0;
  for (const x of cells) { if (x === 1) n1++; else if (x === 2) n2++; }
  return { n1, n2 };
}
