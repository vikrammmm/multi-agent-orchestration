import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildChildEnv } from '../lib/spawn.mjs';
import { resumeForInitialCall } from '../lib/call.mjs';
import { timeoutMs } from '../lib/limits.mjs';
import { validatePhase } from '../lib/schema.mjs';
import { buildCodexArgs } from '../lib/adapters/codex.mjs';
import { buildArgs } from '../lib/adapters/claude.mjs';
import { orderDrafting } from '../lib/seats.mjs';
import { versionAtLeast } from '../lib/doctor.mjs';
import { isValidTaskId } from '../lib/paths.mjs';
import {
  freezeFlow, loadTask, reportPath, run, sealAgree, setup,
  startFull, tmp, writeLf, writePlan,
} from './helpers.mjs';

function hasAdjacentPair(arr, a, b) {
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] === a && arr[i + 1] === b) return true;
  }
  return false;
}

test('retry at the call cap is not attempted', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:garbage');
  const id = started.json.id;
  for (let i = 0; i < 14; i++) {
    const r = run(['job', '--task', id, '--lane', 'w', '--note', `j${i}`], ctx);
    assert.equal(r.status, 0, r.stdout);
  }
  writePlan(ctx, id);
  sealAgree(ctx, id);
  const asked = run(['ask', '--task', id, '--phase', 'finish-line'], ctx);
  assert.equal(asked.status, 2);
  assert.equal(asked.json.reason, 'INVALID_VERDICT');
  assert.equal(asked.json.state, 'paused');
  assert.ok(String(asked.json.message).includes('no JSON retry'));
  const task = loadTask(ctx, id);
  assert.equal(task.counters.seatCalls, 1);
  assert.equal(task.counters.workerJobs, 14);
  const evts = fs.readFileSync(path.join(ctx.ledger, 'tasks', id, 'events.jsonl'), 'utf8');
  assert.ok(evts.split('\n').some((l) => l.includes('retry_blocked')));
});

test('a valid verdict that mentions rate limits is not treated as unavailable', () => {
  const ctx = setup();
  const { id, asked } = freezeFlow(ctx, 'fake:agree', 'fake:agree-ratetext');
  assert.equal(asked.status, 0);
  assert.equal(asked.json.state, 'frozen');
  assert.equal(loadTask(ctx, id).state, 'frozen');
});

