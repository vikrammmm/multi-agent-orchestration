import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSeat, orderDrafting } from '../lib/seats.mjs';
import { tmp, writeLf } from './helpers.mjs';

// Seat selection and drafting order under different Claude CLI versions, offline: each scenario
// runs a private copy of lib\ with its own seats.json and a local.json that points the claude and
// codex binaries at fake CLIs which only answer --version. No seat is launched, no tokens are
// spent, and the CLIs installed on the machine do not matter. Temporary folders use the prefix
// crt- under the operating system's temporary directory, like the other tests' cled- and cproj-.

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEATS = JSON.parse(fs.readFileSync(path.join(SOURCE, 'seats.json'), 'utf8'));
const CUSTOM_ORDER = ['gpt-6.2-sol', 'claude-opus', 'claude-opus-5.5', 'grok-4.7'];

function fakeCli(dir, name, versionLine) {
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\necho ${versionLine}\r\n`, 'utf8');
    return file;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho '${versionLine}'\n`, 'utf8');
  fs.chmodSync(file, 0o755);
  return file;
}

// Each call imports a fresh module instance, so the seats.json cache never leaks between scenarios.
async function runtimeWith({ claudeVersion, seats = SEATS }) {
  const rt = tmp('crt-');
  fs.cpSync(path.join(SOURCE, 'lib'), path.join(rt, 'lib'), { recursive: true });
  writeLf(path.join(rt, 'seats.json'), JSON.stringify(seats, null, 2) + '\n');
  const bin = path.join(rt, 'bin');
  fs.mkdirSync(bin);
  writeLf(path.join(rt, 'local.json'), JSON.stringify({
    binaries: {
      claude: fakeCli(bin, 'claude', `${claudeVersion} (Claude Code)`),
      codex: fakeCli(bin, 'codex', 'codex-cli 0.155.0'),
    },
  }) + '\n');
  return import(pathToFileURL(path.join(rt, 'lib', 'seats.mjs')).href);
}

test('the shipped seats.json starts with GPT-6.2 Sol and Opus 5.5, with both Claude seats as drafters', () => {
  assert.deepEqual(SEATS.preferenceOrder, ['gpt-6.2-sol', 'claude-opus-5.5', 'claude-opus', 'grok-4.7', 'gpt-6.1-sol', 'gpt-6-sol', 'claude-sonnet-5', 'grok-4.6', 'gpt-5.6-sol']);
  assert.deepEqual(SEATS.consultDraftingSeat, ['claude-opus-5.5', 'claude-opus']);
  assert.deepEqual(SEATS.preferenceOrder.slice(0, 2), ['gpt-6.2-sol', 'claude-opus-5.5']);
  assert.equal(SEATS.seats['claude-opus-5.5'].minVersion, '2.1.280');
});

test('the shipped seats.json references only active seats and excludes retired models', () => {
  const seatIds = new Set(Object.keys(SEATS.seats));
  assert.ok(!Object.values(SEATS.seats).some((seat) => ['gpt-6-astra', 'claude-fable-5-1'].includes(seat.model)));
  for (const id of [...SEATS.preferenceOrder, ...SEATS.consultDraftingSeat]) {
    assert.ok(seatIds.has(id), id + ' is an active seat');
  }
  for (const id of Object.keys(SEATS.retired)) {
    assert.ok(!seatIds.has(id), id + ' is not an active seat');
    assert.ok(!SEATS.preferenceOrder.includes(id), id + ' is not in preferenceOrder');
    assert.ok(!SEATS.consultDraftingSeat.includes(id), id + ' is not a drafting seat');
  }
});

test('getSeat refuses retired ids with NO_SEAT and an is retired message', () => {
  for (const id of ['gpt-astra', 'claude-fable']) {
    assert.throws(() => getSeat(id), (error) => {
      assert.equal(error.code, 'NO_SEAT');
      assert.match(error.message, /is retired/);
      return true;
    });
  }
});

test('with Claude Code 2.1.280, Opus 5.5 is the Claude co-CTO and drafts', async () => {
  const seats = await runtimeWith({ claudeVersion: '2.1.280' });
  assert.equal(seats.pickCochair('gpt-6.2-sol', null), 'claude-opus-5.5');
  assert.equal(seats.pickCochair('claude-opus-5.5', null), 'gpt-6.2-sol');
  assert.deepEqual(seats.expandSeats('both'), ['claude-opus-5.5', 'gpt-6.2-sol']);
});

test('with Claude Code 2.1.279, Opus 5 is the Claude co-CTO and drafts; naming Opus 5.5 refuses', async () => {
  const seats = await runtimeWith({ claudeVersion: '2.1.279' });
  assert.equal(seats.pickCochair('gpt-6.2-sol', null), 'claude-opus');
  assert.deepEqual(seats.expandSeats('both'), ['claude-opus', 'gpt-6.2-sol']);
  assert.throws(() => seats.pickCochair('gpt-6.2-sol', 'claude-opus-5.5'), (e) => e.code === 'SEAT_TOO_OLD');
  assert.throws(() => seats.expandSeats('claude-opus-5.5,gpt-6.2-sol'), (e) => e.code === 'SEAT_TOO_OLD');
});

test('a seats.json without consultDraftingSeat defaults to Opus 5.5', async () => {
  const { consultDraftingSeat, ...rest } = SEATS;
  assert.ok(consultDraftingSeat);
  const seats = await runtimeWith({ claudeVersion: '2.1.279', seats: rest });
  // The default is Opus 5.5 specifically, so an available Opus 5 is not moved to the front.
  assert.deepEqual(seats.expandSeats('both'), ['gpt-6.2-sol', 'claude-opus']);
});

test('the legacy string drafting form still works with a custom seat order', async () => {
  const seats = await runtimeWith({
    claudeVersion: '2.1.280',
    seats: { ...SEATS, preferenceOrder: CUSTOM_ORDER, consultDraftingSeat: 'claude-opus' },
  });
  assert.equal(seats.pickCochair('gpt-6.2-sol', null), 'claude-opus');
  assert.deepEqual(seats.expandSeats('both'), ['claude-opus', 'gpt-6.2-sol']);
});

test('drafting order: list priority, Opus 5 fallback, neither listed, string form', () => {
  const list = ['claude-opus-5.5', 'claude-opus'];
  // Both candidates present: the first listed one drafts.
  assert.deepEqual(orderDrafting(['gpt-6.2-sol', 'claude-opus', 'claude-opus-5.5'], list), ['claude-opus-5.5', 'gpt-6.2-sol', 'claude-opus']);
  // Opus 5.5 absent: Opus 5 drafts.
  assert.deepEqual(orderDrafting(['gpt-6.2-sol', 'claude-opus'], list), ['claude-opus', 'gpt-6.2-sol']);
  // Neither listed seat picked: order unchanged.
  assert.deepEqual(orderDrafting(['gpt-6.2-sol', 'grok-4.7'], list), ['gpt-6.2-sol', 'grok-4.7']);
  // Already first: unchanged.
  assert.deepEqual(orderDrafting(['claude-opus-5.5', 'gpt-6.2-sol'], list), ['claude-opus-5.5', 'gpt-6.2-sol']);
  // String form behaves as before.
  assert.deepEqual(orderDrafting(['gpt-6.2-sol', 'claude-opus'], 'claude-opus'), ['claude-opus', 'gpt-6.2-sol']);
  assert.deepEqual(orderDrafting(['gpt-6.2-sol', 'claude-opus-5.5'], 'claude-opus'), ['gpt-6.2-sol', 'claude-opus-5.5']);
});
