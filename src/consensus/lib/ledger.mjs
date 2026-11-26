import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { copyDir, ensureDir, readJson, sha256File, tryReadJson, writeJsonAtomic, appendJsonl, writeUtf8 } from './fsx.mjs';
import { indexPath, ledgerRoot, readVersion, taskPaths } from './paths.mjs';
import { loadLimits } from './limits.mjs';
import { refuse } from './fail.mjs';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function randomBase32(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += BASE32[bytes[i] % 32];
  return s;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeTaskId(when = new Date()) {
  const y = when.getUTCFullYear();
  const mo = String(when.getUTCMonth() + 1).padStart(2, '0');
  const d = String(when.getUTCDate()).padStart(2, '0');
  const h = String(when.getUTCHours()).padStart(2, '0');
  const mi = String(when.getUTCMinutes()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}-${randomBase32(4)}`;
}

export function emptyCounters() {
  return { seatCalls: 0, workerJobs: 0, finishLineRounds: 0, signoffRounds: 0, consultations: 0 };
}

function ensureTaskDirs(id) {
  const p = taskPaths(id);
  for (const dir of [p.root, p.materials, p.frozen, p.seals, p.calls, p.reports]) ensureDir(dir);
  return p;
}

export function loadIndex() {
  const file = indexPath();
  const data = tryReadJson(file);
  if (!data) return { tasks: [] };
  if (Array.isArray(data)) return { tasks: data };
  if (!Array.isArray(data.tasks)) data.tasks = [];
  return data;
}

export function saveIndex(index) {
  ensureDir(ledgerRoot());
  writeJsonAtomic(indexPath(), index);
}

export function updateIndex(ledger) {
  const index = loadIndex();
  const row = {
    id: ledger.id,
    mode: ledger.mode,
    state: ledger.state,
    chair: ledger.chair,
    cochair: ledger.cochair,
    project: ledger.project,
    startedAt: ledger.startedAt,
  };
  const i = index.tasks.findIndex((t) => t.id === ledger.id);
  if (i === -1) index.tasks.push(row);
  else index.tasks[i] = row;
  saveIndex(index);
}

export function logEvent(id, event, data = {}) {
  const p = taskPaths(id);
  appendJsonl(p.events, { at: nowIso(), event, data });
}

export function saveLedger(ledger) {
  const p = taskPaths(ledger.id);
  writeJsonAtomic(p.ledger, ledger);
  updateIndex(ledger);
}

export function loadLedger(id) {
  if (!id) refuse('NO_TASK', 'Missing --task id.');
  const p = taskPaths(id);
  if (!fs.existsSync(p.ledger)) refuse('NO_TASK', `Task ${id} not found.`);
  return readJson(p.ledger);
}

export function createTask({ mode, chair, cochair, project, limitsName, continuedFrom, test, grade, unverified }) {
  const id = makeTaskId();
  const startedAt = nowIso();
  const limits = loadLimits(limitsName || 'standard');
  const deadlineAt = new Date(Date.parse(startedAt) + limits.totalHours * 3600 * 1000).toISOString();
  const p = ensureTaskDirs(id);
  const gradeRec = grade && grade.level ? { level: grade.level, note: grade.note || '' } : { level: 'standard', note: '' };
  const unverifiedRec = Array.isArray(unverified) ? unverified : [];
  const ledger = {
    id,
    version: readVersion(),
    mode,
    state: mode === 'advise' || mode === 'assess' ? 'open' : 'finish-line',
    test: Boolean(test),
    project: path.resolve(project),
    chair,
    cochair,
    startedAt,
    deadlineAt,
    limits,
    counters: emptyCounters(),
    checklistHash: null,
    rounds: [],
    consultations: [],
    continuedFrom: continuedFrom || null,
    closedAt: null,
    outcome: null,
    outcomeReason: null,
    grade: gradeRec,
    unverified: unverifiedRec,
  };
  if (continuedFrom) copyContinueFrom(ledger, continuedFrom);
  saveLedger(ledger);
  logEvent(id, 'start', {
    mode, chair, cochair, project: ledger.project, continuedFrom: continuedFrom || null, grade: gradeRec.level,
  });
  return { ledger, paths: p };
}

function copyContinueFrom(ledger, fromId) {
  const src = taskPaths(fromId);
  if (!fs.existsSync(src.root)) refuse('NO_TASK', `continue-from task ${fromId} not found.`);
  if (fs.existsSync(src.materials)) copyDir(src.materials, taskPaths(ledger.id).materials);
  if (fs.existsSync(src.frozenChecklist)) {
    ensureDir(taskPaths(ledger.id).frozen);
    fs.copyFileSync(src.frozenChecklist, taskPaths(ledger.id).frozenChecklist);
    const destMaterials = path.join(taskPaths(ledger.id).materials, 'checklist.md');
    if (!fs.existsSync(destMaterials)) fs.copyFileSync(src.frozenChecklist, destMaterials);
    // Guard 2 holds in the continued task from the start: the ledger records the hash of the
    // copied frozen checklist (a new finish-line AGREE re-freezes and replaces it).
    ledger.checklistHash = sha256File(taskPaths(ledger.id).frozenChecklist);
  }
}

export function copyGoal(id, goalFile) {
  const dest = path.join(taskPaths(id).materials, 'goal.md');
  if (!goalFile || !fs.existsSync(goalFile)) refuse('NO_GOAL', 'Goal file not found.');
  fs.copyFileSync(path.resolve(goalFile), dest);
}

export function copyBrief(id, briefFile) {
  const dest = path.join(taskPaths(id).materials, 'brief.md');
  if (!briefFile || !fs.existsSync(briefFile)) refuse('NO_BRIEF', 'Brief file not found.');
  fs.copyFileSync(path.resolve(briefFile), dest);
  const dir = path.dirname(path.resolve(briefFile));
  for (const name of ['diff.patch', 'tests.txt']) {
    const src = path.join(dir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(taskPaths(id).materials, name));
  }
}

export function addRound(ledger, rec) {
  ledger.rounds.push(rec);
}

export function setState(ledger, state, extra = {}) {
  ledger.state = state;
  if (extra.outcome !== undefined) ledger.outcome = extra.outcome;
  if (extra.outcomeReason !== undefined) ledger.outcomeReason = extra.outcomeReason;
  if (extra.closedAt !== undefined) ledger.closedAt = extra.closedAt;
  saveLedger(ledger);
  logEvent(ledger.id, 'state', { state, ...extra });
}

export function closeTask(ledger, outcome, reason) {
  ledger.state = outcome === 'abandoned' ? 'abandoned' : outcome;
  ledger.outcome = outcome;
  ledger.outcomeReason = reason || null;
  ledger.closedAt = nowIso();
  saveLedger(ledger);
  logEvent(ledger.id, 'close', { outcome, reason });
}

export function freezeChecklist(ledger) {
  const src = path.join(taskPaths(ledger.id).materials, 'checklist.md');
  if (!fs.existsSync(src)) refuse('NO_CHECKLIST', 'materials/checklist.md is missing.');
  const dest = taskPaths(ledger.id).frozenChecklist;
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  ledger.checklistHash = sha256File(dest);
}

export function writeSeal(id, phase, round, verdict) {
  const file = path.join(taskPaths(id).seals, `${phase}-${round}.json`);
  if (fs.existsSync(file)) refuse('SEAL_EXISTS', `Round ${round} of ${phase} is already sealed.`);
  writeJsonAtomic(file, verdict);
  return { file, hash: sha256File(file) };
}

export function readSeal(id, phase, round) {
  const file = path.join(taskPaths(id).seals, `${phase}-${round}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

export function sealHash(id, phase, round) {
  const file = path.join(taskPaths(id).seals, `${phase}-${round}.json`);
  if (!fs.existsSync(file)) return null;
  return sha256File(file);
}

export function materialText(id, name) {
  const file = path.join(taskPaths(id).materials, name);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function materialPath(id, name) {
  return path.join(taskPaths(id).materials, name);
}

export function isClosed(ledger) {
  return ['done', 'split', 'abandoned', 'recorded', 'failed'].includes(ledger.state);
}
