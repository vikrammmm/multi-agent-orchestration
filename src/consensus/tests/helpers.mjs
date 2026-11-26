import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REFEREE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'referee.mjs');

export function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeLf(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function setup() {
  const ledger = tmp('cled-');
  const project = tmp('cproj-');
  const goal = path.join(project, 'goal.md');
  writeLf(goal, 'Ship a tiny, testable feature.\n');
  return { ledger, project, goal };
}

export function run(argv, { ledger, env = {}, timeout = 60000 } = {}) {
  const clean = { ...process.env };
  delete clean.CONSENSUS_SEAT;
  delete clean.DELEGATION_DISPATCHED;
  delete clean.CONSENSUS_TASK_ID;
  const r = spawnSync(process.execPath, [REFEREE, ...argv], {
    encoding: 'utf8',
    env: { ...clean, CONSENSUS_LEDGER: ledger, ...env },
    timeout,
    windowsHide: true,
  });
  let json = null;
  const out = (r.stdout || '').trim();
  try { json = JSON.parse(out); } catch { json = null; }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

export function startFull(ctx, chair, cochair) {
  return run([
    'start', '--mode', 'full', '--chair', chair, '--cochair', cochair,
    '--project', ctx.project, '--goal', ctx.goal,
  ], ctx);
}

export function writePlan(ctx, id) {
  const materials = path.join(ctx.ledger, 'tasks', id, 'materials');
  writeLf(path.join(materials, 'plan.md'), '1. Implement the feature.\n2. Run the gate.\n');
  writeLf(path.join(materials, 'checklist.md'), '1. The feature is implemented.\n2. The gate command exits 0.\n');
}

export function writeDiff(ctx, id) {
  const materials = path.join(ctx.ledger, 'tasks', id, 'materials');
  writeLf(path.join(materials, 'diff.patch'), 'diff --git a/x b/x\n+ok\n');
  writeLf(path.join(materials, 'tests.txt'), 'all tests passed\n');
}

export function sealFile(dir, name, obj) {
  const file = path.join(dir, name);
  writeLf(file, JSON.stringify(obj, null, 2) + '\n');
  return file;
}

export function sealAgree(ctx, id) {
  const file = sealFile(ctx.project, 'seal-fl.json', {
    phase: 'finish-line', verdict: 'AGREE', summary: 'Chair agrees.',
  });
  return run(['seal', '--task', id, '--phase', 'finish-line', '--file', file], ctx);
}

export function sealDone(ctx, id) {
  const file = sealFile(ctx.project, 'seal-so.json', {
    phase: 'signoff', verdict: 'DONE', blocking: [], later: [], summary: 'Chair says done.',
  });
  return run(['seal', '--task', id, '--phase', 'signoff', '--file', file], ctx);
}

export function loadTask(ctx, id) {
  return JSON.parse(fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'ledger.json'), 'utf8'));
}

export function freezeFlow(ctx, chair = 'fake:agree', cochair = 'fake:done') {
  const started = startFull(ctx, chair, cochair);
  const id = started.json.id;
  writePlan(ctx, id);
  const sealed = sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  return { id, started, sealed, asked };
}

export function reportPath(ctx, id, name) {
  return path.join(ctx.ledger, 'tasks', id, 'reports', name);
}
