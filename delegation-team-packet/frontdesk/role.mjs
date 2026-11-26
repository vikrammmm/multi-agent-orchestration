#!/usr/bin/env node
// The front desk. Delegate by role, never by model:
//   role plan [<role>] [--mode review|implement] [--json]    who would be called, and why anyone ahead was skipped (changes nothing)
//   role list [--json]                                      the commissioned engineers of every role, in call order
//   role doctor [--refresh] [--json]                        install state, tools, hooks, guard log; exits 1 when something is broken
//   role audit ...                                          what the three tools actually delegated (phase 1a: guard log and logs)
//   role call / role continue                               arrive in phase 1b
import fs from 'node:fs';
import path from 'node:path';
import { layout, VERSION } from './lib/paths.mjs';
import { readJson } from './lib/fsx.mjs';
import { loadCurrent } from './lib/generation.mjs';
import { installState, excludedIds, exclusionProblems } from './lib/receipts.mjs';
import { loadTools, TOOL_OF_ROUTE } from './lib/tools.mjs';
import { resolveRole, eligibleEngineer, REASONS } from './lib/eligible.mjs';
import { readRecords, summarize } from './lib/hooklog.mjs';
import { effectiveMode } from './lib/guard.mjs';
import { pretty, ROUTE_NAMES } from './lib/names.mjs';
import { auditLogs, formatAudit } from './lib/audit-logs.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const L = layout();
const asJson = flag('--json');
const out = (obj, text) => { if (asJson) console.log(JSON.stringify(obj, null, 1)); else console.log(text); };
const label = (e) => `${pretty(e.family)} ${e.effort ?? ''}`.trim();

function context(mode, { refresh = false } = {}) {
  const cur = loadCurrent(L);
  if (!cur.ok) return { cur };
  const cooldowns = readJson(path.join(L.state, 'cooldowns.json'), {});
  const tools = loadTools(L, { refresh }).tools;
  return { cur, ctx: { mode, tools, cooldowns, excluded: excludedIds(installState(L).receipt), now: new Date(), requirements: cur.requirements?.requirements ?? {}, rules: cur.requirements?.rules ?? {} } };
}

function refuseUnhealthy() {
  const st = installState(L);
  if (st.state === 'healthy') return null;
  const msg = st.state === 'never-installed'
    ? 'The front desk is not installed on this machine. Use the legacy routes in POLICY.md until it is (run install-frontdesk).'
    : 'The front desk install is BROKEN: ' + st.problems.map((p) => `${p.file}: ${p.problem}`).join('; ') + '. Do not fall back to the legacy table; run role doctor and repair or restore the previous release.';
  out({ ok: false, state: st.state, problems: st.problems }, msg);
  process.exitCode = st.state === 'broken' ? 3 : 2;
  return st;
}

function cmdPlan() {
  if (refuseUnhealthy()) return;
  const mode = val('--mode', 'implement');
  const roleArg = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const { cur, ctx } = context(mode, { refresh: flag('--refresh') });
  if (!cur.ok) return out({ ok: false, problems: cur.problems }, 'No usable ladder generation: ' + JSON.stringify(cur.problems));
  const names = roleArg ? [roleArg] : [...cur.ladder.roles].reverse().map((r) => r.role);
  const result = [];
  const lines = [`Ladder generation ${cur.generation} (release ${cur.release}), mode: ${mode}`, ''];
  for (const name of names) {
    const r = resolveRole(cur.ladder, name, ctx);
    const role = cur.ladder.roles.find((x) => x.role.toLowerCase() === String(name).toLowerCase());
    if (!role) { lines.push(`No such role: ${name}`); continue; }
    lines.push(`${role.role}:`);
    const members = role.engineers.filter((e) => e.commissioned).sort((a, b) => a.callOrder - b.callOrder);
    const rows = [];
    for (const e of members) {
      const el = eligibleEngineer(e, ctx);
      const ex = e.routes.find((x) => x.route === el.route)?.exec ?? e.routes[0]?.exec;
      const walls = [...new Set(e.routes.map((x) => x.wallet))].join(' / ');
      const first = r.ok && r.engineer.key === e.key && r.engineer.callOrder === e.callOrder;
      lines.push(`  #${e.callOrder} ${label(e)}  [${walls}]  ${first ? 'WOULD BE CALLED' : el.ok ? 'eligible' : 'skipped'}${el.ok ? ` via ${ROUTE_NAMES[el.route] || el.route}${ex?.use === 'fast' ? ', Fast mode' : ''}` : ': ' + [...new Set(el.reasons.map((x) => REASONS[x.code] || x.code))].join('; ')}${el.notes.length ? ' (' + el.notes.join('; ') + ')' : ''}`);
      rows.push({ callOrder: e.callOrder, key: e.key, wallets: walls, eligible: el.ok, route: el.route, wouldBeCalled: first, reasons: el.reasons });
    }
    lines.push('');
    result.push({ role: role.role, resolution: r.ok ? { key: r.engineer.key, route: r.route } : { error: r.error }, engineers: rows });
  }
  out({ ok: true, generation: cur.generation, release: cur.release, mode, roles: result }, lines.join('\n'));
}

