# Consensus referee: specification (v0.3)

This file is the design contract for the
referee program and the work order for whoever implements it. Plain-language rules live in
`POLICY.md` (section "Consensus mode"); this file holds the mechanics.

## 1. Purpose

Two top-tier models ("CTOs") must agree a task's finish line before workers build, and both must
sign off before the task counts as finished. A neutral program, the referee, owns the ledger, the
counters, the timers and the report formats, so the limits are identical no matter which agent
starts the task. The referee never edits project code and never runs in the background as a
service. On a desktop machine, when the limits are reached it stops and hands the owner a
one-page split decision. On a server machine, where nobody answers, the chair decides after the
limit and the task moves forward anyway (sections 1b and 8b).

## 1b. Host mode (desktop / server)

The machine-marks file the referee already reads (`loadLocalJson()` in `lib/paths.mjs`, the
runtime `local.json`) carries a key `hostMode` with value `"desktop"` or `"server"`. The team
installer writes it. A missing file or a missing key means `desktop`. No command-line flag and no
environment variable can set or change the host mode. It is a machine setting, like the rule that
no command can raise a limit.

Any other value is invalid. Then `start` and a `consult` that would create a new task refuse with
code `BAD_HOST_MODE` (exit 2, the same refusal mechanism as other refusals) and a plain message
to run the team installer again. A `consult` that reuses a task (`--task`) uses the mode the task
started with and does not check the file. `assess` ignores host mode entirely.

GPT-6.2 Sol is the primary GPT CTO; GPT-6.1 Sol remains an active tier 1 reserve.

## 2. Where it lives and runs

- Source (edited here only): `src\consensus\` (this folder).
- Installed runtime (byte copy made by the team packet installer; never edited directly):
  `%USERPROFILE%\.config\delegate-skills\consensus\` on Windows,
  `$HOME/.config/delegate-skills/consensus/` elsewhere. Reason: Muse's sandbox cannot run Node
  from a Google Drive mount, and the team rollout ships releases, not a synced folder.
- Ledger root (data): `%USERPROFILE%\.config\delegate-skills\consensus-ledger\` (override with
  env `CONSENSUS_LEDGER`). Never inside a project, so a seat cannot read the other seat's verdict.
- Entry point: `node <runtime>\referee.mjs <command> [options]`. Node 18 or newer, built-in
  modules only, no dependencies, no machine-specific paths in the code. Binaries are found on
  PATH; `local.json` (installed, not synced) may override a binary path per seat.

## 3. Seats

A seat is one headless, read-only reviewer. Seats are declared in `seats.json` (each with a
`family`, a `label` and a `tier`); five are CTO seats (tier 1) and four are fallback seats below
CTO level (tier 2, Tech lead), used only when no CTO-level partner is usable. GPT-6.1 Sol replaces GPT-6 Astra;
Claude Opus 5.5 replaces Claude Fable 5.1. Retired seat IDs `gpt-astra` and `claude-fable` are
listed under `retired` in `seats.json`. Naming either refuses with `NO_SEAT` and a retired message.
Tasks that used either continue only as new tasks with `start --continue-from`.

| Seat id | Vendor | Route | Model | Effort | Lock | Role |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-sol` | OpenAI | codex | `gpt-6-sol` | xhigh | firm (as `gpt-6.2-sol`) | fallback, Tech lead |
| `claude-sonnet-5` | Anthropic | claude-code | `claude-sonnet-5` | xhigh | firm (as `claude-opus-5.5`) | fallback, Tech lead |
| `grok-4.6` | xAI | cursor | `cursor-grok-4.6-xhigh` | xhigh | copy (as `grok-4.7`) | fallback, Tech lead, for Cursor plans without Grok 4.7 |
| `gpt-5.6-sol` | OpenAI | codex | `gpt-5.6-sol` | xhigh | firm (as `gpt-6.2-sol`) | fallback, Tech lead, for Codex without GPT-6 |
| `gpt-6.2-sol` | OpenAI | codex | `gpt-6.2-sol` | xhigh | firm: read-only sandbox (no writes) | primary GPT seat |
| `gpt-6.1-sol` | OpenAI | codex | `gpt-6.1-sol` | xhigh | firm: read-only sandbox (no writes) | reserve GPT co-CTO where GPT-6.2 Sol is unavailable |
| `grok-4.7` | xAI | cursor | `grok-4.7-xhigh` | xhigh (highest offered) | copy: runs in a disposable copy of the project in plan mode, integrity check of the real project before and after | backup seat |
| `claude-opus-5.5` | Anthropic | claude-code | `claude-opus-5-5` | xhigh (CTO at high or above) | firm: tool allow-list, no shell, no network, no subagents, no MCP | first-choice Claude seat; needs Claude Code 2.1.280 or later |
| `claude-opus` | Anthropic | claude-code | `claude-opus-5` | xhigh | firm (as above) | reserve: the Claude seat and drafter where Claude Code is older than 2.1.280, and Opus 5.5's partner on Claude-only machines |

