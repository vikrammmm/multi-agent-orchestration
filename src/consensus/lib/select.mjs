// Seat eligibility, selection and grading, pure: no imports and no I/O. Callers pass the seat
// table (seats.json) and facts about the machine. Used by the referee (seats.mjs, doctor.mjs) and
// by the team packet's setup resolver, so both apply one rule and cannot disagree.
//
// Rule: a pair is always two different models (never the same model
// identity). Usable seats are ranked by tier (CTO first), then a different vendor from the partner,
// then a different family, then seats.json preferenceOrder. Two CTOs from different vendors are
// standard grade; two CTOs from one vendor are lower grade (single vendor); a pair with any seat
// below CTO is lower grade (below CTO level). One seat is a single reviewer, never a consensus.

export const TIER_NAMES = Object.freeze({ 1: 'CTO', 2: 'Tech lead', 3: 'Developer', 4: 'Junior' });

function tierOf(seat) {
  const t = Number(seat && seat.tier);
  return Number.isFinite(t) && t >= 1 ? t : 4;
}

// Same model = same identity: the seat's explicit "identity", else its model id without a
// trailing "-fast" (a fast variant is the same model). Fakes use their id.
export function modelIdentity(seat) {
  if (!seat) return '';
  if (seat.identity) return String(seat.identity);
  return String(seat.model || seat.id || '').replace(/-fast$/, '');
}

export function sameModel(a, b) {
  return Boolean(a && b && modelIdentity(a) && modelIdentity(a) === modelIdentity(b));
}

// A missing family never matches, so seats without one (for example test fakes) always differ.
function sameFamily(a, b) {
  return Boolean(a && b && a.family && b.family && a.family === b.family);
}

