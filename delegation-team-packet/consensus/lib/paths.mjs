import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuse } from './fail.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidTaskId(id) {
  const s = String(id == null ? '' : id);
  return TASK_ID_RE.test(s) && !s.includes('..');
}

export function runtimeDir() {
  return path.dirname(LIB_DIR);
}

export function ledgerRoot() {
  const env = process.env.CONSENSUS_LEDGER;
  const root = env && String(env).trim()
    ? path.resolve(String(env).trim())
    : path.join(os.homedir(), '.config', 'delegate-skills', 'consensus-ledger');
  // Long-name form: a Windows 8.3 short name would be rejected by a restricted seat.
  try { return fs.realpathSync.native(root); } catch { return root; }
}

export function indexPath() {
  return path.join(ledgerRoot(), 'index.json');
}

export function taskDir(id) {
  if (id == null || String(id) === '') refuse('NO_TASK', 'Missing --task id.');
  if (!isValidTaskId(id)) refuse('BAD_TASK_ID', 'Task ids contain only letters, digits, dot, dash and underscore.');
  return path.join(ledgerRoot(), 'tasks', String(id));
}

export function taskPaths(id) {
  const root = taskDir(id);
  return {
    root,
    ledger: path.join(root, 'ledger.json'),
    events: path.join(root, 'events.jsonl'),
    materials: path.join(root, 'materials'),
    frozen: path.join(root, 'frozen'),
    frozenChecklist: path.join(root, 'frozen', 'checklist.md'),
    seals: path.join(root, 'seals'),
    calls: path.join(root, 'calls'),
    reports: path.join(root, 'reports'),
    pending: path.join(root, 'pending.json'),
    detach: path.join(root, 'detach'),
  };
}

export function callDir(id, n) {
  return path.join(taskPaths(id).calls, String(n));
}

export function sealPath(id, phase, round) {
  return path.join(taskPaths(id).seals, `${phase}-${round}.json`);
}

export function localJsonPath() {
  return path.join(runtimeDir(), 'local.json');
}

// A missing local.json means no machine marks. One that exists but cannot be read switches
// consensus off (fail closed): its marks might have excluded seats or disabled consensus.
export function loadLocalJson() {
  const file = localJsonPath();
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return { disabled: 'local.json is not a JSON object; run the team installer again' };
  } catch (error) {
    return { disabled: `local.json could not be read (${error.message}); run the team installer again` };
  }
}

export function seatsJsonPath() {
  return path.join(runtimeDir(), 'seats.json');
}

export function limitsJsonPath() {
  return path.join(runtimeDir(), 'limits.json');
}

export function versionPath() {
  return path.join(runtimeDir(), 'VERSION');
}

export function readVersion() {
  try {
    return fs.readFileSync(versionPath(), 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '0.0.0';
  }
}

export function schemaPath(phase) {
  return path.join(runtimeDir(), 'schemas', `${phase}.schema.json`);
}

export function promptPath(name) {
  return path.join(runtimeDir(), 'prompts', name);
}

export function sourceStamp() {
  try {
    const st = fs.statSync(path.join(runtimeDir(), 'referee.mjs'));
    return new Date(st.mtimeMs).toISOString();
  } catch {
    return null;
  }
}
