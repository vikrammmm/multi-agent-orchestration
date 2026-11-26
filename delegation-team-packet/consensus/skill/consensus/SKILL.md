---
name: consensus
description: Two-CTO consensus, task sizing and the shared delegation rulebook. Use when a task is big or risky (many files; money, security, data or production paths; failing gates; irreversible steps), when the owner asks for a second opinion, a CTO opinion, a sign-off, or "consensus", before any nontrivial task (to size it), or before any nontrivial delegation. Also read this before handing work to helpers, because it points at the shared policy every agent on this machine follows.
---

# Consensus (two CTOs) and the shared rulebook

Installed for device profile `{{PROFILE}}` from the shared folder `{{SHARED_ROOT}}`.
The rulebook every agent on this machine follows is `{{SHARED_ROOT}}\POLICY.md` with the device
facts in `{{SHARED_ROOT}}\profiles\{{PROFILE}}.md`. Read both before any nontrivial task if you have
not already. If either is missing, say so and do not delegate from memory.

The referee program: `node "{{REFEREE}}" <command>`. Its ledger: `{{LEDGER}}`.
Check the seats on this machine at any time (no tokens spent): `node "{{REFEREE}}" doctor --human`.

## Are you a seat? Then stop here

If the environment variable `CONSENSUS_SEAT` is set, you are a headless reviewer inside a
consensus task. Do not run the referee, do not delegate, do not modify files. Answer the prompt you
were given with one JSON object and nothing else. The same applies when `DELEGATION_DISPATCHED` is
set: you are a dispatched worker and you have no owner to ask.

## What consensus is

Two top-tier models must agree the finish line before workers build, and both must sign off before
the task counts as done. One of them chairs (the session the owner started from); the other is a
headless read-only seat run by the referee. A neutral referee counts rounds, calls and time against
fixed limits and stops the task with a one-page split decision for the owner when they are reached.
Nothing runs in the background, and no model can extend its own budget.

Standard limits per task: 2 rounds to agree the finish line, 3 sign-off rounds, 15 calls (seat
calls plus logged worker jobs) and 4 hours in total, 45 minutes per seat call. Advise mode: at most
3 consultations per worker task, 6 seat calls per consultation.

## Who may chair, who is a seat

Roles come from the model and effort you are running, never from the vendor:

- Chair (Tier 1, CTO): Claude Opus 5.5 at high, xhigh or max (chair id `claude-opus-5.5`);
  GPT-6.2 Sol at xhigh or above (`gpt-6.2-sol`); GPT-6.1 Sol at xhigh or above
  (`gpt-6.1-sol`, reserve); Grok 4.7 at xhigh through Cursor (`grok-4.7`);
  Claude Opus 5 at xhigh or max (`claude-opus`, reserve). GPT-6 Astra and Claude Fable 5.1
  are retired and may not chair or sit. Below those efforts these models are Tech leads and may not chair; raise the
  effort or use advise mode. Exception: on a machine where no CTO-level model is usable at all
  (`doctor` shows no CTO seat), the session running the best available model may chair with the
  matching seat id (`gpt-6-sol`, `claude-sonnet-5`, `grok-4.6` or `gpt-5.6-sol`), labelled below
  CTO level.
- Seats (headless): the CTO seats `gpt-6.2-sol`, `claude-opus-5.5` (needs Claude Code 2.1.280 or
  later), `claude-opus`, `grok-4.7`, `gpt-6.1-sol` (reserve), and the fallback seats `gpt-6-sol`,
  `claude-sonnet-5`, `grok-4.6`, `gpt-5.6-sol` (Tech lead, used only when no CTO-level partner is
  usable). The referee always pairs two different models: a CTO first, then a different vendor,
  then a different family, then that order. You may name a seat with `--cochair` (it must be usable
  here and a different model from yours).
