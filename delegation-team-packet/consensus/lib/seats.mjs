import { readJson } from './fsx.mjs';
import { loadLocalJson, seatsJsonPath } from './paths.mjs';
import { binaryVersion, resolveSeatBinary, versionAtLeast } from './spawn.mjs';
import { refuse } from './fail.mjs';
import { assessorEligibility, gradeOf, pickAssessor, pickPair, pickPartner, sameModel, seatEligibility } from './select.mjs';
import * as claude from './adapters/claude.mjs';
import * as codex from './adapters/codex.mjs';
import * as cursor from './adapters/cursor.mjs';
import * as fake from './adapters/fake.mjs';

let cached = null;
const versionByBinary = new Map();

export function loadSeatsJson() {
  if (!cached) cached = readJson(seatsJsonPath());
  return cached;
}

export function apiKeysToStrip() {
  return loadSeatsJson().apiKeyEnvToStrip || [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'MUSE_API_KEY',
  ];
}

export function getSeat(id) {
  if (!id) refuse('NO_SEAT', 'Seat id is required.');
  if (String(id).startsWith('fake:')) {
    const behaviour = String(id).slice(5);
    return {
      id,
      vendor: `fake-${behaviour}`,
      route: 'fake',
      model: id,
      effort: 'xhigh',
      tier: 1,
      lock: 'none',
      chairEligible: true,
      seatEligible: true,
      behaviour,
    };
  }
  const table = loadSeatsJson();
  const seat = table.seats[id];
  if (!seat && table.retired && Object.hasOwn(table.retired, id)) {
    refuse('NO_SEAT', `Seat ${id} is retired: ${table.retired[id]} A task that used it continues only as a new task (start --continue-from).`);
  }
  if (!seat) refuse('NO_SEAT', `Unknown seat ${id}.`);
  return { id, ...seat };
}

export function getAssessor(id) {
  if (String(id).startsWith('fake:')) {
    const behaviour = String(id).slice(5);
    return { id, vendor: `fake-${behaviour}`, route: 'fake', model: id, effort: 'high', tier: 3, lock: 'none', behaviour };
  }
  const table = loadSeatsJson();
  if (!table.assessors?.[id]) refuse('BAD_ARGS', `Unknown assessor ${id}; the assessors are ${(table.assessorOrder || []).join(', ')}.`);
  return { id, ...table.assessors[id] };
}

export function assessorStatus(id) {
  if (String(id).startsWith('fake:')) {
    const mark = (loadLocalJson().assessors || {})[id] || {};
    if (id === 'fake:missing') return { usable: false, reason: 'fake assessor is missing', unverified: null };
    if (mark.unavailable) return { usable: false, reason: `not usable on this machine: ${mark.unavailable}`, unverified: null };
    return { usable: true, reason: null, unverified: mark.unverified || null };
  }
  return assessorEligibility(loadSeatsJson(), id, machineFacts());
}

export function chooseAssessor(explicit) {
  refuseIfDisabled();
  if (explicit) {
    const seat = getAssessor(String(explicit));
    const status = assessorStatus(seat.id);
    if (!status.usable && seat.id !== 'fake:missing') refuse('ASSESSOR_UNAVAILABLE', status.reason);
    return seat.id;
  }
  const id = pickAssessor(loadSeatsJson(), (candidate) => assessorStatus(candidate).usable);
  if (!id) refuse('ASSESSOR_UNAVAILABLE', 'No task-sizing assessor is usable on this machine (run doctor).');
  return id;
}

export function routeInfo(route) {
  return loadSeatsJson().routes[route] || null;
}

export function binaryForSeat(seat) {
  if (seat.route === 'fake') return seat.behaviour === 'missing' ? null : process.execPath;
  const route = routeInfo(seat.route);
  if (!route) return null;
  return resolveSeatBinary(route.binary);
}

function cachedBinaryVersion(bin) {
  if (!versionByBinary.has(bin)) versionByBinary.set(bin, binaryVersion(bin));
  return versionByBinary.get(bin);
}

// Tools actually present on this machine, plus the per-machine local.json. Versions are cached
// per binary path for the life of the process (`--version` only; no tokens).
export function machineFacts() {
  const table = loadSeatsJson();
  const tools = {};
  for (const [route, info] of Object.entries(table.routes || {})) {
    const bin = info && info.binary ? resolveSeatBinary(info.binary) : null;
    tools[route] = { found: Boolean(bin), version: bin ? cachedBinaryVersion(bin) : null };
  }
  return { tools, local: loadLocalJson() };
}

