---
name: muse-delegate
description: >-
  Delegate a coding task to the Meta Muse CLI (`muse`) as a background implementer, then
  review its diff and land it yourself. Use this whenever the user wants to hand implementation
  work to Muse — phrasings like "have Muse implement X", "delegate this to Muse", or "use Muse
  to implement/fix/refactor" — or wants to run a queue of coding tasks through Muse while
  staying the reviewer. DO NOT USE for tasks small enough to do inline.
license: MIT
compatibility: Requires the `muse` CLI (muse.cmd) installed and authenticated, Node 18+. Shell
  examples assume the relay is launched from PowerShell or cmd on Windows (muse is a .cmd shim).
metadata:
  version: 0.1.0
---

# Muse Delegate

You are the **orchestrator**. Hand a bounded coding task to a separate **implementer** — the Meta
Muse CLI — then review what it produced and land it yourself. You write the brief and own the
judgment; Muse does the typing in its own headless session; you verify and commit.

## When NOT to use this

- The task is small enough to do inline.
- `muse --version` fails (not installed).
- You only need a review with no edits — use `--read-only`.

## Prerequisites (check once)

1. `muse --version` succeeds.
2. `muse` is authenticated (check `~/.config/muse/auth.json`).

## The loop

### 1. Write the brief

Muse sees only the text you send plus what it can inspect in the workspace. Include the goal,
current state, what to change, what to leave untouched, the project's real gates, and a report
contract. Keep one task per brief. See [references/writing-the-brief.md](references/writing-the-brief.md).

