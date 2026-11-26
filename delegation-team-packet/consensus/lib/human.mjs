export function printHuman(obj) {
  if (!obj) {
    console.log('no result');
    return;
  }
  if (obj.help) {
    console.log(obj.help);
    return;
  }
  if (typeof obj.version === 'string' && obj.ok !== false && !obj.seats) {
    console.log(obj.version);
    return;
  }
  const lines = [];
  if (obj.ok === false) {
    lines.push(`REFUSED ${obj.code || obj.reason || 'ERROR'}: ${obj.message || obj.reason || ''}`.trim());
  } else if (obj.ok === true) {
    lines.push('ok');
  }
  if (obj.id) lines.push(`task ${obj.id}`);
  if (obj.state) lines.push(`state ${obj.state}`);
  if (obj.phase) lines.push(`phase ${obj.phase}`);
  if (obj.round != null) lines.push(`round ${obj.round}`);
  if (obj.verdict && obj.verdict.verdict) lines.push(`verdict ${obj.verdict.verdict}`);
  if (obj.report) lines.push(`report ${obj.report}`);
  if (obj.assessor && !obj.bestPair) lines.push(`assessor ${obj.assessor}`);
  if (obj.rating) lines.push(`rating ${obj.rating}; suggest consensus: ${obj.suggestConsensus}; tier: ${obj.suggestedTier}`);
  if (obj.trial && typeof obj.trial === 'object' && !obj.bestPair) lines.push(`trial: ${obj.trial.recorded} of ${obj.trial.trialTasks} outcomes recorded (complete: ${obj.trial.trialComplete})`);
  if (obj.outcome && obj.state === 'recorded') lines.push(`outcome ${JSON.stringify(obj.outcome)}`);
  if (obj.totals) {
    lines.push(`assessed ${obj.totals.assessed}; recorded ${obj.totals.recorded}; waiting ${obj.totals.waiting}; failed ${obj.totals.failed}`);
    lines.push(`misses ${obj.misses}; over-calls ${obj.overCalls}`);
  }
  if (obj.note && (obj.rating || obj.totals)) lines.push(obj.note);
  if (obj.materials) lines.push(`materials ${obj.materials}`);
  if (obj.detached) lines.push(`detached pid ${obj.pid}`);
  if (obj.status === 'pending') lines.push('still pending');
  if (obj.twoVendors != null) lines.push(`two vendors available: ${obj.twoVendors}`);
  if (obj.hostModeDisplay) lines.push(`host mode: ${obj.hostModeDisplay}`);
  else if (obj.hostMode) lines.push(`host mode: ${obj.hostMode}`);
  if (obj.hostModeProblem) lines.push(`host mode problem: ${obj.hostModeProblem}`);
  if (Array.isArray(obj.seats) && obj.seats[0] && obj.seats[0].id) {
    for (const s of obj.seats) {
      if (s.unverified) {
        lines.push(`seat ${s.id}: available, not verified: ${s.unverified}${s.version ? ` (${s.version})` : ''}`);
      } else {
        lines.push(`seat ${s.id}: ${s.available ? 'available' : 'unavailable'}${s.version ? ` (${s.version})` : ''}${s.reason ? ` - ${s.reason}` : ''}`);
      }
    }
  }
  if (obj.bestPair) {
    for (const a of obj.assessors || []) {
      lines.push(`assessor ${a.id}: ${a.available ? 'available' : 'unavailable'}${a.version ? ` (${a.version})` : ''}${a.reason ? ` - ${a.reason}` : ''}`);
    }
    const usable = (obj.assessors || []).filter((entry) => entry.available).map((entry) => entry.id);
    if (obj.assessor) lines.push(`assessor: ${obj.assessor} (fallback ${usable.find((id) => id !== obj.assessor) || 'none'})`);
    else lines.push(`assessor: none usable (${obj.disabled || (obj.assessors || []).map((entry) => entry.reason).filter(Boolean).join('; ') || 'none configured'})`);
    lines.push(`task sizing trial: ${obj.trial?.recorded || 0} of ${obj.trial?.trialTasks || 0} outcomes recorded`);
    const bp = obj.bestPair;
    if (Array.isArray(bp.seats) && bp.seats.length >= 2) {
      lines.push(`best pair: ${bp.seats[0]} + ${bp.seats[1]} (${bp.grade})`);
    } else {
      lines.push(`best pair: none (off: ${bp.note})`);
    }
  }
  if (obj.block && !obj.written) lines.push(obj.block);
  if (obj.written) lines.push(`wrote ${obj.written}`);
  if (Array.isArray(obj.tasks)) lines.push(`${obj.tasks.length} task(s)`);
  console.log(lines.filter(Boolean).join('\n'));
}
