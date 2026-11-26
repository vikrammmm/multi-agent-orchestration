import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  gradeOf, modelIdentity, pickPair, pickPartner, rankPartners, sameModel, seatEligibility, versionAtLeast,
} from '../lib/select.mjs';

// The pure eligibility, selection and grading rule against the shipped seats.json.

const TABLE = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seats.json'), 'utf8'));
const seat = (id) => ({ id, ...TABLE.seats[id] });
const only = (...ids) => (id) => ids.includes(id);
const all = () => true;

test('the GPT-6.1 reserve is a distinct tier 1 standard-grade partner', () => {
  const primary = seat('gpt-6.2-sol'), reserve = seat('gpt-6.1-sol'), claude = seat('claude-opus-5.5');
  assert.equal(pickPartner(TABLE, all, claude), primary.id);
  assert.equal(TABLE.seats[reserve.id].reserve, true);
  assert.equal(reserve.tier, 1);
  assert.deepEqual(pickPair(TABLE, only(claude.id, reserve.id)), [claude.id, reserve.id]);
  assert.equal(gradeOf([claude, reserve]).level, 'standard');
  assert.equal(sameModel(primary, reserve), false);
  assert.notEqual(modelIdentity(primary), modelIdentity(reserve));
  assert.deepEqual(pickPair(TABLE, only(primary.id, reserve.id)), [primary.id, reserve.id]);
  assert.equal(gradeOf([primary, reserve]).level, 'single-vendor');
});

test('shipped seats.json: every seat has a family, a tier and a label, and is in preferenceOrder', () => {
  for (const [id, s] of Object.entries(TABLE.seats)) {
    assert.ok(s.family, `${id} has a family`);
    assert.ok([1, 2].includes(s.tier), `${id} tier is 1 or 2`);
    assert.ok(s.label, `${id} has a label`);
    assert.ok(TABLE.preferenceOrder.includes(id), `${id} is in preferenceOrder`);
  }
  const lastCto = Math.max(...TABLE.preferenceOrder.map((id, i) => (TABLE.seats[id].tier === 1 ? i : -1)));
  const firstFallback = Math.min(...TABLE.preferenceOrder.map((id, i) => (TABLE.seats[id].tier > 1 ? i : Infinity)));
  assert.ok(lastCto < firstFallback);
  for (const [id, s] of Object.entries(TABLE.seats)) assert.equal(Boolean(s.fallback), s.tier > 1, id);
  // No two shipped seats are the same model.
  const ids = Object.keys(TABLE.seats);
  for (const a of ids) for (const b of ids) if (a !== b) assert.ok(!sameModel(seat(a), seat(b)), `${a} and ${b}`);
});

test('everything usable: standard picks', () => {
  assert.equal(pickPartner(TABLE, all, seat('gpt-6.2-sol')), 'claude-opus-5.5');
  assert.equal(pickPartner(TABLE, all, seat('claude-opus-5.5')), 'gpt-6.2-sol');
  assert.equal(pickPartner(TABLE, all, seat('claude-opus')), 'gpt-6.2-sol');
  assert.equal(pickPartner(TABLE, all, seat('grok-4.7')), 'gpt-6.2-sol');
  assert.deepEqual(pickPair(TABLE, all), ['gpt-6.2-sol', 'claude-opus-5.5']);
  assert.equal(gradeOf([seat('gpt-6.2-sol'), seat('claude-opus-5.5')]).level, 'standard');
});

test('when Opus 5.5 is unavailable, Opus 5 takes the Claude place ahead of Grok 4.7', () => {
  const usable = (id) => id !== 'claude-opus-5.5';
  assert.equal(pickPartner(TABLE, usable, seat('gpt-6.2-sol')), 'claude-opus');
  assert.deepEqual(pickPair(TABLE, usable), ['gpt-6.2-sol', 'claude-opus']);
  assert.equal(gradeOf([seat('gpt-6.2-sol'), seat('claude-opus')]).level, 'standard');
});

test('when no Claude CTO is usable, Grok 4.7 is the GPT chair\'s partner at standard grade', () => {
  const usable = only('gpt-6.2-sol', 'grok-4.7', 'gpt-6-sol');
  assert.equal(pickPartner(TABLE, usable, seat('gpt-6.2-sol')), 'grok-4.7');
  assert.deepEqual(pickPair(TABLE, usable), ['gpt-6.2-sol', 'grok-4.7']);
  assert.equal(gradeOf([seat('gpt-6.2-sol'), seat('grok-4.7')]).level, 'standard');
});