function prefIndex(table, id) {
  const i = (table.preferenceOrder || []).indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// true, false, or null when either side carries no x.y.z version.
export function versionAtLeast(text, min) {
  const a = parseVersion(text);
  const b = parseVersion(min);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

// Whether a seat can run on this machine. facts = {
//   tools: { <route>: { found: bool, version: 'x.y.z text' | null } },   // per route of seats.json
//   local: { disabled?: string, seats?: { <id>: { unavailable?: string, unverified?: string } } },
// }. Returns { usable, reason, unverified }. Checks, in order: known and seat-eligible, blocked,
// tool present, the route's minVersion, the seat's minVersion, marked unavailable on this machine.
export function seatEligibility(table, id, facts) {
  const seat = table.seats && table.seats[id];
  if (!seat) return { usable: false, reason: `unknown seat ${id}`, unverified: null };
  if (!seat.seatEligible) return { usable: false, reason: 'not seat-eligible', unverified: null };
  if (seat.blocked) return { usable: false, reason: `blocked: ${seat.blocked}`, unverified: null };
  const route = (table.routes && table.routes[seat.route]) || {};
  const tool = (facts && facts.tools && facts.tools[seat.route]) || { found: false, version: null };
  const binary = route.binary || seat.route;
  if (!tool.found) return { usable: false, reason: `${binary} not found`, unverified: null };
  for (const min of [route.minVersion, seat.minVersion]) {
    if (min && versionAtLeast(tool.version, min) === false) {
      return { usable: false, reason: `${binary} ${min} or later is required (found ${tool.version}); update the CLI`, unverified: null };
    }
  }
  const mark = (facts && facts.local && facts.local.seats && facts.local.seats[id]) || {};
  if (mark.unavailable) return { usable: false, reason: `not usable on this machine: ${mark.unavailable}`, unverified: null };
  let unverified = mark.unverified || null;
  if (!unverified && (route.minVersion || seat.minVersion) && versionAtLeast(tool.version, route.minVersion || seat.minVersion) === null) {
    unverified = `${binary} version could not be read`;
  }
  return { usable: true, reason: null, unverified };
}

export function assessorEligibility(table, id, facts) {
  const assessor = table.assessors && table.assessors[id];
  if (!assessor) return { usable: false, reason: `unknown assessor ${id}`, unverified: null };
  if (assessor.blocked) return { usable: false, reason: `blocked: ${assessor.blocked}`, unverified: null };
  const route = (table.routes && table.routes[assessor.route]) || {};
  const tool = (facts && facts.tools && facts.tools[assessor.route]) || { found: false, version: null };
  const binary = route.binary || assessor.route;
  if (!tool.found) return { usable: false, reason: `${binary} not found`, unverified: null };
  for (const min of [route.minVersion, assessor.minVersion]) {
    if (min && versionAtLeast(tool.version, min) === false) {
      return { usable: false, reason: `${binary} ${min} or later is required (found ${tool.version}); update the CLI`, unverified: null };
    }
  }
  const mark = (facts && facts.local && facts.local.assessors && facts.local.assessors[id]) || {};
  if (mark.unavailable) return { usable: false, reason: `not usable on this machine: ${mark.unavailable}`, unverified: null };
  let unverified = mark.unverified || null;
  if (!unverified && (route.minVersion || assessor.minVersion) && versionAtLeast(tool.version, route.minVersion || assessor.minVersion) === null) {
    unverified = `${binary} version could not be read`;
  }
  return { usable: true, reason: null, unverified };
}

export function pickAssessor(table, isUsable) {
  return (table.assessorOrder || []).find((id) => table.assessors && table.assessors[id] && isUsable(id)) || null;
}

function usableIds(table, isUsable) {
  return (table.preferenceOrder || []).filter((id) => {
    const seat = table.seats && table.seats[id];
    return Boolean(seat && seat.seatEligible && isUsable(id));
  });
}

export function seatLabel(seat) {
  if (!seat) return 'unknown seat';
  return seat.label || `${seat.model || seat.id} at ${seat.effort || 'default effort'}`;
}

// Candidates to sit with `partner` (a seat object with id, vendor, tier, family, model), best first.
export function rankPartners(table, isUsable, partner) {
  const ids = usableIds(table, isUsable)
    .filter((id) => id !== partner.id && !sameModel({ id, ...table.seats[id] }, partner));
  return ids.sort((a, b) => {
    const sa = table.seats[a];
    const sb = table.seats[b];
    return (tierOf(sa) - tierOf(sb))
      || (Number(sa.vendor === partner.vendor) - Number(sb.vendor === partner.vendor))
      || (Number(sameFamily(sa, partner)) - Number(sameFamily(sb, partner)))
      || (prefIndex(table, a) - prefIndex(table, b));
  });
}

export function pickPartner(table, isUsable, partner) {
  const ranked = rankPartners(table, isUsable, partner);
  return ranked.length > 0 ? ranked[0] : null;
}

// The best pair on this machine (what "--seats both" picks): the best seat, then its best partner.
// Returns [] when nothing is usable and [id] when no second model is usable.
export function pickPair(table, isUsable) {
  const firsts = usableIds(table, isUsable)
    .sort((a, b) => (tierOf(table.seats[a]) - tierOf(table.seats[b])) || (prefIndex(table, a) - prefIndex(table, b)));
  if (firsts.length === 0) return [];
  const first = firsts[0];
  const second = pickPartner(table, isUsable, { id: first, ...table.seats[first] });
  return second ? [first, second] : [first];
}

function kinship(a, b) {
  if (sameFamily(a, b)) return ` Both are ${a.vendor} models of the same family.`;
  if (a.vendor === b.vendor) return ` Both are ${a.vendor} models.`;
  return '';
}

// Grade of one or two seat objects (each with id, vendor, tier, and optionally label, model,
// family). Levels: standard, single-vendor, below-cto (pairs); single-reviewer (one seat); off.
export function gradeOf(seats) {
  const list = (seats || []).filter(Boolean);
  if (list.length === 0) return { level: 'off', note: 'No seat is usable.' };
  const [a, b] = list;
  if (!b) {
    return {
      level: 'single-reviewer',
      note: `SINGLE REVIEWER: only ${seatLabel(a)} (${TIER_NAMES[tierOf(a)]}) reviewed this; it is not a two-model consensus.`,
    };
  }
  const bothCto = tierOf(a) === 1 && tierOf(b) === 1;
  if (bothCto && a.vendor !== b.vendor) return { level: 'standard', note: '' };
  if (bothCto) {
    return {
      level: 'single-vendor',
      note: `LOWER GRADE (single vendor): both CTOs are ${a.vendor} models, ${seatLabel(a)} and ${seatLabel(b)}. `
        + 'This is an independent second look, but not a cross-vendor one.'
        + (sameFamily(a, b) ? ' They are also of the same model family.' : ''),
    };
  }
  // Neutral on purpose: the grade does not claim how the pair was chosen (automatic or named).
  return {
    level: 'below-cto',
    note: 'LOWER GRADE (below CTO level): this review uses '
      + `${seatLabel(a)} (${TIER_NAMES[tierOf(a)]}) and ${seatLabel(b)} (${TIER_NAMES[tierOf(b)]}); `
      + 'at least one of them is not a CTO-level model.'
      + kinship(a, b),
  };
}