export function localDisabled() {
  const value = loadLocalJson().disabled;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function refuseIfDisabled() {
  const reason = localDisabled();
  if (reason) {
    refuse('CONSENSUS_DISABLED', `consensus is off on this machine: ${reason}; run the team installer again`);
  }
}

export function eligibility(id) {
  if (String(id).startsWith('fake:')) {
    // Fake seats honour local.json marks like real ones, so tests can drive them.
    const behaviour = String(id).slice(5);
    const mark = ((loadLocalJson().seats || {})[id]) || {};
    if (behaviour === 'missing') return { usable: false, reason: 'fake seat is missing', unverified: null };
    if (mark.unavailable) return { usable: false, reason: `not usable on this machine: ${mark.unavailable}`, unverified: null };
    return { usable: true, reason: null, unverified: mark.unverified || null };
  }
  return seatEligibility(loadSeatsJson(), id, machineFacts());
}

// Before any seat call of an existing task (ask, and every consultation): consensus must be on
// and the assigned reviewer still usable here under the shared rule. The reviewer is never
// replaced; the refusal tells the chair to fix the machine or continue in a new task.
// (A fake "missing" seat still fails at call time, which the offline pause tests rely on.)
export function assertDispatchable(id) {
  refuseIfDisabled();
  if (String(id) === 'fake:missing') return;
  const elig = eligibility(id);
  if (!elig.usable) refuseUnusable(id, elig);
}

// A seat may require a minimum CLI version (seats.json seats.<id>.minVersion), for example the
// first Claude Code build that knows its model.
// Agrees with seatEligibility: missing tool or a too-old CLI is not ok; an unreadable version is.
export function seatVersionOk(seat) {
  if (!seat || !seat.minVersion || seat.route === 'fake') return true;
  const tool = (machineFacts().tools && machineFacts().tools[seat.route]) || { found: false, version: null };
  if (!tool.found) return false;
  return versionAtLeast(tool.version, seat.minVersion) !== false;
}

export function isAvailable(id) {
  try {
    return eligibility(id).usable;
  } catch {
    return false;
  }
}

function refuseUnusable(id, elig) {
  const reason = elig && elig.reason ? elig.reason : `Seat ${id} is not usable.`;
  if (reason.startsWith('blocked:')) refuse('SEAT_BLOCKED', reason);
  if (/or later is required/.test(reason)) refuse('SEAT_TOO_OLD', reason);
  if (reason.includes('not usable on this machine')) refuse('SEAT_NOT_HERE', reason);
  refuse('SEAT_UNAVAILABLE', reason);
}

function refuseRealSeat(id) {
  const elig = eligibility(id);
  if (!elig.usable) refuseUnusable(id, elig);
}

export function pickCochair(chairId, explicit) {
  refuseIfDisabled();
  if (explicit) {
    const chair = getSeat(chairId);
    const co = getSeat(explicit);
    if (sameModel(chair, co)) refuse('SAME_MODEL', `Chair and co-chair are the same model (${co.id}).`);
    // Fake seats stay as they were: blocked and version only. A missing fake is still named
    // here so later calls can pause; eligibility is what isAvailable reports.
    if (String(co.id).startsWith('fake:')) {
      if (co.blocked) refuse('SEAT_BLOCKED', `Seat ${co.id} is blocked: ${co.blocked}`);
      if (!seatVersionOk(co)) refuse('SEAT_TOO_OLD', `Seat ${co.id} needs ${co.minVersion} or later of its CLI.`);
      return co.id;
    }
    refuseRealSeat(co.id);
    return co.id;
  }
  const partner = pickPartner(loadSeatsJson(), isAvailable, getSeat(chairId));
  if (!partner) {
    refuse('SEAT_UNAVAILABLE', 'No second model is usable on this machine; consensus needs two different models (run doctor).');
  }
  return partner;
}

export function expandSeats(spec, fallbackBoth) {
  refuseIfDisabled();
  const table = loadSeatsJson();
  if (!spec || spec === true || spec === 'both') {
    const ranked = Array.isArray(fallbackBoth) && fallbackBoth.length
      ? { ...table, preferenceOrder: fallbackBoth }
      : table;
    const picked = pickPair(ranked, isAvailable);
    if (picked.length < 2) refuse('SEAT_UNAVAILABLE', 'fewer than two different models are usable here');
    return orderDrafting(picked, table.consultDraftingSeat || 'claude-opus-5.5');
  }
  const list = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) refuse('NO_SEAT', 'No seats given.');
  const resolved = refuseSameModel(list);
  for (const seat of resolved) {
    if (String(seat.id).startsWith('fake:')) {
      if (seat.blocked) refuse('SEAT_BLOCKED', `Seat ${seat.id} is blocked: ${seat.blocked}`);
      if (!seatVersionOk(seat)) refuse('SEAT_TOO_OLD', `Seat ${seat.id} needs ${seat.minVersion} or later of its CLI.`);
      continue;
    }
    refuseRealSeat(seat.id);
  }
  return list;
}

// The same model never fills two seats (SAME_MODEL). Returns the resolved seats.
export function refuseSameModel(list) {
  const resolved = list.map((id) => getSeat(id));
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      // Identical fake ids are how the offline consult tests drive two answers from one behaviour.
      if (String(a.id).startsWith('fake:') && String(b.id).startsWith('fake:')) continue;
      if (a.id === b.id || sameModel(a, b)) refuse('SAME_MODEL', `Seats ${a.id} and ${b.id} are the same model.`);
    }
  }
  return resolved;
}

export function gradeForSeatIds(ids) {
  return gradeOf((ids || []).filter(Boolean).map((id) => getSeat(id)));
}

export function unverifiedFor(ids) {
  const out = [];
  for (const id of (ids || []).filter(Boolean)) {
    const elig = eligibility(id);
    if (elig.unverified) out.push({ seat: id, reason: elig.unverified });
  }
  return out;
}

// SPEC section 9: the drafting seat is the first in --seats; for "both" it is the first seat
// listed in seats.json consultDraftingSeat (a seat id or an ordered list of ids) that was picked.
export function orderDrafting(picked, draftingSeat) {
  const preferred = Array.isArray(draftingSeat) ? draftingSeat : [draftingSeat];
  const id = preferred.find((s) => picked.includes(s));
  const i = id === undefined ? -1 : picked.indexOf(id);
  if (i <= 0) return picked;
  return [picked[i], ...picked.slice(0, i), ...picked.slice(i + 1)];
}

export function getAdapter(seat) {
  if (seat.route === 'fake' || String(seat.id).startsWith('fake:')) return fake;
  if (seat.route === 'claude-code') return claude;
  if (seat.route === 'codex') return codex;
  if (seat.route === 'cursor') return cursor;
  refuse('NO_SEAT', `No adapter for route ${seat.route}.`);
}

export function usedFake(id) {
  return Boolean(id && String(id).startsWith('fake:'));
}

export function localBinaries() {
  return loadLocalJson().binaries || {};
}
