import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleEngineer, eligibleRoute, resolveRole, lockRank } from '../lib/eligible.mjs';
import { versionAtLeast, firstVersion } from '../lib/tools.mjs';

const route = (o = {}) => ({ route: 'codex', wallet: 'ChatGPT plan', readOnlyLock: 'firm (sandbox)', exec: { tool: 'codex', model: 'f', effort: 'high', use: 'standard', problem: null, guessedId: false }, ...o });
const eng = (o = {}) => ({ key: 'f|high', family: 'f', effort: 'high', commissioned: true, isNew: false, ownerCleared: null, callOrder: 1, routes: [route()], ...o });
const tools = { codex: { path: 'x', version: '0.162.0' }, claude: { path: 'y', version: '2.1.295' }, cursor: null, muse: { path: 'z', version: '1.4.7' }, qwen: null };
const ctx = (o = {}) => ({ mode: 'implement', tools, cooldowns: {}, now: new Date('2026-10-14T12:00:00Z'), requirements: { families: [], tools: {} }, rules: { modeExclusions: [] }, ...o });
const codes = (r) => r.reasons.map((x) => x.code);

test('lockRank orders firm, medium, copy, weak', () => {
  assert.deepEqual(['firm (x)', 'medium (x)', 'copy: x', 'weak (plan mode)', undefined].map(lockRank), [0, 1, 2, 3, 3]);
});

test('versions compare numerically and a missing part counts as zero', () => {
  assert.equal(versionAtLeast('2.1.295', '2.1.293'), true);
  assert.equal(versionAtLeast('2.1.9', '2.1.10'), false);
  assert.equal(versionAtLeast('1.4', '1.4.0'), true);
  assert.equal(firstVersion('Claude Code 2.1.295 (x)'), '2.1.295');
  assert.equal(firstVersion('nothing'), '');
});

test('a commissioned engineer on a usable route is eligible', () => {
  const r = eligibleEngineer(eng(), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.route, 'codex');
});

test('not commissioned is refused', () => assert.ok(codes(eligibleEngineer(eng({ commissioned: false }), ctx())).includes('not_commissioned')));

test('a newly found model needs the owner to clear it', () => {
  assert.ok(codes(eligibleEngineer(eng({ isNew: true }), ctx())).includes('needs_clearance'));
  assert.equal(eligibleEngineer(eng({ isNew: true, ownerCleared: { by: 'owner', date: 'd', what: 'w' } }), ctx()).ok, true);
});

test('unconfirmed billing blocks until the owner accepts it', () => {
  const unconfirmed = eng({ routes: [route({ route: 'muse', wallet: 'Meta plan (billing mode unconfirmed)', exec: { tool: 'muse', model: 'm', effort: 'max', use: 'standard', problem: null } })] });
  assert.ok(codes(eligibleEngineer(unconfirmed, ctx())).includes('billing_unverified'));
  const cleared = { ...unconfirmed, ownerCleared: { by: 'owner', date: 'd', what: 'w' } };
  assert.equal(eligibleEngineer(cleared, ctx()).ok, true);
  const held = { ...cleared, commission: { state: 'billing_hold', by: 'assistant' } };
  assert.ok(codes(eligibleEngineer(held, ctx())).includes('billing_unverified'));
  assert.equal(eligibleEngineer(held, ctx()).ok, false);
});

test('a billing hold blocks even when the wallet description is not marked unconfirmed', () => {
  const held = eng({ commission: { state: 'billing_hold' }, ownerCleared: { by: 'owner', date: 'd' }, routes: [route({ wallet: 'Meta plan' })] });
  assert.equal(eligibleEngineer(held, ctx()).ok, false);
  assert.ok(codes(eligibleEngineer(held, ctx())).includes('billing_unverified'));
});

test('a standing mode rule keeps an engineer out of review but not of implement', () => {
  const rules = { modeExclusions: [{ family: 'f', mode: 'review', reason: 'unknown model' }] };
  assert.ok(codes(eligibleEngineer(eng(), ctx({ mode: 'review', rules }))).includes('excluded_for_mode'));
  assert.equal(eligibleEngineer(eng(), ctx({ mode: 'implement', rules })).ok, true);
});