function cmdList() {
  if (refuseUnhealthy()) return;
  const { cur, ctx } = context('implement');
  if (!cur.ok) return out({ ok: false, problems: cur.problems }, JSON.stringify(cur.problems));
  const lines = [`Ladder generation ${cur.generation} (release ${cur.release})`, ''];
  const data = [];
  for (const r of [...cur.ladder.roles].reverse()) {
    lines.push(`${r.role} (from ${r.min}):`);
    const m = r.engineers.filter((e) => e.commissioned || e.commission?.state === 'billing_hold').sort((a, b) => a.callOrder - b.callOrder);
    const exclusions = (e) => eligibleEngineer(e, ctx).reasons.filter((x) => x.code === 'excluded_here');
    for (const e of m) lines.push(`  #${e.callOrder} ${label(e)}  ${e.commission?.state === 'billing_hold' ? 'held (billing unconfirmed)' : e.ii == null ? 'no score' : 'score ' + e.ii}, ${e.effectiveCost == null ? 'no cost' : '$' + e.effectiveCost + ' per task'}${exclusions(e).length ? ' [excluded_here: ' + exclusions(e).map((x) => x.detail).join(', ') + ']' : ''}`);
    lines.push('');
    data.push({ role: r.role, engineers: m.map((e) => ({ callOrder: e.callOrder, key: e.key, score: e.ii, cost: e.effectiveCost, status: e.commission?.state === 'billing_hold' ? 'held (billing unconfirmed)' : 'commissioned', ...(exclusions(e).length ? { eligible: false, reasons: exclusions(e) } : {}) })) });
  }
  out({ ok: true, generation: cur.generation, roles: data }, lines.join('\n'));
}

