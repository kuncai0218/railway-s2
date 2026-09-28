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
  rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { rows, online };
}

// latest[scene_id] = { quality: row, compare: row }
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