test('Claude only: Opus 5.5 pairs with Opus 5 at single-vendor grade', () => {
  const usable = only('claude-opus-5.5', 'claude-opus', 'claude-sonnet-5');
  assert.equal(pickPartner(TABLE, usable, seat('claude-opus-5.5')), 'claude-opus');
  assert.equal(pickPartner(TABLE, usable, seat('claude-opus')), 'claude-opus-5.5');
  assert.deepEqual(pickPair(TABLE, usable), ['claude-opus-5.5', 'claude-opus']);
  const g = gradeOf([seat('claude-opus-5.5'), seat('claude-opus')]);
  assert.equal(g.level, 'single-vendor');
  assert.match(g.note, /single vendor/);
  assert.match(g.note, /Anthropic/);
  assert.match(g.note, /same model family/);
});

test('two different models of one family pair when nothing better is usable, and say so', () => {
  assert.equal(pickPartner(TABLE, only('claude-opus-5.5', 'claude-opus'), seat('claude-opus-5.5')), 'claude-opus');
  const g1 = gradeOf([seat('claude-opus-5.5'), seat('claude-opus')]);
  assert.equal(g1.level, 'single-vendor');
  assert.match(g1.note, /same model family/);
  // The two Sol models are the only usable seats: they still get both seats, below CTO level.
  assert.deepEqual(pickPair(TABLE, only('gpt-6-sol', 'gpt-5.6-sol')), ['gpt-6-sol', 'gpt-5.6-sol']);
  const g2 = gradeOf([seat('gpt-6-sol'), seat('gpt-5.6-sol')]);
  assert.equal(g2.level, 'below-cto');
  assert.match(g2.note, /OpenAI models of the same family/);
  // A different family of the same tier wins over the same family.
  assert.equal(pickPartner(TABLE, only('gpt-5.6-sol', 'claude-sonnet-5'), seat('gpt-6-sol')), 'claude-sonnet-5');
});

test('the same model never fills both seats, fast variants included', () => {
  const table = JSON.parse(JSON.stringify(TABLE));
  table.seats['grok-4.7-fast'] = { ...table.seats['grok-4.7'], model: 'grok-4.7-xhigh-fast', label: 'Grok 4.7 fast' };
  table.preferenceOrder.push('grok-4.7-fast');
  const g47 = { id: 'grok-4.7', ...table.seats['grok-4.7'] };
  assert.equal(modelIdentity(table.seats['grok-4.7-fast']), 'grok-4.7-xhigh');
  assert.equal(pickPartner(table, only('grok-4.7', 'grok-4.7-fast'), g47), null);
  assert.ok(!rankPartners(table, all, g47).includes('grok-4.7-fast'));
});

test('tier outranks vendor and family', () => {
  const table = JSON.parse(JSON.stringify(TABLE));
  table.seats['claude-other-cto'] = {
    vendor: 'Anthropic', family: 'other', model: 'claude-other', label: 'Other Claude CTO',
    tier: 1, seatEligible: true,
  };
  table.preferenceOrder.push('claude-other-cto');
  const partner = { id: 'claude-opus-5.5', ...table.seats['claude-opus-5.5'] };
  assert.equal(pickPartner(table, only('claude-other-cto', 'gpt-6-sol'), partner), 'claude-other-cto');
  assert.equal(pickPartner(TABLE, only('claude-opus', 'gpt-6-sol'), seat('claude-opus-5.5')), 'claude-opus');
});

test('at equal tier a different vendor wins', () => {
  assert.equal(pickPartner(TABLE, only('claude-opus', 'grok-4.7'), seat('claude-opus-5.5')), 'grok-4.7');
  assert.equal(pickPartner(TABLE, only('claude-sonnet-5', 'gpt-6-sol'), seat('claude-opus-5.5')), 'gpt-6-sol');
});

test('no CTO usable at all: the best two Tech leads, labelled below CTO level', () => {
  const usable = only('gpt-6-sol', 'claude-sonnet-5', 'grok-4.6', 'gpt-5.6-sol');
  assert.deepEqual(pickPair(TABLE, usable), ['gpt-6-sol', 'claude-sonnet-5']);
  const g = gradeOf([seat('gpt-6-sol'), seat('claude-sonnet-5')]);
  assert.equal(g.level, 'below-cto');
  assert.match(g.note, /below CTO level/);
  assert.match(g.note, /Tech lead/);
});