function hookCommandPaths(command) {
  const m = /^(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s+(?:claude|codex|muse)\s+--fd-guard$/i.exec(command || '');
  return m ? { node: m[1] || m[2], hook: m[3] || m[4] } : null;
}

function codexApproval(text, command) {
  if (!text.includes('[hooks.state')) return { verifiable: true, trusted: false };
  const heads = [...text.matchAll(/^\s*\[{1,2}([^\]\r\n]+)\]{1,2}\s*$/gm)];
  if (!heads.length) return { verifiable: false, trusted: false };
  const hookHeaders = [...text.matchAll(/^\s*\[\[hooks\.PreToolUse\]\]\s*$/gm)];
  // our group is the one whose command carries --fd-guard (Codex may have moved its own tables between our markers)
  const ourIndex = hookHeaders.findIndex((match, k) => /^\s*command(_windows)?\s*=.*--fd-guard/m.test(text.slice(match.index, hookHeaders[k + 1]?.index ?? text.length)));
  if (ourIndex < 0) return { verifiable: false, trusted: false };
  // a bare [hooks.state] header is what Codex writes itself; it only makes approval unverifiable when it holds keys of its own
  if (heads.some((head, k) => head[1] === 'hooks.state' && /^\s*[A-Za-z0-9_-]+\s*=/m.test(text.slice(head.index + head[0].length, heads[k + 1]?.index ?? text.length)))) return { verifiable: false, trusted: false };
  for (let i = 0; i < heads.length; i++) {
    const header = heads[i][1];
    if (!header.startsWith('hooks.state.')) continue;
    const end = heads[i + 1]?.index ?? text.length;
    const section = text.slice(heads[i].index, end);
    const key = header.slice('hooks.state.'.length).replace(/^['"]|['"]$/g, '');
    const ours = new RegExp(`pre_tool_use:${ourIndex}:\\d+$`).test(key) || (!!command && section.includes(command));
    const hasHash = /\btrusted_hash\s*=/.test(section);
    const validHash = /^\s*trusted_hash\s*=\s*["'][^"']+["']\s*$/m.test(section);
    if (ours && validHash) return { verifiable: true, trusted: true };
    if (hasHash && (!validHash || (!ours && !/pre_tool_use:\d+:\d+$/.test(key)))) return { verifiable: false, trusted: false };
  }
  return { verifiable: true, trusted: false };
}

function hookStatus(receipt, records) {
  const has = (file, test) => { try { return test(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const configured = {
    claude: has(L.claudeSettings, (t) => t.includes('--fd-guard')) === true,
    codex: has(L.codexConfig, (t) => t.includes('>>> frontdesk-guard')) === true,
    muse: !!receipt?.hooks?.muse,
  };
  const proven = Object.fromEntries(['claude', 'codex', 'muse'].map((tool) => {
    const hook = receipt?.hooks?.[tool];
    const installedAt = Date.parse(hook?.installedAt || receipt?.installedAt || '');
    // proof needs the hook still configured and a real delegation record (kind other, such as wait_agent, is not one) from this install
    return [tool, !!hook && configured[tool] && Number.isFinite(installedAt) && records.some((r) => r.tool === tool && r.decision && !r.fault && r.kind && r.kind !== 'other' && r.gen === receipt?.generation && Date.parse(r.t) >= installedAt)];
  }));
  const codexText = has(L.codexConfig, (t) => t);
  const approval = codexText === null ? { verifiable: false, trusted: false } : codexApproval(codexText, receipt?.hooks?.codex?.command);
  const status = (tool) => proven[tool] ? 'proven' : configured[tool] ? 'configured' : 'not installed';
  const codexStatus = proven.codex ? 'proven' : !configured.codex ? 'not installed' : !approval.verifiable ? 'configured (approval not verifiable)' : approval.trusted ? 'configured' : 'pending approval';
  const museStatus = !receipt?.hooks?.muse ? 'not covered (user-level hook location unproven)' : status('muse');
  const commands = {};
  for (const [tool, hook] of Object.entries(receipt?.hooks || {})) {
    const paths = hookCommandPaths(hook.command);
    if (!paths) { commands[tool] = { ok: false, problem: 'command could not be parsed' }; continue; }
    const node = fs.existsSync(paths.node), script = fs.existsSync(paths.hook);
    commands[tool] = { node: paths.node, hook: paths.hook, nodeExists: node, hookExists: script, ok: node && script };
  }
  return {
    claude: { configured: configured.claude, proven: proven.claude, status: status('claude') },
    muse: { configured: configured.muse, proven: proven.muse, status: museStatus },
    codex: { configured: configured.codex, pendingApproval: configured.codex && approval.verifiable && !approval.trusted, approvalVerifiable: approval.verifiable, proven: proven.codex, status: codexStatus },
    commands,
  };
}

async function cmdDoctor() {
  const st = installState(L);
  const rep = { version: VERSION, state: st.state, problems: st.problems, home: L.home };
  const lines = [`Front desk ${VERSION}: install state = ${st.state.toUpperCase()}`];
  const ctx = { excluded: st.receipt && !exclusionProblems(st.receipt).length ? excludedIds(st.receipt) : new Set() };
  rep.installedBy = st.receipt?.installedBy ?? null;
  rep.exclusions = st.receipt?.exclusions ?? { required: [], declared: [] };
  rep.excluded = [...ctx.excluded].sort();
  lines.push(`  installedBy: ${rep.installedBy ?? '(absent)'}`);
  lines.push(`  exclusions: ${JSON.stringify(rep.exclusions)}`);
  const modeResults = await Promise.all(['claude', 'codex', 'muse'].map(async (tool) => {
    try { return [tool, { ok: true, mode: await effectiveMode(L, tool) }]; }
    catch (error) { return [tool, { ok: false, reason: error.kind || error.name || 'mode_unreadable' }]; }
  }));
  const modes = Object.fromEntries(modeResults.map(([tool, result]) => [tool, result.ok ? result.mode : `UNKNOWN (${result.reason})`]));
  rep.modes = modes;
  lines.push('  effective guard mode: ' + Object.entries(modes).map(([tool, mode]) => `${tool} ${mode}`).join(', '));
  if (Object.values(modes).some((mode) => mode !== 'shadow')) lines.push('  WARNING: one or more tools are not in shadow mode');
  for (const [tool, result] of modeResults) if (!result.ok) lines.push(`  ${tool} mode: UNKNOWN (${result.reason})`);
  for (const p of st.problems) lines.push(`  problem: ${p.file}: ${p.problem}`);
  const guardRecords = readRecords(L, { days: 7 });
  const hs = hookStatus(st.receipt, guardRecords);
  rep.hooks = hs;
  lines.push(`  hooks: claude ${hs.claude.status}, muse ${hs.muse.status}, codex ${hs.codex.status}`);
  rep.hookCommands = hs.commands;
  for (const [tool, check] of Object.entries(hs.commands)) if (!check.ok) lines.push(`  hook command ${tool}: ${check.problem || `node ${check.nodeExists ? 'ok' : 'missing'}; hook ${check.hookExists ? 'ok' : 'missing'}`}`);
  if (st.state !== 'never-installed') {
    const cur = loadCurrent(L, { withLadder: false });
    if (cur.ok) {
      const m = cur.manifest;
      rep.generation = { number: m.generation, release: m.release, publisher: m.publisher, time: m.time, inputs: m.source?.inputsHash };
      lines.push(`  ladder generation ${m.generation}, release ${m.release}, published ${m.time} by ${m.publisher?.machine ?? '?'}; inputs hash ${String(m.source?.inputsHash || '').slice(0, 12)}`);
    }
    const tools = loadTools(L, { refresh: flag('--refresh') });
    rep.tools = tools.tools;
    lines.push('  tools: ' + Object.entries(tools.tools).map(([k, v]) => `${k} ${v ? v.version : 'NOT FOUND'}`).join(', '));
    const sum = summarize(guardRecords);
    rep.guardLog = sum;
    lines.push(`  guard log (7 days): ${sum.total} records, would-deny ${Object.values(sum.byTool).reduce((a, t) => a + t.wouldDeny, 0)}, faults ${sum.faults}, latency p50 ${sum.p50 ?? '-'} ms, p95 ${sum.p95 ?? '-'} ms`);
    const cd = readJson(path.join(L.state, 'cooldowns.json'), {});
    const active = Object.entries(cd).filter(([, v]) => Date.parse(v.until) > Date.now());
    rep.cooldowns = active.map(([k, v]) => ({ key: k, until: v.until, reason: v.reason }));
    if (active.length) lines.push('  cooldowns: ' + active.map(([k, v]) => `${k} until ${v.until}`).join('; '));
  } else lines.push('  Not installed: delegate with the legacy routes in POLICY.md until this machine runs install-frontdesk.');
  out(rep, lines.join('\n'));
  if (st.state === 'broken' || modeResults.some(([, result]) => !result.ok)) process.exitCode = 1;
}

async function cmdAudit() {
  const days = Number(val('--days', 7));
  const recs = readRecords(L, { days });
  const sum = summarize(recs);
  const lines = [`Guard log, last ${days} days: ${sum.total} records`];
  for (const [t, v] of Object.entries(sum.byTool)) lines.push(`  ${t}: ${v.delegation} delegation requests, ${v.wouldDeny} would be refused`);
  for (const [r, n] of Object.entries(sum.byReason).sort((a, b) => b[1] - a[1])) lines.push(`  would refuse because "${r}": ${n}`);
  lines.push(`  faults ${sum.faults}; latency p50 ${sum.p50 ?? '-'} ms, p95 ${sum.p95 ?? '-'} ms, max ${sum.max ?? '-'} ms`);
  let logs = null;
  if (flag('--logs')) { logs = await auditLogs(L.home, { days }); lines.push('', formatAudit(logs)); }
  else lines.push('  (Add --logs for the retrospective scan of the Claude Code and Codex session logs.)');
  out({ days, ...sum, ...(logs ? { logs } : {}) }, lines.join('\n'));
}

switch (cmd) {
  case 'plan': cmdPlan(); break;
  case 'list': cmdList(); break;
  case 'doctor': await cmdDoctor(); break;
  case 'audit': await cmdAudit(); break;
  case 'call': case 'continue': out({ ok: false, error: 'not available yet' }, `role ${cmd} arrives in phase 1b; until then delegate with the routes in POLICY.md.`); process.exitCode = 2; break;
  default:
    console.log('role plan [<role>] [--mode review|implement] | role list | role doctor [--refresh] | role audit [--days N] [--logs]  (add --json for machine output)');
    process.exitCode = cmd ? 2 : 0;
}
