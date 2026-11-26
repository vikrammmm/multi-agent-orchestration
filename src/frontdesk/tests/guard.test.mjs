import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkflow, normalize, decide, refusalText } from '../lib/guard.mjs';
import * as P from './fixtures.mjs';

const ctx = {
  commissioned: new Set(['claude-haiku-5-5|high', 'claude-sonnet-5-5|high']),
  helpers: {
    'haiku-helper': { kind: 'legacy', engineer: 'claude-haiku-5-5|max' },       // decommissioned today
    verifier: { kind: 'legacy', engineer: 'claude-sonnet-5-5|high' },
    developer: { kind: 'role', engineer: 'claude-haiku-5-5|high' },
  },
};

// ---- Workflow script reader ----
test('workflow: no agent calls', () => {
  const a = analyzeWorkflow("export const meta = { name: 'x', description: 'y' }\nreturn 1");
  assert.equal(a.total, 0);
});

test('workflow: a pinned model, a pinned role helper and an unpinned agent are told apart', () => {
  const a = analyzeWorkflow("const x = await agent('p', { model: 'claude-haiku-5-5' })\nconst y = await agent('q', { agentType: 'developer', label: 'l' })\nconst z = await agent('r')");
  assert.equal(a.total, 3);
  assert.equal(a.pinned, 2);
  assert.equal(a.unpinned, 1);
  assert.equal(a.unreadable, 0);
  assert.equal(a.calls[0].model, 'claude-haiku-5-5');
  assert.equal(a.calls[1].agentType, 'developer');
});

test('workflow: dynamic options, a dynamic model and a spread are unreadable', () => {
  assert.equal(analyzeWorkflow("agent('p', opts)").unreadable, 1);
  assert.equal(analyzeWorkflow("agent('p', { model: m })").unreadable, 1);
  assert.equal(analyzeWorkflow("agent('p', { ...base, label: 'l' })").unreadable, 1);
  assert.equal(analyzeWorkflow("agent('p', { model })").unreadable, 1);
});

test('workflow: only top-level options count (a schema that mentions "model" is not a model pin)', () => {
  const a = analyzeWorkflow("agent('p', { schema: { type: 'object', properties: { model: { type: 'string' } } }, agentType: 'developer' })");
  assert.equal(a.unreadable, 0);
  assert.equal(a.calls[0].agentType, 'developer');
  assert.equal(a.calls[0].model, null);
});

test('workflow: text in comments, strings and template literals is not an agent call', () => {
  const a = analyzeWorkflow("// agent('x')\n/* agent('y') */\nconst s = \"agent('z')\"\nconst t = `agent('w') ${1 + 1}`\nreturn s + t");
  assert.equal(a.total, 0);
});

test('workflow: agent calls inside pipeline and parallel callbacks are found; a name like myagent( is not', () => {
  const a = analyzeWorkflow("await pipeline(items, (i) => agent(`do ${i}`, { model: 'm' }), (r) => parallel([() => agent('x', { model: 'm' })]))\nmyagent('no')");
  assert.equal(a.total, 2);
  assert.equal(a.pinned, 2);
});

test('workflow: strings containing commas and braces inside the options do not confuse the reader', () => {
  const a = analyzeWorkflow("agent('p', { label: 'a, b, {c}', model: 'claude-haiku-5-5' })");
  assert.equal(a.unreadable, 0);
  assert.equal(a.calls[0].model, 'claude-haiku-5-5');
});

// ---- normalize ----
test('normalize: Claude Agent keeps structure and drops the prompt', () => {
  const r = normalize('claude', P.claudeAgent('general-purpose'));
  assert.equal(r.kind, 'agent_spawn');
  assert.equal(r.sub, 'general-purpose');
  assert.equal(r.namesModel, false);
  assert.equal(r.callerIsSubagent, false);
  assert.equal(r.cwd, 'project-x');
  assert.ok(!JSON.stringify(r).includes(P.SECRET), 'no prompt text in the request');
});

test('normalize: a subagent call carries agent_id; a Bash call is "other"; the Workflow script is reduced to counts', () => {
  assert.equal(normalize('claude', P.claudeSubagentCallsAgent('x')).callerIsSubagent, true);
  assert.equal(normalize('claude', P.claudeBash()).kind, 'other');
  const w = normalize('claude', P.claudeWorkflow("agent('SECRET-IN-SCRIPT', { model: 'm' })"));
  assert.equal(w.kind, 'workflow');
  assert.equal(w.workflow.total, 1);
  assert.ok(!JSON.stringify({ ...w, workflow: { ...w.workflow, calls: undefined } }).includes('SECRET-IN-SCRIPT'));
});

test('normalize: Muse subagent_spawn and the session model; Muse shell is "other"', () => {
  const r = normalize('muse', P.museSpawn('general-purpose'));
  assert.equal(r.kind, 'subagent_spawn');
  assert.equal(r.sessionModel, 'muse-spark-1.3');
  assert.ok(!JSON.stringify(r).includes(P.SECRET));
  assert.equal(normalize('muse', P.museShell()).kind, 'other');
});

