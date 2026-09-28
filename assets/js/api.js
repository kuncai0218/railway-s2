// Supabase REST access (read + append only) with a local retry queue so nothing is lost when the network drops.
import { SUPABASE_URL, SUPABASE_KEY, APP_VERSION } from './config.js';

const QUEUE_KEY = 'rs2_upload_queue_v1';
const CLIENT_KEY = 'rs2_client_id';
const listeners = new Set();

function headers(extra = {}) {
  return { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...extra };
}

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function clientId() {
  let id = null;
  try { id = localStorage.getItem(CLIENT_KEY); } catch { /* storage blocked */ }
  if (!id) { id = uuid(); try { localStorage.setItem(CLIENT_KEY, id); } catch { /* ignore */ } }
  return id;
}

export function pendingRows(table) {
  return readJSON(QUEUE_KEY, []).filter(item => !table || item.table === table).map(item => item.row);
}

export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { const n = readJSON(QUEUE_KEY, []).length; listeners.forEach(fn => fn(n)); }

async function post(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    // created_at is set by the server so the order of versions never depends on a student's computer clock
    method: 'POST', headers: headers({ Prefer: 'return=minimal' }), body: JSON.stringify({ ...row, created_at: undefined }),
  });
  // 409 = the row id already exists, i.e. an earlier retry already got through
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    const err = new Error(`保存失败（${res.status}）${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

// The server rejected the content itself (bad data); anything else (offline, table missing, project paused) is retried later.
const isRejected = err => [400, 413, 422].includes(err.status);

// Append a row. The row gets its id on the client so retries never create duplicates.
export async function append(table, row) {
  const full = { id: uuid(), created_at: new Date().toISOString(), client_id: clientId(), ...row };
  if (table === 'readings') full.app_version = APP_VERSION;
  try {
    await post(table, full);
    return { row: full, queued: false };
  } catch (err) {
    if (isRejected(err)) throw err;
    const q = readJSON(QUEUE_KEY, []);
    q.push({ table, row: full });
    writeJSON(QUEUE_KEY, q);
    notify();
    return { row: full, queued: true };
  }
}

let flushing = false;
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let q = readJSON(QUEUE_KEY, []);
    while (q.length) {
      const item = q[0];
      try { await post(item.table, item.row); } catch (err) {
        if (isRejected(err)) {
          console.error('丢弃无法保存的记录', item, err);
        } else break;
      }
      q = readJSON(QUEUE_KEY, []).slice(1);
      writeJSON(QUEUE_KEY, q);
      notify();
    }
  } finally { flushing = false; }
}
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 30000);

// Read every row matching the filters, 1000 at a time.
export async function selectAll(table, filters = {}, order = 'created_at.asc') {
  const out = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const qs = new URLSearchParams({ select: '*', order, limit: String(page), offset: String(offset) });
    for (const [k, v] of Object.entries(filters)) qs.append(k, v);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, { headers: headers() });
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}
