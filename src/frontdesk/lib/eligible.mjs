// THE eligibility rule. The front desk uses it to pick who to call; the guard uses the very same function on every helper spawn, so
// there is one definition of "may this engineer be called now". Pure: everything it needs is in ctx.
//
// ctx = { mode: 'review' | 'implement', tools: { claude: {path, version} | null, ... }, cooldowns: { <route or wallet>: { until, reason } },
//         now: Date, requirements: { families: [{ family, route, minVersion }], tools: {...} }, rules: { modeExclusions: [...] } }
import { TOOL_OF_ROUTE, versionAtLeast } from './tools.mjs';

export const lockRank = (lock) => (/^firm/.test(lock || '') ? 0 : /^medium/.test(lock || '') ? 1 : /^copy/.test(lock || '') ? 2 : 3);

export const REASONS = {
  not_commissioned: 'the owner has not commissioned it',
  needs_clearance: 'a newly found model the owner has not cleared',
  billing_unverified: 'how it is billed is unverified and the owner has not accepted that',
  excluded_for_mode: 'a standing rule keeps it out of this kind of work',
  excluded_here: "switched off on this machine: the owner's own endpoint, or a model this person declared unavailable",
  exec_problem: 'no usable run instruction for this route',
  id_unverified: 'the model id for this route is only a guess',
  tool_missing: 'the tool is not installed here',
  tool_too_old: 'the tool is older than this model needs',
  cooldown: 'in a quota cooldown',
  lock_too_weak_for_review: 'the read-only lock is too weak for review work',
};

function activeCooldown(ctx, rt) {
  const c = ctx.cooldowns || {};
  for (const k of [rt.route, rt.wallet]) {
    const x = c[k];
    if (x && Date.parse(x.until) > (ctx.now ?? new Date()).getTime()) return { key: k, until: x.until, reason: x.reason };
  }
  return null;
}

export function eligibleRoute(e, rt, ctx) {
  const reasons = [], notes = [];
  const ex = rt.exec;
  if (ctx.excluded?.has(ex?.model)) reasons.push({ code: 'excluded_here', detail: ex.model });
  if (!ex || ex.problem || !ex.model) reasons.push({ code: 'exec_problem', detail: ex?.problem || 'no exec' });
  else if (ex.guessedId) reasons.push({ code: 'id_unverified', detail: ex.model });
  const toolKey = TOOL_OF_ROUTE[rt.route];
  const tool = ctx.tools?.[toolKey];
  if (!tool) reasons.push({ code: 'tool_missing', detail: toolKey });
  else {
    const need = (ctx.requirements?.families || []).filter((r) => r.family === e.family && r.route === rt.route).map((r) => r.minVersion);
    const base = ctx.requirements?.tools?.[rt.route]?.minVersion;
    for (const v of [...need, base].filter(Boolean)) if (!versionAtLeast(tool.version, v)) { reasons.push({ code: 'tool_too_old', detail: `${tool.version} < ${v}` }); break; }
  }
  const cd = activeCooldown(ctx, rt);
  if (cd) reasons.push({ code: 'cooldown', detail: `${cd.key} until ${cd.until}` });
  if (ctx.mode === 'review') {
    const rank = lockRank(rt.readOnlyLock);
    if (rank > 2) reasons.push({ code: 'lock_too_weak_for_review', detail: rt.readOnlyLock });
    else if (rank === 2) notes.push('review needs a disposable copy of the workspace (copy lock)');
  }
  return { route: rt.route, ok: reasons.length === 0, reasons, notes };
}

export function eligibleEngineer(e, ctx) {
  const reasons = [];
  if (ctx.excluded?.has(e.family)) reasons.push({ code: 'excluded_here', detail: e.family });
  if (!e.commissioned) reasons.push({ code: 'not_commissioned' });
  if (e.isNew && !e.ownerCleared) reasons.push({ code: 'needs_clearance' });
  if (e.commission?.state === 'billing_hold' || (e.routes.some((r) => /unconfirmed/i.test(r.wallet || '')) && !e.ownerCleared)) reasons.push({ code: 'billing_unverified' });
  for (const x of ctx.rules?.modeExclusions || []) if (x.family === e.family && x.mode === ctx.mode) reasons.push({ code: 'excluded_for_mode', detail: x.reason });
  const perRoute = e.routes.map((rt) => eligibleRoute(e, rt, ctx));
  const first = perRoute.find((r) => r.ok);
  if (!first && perRoute.length) for (const r of perRoute) for (const x of r.reasons) reasons.push({ ...x, route: r.route });
  return { ok: reasons.length === 0 && !!first, route: first?.route ?? null, notes: first?.notes ?? [], reasons, perRoute };
}

// The first eligible engineer of a role in call order, plus what skipped each one before it.
export function resolveRole(ladder, roleName, ctx) {
  const role = ladder.roles.find((r) => r.role.toLowerCase() === String(roleName).toLowerCase());
  if (!role) return { ok: false, error: `no such role: ${roleName}`, roles: ladder.roles.map((r) => r.role) };
  const skipped = [];
  const members = role.engineers.filter((e) => e.commissioned).sort((a, b) => a.callOrder - b.callOrder);
  for (const e of members) {
    const r = eligibleEngineer(e, ctx);
    if (r.ok) return { ok: true, role: role.role, engineer: e, route: r.route, notes: r.notes, skipped };
    skipped.push({ key: e.key, callOrder: e.callOrder, reasons: r.reasons });
  }
  return { ok: false, role: role.role, error: 'no eligible engineer', skipped };
}
