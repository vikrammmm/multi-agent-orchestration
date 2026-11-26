import fs from 'node:fs';
import path from 'node:path';
import { readUtf8, writeUtf8 } from './fsx.mjs';
import { materialText, readSeal } from './ledger.mjs';
import { taskPaths } from './paths.mjs';

const TEST_LINE = 'TEST RUN: a fake seat was used; this is not a real consensus.';

function testBanner(ledger) {
  return ledger.test ? `${TEST_LINE}\n\n` : '';
}

export function gradeBanner(ledger) {
  if (!ledger) return '';
  let text = '';
  if (ledger.grade && ledger.grade.level && ledger.grade.level !== 'standard') {
    text += `${ledger.grade.note || ''}\n\n`;
  }
  const list = Array.isArray(ledger.unverified) ? ledger.unverified : [];
  for (const entry of list) {
    if (!entry || !entry.seat) continue;
    text += `Not verified on this machine: ${entry.seat} (${entry.reason})\n\n`;
  }
  return text;
}

function lastRound(ledger, phase) {
  const rows = (ledger.rounds || []).filter((r) => r.phase === phase);
  return rows[rows.length - 1] || null;
}

function elapsed(ledger) {
  const start = Date.parse(ledger.startedAt);
  const end = Date.parse(ledger.closedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown';
  const mins = Math.max(0, Math.round((end - start) / 60000));
  return `${mins} minutes`;
}

function countersBlock(ledger) {
  const c = ledger.counters;
  return [
    `- seat calls: ${c.seatCalls}`,
    `- worker jobs: ${c.workerJobs}`,
    `- finish-line rounds: ${c.finishLineRounds}`,
    `- sign-off rounds: ${c.signoffRounds}`,
    `- consultations: ${c.consultations}`,
    `- elapsed: ${elapsed(ledger)}`,
  ].join('\n');
}

export function writeSplitDecision(ledger) {
  const goal = materialText(ledger.id, 'goal.md') || '(no goal)';
  const fl = lastRound(ledger, 'finish-line');
  const so = lastRound(ledger, 'signoff');
  const flSeal = fl ? readSeal(ledger.id, 'finish-line', fl.round) : null;
  const soSeal = so ? readSeal(ledger.id, 'signoff', so.round) : null;
  const chair = soSeal || flSeal || {};
  const seat = (so && so.verdict) || (fl && fl.verdict) || {};
  const body = `${testBanner(ledger)}${gradeBanner(ledger)}# Split decision

Task: ${ledger.id}

## Goal

${goal}

## Where they disagree

Chair seal:

\`\`\`json
${JSON.stringify(chair, null, 2)}
\`\`\`

Co-CTO verdict:

\`\`\`json
${JSON.stringify(seat, null, 2)}
\`\`\`

## What is agreed

Points that appear in both summaries or that neither blocked stay available to the owner.

## Counters

${countersBlock(ledger)}

## Owner options

- Accept the chair's view and continue from there.
- Accept the co-CTO's view and continue from there.
- Start a continuation task: \`start --continue-from ${ledger.id}\`.
`;
  const file = path.join(taskPaths(ledger.id).reports, 'split-decision.md');
  writeUtf8(file, body);
  return file;
}

export function writeFinal(ledger) {
  const last = lastRound(ledger, 'signoff');
  const chair = last ? readSeal(ledger.id, 'signoff', last.round) : {};
  const seat = last?.verdict || {};
  const frozenFile = taskPaths(ledger.id).frozenChecklist;
  const frozen = fs.existsSync(frozenFile) ? readUtf8(frozenFile) : materialText(ledger.id, 'checklist.md');
  const tainted = (ledger.rounds || []).some((r) => r.tainted);
  const body = `${testBanner(ledger)}${gradeBanner(ledger)}# Final sign-off

Task: ${ledger.id}
Closed: ${ledger.closedAt || ''}

## Chair (DONE)

\`\`\`json
${JSON.stringify(chair, null, 2)}
\`\`\`

## Co-CTO (DONE)

\`\`\`json
${JSON.stringify(seat, null, 2)}
\`\`\`

## Frozen checklist

${frozen || '(missing)'}

## Counters

${countersBlock(ledger)}

Started: ${ledger.startedAt}
Deadline: ${ledger.deadlineAt}
Tainted calls: ${tainted ? 'yes' : 'no'}
`;
  const file = path.join(taskPaths(ledger.id).reports, 'final.md');
  writeUtf8(file, body);
  return file;
}

export function writeFeedback(ledger, text) {
  const body = `${testBanner(ledger)}${gradeBanner(ledger)}# Consultation feedback

Task: ${ledger.id}

${text || ''}
`;
  const file = path.join(taskPaths(ledger.id).reports, 'feedback.md');
  writeUtf8(file, body);
  return file;
}

export function writeSplitConsult(ledger, { draft, confirm, answers }) {
  const disputed = (draft && draft.disputed) || [];
  const dropped = (draft && draft.dropped) || [];
  const objections = (confirm && confirm.objections) || [];
  const body = `${testBanner(ledger)}${gradeBanner(ledger)}# Consultation split

Task: ${ledger.id}

The two seats could not confirm one unified feedback.

## Unified draft (last)

${(draft && draft.unified_feedback) || '(none)'}

## Dropped

${dropped.length ? dropped.map((d) => `- ${d}`).join('\n') : '- (none)'}

## Disputed

${disputed.length ? disputed.map((d) => `- ${d.point}: A: ${d.seat_a} / B: ${d.seat_b}`).join('\n') : '- (none)'}

## Confirm objections

${objections.length ? objections.map((o) => `- ${o}`).join('\n') : '- (none)'}

The raw seat answers are in \`reports/split-raw.md\` for the owner only; a worker acts on this
file, never on the raw answers.
`;
  const raw = `${testBanner(ledger)}${gradeBanner(ledger)}# Consultation split: raw seat answers (owner only)

Task: ${ledger.id}

Seat A:

\`\`\`json
${JSON.stringify(answers?.[0] || {}, null, 2)}
\`\`\`

Seat B:

\`\`\`json
${JSON.stringify(answers?.[1] || {}, null, 2)}
\`\`\`
`;
  writeUtf8(path.join(taskPaths(ledger.id).reports, 'split-raw.md'), raw);
  const file = path.join(taskPaths(ledger.id).reports, 'split.md');
  writeUtf8(file, body);
  return file;
}

export function formatConsultFeedback(verdict) {
  if (!verdict) return '(no verdict)';
  if (verdict.unified_feedback) return verdict.unified_feedback;
  const risks = (verdict.risks || []).map((r) => `- (${r.severity}) ${r.risk} @ ${r.where}`).join('\n');
  const recs = (verdict.recommendations || []).map((r) => `- [${r.priority}] ${r.what} — ${r.why}`).join('\n');
  const qs = (verdict.questions_for_owner || []).map((q) => `- ${q}`).join('\n');
  return `## Assessment\n\n${verdict.assessment || ''}\n\n## Risks\n\n${risks || '- (none)'}\n\n## Recommendations\n\n${recs || '- (none)'}\n\n## Questions for the owner\n\n${qs || '- (none)'}\n\n## Summary\n\n${verdict.summary || ''}\n`;
}
