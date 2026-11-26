// The guard's own log: one JSON line per delegation request, local to this machine, never synced. It holds structure only (tool,
// kind, helper or role name, whether a model was named, counts for a Workflow, the decision, the time it took), never prompts,
// scripts or file contents. `doctor` and `audit` read it; it is the one audit source for all three tools.
import fs from 'node:fs';
import path from 'node:path';

export const logFile = (L, d = new Date()) => path.join(L.logs, `guard-${d.toISOString().slice(0, 7)}.jsonl`);
export const LOG_STRING_MAX = 200;
export const LOG_OBJECT_KEYS_MAX = 24;
export const LOG_ARRAY_ENTRIES_MAX = 16;
export const LOG_RECORD_BYTES_MAX = 16384;

export function boundRecord(value) {
  let remaining = 160;
  function visit(x, depth = 0) {
    if (--remaining < 0) return '[truncated]';
    if (typeof x === 'string') return x.slice(0, LOG_STRING_MAX);
    if (x === null || typeof x === 'number' || typeof x === 'boolean') return x;
    if (Array.isArray(x)) return x.slice(0, LOG_ARRAY_ENTRIES_MAX).map((v) => visit(v, depth + 1));
    if (typeof x !== 'object' || depth >= 5) return undefined;
    const out = {};
    for (const [key, item] of Object.entries(x).slice(0, LOG_OBJECT_KEYS_MAX)) {
      const bounded = visit(item, depth + 1);
      if (bounded !== undefined) out[String(key).slice(0, 64)] = bounded;
    }
    return out;
  }
  const safe = visit(value);
  let text = JSON.stringify(safe);
  if (Buffer.byteLength(text, 'utf8') > LOG_RECORD_BYTES_MAX) {
    const minimal = {};
    for (const k of ['t', 'tool', 'mode', 'fault', 'errorName']) if (safe?.[k] !== undefined) minimal[k] = safe[k];
    text = JSON.stringify(minimal);
  }
  return JSON.parse(text);
}

export async function logRecord(L, rec) {
  const record = boundRecord({ t: new Date().toISOString(), ...rec });
  await fs.promises.mkdir(L.logs, { recursive: true });
  await fs.promises.appendFile(logFile(L), JSON.stringify(record) + '\n');
}

export function readRecords(L, { days = 7, now = new Date() } = {}) {
  const out = [];
  if (!fs.existsSync(L.logs)) return out;
  const since = now.getTime() - days * 86400000;
  const current = now.getTime();
  let names;
  try { names = fs.readdirSync(L.logs); } catch { return out; }
  for (const f of names.filter((n) => /^guard-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    const [, year, month] = /^guard-(\d{4})-(\d{2})\.jsonl$/.exec(f);
    const fileStart = Date.UTC(Number(year), Number(month) - 1, 1);
    const fileEnd = Date.UTC(Number(year), Number(month), 1);
    if (fileEnd <= since || fileStart > current) continue;
    let content;
    try { content = fs.readFileSync(path.join(L.logs, f), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); const t = Date.parse(r.t); if (t >= since && t <= current) out.push(r); } catch { /* a torn last line is ignored */ }
    }
  }
  return out;
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

export function summarize(records) {
  const byTool = {}, byReason = {}, faults = [];
  const ms = [];
  for (const r of records) {
    const t = (byTool[r.tool] ||= { requests: 0, wouldDeny: 0, delegation: 0 });
    t.requests++;
    if (r.kind && r.kind !== 'other') t.delegation++;
    if (r.decision === 'deny') { t.wouldDeny++; for (const x of r.reasons || []) byReason[x] = (byReason[x] || 0) + 1; }
    if (r.fault) faults.push(r);
    if (typeof r.ms === 'number') ms.push(r.ms);
  }
  ms.sort((a, b) => a - b);
  return { total: records.length, byTool, byReason, faults: faults.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: ms.length ? ms[ms.length - 1] : null };
}