test('normalize: Codex spawn (a guess) reads model and effort; anything else is "other"', () => {
  const r = normalize('codex', P.codexSpawn({ model: 'gpt-6-luna', reasoning_effort: 'low' }));
  assert.equal(r.kind, 'spawn_agent');
  assert.equal(r.namesModel, true);
  assert.equal(normalize('codex', P.codexBash()).kind, 'other');
});

test('normalize: environment markers mark a dispatched worker', () => {
  assert.equal(normalize('claude', P.claudeAgent('x'), { DELEGATION_DISPATCHED: '1' }).envWorker, true);
  assert.equal(normalize('claude', P.claudeAgent('x'), { CONSENSUS_SEAT: 'gpt-6.1-sol' }).envWorker, true);
  assert.equal(normalize('claude', P.claudeAgent('x'), {}).envWorker, false);
});

test('normalize: garbage payloads become "other" instead of throwing', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}]) assert.equal(normalize('claude', bad).kind, 'other');
});

// ---- decide ----
const dec = (tool, payload, env = {}) => decide(normalize(tool, payload, env), ctx);

test('decide: a general-purpose or untyped spawn would inherit the boss model', () => {
  assert.deepEqual(dec('claude', P.claudeAgent('general-purpose')).reasons, ['inherits_boss_model']);
  assert.deepEqual(dec('claude', P.claudeAgentNoType()).reasons, ['inherits_boss_model']);
  assert.deepEqual(dec('claude', P.claudeAgent('fork')).reasons, ['inherits_boss_model']);
});

test('decide: a role helper of a commissioned engineer is allowed', () => {
  const d = dec('claude', P.claudeAgent('developer'));
  assert.equal(d.decision, 'allow');
  assert.deepEqual(d.reasons, ['ok']);
});

test('decide: a legacy helper of a decommissioned engineer is refused, of a commissioned one allowed', () => {
  assert.deepEqual(dec('claude', P.claudeAgent('haiku-helper')).reasons, ['decommissioned_engineer']);
  assert.equal(dec('claude', P.claudeAgent('verifier')).decision, 'allow');
  assert.equal(dec('claude', P.claudeAgent('VERIFIER')).decision, 'allow', 'names are matched case-insensitively');
});

test('decide: an unknown helper and a named model are refused', () => {
  assert.deepEqual(dec('claude', P.claudeAgent('mystery-agent')).reasons, ['unknown_helper']);
  assert.ok(dec('claude', P.claudeAgent('developer', { model: 'claude-haiku-5-5' })).reasons.includes('names_model'));
});

test('decide: a native subagent calling Agent is a worker delegating; an env worker too', () => {
  assert.ok(dec('claude', P.claudeSubagentCallsAgent('developer')).reasons.includes('worker_delegation_subagent'));
  assert.ok(dec('claude', P.claudeAgent('developer'), { DELEGATION_DISPATCHED: '1' }).reasons.includes('worker_delegation_env'));
});

test('decide: ordinary tools are always allowed', () => {
  assert.equal(dec('claude', P.claudeBash()).decision, 'allow');
  assert.equal(dec('claude', P.claudeSubagentBash()).decision, 'allow');
  assert.equal(dec('muse', P.museShell()).decision, 'allow');
  assert.equal(dec('codex', P.codexBash()).decision, 'allow');
});

test('decide: workflows', () => {
  const w = (s) => dec('claude', P.claudeWorkflow(s));
  assert.equal(w("return 1").decision, 'allow');
  assert.ok(w("agent('p')").reasons.includes('workflow_unpinned_agent'));
  assert.ok(w("agent('p', { model: 'claude-haiku-5-5' })").reasons.includes('names_model'));
  assert.equal(w("agent('p', { agentType: 'developer' })").decision, 'allow');
  assert.ok(w("agent('p', { agentType: 'nope' })").reasons.includes('workflow_unknown_helper'));
  assert.ok(w("agent('p', { agentType: 'haiku-helper' })").reasons.includes('decommissioned_engineer'));
  assert.ok(w("agent('p', opts)").reasons.includes('workflow_unreadable_options'));
});

test('decide: Muse subagent_spawn is refused as a native subagent (it would run the parent model)', () => {
  assert.deepEqual(dec('muse', P.museSpawn()).reasons, ['native_subagent']);
});

test('decide: Codex spawn naming a model, or with no helper, is refused', () => {
  assert.ok(dec('codex', P.codexSpawn({ model: 'gpt-6-luna', reasoning_effort: 'low' })).reasons.includes('names_model'));
  assert.ok(dec('codex', P.codexSpawn()).reasons.includes('inherits_boss_model'));
});

test('decide: a decision without any context still answers (the hook may have no generation)', () => {
  const d = decide(normalize('claude', P.claudeAgent('developer')), {});
  assert.equal(d.decision, 'deny');
});

test('refusalText: gives the agent a way to comply', () => {
  assert.match(refusalText(['names_model']), /role/i);
  assert.match(refusalText(['workflow_unreadable_options']), /literal/i);
  assert.match(refusalText(['something_new']), /front desk/i);
});
