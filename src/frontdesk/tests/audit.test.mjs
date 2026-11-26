import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditLogs, formatAudit } from '../lib/audit-logs.mjs';
import { tmp, rm } from './helpers.mjs';

const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const asst = (id, model, content) => ({ type: 'assistant', uuid: id, timestamp: '2026-10-13T10:00:00Z', message: { id, model, content } });
const toolUse = (name, input) => ({ type: 'tool_use', id: 't' + Math.random(), name, input });

function fixtureHome() {
  const home = tmp('fd-audit-');
  const proj = path.join(home, '.claude', 'projects', 'p1');
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), jl([
    asst('m1', 'claude-opus-5-5', [toolUse('Agent', { subagent_type: 'general-purpose', description: 'd', prompt: 'SECRET', model: 'claude-haiku-5-5' })]),
    asst('m2', 'claude-opus-5-5', [toolUse('Agent', { subagent_type: 'haiku-helper', prompt: 'x' })]),
    asst('m3', 'claude-opus-5-5', [toolUse('Bash', { command: 'node ~/.claude/skills/codex-delegate/scripts/relay.mjs --brief b.txt --lane codex-luna-review' })]),
    asst('m4', 'claude-opus-5-5', [toolUse('Bash', { command: 'node ~/.claude/skills/muse-delegate/scripts/relay.mjs --brief b.txt --model muse-spark-1.3' })]),
    asst('m5', 'claude-opus-5-5', [toolUse('Bash', { command: 'node ~/.claude/skills/muse-delegate/scripts/relay.mjs --brief b.txt' })]),
    asst('m6', 'claude-opus-5-5', [toolUse('Bash', { command: 'ls -la' })]),
  ]));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-a.jsonl'), jl([asst('s1', 'claude-opus-5-5', [])]));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-a.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-b.jsonl'), jl([asst('s2', 'claude-haiku-5-5', [])]));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-b.meta.json'), JSON.stringify({ agentType: 'haiku-helper' }));
  const sess = path.join(home, '.codex', 'sessions', '2026', '10', '13');
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, 'rollout-2026-10-13T10-00-00-abc.jsonl'), jl([
    { type: 'session_meta', payload: { id: 'x', source: 'cli' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ model: 'gpt-6-luna', reasoning_effort: 'low', task_name: 't', message: 'SECRET' }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'u', message: 'SECRET' }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
  ]));
  return home;
}

test('audit counts Claude Agent calls, subagent runs, workflow agents and relay dispatches', async () => {
  const home = fixtureHome();
  try {
    const a = await auditLogs(home, { days: 30, now: Date.now() });
    assert.equal(a.claude.mainSessions, 1);
    assert.equal(a.claude.agentCalls.total, 2);
    assert.equal(a.claude.agentCalls.namingModel, 1);
    assert.equal(a.claude.agentCalls.byType['general-purpose'], 1);
    assert.equal(a.claude.subagentRuns.total, 2);
    assert.equal(a.claude.workflowAgents.total, 1);
    assert.equal(a.claude.relayDispatches.total, 3);
    assert.equal(a.claude.relayDispatches.byTool.codex, 1);
    assert.equal(a.claude.relayDispatches.byTool.muse, 2);
    assert.equal(a.claude.relayDispatches.byLane['codex-luna-review'], 1);
    assert.equal(a.claude.relayDispatches.explicitModel, 1);
    assert.equal(a.claude.relayDispatches.noLaneNoModel, 1);
    assert.equal(a.claude.mainModels['claude-opus-5-5'], 1);
  } finally { rm(home); }
});

test('audit counts Codex spawn_agent calls and how many name a model or effort', async () => {
  const home = fixtureHome();
  try {
    const a = await auditLogs(home, { days: 30, now: Date.now() });
    assert.equal(a.codex.rollouts, 1);
    assert.equal(a.codex.spawns.total, 2);
    assert.equal(a.codex.spawns.namingModel, 1);
    assert.equal(a.codex.spawns.byModel['gpt-6-luna'], 1);
  } finally { rm(home); }
});

test('audit reads structure only: the report never contains prompt text', async () => {
  const home = fixtureHome();
  try {
    const a = await auditLogs(home, { days: 30, now: Date.now() });
    assert.ok(!JSON.stringify(a).includes('SECRET'));
    assert.ok(!formatAudit(a).includes('SECRET'));
    assert.match(formatAudit(a), /Claude Code: 1 main sessions/);
  } finally { rm(home); }
});

test('audit skips logs older than the window and copes with an empty home', async () => {
  const home = fixtureHome();
  try {
    const old = await auditLogs(home, { days: 30, now: Date.now() + 90 * 86400000 });
    assert.equal(old.claude.transcripts, 0);
    assert.equal(old.codex.rollouts, 0);
  } finally { rm(home); }
  const empty = tmp('fd-audit-empty-');
  try { const a = await auditLogs(empty, { days: 7 }); assert.equal(a.unrouted.codexSpawns, 0); } finally { rm(empty); }
});

test('audit survives torn and non-JSON lines', async () => {
  const home = fixtureHome();
  try {
    const f = path.join(home, '.claude', 'projects', 'p1', 's1.jsonl');
    fs.appendFileSync(f, '{"type":"assistant","message":\nnot json\n');
    const a = await auditLogs(home, { days: 30 });
    assert.equal(a.claude.agentCalls.total, 2);
  } finally { rm(home); }
});