- Which seats are usable here follows one shared rule (the referee and the team installer use the
  same code): the seat's CLI is found and new enough (the route's and the seat's minimum
  versions), the seat is not blocked in `seats.json`, and this machine's `local.json` does not mark
  it `unavailable`. A seat marked `unverified` in `local.json` stays usable and is reported as not
  verified; `local.json` `disabled` switches consensus off (every command refuses with
  `CONSENSUS_DISABLED`; an unreadable `local.json` counts as disabled). `doctor` shows it all.
- The same model never fills both seats; a `-fast` variant counts as the same model
  (`SAME_MODEL`). Naming a seat that is not usable here is refused before any call:
  `SEAT_BLOCKED`, `SEAT_TOO_OLD` (update the CLI), `SEAT_NOT_HERE` (marked unavailable on this
  machine) or `SEAT_UNAVAILABLE` (CLI missing, or fewer than two different usable models).
- A task keeps its reviewers. A later `consult --task <id>` uses the same seats (naming other
  seats, the same seat twice or a pair on a one-seat task is refused), and `ask` refuses before any
  call if the assigned reviewer has since become
  unusable here; then fix the machine, or start a new task with `--continue-from <id>`.
- Grades: two CTOs from different vendors is standard; two CTOs from one vendor is lower grade
  (single vendor); a fallback seat makes it lower grade (below CTO level); one seat alone is a
  single reviewer. `start` and `consult` print the grade and any seat "not verified" on this
  machine: **tell the owner both in one plain sentence before the task goes on.**
- Everyone else (Sonnet, Haiku, GPT-6.2 Sol and GPT-6.1 Sol below extra-high, GPT-6 Sol,
  GPT-6 Luna, the GPT-5.6 models, Muse, Grok 4.6, Grok 4.7 below extra-high, Qwen) is a worker:
  use advise mode.
- If a seat fails because its account does not offer the model, the task pauses. Tell the owner;
  the person runs the packet installer with `--unavailable <model id>` and the chair starts a new
  task with `--continue-from <id>`. Never change the seats of a running task.

If you do not know which model and effort you are running, say so to the owner and use advise
mode; never claim a chair you cannot prove.

## Size the task first (trial)

Before any nontrivial task (tiny edits skip this), check the fixed triggers in the next section,
then ask the referee's cheap assessor to size the task, passing what the triggers said:

`node "{{REFEREE}}" assess --project "<repo>" --brief brief.md --rules-said suggest|no --triggers "<which fired, or none>"`

(or add `--detach`, then `node "{{REFEREE}}" wait --task <id>`; an assessment takes a minute or
two). It runs GPT-6 Luna, or Claude Sonnet 5.5 where Codex is missing (Sonnet 4.6 where Claude
Code is older than 2.1.284), read-only, and answers in a fixed form: a rating (simple, moderate or
complex), the danger areas it saw, the files it expects the change to touch, and the lowest tier
that can do the work.

- During the trial it changes nothing: the fixed triggers still decide, and the tier it suggests
  is advisory. Tell the owner in one plain sentence only when the assessor and the triggers
  disagree, and let the owner decide.
- When the task is finished, record what happened; outcomes are what the trial is judged on:
  `node "{{REFEREE}}" assess-outcome --task <id> --files-changed <n> --gate-failures <n> --consensus used|declined|not-suggested [--owner-view right|too-low|too-high]`.
- If the assessment fails, carry on with the fixed triggers; never retry it in a loop.
- `node "{{REFEREE}}" assess-report --human` shows the trial so far. After 20 recorded outcomes the
  owner, and only the owner, decides whether the assessment replaces the size trigger (8 or more
  files, more than one repository) and the unclear, contradictory or architectural trigger;
  reaching the count changes nothing by itself. The danger triggers (money, payments, security,
  credentials, personal data, production paths, irreversible steps, gates failed twice) stay fixed
  permanently.
- An assessor is never a seat or a chair, and seats and dispatched workers never run `assess`.