test('one CTO plus a Tech lead is below CTO level', () => {
  assert.deepEqual(pickPair(TABLE, only('gpt-6.2-sol', 'claude-sonnet-5')), ['gpt-6.2-sol', 'claude-sonnet-5']);
  assert.equal(gradeOf([seat('gpt-6.2-sol'), seat('claude-sonnet-5')]).level, 'below-cto');
});

test('one usable model gives one seat and a single-reviewer grade, never standard', () => {
  assert.deepEqual(pickPair(TABLE, only('claude-sonnet-5')), ['claude-sonnet-5']);
  assert.deepEqual(pickPair(TABLE, () => false), []);
  assert.equal(gradeOf([]).level, 'off');
  const one = gradeOf([seat('gpt-6.2-sol')]);
  assert.equal(one.level, 'single-reviewer');
  assert.match(one.note, /not a two-model consensus/);
  assert.equal(gradeOf([seat('gpt-6-sol')]).level, 'single-reviewer');
});

test('seats that are not seat-eligible or not in preferenceOrder are never picked', () => {
  const table = JSON.parse(JSON.stringify(TABLE));
  table.seats['gpt-6.2-sol'].seatEligible = false;
  table.seats.extra = { vendor: 'OpenAI', family: 'x', model: 'x', tier: 1, seatEligible: true };
  assert.equal(pickPartner(table, all, { id: 'claude-opus-5.5', ...table.seats['claude-opus-5.5'] }), 'grok-4.7');
  assert.ok(!rankPartners(table, all, { id: 'claude-opus', ...table.seats['claude-opus'] }).includes('extra'));
});

test('seats without a family or model (test fakes) are treated as distinct', () => {
  const fakeA = { id: 'fake:agree', vendor: 'fake-agree', tier: 1 };
  const fakeB = { id: 'fake:done', vendor: 'fake-done', tier: 1 };
  assert.equal(gradeOf([fakeA, fakeB]).level, 'standard');
  assert.equal(pickPartner(TABLE, only('gpt-6.2-sol'), fakeA), 'gpt-6.2-sol');
});

test('versionAtLeast compares x.y.z and returns null without a version', () => {
  assert.equal(versionAtLeast('2.1.280 (Claude Code)', '2.1.280'), true);
  assert.equal(versionAtLeast('2.1.279', '2.1.280'), false);
  assert.equal(versionAtLeast('codex-cli 0.155.0-alpha.16.4', '0.155.0'), true);
  assert.equal(versionAtLeast('', '2.1.248'), null);
});

test('seatEligibility applies tool presence, both minimum versions, blocks and machine marks in order', () => {
  const facts = (claude, local = {}) => ({
    tools: {
      'claude-code': { found: claude !== null, version: claude },
      codex: { found: true, version: 'codex-cli 0.155.0' },
      cursor: { found: false, version: null },
    },
    local,
  });
  assert.deepEqual(seatEligibility(TABLE, 'claude-opus', facts('2.1.280')), { usable: true, reason: null, unverified: null });
  assert.match(seatEligibility(TABLE, 'claude-opus', facts('2.1.200')).reason, /2\.1\.248 or later is required/);
  assert.match(seatEligibility(TABLE, 'claude-opus-5.5', facts('2.1.279')).reason, /2\.1\.280 or later is required/);
  assert.match(seatEligibility(TABLE, 'claude-opus', facts(null)).reason, /claude not found/);
  assert.match(seatEligibility(TABLE, 'grok-4.7', facts('2.1.280')).reason, /cursor-agent not found/);
  const marked = facts('2.1.280', { seats: { 'gpt-6.2-sol': { unavailable: 'GPT seat is not offered' } } });
  assert.equal(seatEligibility(TABLE, 'gpt-6.2-sol', marked).usable, false);
  assert.match(seatEligibility(TABLE, 'gpt-6.2-sol', marked).reason, /not usable on this machine: GPT seat is not offered/);
  const unverified = facts('2.1.280', { seats: { 'claude-opus': { unverified: 'Claude plan access is assumed' } } });
  assert.deepEqual(seatEligibility(TABLE, 'claude-opus', unverified), { usable: true, reason: null, unverified: 'Claude plan access is assumed' });
  assert.match(seatEligibility(TABLE, 'claude-opus', facts('unknown')).unverified, /version could not be read/);
  const blocked = JSON.parse(JSON.stringify(TABLE));
  blocked.seats['claude-opus'].blocked = 'test';
  assert.match(seatEligibility(blocked, 'claude-opus', facts('2.1.280')).reason, /blocked: test/);
  assert.equal(seatEligibility(TABLE, 'nope', facts('2.1.280')).usable, false);
});
