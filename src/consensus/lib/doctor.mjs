import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeUtf8 } from './fsx.mjs';
import { SERVER_HOST_NOTE, hostModeFromLocal, ledgerRoot, readVersion } from './paths.mjs';
import { gradeOf, pickAssessor, pickPair } from './select.mjs';
import { assessorStatus, binaryForSeat, eligibility, getAssessor, getSeat, isAvailable, loadSeatsJson, localDisabled, machineFacts, routeInfo } from './seats.mjs';
import { loadIndex, loadLedger } from './ledger.mjs';
import { quoteWinArg, resolveSeatBinary, versionAtLeast } from './spawn.mjs';

export { versionAtLeast };

function runArgv(bin, argv, timeout = 8000) {
  const opts = { encoding: 'utf8', timeout, windowsHide: true };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quoted = [bin, ...argv].map(quoteWinArg).join(' ');
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(bin, argv, opts);
}

export function cmdDoctor() {
  const node = process.version;
  const nodeOk = Number(String(node).replace(/^v/, '').split('.')[0]) >= 18;
  const root = ledgerRoot();
  let writable = false;
  try {
    ensureDir(root);
    const probe = path.join(root, `.write-probe-${process.pid}`);
    writeUtf8(probe, 'ok\n');
    fs.unlinkSync(probe);
    writable = true;
  } catch { writable = false; }

  const table = loadSeatsJson();
  const facts = machineFacts();
  const disabled = localDisabled();
  const seats = [];
  const assessors = [];
  const vendors = new Set();
  for (const id of Object.keys(table.seats)) {
    const seat = getSeat(id);
    const route = routeInfo(seat.route) || {};
    const bin = binaryForSeat(seat);
    const tool = (facts.tools && facts.tools[seat.route]) || { found: false, version: null };
    const elig = eligibility(id);
    if (elig.usable && seat.seatEligible) vendors.add(seat.vendor);
    seats.push({
      id,
      vendor: seat.vendor,
      route: seat.route,
      available: elig.usable,
      binary: bin,
      version: bin ? tool.version : null,
      minVersion: seat.minVersion || route.minVersion || null,
      reason: elig.reason,
      seatEligible: seat.seatEligible,
      tier: seat.tier,
      family: seat.family,
      fallback: Boolean(seat.fallback),
      unverified: elig.unverified,
    });
  }
  for (const id of table.assessorOrder || []) {
    const assessor = getAssessor(id);
    const status = assessorStatus(id);
    const bin = binaryForSeat(assessor);
    assessors.push({ id, route: assessor.route, model: assessor.model, available: status.usable,
      reason: status.reason, version: bin ? facts.tools?.[assessor.route]?.version || null : null });
  }
  const assessor = disabled ? null : pickAssessor(table, (id) => assessorStatus(id).usable);
  // A damaged task folder must not break the health check: it simply is not counted.
  const recorded = (loadIndex().tasks || []).filter((row) => row.mode === 'assess' && row.state === 'recorded')
    .filter((row) => { try { return !loadLedger(row.id).test; } catch { return false; } }).length;
  const trial = { recorded, trialTasks: table.assessment?.trialTasks || 0 };

  let codexLogin = null;
  const codexBin = resolveSeatBinary('codex');
  if (codexBin) {
    const r = runArgv(codexBin, ['login', 'status'], 8000);
    codexLogin = ((r.stdout || '') + (r.stderr || '')).trim() || `(exit ${r.status})`;
  }

  let bestPair;
  if (disabled) {
    bestPair = { seats: [], grade: 'off', note: disabled };
  } else {
    const pair = pickPair(table, isAvailable);
    if (pair.length >= 2) {
      const g = gradeOf(pair.map((id) => getSeat(id)));
      bestPair = { seats: pair, grade: g.level, note: g.note };
    } else {
      bestPair = { seats: pair, grade: 'off', note: 'fewer than two different models are usable here' };
    }
  }

  const rawHost = hostModeFromLocal();
  const hostValid = rawHost === 'desktop' || rawHost === 'server';
  const hostMode = rawHost;
  const hostModeDisplay = rawHost === 'server'
    ? SERVER_HOST_NOTE
    : (hostValid ? 'desktop' : `invalid host mode ${JSON.stringify(rawHost)}`);
  const hostModeProblem = hostValid
    ? null
    : `Unknown host mode ${JSON.stringify(rawHost)}; run the team installer again.`;

  return {
    ok: nodeOk && writable,
    version: readVersion(),
    node,
    nodeOk,
    ledger: { path: root, writable },
    hostMode,
    hostModeDisplay,
    hostModeProblem,
    seats,
    assessors,
    assessor,
    trial,
    codexLogin,
    twoVendors: vendors.size >= 2,
    vendors: [...vendors],
    disabled,
    bestPair,
  };
}

const AGENTS_BLOCK = `## Consensus referee (CTO consult)

This project can ask the installed consensus referee for a CTO opinion without
the working session claiming a chair.

Write a short brief (the task, the plan or the diff, what you are unsure about,
the relevant paths) and run:

\`node <referee> consult --project . --brief brief.md --seats both --stage plan\`

Use \`--stage review\` after the work, with \`diff.patch\` and \`tests.txt\` next
to the brief. Then \`wait --task <id>\` if you used \`--detach\`. Read only
\`reports/feedback.md\` or \`reports/split.md\` — not the raw seat answers.

If \`CONSENSUS_SEAT\` or \`DELEGATION_DISPATCHED\` is set, do not run the referee.
`;

export function cmdInitProject(args) {
  const dir = path.resolve(String(args.dir || args.project || process.cwd()));
  const block = AGENTS_BLOCK;
  if (args.write) {
    const file = path.join(dir, 'AGENTS.md');
    let existing = '';
    if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (!existing.includes('Consensus referee (CTO consult)')) {
      const next = existing && !existing.endsWith('\n') ? `${existing}\n\n${block}` : `${existing}${existing ? '\n' : ''}${block}`;
      writeUtf8(file, next.endsWith('\n') ? next : `${next}\n`);
    }
    return { ok: true, written: file, block };
  }
  return { ok: true, block };
}