## When to suggest it (mechanical triggers, not a feeling)

Suggest consensus to the owner, in one plain sentence, when any of these is true; the owner may
decline, and may ask for it at any time regardless (during the sizing trial these still decide):

- the task will touch 8 or more files, or more than one repository;
- it touches money, payments, security, credentials, personal data, or production paths;
- the project's gates have failed twice on the same task;
- it includes irreversible steps (deletion, migration, release, sending, deployment);
- the requirements are unclear or contradictory, or the task is an architectural choice.

Small tasks stay as today.

## Full mode, when you chair

1. Start: `node "{{REFEREE}}" start --mode full --chair <your seat id> --project "<repo>" --goal goal.md`
   (write the owner's goal into `goal.md` first). Note the task id it prints.
2. Write `plan.md` and `checklist.md` into the task's `materials` folder (the path is in the
   start output). The checklist is numbered lines; each line is one checkable statement with the
   real gate command where one exists. It is the only finish line, so make it complete.
3. Seal your own verdict first, then ask the seat:
   `node "{{REFEREE}}" seal --task <id> --phase finish-line --file chair-verdict.json`
   `node "{{REFEREE}}" ask --task <id> --phase finish-line --detach` then
   `node "{{REFEREE}}" wait --task <id> --minutes 9` until it returns the verdict (a seat call can
   take up to 45 minutes; use your background-command facility for the wait).
   AGREE freezes the checklist. OBJECT: revise plan and checklist from the objections, seal round
   2, ask again. A second OBJECT ends the task with `reports\split-decision.md` for the owner.
4. Build with your normal helpers and lanes. Log every dispatch:
   `node "{{REFEREE}}" job --task <id> --lane <lane> --note "<what>"`.
5. Sign-off: put `diff.patch` and `tests.txt` (real gate output) into `materials`, seal
   `{"phase":"signoff","verdict":"DONE",...}`, then `ask --phase signoff --detach` and `wait`.
   Both DONE: the task is done and `reports\final.md` records the two keys; you land the change.
   NOT_DONE: fix the blocking items that cite a checklist line or a concrete defect, seal the next
   round, ask again. The referee stops after 3 rounds, or sooner when the same blocking items
   repeat, and writes the split decision.
6. Tell the owner the outcome in plain words and where the report is. Never call a task done on
   one key. Never bypass a refusal; a refused command means the limit was reached or the order
   was wrong, and the JSON says which.

Verdict files you seal: finish-line `{"phase":"finish-line","verdict":"AGREE","summary":"..."}`;
sign-off `{"phase":"signoff","verdict":"DONE","blocking":[],"later":[],"summary":"..."}` (or
`NOT_DONE` with blocking items citing `checklist_line` or `defect` plus `evidence`).

## Advise mode, when you are a worker

Write a short brief file: the task, what you plan or did, what you are unsure about, the paths.
Then:

`node "{{REFEREE}}" consult --project "<repo>" --brief brief.md --seats both --stage plan --detach`
(`--stage review` after the work; put `diff.patch` and `tests.txt` next to the brief), then
`node "{{REFEREE}}" wait --task <id> --minutes 9` until `reports\feedback.md` exists. Reuse the
task id with `--task <id>` for later consultations on the same job (at most 3). `--seats
claude-opus-5.5` or `--seats gpt-6.2-sol` asks one CTO only. When the two CTOs cannot agree you get
`reports\split.md`; hand it to the owner, who decides. The CTOs advise and review; they do not
decide when your task is finished unless the owner asked for a sign-off.

## What the referee will not do

It never edits project code, never runs as a service, never retries on its own, never raises a
limit, and never completes a task on one key. A paused task (seat unavailable, timeout, unusable
verdict twice, or `REFEREE_STOPPED`: the detached referee ended without a result) is rerun with
the same command after the cause is fixed; the failed calls stay counted.