### 2. Dispatch

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
# pin a model:                    add --model muse-spark-1.3
# reasoning effort:               add --effort xhigh
# read-only (no file writes):     add --read-only
# resume the most recent session: add --resume-last    (delta brief only)
# resume a specific session:      add --session <uuid> (delta brief only)
# hard time limit:                add --timeout 2h   (default 30m)
# use a fleet lane:               add --lane muse-implement
# see all options:                node .../relay.mjs --help
```

### 3. Wait for completion

The helper blocks. Run it with the orchestrator's background-command facility. Completion means
the process exited and `result.json` exists with a `status`.

Key `result.json` fields:

- `status`: `completed` | `failed` | `timeout` | `muse_unavailable` | `session_not_found`
  (resume asked for, but no such session in `--cd`; muse was not run — dispatch a fresh run with
  a full brief) | `muse_too_old` (Muse older than 1.4.15; not run, exit 1: tell the person to
  update Muse) | `cancelled` (the relay got SIGINT, SIGTERM, SIGHUP or SIGBREAK and stopped Muse
  first; exit 128 + the signal's number) | `contributor_tier_used` (Muse sent work to Meta's
  contributor tier anyway; the relay stopped Muse and everything it started, exit 3: stop using
  Muse on this machine and tell the person)
- `sentToModels`: the model ids Muse reported actually sending requests to
- `contributorCheck`: `verified` (only standard models) | `unverified` (Muse reported no model at
  all, so the relay cannot tell: stop using Muse and tell the person) | `contributor_tier_used` |
  `not_sent` (provably nothing was sent: Muse refused the flag before its first event, Muse could
  not be started, or the Windows guard could not be set up) | `not_applicable` (echo provider)
- `museVersionCheck`: `ok` (1.4.15 or newer) | `unparsed` (version not readable; the run went ahead
  with the flag) — `old` appears only with `muse_too_old`
- `modelWarning`: present when Muse reported a model other than the one asked for
- `museContributorSetting`: this machine's own Muse setting (`on`, `off`, `absent`, `unreadable`);
  read only. `on` is worth telling the person even when the run was protected
- `museStopped`: present when the relay stopped Muse (timeout, contributor tier, cancel); `true`
  only when it is confirmed that Muse and everything it started are gone; `false` means it could
  not confirm that (check for running Muse processes). After a normal end it appears only as
  `false`, when the stop of what Muse left behind could not be confirmed
- `museLeftRunning`: present when Muse ended while processes it started were still running (a
  count on Windows, `true` elsewhere); the relay stopped them. Check the worktree for partial
  writes, for example a leftover `.git/index.lock`. Anything meant to outlive the job (a dev
  server, a build daemon) is stopped too
- `ok`: boolean — true only when the terminal event reported `completed`
- `sessionId`: use with `--session <id>` for follow-up briefs
- `finalText`: Muse's closing response. When Muse ran more than one turn in the call (it can add a
  turn of its own, for example after a background command finishes), every turn's text in order,
  each under a `--- muse turn N of M ---` line; read all of it
- `warning`: present only when Muse ran more than one turn; says which turns Muse started itself
- `rawEventCount`: events parsed from the JSONL stream
- `briefPath`, `eventsPath`, `stderrPath`: artifact paths

### 4. Review — do not trust the self-report

- Re-run the project's gates yourself.
- Read the diff against the brief.
- Send rework as a delta brief with `--resume-last` or `--session <id>`.

### 5. Land it

The orchestrator commits after the gates pass and the diff holds. The relay never commits.

## Autonomy

A fresh run defaults to write-capable with `--approval-mode never`. `--read-only` adds
`--disable-write` to block workspace file writes. The relay always passes `--trust-workspace`
and `--approval-mode never` so headless runs do not stall on prompts.

## Never the contributor tier

Meta's contributor tier (`<model>-contributor`) may use prompts and completions to train Meta's
models; it is banned for team work. With `contributor_mode_enabled: true` in
`~/.config/muse/settings.json` (or `MUSE_CONTRIBUTOR_MODE=1` in the environment), Muse silently
swaps every standard id for its contributor twin when it sends a request. So the relay:

- always passes `--contributor-mode off`, which wins over the setting and the variable for that run.
  A Muse that reports a
  version older than 1.4.15 is refused before it runs (`muse_too_old`); a Muse that refuses the flag
  anyway fails with "update Muse to 1.4.15 or newer"; the relay never runs Muse without it;
- removes `MUSE_CONTRIBUTOR_MODE` from Muse's environment;
- refuses a `--model`, lane model or `--provider` whose name contains `contributor` (any case),
  exit 2, before Muse starts;
- records where requests really went (`sentToModels`, `contributorCheck`) and, if any went to a
  contributor model, stops Muse and every process it started (`contributor_tier_used`, exit 3).
  That stop is a backstop only: Muse reports the model after a request was answered.

How the relay stops Muse. On Windows Muse runs inside a job object held by a small PowerShell
guard the relay starts. It needs Windows PowerShell 5.1 in Full Language mode with `Add-Type`
allowed: on a machine where WDAC or AppLocker forces Constrained Language Mode, or where security
software blocks it, every Muse job fails before Muse starts (`failed`, `not_sent`, an error that
says why). The guard starts Muse suspended in `--cd`, records that, and only then lets it run.
Everything Muse starts stays in that job, also after Muse itself has ended; a stop ends the whole
job and is confirmed by the job's own process count, processes Muse leaves running at its end
are stopped too, and if the relay dies the job ends with it. Elsewhere Muse leads its own process
group (SIGTERM, then SIGKILL); the relay stops that group when Muse ends and leaves something in
it, and a relay that gets SIGINT, SIGTERM or SIGHUP stops it before it exits. Not covered: a
relay killed with SIGKILL on Linux or macOS, and a process there that starts its own session.
The Linux and macOS side has not yet been run on Linux or macOS.

Never pass a bare id such as `muse-ember`; use versioned ids (`muse-ember-1.0`).

## What the relay runs

```
muse exec --json --approval-mode never --trust-workspace --contributor-mode off --prompt-file <brief>
  [--model <id>] [--reasoning-effort <effort>] [--disable-write]
```

For resume: the same `muse exec` line plus `--session-id <uuid>`. `muse resume` is interactive-only
(Muse Code 1.4.3 rejects `--json` there), so the relay first confirms the session with
`muse export --session <uuid>` (or finds the newest one in `--cd` with `muse export --last`),
because `--session-id` silently starts a blank session for an unknown id.

## References

- [references/writing-the-brief.md](references/writing-the-brief.md)
- [references/dispatch-and-poll.md](references/dispatch-and-poll.md)
- [references/review-and-land.md](references/review-and-land.md)
- [references/multi-task-queues.md](references/multi-task-queues.md)