test('a missing or too-old tool skips the route', () => {
  assert.ok(codes(eligibleEngineer(eng({ routes: [route({ route: 'cursor' })] }), ctx())).includes('tool_missing'));
  const claude = eng({ family: 'claude-haiku-5-5', routes: [route({ route: 'claude-code', exec: { tool: 'claude-code', model: 'claude-haiku-5-5', effort: 'high', use: 'standard', problem: null } })] });
  const need = { families: [{ family: 'claude-haiku-5-5', route: 'claude-code', minVersion: '2.1.293' }], tools: { 'claude-code': { minVersion: '2.1.248' } } };
  assert.equal(eligibleEngineer(claude, ctx({ requirements: need })).ok, true);
  const old = { ...tools, claude: { path: 'y', version: '2.1.283' } };
  assert.ok(codes(eligibleEngineer(claude, ctx({ requirements: need, tools: old }))).includes('tool_too_old'));
});

test('a quota cooldown on the route or on the wallet skips it until it ends', () => {
  const future = '2026-10-14T15:00:00Z', past = '2026-10-14T09:00:00Z';
  assert.ok(codes(eligibleEngineer(eng(), ctx({ cooldowns: { codex: { until: future, reason: 'limit' } } }))).includes('cooldown'));
  assert.ok(codes(eligibleEngineer(eng(), ctx({ cooldowns: { 'ChatGPT plan': { until: future, reason: 'limit' } } }))).includes('cooldown'));
  assert.equal(eligibleEngineer(eng(), ctx({ cooldowns: { codex: { until: past, reason: 'limit' } } })).ok, true);
});

test('review needs a strong enough read-only lock; a copy lock is allowed with a note', () => {
  const weak = eng({ routes: [route({ route: 'codex', readOnlyLock: 'weak (plan mode)' })] });
  assert.ok(codes(eligibleEngineer(weak, ctx({ mode: 'review' }))).includes('lock_too_weak_for_review'));
  assert.equal(eligibleEngineer(weak, ctx({ mode: 'implement' })).ok, true);
  const copy = eng({ routes: [route({ readOnlyLock: 'copy: disposable copy' })] });
  const r = eligibleEngineer(copy, ctx({ mode: 'review' }));
  assert.equal(r.ok, true);
  assert.match(r.notes[0], /copy/);
});

test('a guessed model id and a run problem skip the route; a second good route still makes the engineer eligible', () => {
  const guessed = route({ route: 'cursor', exec: { tool: 'cursor', model: 'x-high', effort: null, use: 'standard', problem: null, guessedId: true } });
  const problem = route({ route: 'qwen', exec: { tool: 'qwen', model: null, problem: 'no model id known for this route' } });
  const t = { ...tools, cursor: { path: 'c', version: '1' }, qwen: { path: 'q', version: '1' } };
  assert.ok(codes(eligibleEngineer(eng({ routes: [guessed] }), ctx({ tools: t }))).includes('id_unverified'));
  assert.ok(codes(eligibleEngineer(eng({ routes: [problem] }), ctx({ tools: t }))).includes('exec_problem'));
  const both = eligibleEngineer(eng({ routes: [guessed, route()] }), ctx({ tools: t }));
  assert.equal(both.ok, true);
  assert.equal(both.route, 'codex');
});

test('resolveRole takes the first eligible engineer in call order and says why earlier ones were skipped', () => {
  const ladder = { roles: [{ role: 'Developer', engineers: [
    eng({ key: 'a|1', callOrder: 1, routes: [route({ route: 'qwen' })] }),
    eng({ key: 'b|1', callOrder: 2, commissioned: false }),
    eng({ key: 'c|1', callOrder: 3 }),
    eng({ key: 'd|1', callOrder: 4 }),
  ] }] };
  const r = resolveRole(ladder, 'developer', ctx());
  assert.equal(r.ok, true);
  assert.equal(r.engineer.key, 'c|1');
  assert.deepEqual(r.skipped.map((s) => s.key), ['a|1']);
});

test('resolveRole reports an unknown role and a role nobody can serve', () => {
  const ladder = { roles: [{ role: 'CTO', engineers: [eng({ routes: [route({ route: 'cursor' })] })] }] };
  assert.equal(resolveRole(ladder, 'Wizard', ctx()).ok, false);
  const none = resolveRole(ladder, 'CTO', ctx());
  assert.equal(none.ok, false);
  assert.equal(none.error, 'no eligible engineer');
  assert.equal(none.skipped.length, 1);
});
