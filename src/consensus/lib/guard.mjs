import fs from 'node:fs';
import { sha256File, tryReadJson, writeJsonAtomic } from './fsx.mjs';
import { logEvent, materialPath } from './ledger.mjs';
import { taskPaths } from './paths.mjs';
import { refuse } from './fail.mjs';

export function checkAskRecursion() {
  if (process.env.CONSENSUS_SEAT) {
    refuse('CONSENSUS_SEAT', 'ask refuses when CONSENSUS_SEAT is set.');
  }
  if (process.env.DELEGATION_DISPATCHED) {
    refuse('DELEGATION_DISPATCHED', 'ask refuses when DELEGATION_DISPATCHED is set.');
  }
}

export function checkConsultRecursion() {
  if (process.env.CONSENSUS_SEAT) {
    refuse('CONSENSUS_SEAT', 'consult refuses when CONSENSUS_SEAT is set.');
  }
  if (process.env.DELEGATION_DISPATCHED) {
    refuse('DELEGATION_DISPATCHED', 'consult refuses when DELEGATION_DISPATCHED is set.');
  }
}

export function checkStartNested() {
  if (process.env.CONSENSUS_TASK_ID) {
    refuse('NESTED_TASK', 'start refuses when CONSENSUS_TASK_ID is set.');
  }
}

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return true;
    return false;
  }
}

export function readPending(id) {
  return tryReadJson(taskPaths(id).pending);
}

export function writePending(id, rec) {
  writeJsonAtomic(taskPaths(id).pending, rec);
}

export function clearPending(id, reason = 'cleared') {
  const file = taskPaths(id).pending;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    logEvent(id, 'pending_cleared', { reason });
  }
}

export function checkPending(id) {
  const pending = readPending(id);
  if (!pending) return null;
  if (Number(pending.pid) === process.pid) return null;
  if (!pidAlive(pending.pid)) {
    clearPending(id, 'stale-pid');
    return null;
  }
  refuse('PENDING', `A detached call is still running (pid ${pending.pid}).`);
}

export function checkFrozenChecklist(ledger) {
  if (!ledger.checklistHash) return;
  const file = materialPath(ledger.id, 'checklist.md');
  if (!fs.existsSync(file)) {
    refuse('CHECKLIST_CHANGED', 'Frozen checklist is missing from materials.');
  }
  const hash = sha256File(file);
  if (hash !== ledger.checklistHash) {
    refuse('CHECKLIST_CHANGED', 'materials/checklist.md no longer matches the frozen checklist hash.');
  }
}

export function assertState(ledger, allowed, action) {
  if (!allowed.includes(ledger.state)) {
    refuse('WRONG_STATE', `${action} is not allowed in state ${ledger.state}.`);
  }
}