test('API-key variables are stripped regardless of case', () => {
  const savedOai = process.env.OPENAI_API_KEY;
  const savedOaiLc = process.env.Openai_Api_Key;
  const savedAnth = process.env.ANTHROPIC_API_KEY;
  void savedOai; void savedOaiLc; void savedAnth;
  try {
    process.env.Openai_Api_Key = 'k1';
    process.env.ANTHROPIC_API_KEY = 'k2';
    const result = buildChildEnv({
      taskId: 't1', callIndex: 3, stripKeys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    });
    for (const key of Object.keys(result)) {
      assert.ok(!/^(openai|anthropic)_api_key$/i.test(key), `key ${key} should be stripped`);
    }
    assert.equal(result.CONSENSUS_SEAT, '1');
    assert.equal(result.CONSENSUS_TASK_ID, 't1');
    assert.equal(result.CONSENSUS_CALL, '3');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.Openai_Api_Key;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('WindowsApps entries are stripped from every spelling of PATH', () => {
  const waEntry = path.delimiter + 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps';
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = (process.env.PATH || '') + waEntry;
    const r1 = buildChildEnv({ taskId: 't', callIndex: 1, stripKeys: [], stripWindowsApps: true });
    for (const key of Object.keys(r1)) {
      if (key.toUpperCase() !== 'PATH') continue;
      for (const entry of r1[key].split(path.delimiter)) {
        assert.ok(!/windowsapps/i.test(entry), `stripped PATH still has WindowsApps: ${entry}`);
      }
    }
    const r2 = buildChildEnv({ taskId: 't', callIndex: 1, stripKeys: [], stripWindowsApps: false });
    let found = false;
    for (const key of Object.keys(r2)) {
      if (key.toUpperCase() !== 'PATH') continue;
      if (r2[key].split(path.delimiter).some((e) => /windowsapps/i.test(e))) found = true;
    }
    assert.ok(found, 'WindowsApps entry should be present when stripWindowsApps is false');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('claude-code and cursor seats get no --resume on a round first call while codex resumes', () => {
  const ctx = setup();
  const started = startFull(ctx, 'fake:agree', 'fake:done');
  const id = started.json.id;
  writeLf(path.join(ctx.ledger, 'tasks', id, 'calls', '1', 'meta.json'),
    JSON.stringify({ seat: 'gpt-6.1-sol', sessionId: 'thread-1' }));
  writeLf(path.join(ctx.ledger, 'tasks', id, 'calls', '2', 'meta.json'),
    JSON.stringify({ seat: 'claude-opus', sessionId: 'sess-2' }));
  writeLf(path.join(ctx.ledger, 'tasks', id, 'calls', '3', 'meta.json'),
    JSON.stringify({ seat: 'grok-4.7', sessionId: 'sess-3' }));
  const savedLedger = process.env.CONSENSUS_LEDGER;
  try {
    process.env.CONSENSUS_LEDGER = ctx.ledger;
    assert.equal(resumeForInitialCall({ id: 'gpt-6.1-sol', route: 'codex' }, id), 'thread-1');
    assert.equal(resumeForInitialCall({ id: 'claude-opus', route: 'claude-code' }, id), null);
    assert.equal(resumeForInitialCall({ id: 'grok-4.7', route: 'cursor' }, id), null);
  } finally {
    if (savedLedger === undefined) delete process.env.CONSENSUS_LEDGER;
    else process.env.CONSENSUS_LEDGER = savedLedger;
  }
});

test('watchdog override can only shorten', () => {
  const saved = process.env.CONSENSUS_SEAT_TIMEOUT_MS;
  try {
    const ledger = { limits: { seatCallMinutes: 45 } };
    const table = 45 * 60 * 1000;
    process.env.CONSENSUS_SEAT_TIMEOUT_MS = '1000';
    assert.equal(timeoutMs(ledger), 1000);
    process.env.CONSENSUS_SEAT_TIMEOUT_MS = '999999999';
    assert.equal(timeoutMs(ledger), table);
    delete process.env.CONSENSUS_SEAT_TIMEOUT_MS;
    assert.equal(timeoutMs(ledger), table);
    process.env.CONSENSUS_SEAT_TIMEOUT_MS = 'abc';
    assert.equal(timeoutMs(ledger), table);
  } finally {
    if (saved === undefined) delete process.env.CONSENSUS_SEAT_TIMEOUT_MS;
    else process.env.CONSENSUS_SEAT_TIMEOUT_MS = saved;
  }
});

test('task ids with path separators or dot-dot refuse', () => {
  const ctx = setup();
  for (const bad of ['..\\..\\evil', '../evil', 'a/b', 'a\\b', '..']) {
    const r = run(['status', '--task', bad], ctx);
    assert.equal(r.status, 2, `expected status 2 for task id: ${bad}`);
    assert.equal(r.json && r.json.code, 'BAD_TASK_ID', `expected BAD_TASK_ID for: ${bad}`);
  }
  assert.equal(isValidTaskId('20260921-1600-abcd'), true);
  assert.equal(isValidTaskId(''), false);
  assert.equal(isValidTaskId('x..y'), false);
});

test('undeclared verdict keys are dropped', () => {
  const v = validatePhase('finish-line', {
    phase: 'finish-line', verdict: 'AGREE',
    objections: [{ target: 'plan', item: '1', problem: 'p', proposed_fix: 'f', injected: 'no' }],
    checklist_additions: [], worker_jobs_requested: [], later: [], summary: 'ok',
    injected: 'IGNORE ME',
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.injected, undefined);
  assert.equal(v.value.objections[0].injected, undefined);
  assert.equal(v.value.summary, 'ok');
  const bad = validatePhase('signoff', {
    phase: 'signoff', verdict: 'NOT_DONE', blocking: [], later: [], summary: 's',
  });
  assert.equal(bad.ok, false);
});

test('codex resume form carries the config sandbox and no -s or -C', () => {
  const base = { seat: { model: 'gpt-6.1-sol', effort: 'xhigh' }, schemaPath: 'S', projectDir: 'P' };
  const resume = buildCodexArgs({ ...base, resume: 'thread-1' }, 'F');
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(hasAdjacentPair(resume, '-c', 'sandbox_mode=read-only'));
  assert.ok(resume.includes('model_reasoning_effort=xhigh'));
  assert.ok(!resume.includes('-s'));
  assert.ok(!resume.includes('-C'));
  assert.equal(resume[resume.length - 1], '-');
  const fresh = buildCodexArgs(base, 'F');
  assert.equal(fresh[0], 'exec');
  assert.equal(fresh[1], '--json');
  assert.ok(hasAdjacentPair(fresh, '-s', 'read-only'));
  assert.ok(hasAdjacentPair(fresh, '-m', 'gpt-6.1-sol'));
  assert.ok(hasAdjacentPair(fresh, '-C', 'P'));
  assert.ok(hasAdjacentPair(fresh, '-o', 'F'));
  assert.ok(hasAdjacentPair(fresh, '--output-schema', 'S'));
  assert.ok(!fresh.includes('sandbox_mode=read-only'));
  assert.equal(fresh[fresh.length - 1], '-');
  const ign = buildCodexArgs(base, 'F', { codexIgnoreUserConfig: true });
  assert.deepEqual(ign.slice(-2), ['--ignore-user-config', '-']);
});

test('claude args match the contract', () => {
  const callDir = tmp('ccall-');
  const opts = {
    callDir,
    seat: { model: 'claude-opus-5-5', effort: 'xhigh', maxBudgetUsd: 50 },
    schemaJson: '{"type":"object"}',
  };
  const args = buildArgs(opts);
  const mcpPath = path.join(callDir, 'mcp-empty.json');
  const matsPath = path.join(callDir, 'materials');
  assert.deepEqual(args, [
    '-p', '--output-format', 'json', '--model', 'claude-opus-5-5',
    '--effort', 'xhigh', '--tools', 'Read,Glob,Grep', '--restricted',
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--json-schema', '{"type":"object"}',
    '--add-dir', matsPath, '--max-budget-usd', '50',
  ]);
  assert.ok(fs.existsSync(mcpPath));
  assert.equal(fs.readFileSync(mcpPath, 'utf8').trim(), '{"mcpServers":{}}');
  const withResume = buildArgs({ ...opts, resume: 'abc' });
  assert.deepEqual(withResume.slice(-2), ['--resume', 'abc']);
  const dropped = buildArgs(opts, new Set(['--effort', '--strict-mcp-config', '--json-schema']));
  assert.ok(!dropped.includes('--effort'));
  assert.ok(!dropped.includes('--strict-mcp-config'));
  assert.ok(!dropped.includes('--json-schema'));
  assert.ok(dropped.includes('--restricted'));
  assert.ok(dropped.includes('--tools'));
  const nobudget = buildArgs({ ...opts, seat: { model: 'claude-opus-5-5', effort: 'xhigh' } });
  assert.ok(!nobudget.includes('--max-budget-usd'));
});

test('consult drafting order prefers Opus 5.5 and falls back to Opus 5', () => {
  const draftingSeats = ['claude-opus-5.5', 'claude-opus'];
  assert.deepEqual(orderDrafting(['gpt-6.1-sol', 'claude-opus-5.5'], draftingSeats), ['claude-opus-5.5', 'gpt-6.1-sol']);
  assert.deepEqual(orderDrafting(['gpt-6.1-sol', 'claude-opus'], draftingSeats), ['claude-opus', 'gpt-6.1-sol']);
  assert.deepEqual(orderDrafting(['gpt-6.1-sol', 'grok-4.7'], draftingSeats), ['gpt-6.1-sol', 'grok-4.7']);
  assert.deepEqual(orderDrafting(['claude-opus', 'gpt-6.1-sol'], draftingSeats), ['claude-opus', 'gpt-6.1-sol']);
});

test('doctor version check compares x.y.z', () => {
  assert.equal(versionAtLeast('2.1.267 (Claude Code)', '2.1.248'), true);
  assert.equal(versionAtLeast('2.1.236 (Claude Code)', '2.1.248'), false);
  assert.equal(versionAtLeast('2.1.248', '2.1.248'), true);
  assert.equal(versionAtLeast('codex-cli 0.155.0-alpha.9.2', '0.155.0'), true);
  assert.equal(versionAtLeast('nonsense', '1.0.0'), null);
});