Rules enforced by the referee (the rule lives in `lib\select.mjs`,
which has no imports so the team packet's installer uses the very same code):
- **Eligibility.** A seat is usable when it is known and seat-eligible, not `blocked`, its CLI is
  found (on PATH or through `local.json` `binaries`), the CLI's `--version` meets the route's
  `minVersion` and the seat's own `minVersion`, and `local.json` does not mark it `unavailable`.
  An unreadable version or a `local.json` `unverified` note keeps the seat usable but marks it
  "not verified". No tokens are spent to check. `isAvailable`, `doctor` and every pick use this one
  rule.
- **Pairs.** A pair is always two different models: the same model identity (the model id without
  a trailing `-fast`, or a seat's explicit `identity`) never fills both seats. Automatic picks
  (`start` without `--cochair`, `consult --seats both`) rank usable seats by tier (CTO first), then
  a different vendor from the partner, then a different family, then `preferenceOrder`. With fewer
  than two different usable models, `start` and `consult --seats both` refuse with
  `SEAT_UNAVAILABLE` before any seat call.
- **Named seats.** `--cochair` and `--seats` accept a same-vendor seat (graded single vendor) but
  refuse, before any seat call, the same model twice (`SAME_MODEL`), a blocked seat
  (`SEAT_BLOCKED`), a CLI that is too old (`SEAT_TOO_OLD`), a seat marked unavailable on this
  machine (`SEAT_NOT_HERE`) and a missing CLI (`SEAT_UNAVAILABLE`). A single named seat
  (`consult --seats <one>`) is allowed and graded single reviewer.
- **Grades.** Two CTOs from different vendors: standard. Two CTOs from one vendor: lower grade,
  single vendor. Any seat below CTO: lower grade, below CTO level. One seat: single reviewer, never
  a consensus. `start` and `consult` return the grade (`grade`, and `gradeNote` when not standard)
  and the not-verified seats (`unverified`); the ledger stores both; every report begins with the
  grade note and the not-verified lines (after the TEST banner). The chair tells the person the
  grade and any not-verified seat before the task starts.
- **`local.json`** (per machine, next to `seats.json`, written by the team installer, absent before
  the team installer runs): `binaries` (path overrides), `seats.<id>.unavailable` (the account does not
  offer the model: unusable, reported by `doctor`), `seats.<id>.unverified` (usable, reported), and
  `disabled` (consensus off on this machine: `doctor` says so and `start`, `consult` and `ask`
  refuse with `CONSENSUS_DISABLED`). A `local.json` that exists but cannot be read, or is not a
  JSON object, counts as `disabled` with the reason (fail closed).
- **Who may chair.** A CTO-level model at its CTO effort (`chairEligible` seats). Exception: on a
  machine where no CTO-level seat is usable (`doctor` shows none), the session running the best
  available model may chair with the matching fallback seat id (`gpt-6-sol`, `claude-sonnet-5`,
  `grok-4.6` or `gpt-5.6-sol`); the pair is then graded below CTO level.
- **A task keeps its reviewers.** Before every seat call of an existing task (`ask`, each
  consultation) the assigned seat is checked with the eligibility rule and refused before the call
  (`SEAT_*`, `CONSENSUS_DISABLED`) if it is no longer usable here; it is never replaced. A later
  `consult --task <id>` uses the seats the task started with (naming other seats is `BAD_ARGS`,
  the same seat twice `SAME_MODEL`, and `--seats both` on a one-seat task `SEAT_UNAVAILABLE`)
  and stores that consultation's grade and not-verified seats on the ledger and in its record, so
  its answer and report describe that consultation.
- **When a seat's model turns out to be missing** at call time, the call fails and the task pauses
  (as for any unavailable seat). The seat is then blocked in `seats.json` (owner) or declared with
  the team installer's `--unavailable` (person installing), and the chair starts a new task with
  `--continue-from`; the seats of a running task are never changed.
- Every seat call gets a 45-minute watchdog (`seatCallMinutes`); on expiry the process tree is
  killed (`taskkill /T /F` on Windows, process-group kill elsewhere) and the call is recorded as
  failed. Failed calls count against the budget. A seat process that does not exit never holds a
  call open: once the seat's declared output (codex
  `final.txt`, the claude-code or cursor result object) holds a valid verdict, the process gets 20
  seconds to exit and then its tree is killed and the call counts as answered; after any kill, or
  after the process exits while something it left behind keeps the output pipes open, the referee
  waits at most 5 seconds for the pipes and then stops reading them. Section 10, guard 5.
- Seat child processes get `CONSENSUS_SEAT=1` and `CONSENSUS_TASK_ID=<id>` in their environment
  and have `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `XAI_API_KEY` and
  `MUSE_API_KEY` removed (matched without regard to letter case), so a seat always bills the
  subscription login, never an API key.
- Fake seats `fake:<behaviour>` exist for tests only; a task that used one is stamped `TEST` in
  every report.
- A seat may carry `blocked: "<reason>"` in `seats.json` while its CLI cannot run it (for
  example a model the installed CLI does not recognize yet). `doctor` reports it unavailable with
  that reason, automatic seat picking skips it, and naming it with `--cochair` or `--seats`
  refuses with `SEAT_BLOCKED`. The field is removed once the cause is fixed and retested.
- A seat may carry `minVersion: "<x.y.z>"`, the oldest CLI build that knows its model (`doctor`
  checks it with `--version`, no tokens): an older CLI makes the seat unavailable with the reason
  "update the CLI", automatic picking skips it, and naming it refuses with `SEAT_TOO_OLD`. The
  seat comes back by itself once the CLI is updated.

Seat adapters follow `ADAPTERS.md` exactly. Summary:

- `claude-code`: `claude -p` with the prompt as the argument, `--model`, `--effort xhigh`,
  `--output-format json`, `--tools "Read,Glob,Grep"` (no Bash, no Edit or Write, no WebFetch or
  WebSearch, no Agent), an empty strict MCP config so no MCP tools load, `--max-budget-usd` as a
  second ceiling, working directory = project.
- `codex`: `codex exec` with `-m gpt-6.2-sol`, `-c model_reasoning_effort=xhigh`, `-s read-only`,
  `--output-schema <schema file>`, `-o <last-message file>`, `-C <project>`,
  `--skip-git-repo-check`. Later rounds in the same task use `codex exec resume <session id>`
  (with `-c sandbox_mode=read-only`, since `resume` takes no `-s` or `-C`) when a session id was
  captured; otherwise a fresh call with the full materials. The claude-code and cursor routes never
  resume across rounds; they get `--resume` only on the JSON retry of the same call. On Windows the
  `WindowsApps` entries are stripped from PATH for the sandboxed child (the relay does the same).
- `cursor`: `cursor-agent -p` with `--model grok-4.7-xhigh`, `--mode plan`, `--output-format json`,
  `--workspace <copy>` where the copy is the disposable copy of the project
  (`<ledger>\tasks\<id>\calls\<n>\copy\`), materials copied into the copy under `.consensus\`.
  The copy excludes `.git`, `node_modules`, `.venv`, `venv`, `dist`, `build`, `target`,
  `__pycache__`, `.consensus*`; it is deleted after the call unless `--keep-copy` is given.

Before and after every seat call (all routes) the referee takes an integrity manifest of the real
project (relative path, size, mtime for every file outside the excluded folders); any difference
marks the call `tainted: true`, logs an event, and the verdict is still recorded but reported as
tainted.

## 4. Limits ("standard" and "server", in `limits.json`)

| Limit | standard | server |
| --- | --- | --- |
| Finish-line rounds per full task | 2 | 3 |
| Sign-off rounds per full task | 3 | 3 |
| Total calls per full task (seat calls + logged worker jobs) | 15 | 15 |
| Total elapsed time per full task | 4 hours from `start` | 4 hours from `start` |
| Minutes per seat call | 45 | 45 |
| Merge rounds per consultation | 2 | 2 |
| Seat calls per consultation | 6 | 6 |
| Consultations per worker task | 3 | 3 |
| No-progress rule | identical blocking set in two consecutive sign-off rounds ends the task | same as standard |

A server-mode task copies the `server` table into `ledger.limits`; a desktop task copies
`standard` as before. The table is chosen by host mode, never by a flag. `--limits` values other
than `standard` are still refused.

No command can raise a limit for an existing task. There is no `extend`; a stopped task can be
carried into a new task with `start --continue-from <id>` (copies the frozen checklist and the
last materials; the new task has a fresh budget, and the ledger links both so the owner sees it).

## 5. Ledger layout

```
<ledger>\index.json                         list of tasks (id, mode, state, chair, cochair, project, startedAt)
<ledger>\tasks\<id>\ledger.json             the task record (see below), rewritten atomically (temp file + rename)
<ledger>\tasks\<id>\events.jsonl            append-only log: {"at","event","data"}
<ledger>\tasks\<id>\materials\              what the chair supplies: goal.md, plan.md, checklist.md, diff.patch, tests.txt, ...
<ledger>\tasks\<id>\frozen\checklist.md     copy taken when the finish line was agreed
<ledger>\tasks\<id>\seals\<phase>-<round>.json   the chair's sealed verdict per round
<ledger>\tasks\<id>\calls\<n>\              one folder per seat call: prompt.md, stdout.txt, stderr.txt, verdict.json, meta.json, materials\ (snapshot), copy\ (cursor only, deleted after)
<ledger>\tasks\<id>\reports\                split-decision.md, final.md, feedback.md, split.md, split-raw.md, chair-decision.md (server only)
<ledger>\tasks\<id>\pending.json            present while a detached call is running: {pid, command, startedAt}
```

`ledger.json` fields: `id`, `version`, `mode` (`full` | `advise`), `state`, `test` (true when a fake
seat was used), `project` (absolute path), `chair` (seat id claimed by the session), `cochair`,
`startedAt`, `deadlineAt`, `limits` (the standard table copied in), `counters` {`seatCalls`,
`workerJobs`, `finishLineRounds`, `signoffRounds`, `consultations`}, `checklistHash` (sha256 of
the frozen checklist, null until frozen), `rounds` [ {`phase`, `round`, `sealHash`, `callIndex`,
`verdict`, `tainted`, `blockingKey`} ], `consultations` [ {`n`, `seats`, `calls`, `mergeRounds`,
`outcome`} ], `continuedFrom`, `closedAt`, `outcome`, `outcomeReason`, `grade` {`level`
(`standard` | `single-vendor` | `below-cto` | `single-reviewer`), `note`} and `unverified`
[ {`seat`, `reason`} ] (older ledgers without these fields read as standard, with no unverified seats).
`hostMode` (`desktop` | `server`, full and advise tasks) records the mode the task started with;
a task keeps it even if `local.json` changes later, and older ledgers without it read as
`desktop`. `chairDecided` lists each chair decision
[ {`phase`, `round`, `reason`, `at`} ] (server only, empty otherwise). `chairVerdict` holds the
chair's last sealed sign-off verdict (`DONE` | `NOT_DONE`) when a server task closed `decided`.

Task id: `YYYYMMDD-HHMM-xxxx` (4 random base32 characters). Task ids are printed on `start` and
`consult` and must be passed to every later command. An id that is not a plain name (letters,
digits, dot, dash, underscore; no `..`) is refused with `BAD_TASK_ID`.

## 6. Task states

Full mode: `finish-line` → `frozen` → `signoff` → `done` | `split` | `paused` | `abandoned`.
Server full mode adds a closed state `decided`: the chair's judgment after the limit.
Advise mode: `open` → `answered` | `split` | `paused` | `abandoned`.
`decided` is closed everywhere `done` and `split` are: `isClosed`, `list --open`, `nextStep`
(returns null), `close` refusing an already closed task, and the index.
`paused` means a seat was unavailable, timed out, or returned an unusable verdict twice; the
chair or owner reruns the same command after fixing the cause (the failed calls stay counted).

## 7. Commands

All commands print one JSON object on stdout (`{"ok":true|false, ...}`) and exit 0 on success, 2 on
a refusal (limit, guard, wrong state, missing seal), 1 on an internal error. `--json` is the default;
`--human` prints a short readable summary instead.

| Command | What it does |
| --- | --- |
| `start --mode full --chair <seat> --project <dir> --goal <file> [--cochair <seat>] [--limits standard] [--continue-from <id>]` | creates the task and its ledger, copies the goal into `materials\goal.md`, prints the id, the co-CTO, `hostMode`, `grade` (with `gradeNote` when not standard) and `unverified`; refuses per section 3 (`CONSENSUS_DISABLED`, `SAME_MODEL`, `SEAT_*`) before creating anything; an invalid `hostMode` in `local.json` refuses with `BAD_HOST_MODE` |
| `seal --task <id> --phase finish-line\|signoff --file <chair verdict json>` | records the chair's verdict for the next round before the co-CTO is asked; refuses if the round already has a seal or the state is wrong |
| `ask --task <id> --phase finish-line\|signoff [--detach] [--keep-copy]` | runs the co-CTO seat for the current round with the current `materials\`; enforces every limit; records and returns the verdict; transitions the state |
| `job --task <id> --lane <lane> --note <text>` | logs a worker dispatch against the call budget; refuses when the budget is exhausted |
| `consult --project <dir> --brief <file> --seats both\|<seat>[,<seat>] [--task <id>] [--stage plan\|review] [--detach]` | advise mode for worker-started sessions; creates or reuses an advise task, runs the seats, writes `feedback.md` or `split.md`; returns `hostMode`, `grade` (two different models, or `single-reviewer` for one named seat) and `unverified`; `both` with fewer than two different usable models refuses before any seat call; a new task with an invalid `hostMode` refuses with `BAD_HOST_MODE` |
| `wait --task <id> [--minutes 9]` | blocks until a detached call finishes or the minutes elapse; returns the call result or `{"status":"pending"}`; when the detached referee is gone without printing a result, `REFEREE_STOPPED` and the task is paused (an assessment: `failed`) |
| `status --task <id>` | the ledger summary: state, `hostMode`, counters, deadline, last verdict, next step; collects a detached referee that has ended, as `wait` does |
| `list [--open]` | the task index |
| `close --task <id> --outcome abandoned --reason <text>` | the only manual close; `done`, `split` and `decided` are set by the referee itself |
| `doctor` | checks Node, the ledger folder, and each seat by the eligibility rule of section 3 (reporting the reason, the seat's `tier`, `family` and any not-verified note), login status where the CLI exposes it without spending tokens; reports `disabled` and the `bestPair` (the pair `consult --seats both` would use, with its grade, or `off`); reports the host mode (`hostMode`, `hostModeDisplay`, and `hostModeProblem` when invalid); `--human` prints one line per seat, a host-mode line and a best-pair line |
| `init-project [--dir <project>] [--write]` | prints (or with `--write`, appends to the project's `AGENTS.md`) the short block that tells Cursor and Muse sessions in that project how to consult the CTOs |
| `--version` | prints the runtime version and the installed source stamp |

Detach: `--detach` re-spawns the same command without `--detach`, detached, with stdout and
stderr redirected into the call folder, writes `pending.json`, and returns at once. The child is a
one-shot process that ends with the seat call; it is not a service and nothing restarts it. If it
ends without printing its result (it crashed or was stopped by hand), the next `wait` or `status`
logs `referee_stopped` and records the cut-off call as failed: an `ask` or `consult` task in
progress is paused with reason `REFEREE_STOPPED`, an open assessment closes as `failed`, and a task
already past that point is left as it is. A task never stays silently pending.
Chairs whose shell tool has a short timeout (Claude Code's is 10 minutes) use `--detach` and then
`wait`. `ask` and `consult` refuse to start while `pending.json` exists for the task.

## 8. Full mode, exact flow

1. `start`. State `finish-line`. `deadlineAt = startedAt + totalHours`. Counters zero.
2. The chair writes `materials\plan.md` and `materials\checklist.md` (numbered lines; each line a
   checkable statement, with the real gate command where one exists), then `seal --phase
   finish-line` with `{"phase":"finish-line","verdict":"AGREE","summary":"..."}`.
3. `ask --phase finish-line`, round n (n = finishLineRounds + 1). Refused when: n exceeds the
   finish-line limit (2 on desktop, 3 on server), deadline
   passed, seatCalls + workerJobs >= totalCalls, no seal for round n, state not `finish-line`,
   `pending.json` present, or a guard in section 10 trips. The seat receives goal, plan,
   checklist and read access to the project, never the chair's seal. Verdict `AGREE` → state
   `frozen`, the frozen checklist written, `checklistHash` recorded. Verdict `OBJECT` before the
   last round →
   the chair revises plan and checklist (objections and `checklist_additions` are the input),
   seals the next round, asks again. `OBJECT` at the last round → desktop: state `split` with
   the split decision; server: section 8b.
4. Building. The chair dispatches workers through its normal lanes and logs each with `job`. The
   co-CTO may have listed `worker_jobs_requested`; the chair decides whether to run them; they
   count when logged like any job.
5. Sign-off round n (n = signoffRounds + 1). The chair updates `materials\` (at least
   `diff.patch` and `tests.txt`; `checklist.md` must still hash to `checklistHash`, otherwise
   `ask` refuses with `CHECKLIST_CHANGED`), seals `{"phase":"signoff","verdict":"DONE"|"NOT_DONE",
   "blocking":[...],"later":[...],"summary":"..."}`, then `ask --phase signoff`. The seat receives
   the frozen checklist, the diff, the test output and read access to the project.
6. Both seals DONE (chair's seal for round n and the seat's verdict) → state `done`,
   with the final report. Otherwise: if the seat's normalized blocking set equals the previous
   round's → desktop `split` (no progress), server section 8b. Else if n reaches the sign-off
   limit (3) → desktop `split`, server section 8b. Else the chair fixes, seals
   round n + 1, asks again.
7. Any refusal for a limit (`LIMIT_ROUNDS`, `LIMIT_CALLS`, `LIMIT_TIME`) writes
   the split decision and sets `split` on desktop, or writes the chair decision and sets
   `decided` on server (section 8b), if the task was not already closed. The command still
   refuses with the same code and exit code; on server its JSON says `state: "decided"` and
   gives the report path.

## 8b. Server mode: the chair decides after the limit

Nobody answers on a server machine, so the task moves forward on the chair's judgment. Server
text never addresses an owner.

- Finish line: `AGREE` freezes as on desktop. `OBJECT` before the last round (rounds 1-2):
  as on desktop. `OBJECT` at the last round (round 3): the chair's current checklist freezes
  with the same routine `AGREE` uses (checklist hash, frozen copy), state `frozen`, a
  `chairDecided` entry `{phase:"finish-line", round, reason:"finish-line OBJECT at last round",
  at}`, `reports/chair-decision.md`, and a `chair-decision` event. The ask result carries
  `chairDecided: true` and the report path. Work and sign-off then proceed normally.
- Sign-off: both `DONE` closes `done` as on desktop, and `final.md` also says when the finish
  line was chair-decided. Where desktop would close `split` (identical blocking set in two
  consecutive rounds, or sign-off rounds exhausted), server mode closes `decided` with
  `outcome: "decided"`, the same reason text desktop uses, `chairVerdict` set to the chair's
  last sealed sign-off verdict (`DONE` or `NOT_DONE`), a `chairDecided` entry, and
  `reports/chair-decision.md`.
- Limits (time, total calls): every place that writes a split decision and closes `split`
  on desktop (`splitLimit`, the cap check in `cmdJob`) closes `decided` on server instead,
  with `outcomeReason` set to the limit code and `reports/chair-decision.md` written.

Normalized blocking key: for each blocking item, `checklist_line` if present else the first 80
characters of `defect` lower-cased and whitespace-collapsed; sorted; joined with `|`.

## 9. Advise mode, exact flow

1. `consult` with `--seats both` (default: the best two different usable models, by the rule of
   section 3; fewer than two refuses before any seat call), or named seats (two different models,
   or one seat, graded single reviewer). A worker-started session (Muse, Cursor,
   Codex on a non-CTO model, Claude on Sonnet or Haiku) writes a brief: what the task is, what it plans or
   did, what it is unsure about, the relevant paths. `--stage plan` asks for advice before work;
   `--stage review` asks for a review of work done (brief plus `diff.patch` and `tests.txt` in the
   same folder as the brief are picked up automatically).
2. New advise task (or reuse with `--task`): `consultations` + 1 must be ≤ 3, else refused.
3. Independent calls to each requested seat in parallel with the `consult` schema; neither sees
   the other. One seat: `reports\feedback.md` is that seat's answer; state `answered`.
4. Two seats: merge round 1: the drafting seat (the first in `--seats`; for `both`, the first
   seat listed in `consultDraftingSeat` in `seats.json` that was picked, with `claude-opus-5.5` first
   and then `claude-opus`; the field may also be a single seat id, and `claude-opus-5.5` is the
   default when it is missing; when no listed seat was picked, the first picked seat drafts)
   receives both answers and returns a `merge` verdict with one unified feedback text, the points
   it dropped and the points in dispute; the confirming seat receives the brief and the draft and
   returns `confirm` (`CONFIRM` | `OBJECT` with objections). `CONFIRM` → `feedback.md`, state
   `answered`. `OBJECT` → merge round 2 (draft revised with the objections, confirm again).
   `OBJECT` again, or the sixth seat call spent, including JSON retries →
   `reports\split.md` with the agreed points and the disputed points; state `split`; on desktop
   the owner decides, on server the worker decides (section 9b).
5. The worker never receives the raw seat answers, only `feedback.md` or `split.md`.

## 9b. Advise mode on server: wording only

States and outcomes stay as they are. The advisers never decide in advise mode. Only report
wording changes in `split.md`: it tells the worker that no person will settle this, to weigh
both positions, decide, and say plainly in its result that the reviewers disagreed. The line
that keeps raw answers "for the owner only" says "kept for the record" instead. The feedback
heading "Questions for the owner" reads "Open questions (decide them yourself)". Server text
never addresses an owner.

## 10. Guards (all mechanical)

1. Recursion: every command that spends tokens (`ask`, `consult`) refuses when `CONSENSUS_SEAT` or
   `DELEGATION_DISPATCHED` is set in its own environment (a seat, or a dispatched worker, is
   trying to consult). `start` refuses when `CONSENSUS_TASK_ID` is set (a nested task).
2. Frozen finish line: after `frozen`, `checklist.md` must hash to `checklistHash` for every
   later command that reads it.
3. Order: `ask` needs a seal for its round; a round can be sealed once.
4. Budget: counters are incremented before a seat is launched, so a crash still counts. The JSON
   retry is a seat call: it is not attempted when the call budget is at its cap.
5. Watchdog: per-call timer, process-tree kill, call recorded as `timeout`. The test override
   `CONSENSUS_SEAT_TIMEOUT_MS` can only shorten the timer. The adapter may declare when its output
   is complete; a valid verdict there ends the call 20 seconds later even if the process is still
   running (tree killed, call `completed`; also when the watchdog expires first). After a kill, or
   after an exit while the output pipes stay open, the referee stops reading the pipes 5 seconds
   later, so no process can hold a call open. `meta.json` records `endedBy` (`exit`,
   `output-ready`, `exit-pipes-held`, `timeout`, `spawn-error`, `adapter-deadline`) and every
   ending other than `exit` is logged as `call_forced_end`. As a last resort an adapter that has
   not returned after twice the watchdog plus two minutes ends the call as `timeout` (`endedBy`
   `adapter-deadline`), and one that throws is a `failed` call; either way the task pauses, but
   a process that adapter still owns is not stopped. The test override
   `CONSENSUS_SEAT_SETTLE_MS` can only shorten the 20 seconds.
6. Unusable verdict: not JSON, or JSON failing the schema (for `signoff`, a `NOT_DONE` with no
   blocking item that cites a checklist line or gives both `defect` and `evidence` is unusable) →
   one retry with the compliance reminder (counted); a second failure → state `paused`, reason
   `INVALID_VERDICT`, raw output kept in the call folder.
7. Seat unavailable (binary missing, non-zero exit without a verdict, login error or rate-limit
   text in an output that is not a valid verdict) → `paused`, reason recorded; never a single-key
   completion. A verdict that validates stands even when its own text mentions limits or logins.
8. Integrity: manifest before and after every seat call; differences mark the call tainted.
9. Concurrency: one call at a time per task (`pending.json` lock); stale locks (pid not alive)
   are cleared with an event.
10. Nothing in the background beyond the one-shot detached call: no service, schedule or restart.

## 11. Verdict schemas (JSON; `schemas\*.schema.json`, also embedded in the prompts)

finish-line: `{"phase":"finish-line","verdict":"AGREE"|"OBJECT","objections":[{"target":"goal"|"plan"|"checklist","item":"<line number or section>","problem":"...","proposed_fix":"..."}],"checklist_additions":["..."],"worker_jobs_requested":[{"what":"...","why":"..."}],"later":["..."],"summary":"..."}`
signoff: `{"phase":"signoff","verdict":"DONE"|"NOT_DONE","blocking":[{"checklist_line":<int|null>,"defect":"...","evidence":"..."}],"later":["..."],"summary":"..."}`
consult: `{"phase":"consult","assessment":"...","risks":[{"risk":"...","severity":"high"|"medium"|"low","where":"..."}],"recommendations":[{"priority":"must"|"should"|"could","what":"...","why":"..."}],"questions_for_owner":["..."],"summary":"..."}`
merge: `{"phase":"merge","unified_feedback":"<markdown>","dropped":["..."],"disputed":[{"point":"...","seat_a":"...","seat_b":"..."}]}`
confirm: `{"phase":"confirm","verdict":"CONFIRM"|"OBJECT","objections":["..."],"summary":"..."}`

Validation is structural (required keys, enum values, types) and done in `lib/schema.mjs` without
a library; keys the schema does not declare are dropped from the recorded verdict rather than
rejected. The parser accepts a bare JSON object, a fenced ```json block, or the last `{...}` block
in the output, in that order.

## 12. Prompts

`prompts\finish-line.md`, `prompts\signoff.md`, `prompts\consult.md`, `prompts\merge.md`,
`prompts\confirm.md`, `prompts\retry-json.md`. Placeholders: `{{GOAL}}`, `{{PLAN}}`,
`{{CHECKLIST}}`, `{{DIFF}}`, `{{TESTS}}`, `{{BRIEF}}`, `{{ANSWER_A}}`, `{{ANSWER_B}}`, `{{DRAFT}}`,
`{{OBJECTIONS}}`, `{{SCHEMA}}`, `{{PROJECT}}`, `{{MATERIALS_DIR}}`. Materials larger than 150 KB are
not inlined; the prompt then gives the path. Every prompt states: read-only reviewer, never
delegate, never run the referee, never modify files, answer with one JSON object only.

## 13. Reports (markdown, plain language, one page)

- `split-decision.md`: goal; where they disagree (last chair seal and last seat verdict side by
  side); what is agreed; counters and elapsed time; the owner's options (accept the chair's view,
  accept the co-CTO's, start a continuation task).
- `final.md`: the two DONE verdicts, the frozen checklist, counters, timestamps, tainted flags.
  It also says when the finish line was chair-decided.
- `feedback.md` / `split.md`: for consultations; the raw seat answers of a split go to
  `split-raw.md`, for the owner only on desktop, kept for the record on server.
- `chair-decision.md` (server only): plain language, one page, same test and grade banners as
  the other reports. It says the task moved forward on the chair's judgment because the second
  reviewer did not agree within the limit; phase, round and reason; the co-chair's last verdict
  with its blocking items or objections; the chair's last verdict; and the sentence "This is not
  an agreement: treat the points above as open." It never addresses an owner.

## 14. Tests (`tests\`, `node --test`, no tokens)

Fake seat behaviours: `fake:agree`, `fake:object`, `fake:done`, `fake:not-done-same` (identical
blocking set every time), `fake:not-done-vary`, `fake:garbage` (never JSON), `fake:timeout`
(sleeps past a 1-second test watchdog), `fake:missing` (binary absent), `fake:writer` (creates a
file in the project), `fake:consult`, `fake:merge-confirm`, `fake:merge-object`.

Required cases: finish-line agree freezes and hashes; two objections end in `split` with the
report; three NOT_DONE end in `split`; same blocking set twice ends in `split` at round 2; both
DONE ends in `done` with `final.md`; call cap refuses the 16th call; deadline in the past refuses;
`ask` without seal refuses; second seal for a round refuses; changed checklist after freeze
refuses; garbage twice → `paused`; timeout → failed call counted, `paused`; missing binary →
`paused`; writer → tainted; `CONSENSUS_SEAT=1` → `ask` refuses; `DELEGATION_DISPATCHED=1` →
`consult` refuses; nested `start` refuses; one-seat consult answers; two-seat confirm → feedback;
two-seat double object → `split.md` and exactly 6 calls; fourth consultation refuses; detach +
wait round trip; stale lock cleared (the lock file is gone); `continue-from` copies the frozen
checklist and records its hash. Host-mode cases (`tests\host-mode.test.mjs`): missing key reads
as desktop; invalid value refuses `start` and new-task `consult` with `BAD_HOST_MODE`;
server finish-line OBJECT x3 freezes with `chairDecided` and the chair decision; server
sign-off exhausted and identical blocking set close `decided` with `chairVerdict`; call cap
and time limit close `decided` on server; a task keeps its recorded mode after `local.json`
changes; server advise split wording; desktop finish line still splits after 2 OBJECTs.

## 15. Portability rules for the code

ES modules, Node built-ins only, no machine-specific paths, `path.join` everywhere, spawn via
`child_process.spawn` with an explicit argument array (on Windows `.cmd` launchers are run through
`cmd.exe /d /s /c` with the arguments quoted by one shared helper), UTF-8 without BOM for every
file written, LF line endings, atomic writes for `ledger.json` and `index.json`, timestamps in
ISO-8601 UTC. Every module under 300 lines. No network access from the referee itself. Every directory handed to a seat or stored in a ledger is resolved to its
long, real form first (`fs.realpathSync.native`): a Windows 8.3 short name such as
`C:\Users\LONGNA~1\...` makes a restricted seat refuse to read the project.

## Task sizing assessment (trial)

`assess --project <dir> --brief <file> [--assessor <id>] [--rules-said suggest|no] [--triggers <text>] [--detach]` creates a separate assess task and asks one read-only assessor to rate the brief. `assess-outcome --task <id> --files-changed <n> --gate-failures <n> --consensus used|declined|not-suggested [--owner-view right|too-low|too-high] [--note <text>]` records what happened after the task is finished. `assess-report [--all]` summarizes the trial in the ledger root; the default excludes fake test tasks. `doctor` shows the current assessor and recorded outcome count.

Choice and refusals: `--assessor <id>` names an assessor, which must be a known assessor (else `BAD_ARGS`, a seat id included) and usable here (else `ASSESSOR_UNAVAILABLE`); without it the first usable id in `assessorOrder` is used (GPT-6 Luna; where Codex is missing Claude Sonnet 5.5, or Claude Sonnet 4.6 where Claude Code is older than 2.1.284, the assessor's `minVersion`), and none usable refuses with `ASSESSOR_UNAVAILABLE`. `assess` also refuses inside a seat (`CONSENSUS_SEAT`) or a dispatched worker (`DELEGATION_DISPATCHED`), when `local.json` disables consensus, and for a missing project directory, a missing brief file or a `--rules-said` value other than suggest or no. Every one of these refusals happens before any task exists or any call is made. `assess --task <id>` on an existing open assessment (the detached child, or a rerun) repeats the machine checks (not inside a seat or worker, consensus on, the task's assessor still usable) before anything is dispatched, in the foreground and with `--detach`.

Suggestion floor: the result's `suggestConsensus` is true when the answer's `suggest_consensus` is true, its rating is complex, or it reports any danger hit; when this rule overrides the model's own false, the result is marked `inconsistent`.

States: an assessment task starts `open`, becomes `assessed` after a valid answer, and closes as `recorded` (outcome recorded) or `failed`; `recorded` and `failed` count as closed, like `done`, `split` and `abandoned`. `seal`, `ask`, `job` and `consult --task` refuse assessment tasks; `close`, `assess --task` and `assess-outcome` refuse closed ones; each refusal leaves `ledger.json` unchanged. `list --open` shows `assessed` tasks, which still wait for their outcome. With `--detach` the task is created first and `wait --task <id>` returns the same result as a foreground run.

Report: `assess-report` makes no model call. It gives totals (assessed, recorded, waiting, failed), ratings, agreement with the fixed rules (both suggest, neither, assessor only, fixed rules only, not given), misses (no suggestion, but two or more gate failures or owner view too-low), over-calls (a suggestion with owner view too-high), calls and mean duration per assessor, trial progress (recorded of `trialTasks`, and whether that count is reached) and any unreadable task folders, and writes `assessment-trial.md` in the ledger root.

The assess ledger stores `fixedRules` (`said`, `triggers`), `assessment` (assessor, model, rating, suggestion, tier, confidence, danger hits, architectural flag, counts, call index, duration, usage and taint), and `outcomeRecord` (date, files changed, gate failures, consensus use, owner view and note). The assess limits are zero rounds, two total calls, one hour per task and 15 minutes per call. The call may use its single JSON retry. A timeout, unavailable assessor or invalid verdict closes the task as `failed`; no second assessor or third call is attempted. A successful answer moves the task to `assessed`, and the outcome record closes it as `recorded`.

Assessors live in a separate table and can never be chairs or consensus seats. The Claude assessor's `strictFlags` setting makes a rejected `--effort`, `--strict-mcp-config` or `--json-schema` fail the call immediately; consensus seats keep their existing flag drop and relaunch behavior.

During the trial the fixed consensus triggers decide and the assessor's suggested tier is advisory. After `trialTasks` (20) recorded outcomes the owner, and only the owner, decides whether the assessment replaces the size trigger (8 or more files, more than one repository) and the unclear, contradictory or architectural trigger. The danger triggers (money or payments, security or credentials, personal data, production paths, irreversible steps, gates failed twice) stay fixed permanently. Reaching the count changes nothing by itself.
