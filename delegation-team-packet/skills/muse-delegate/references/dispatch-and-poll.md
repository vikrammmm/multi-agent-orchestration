# Dispatch and poll

`scripts/relay.mjs` wraps `muse exec --json`, captures the MSP wire JSONL stream, and writes
`result.json`. Run one command, then read one file.

## Before the first run

```bash
muse --version     # confirm installed
# check ~/.config/muse/auth.json exists (written on login)
```

## Dispatching

```bash
node "<skill-dir>/scripts/relay.mjs" --brief brief.txt --cd /path/to/repo
```

| Flag | Effect |
| --- | --- |
| `--brief <file>` / `--prompt-file <file>` | Brief path. Omit to read from stdin. |
| `--cd <dir>` | Working directory for muse (default: cwd). |
| `--lane <name>` | Fleet lane from delegate-setup; dials apply; flags win. |
| `--model <id>` | Muse model id (e.g. `muse-spark-1.3`). |
| `--effort <level>` / `--reasoning-effort <level>` | `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra` |
| `--read-only` | Pass `--disable-write` to muse (blocks workspace writes). |
| `--session <uuid>` | Continue a specific session (`muse exec --session-id <uuid>`). |
| `--resume-last` | Continue the most recent session in `--cd` (found with `muse export --last`). |
| `--timeout <dur>` | Relay watchdog (default: `30m`). |
| `--out-dir <dir>` | Artifact directory (default: system temp). |

## Artifacts and result fields

- `brief.txt`, `events.jsonl` (raw muse JSONL), `stderr.txt`, `result.json`

Key `result.json` fields:

- `schema`: `"delegate-relay.result.v1"`
- `tool`: `"muse"`
- `status`: `completed` | `failed` | `timeout` (exit 124) | `muse_unavailable` | `session_not_found` |
  `muse_too_old` (exit 1, not run) | `cancelled` (exit 129 / 130 / 143 / 149 for SIGHUP / SIGINT /
  SIGTERM / SIGBREAK) | `contributor_tier_used` (exit 3; see below)
- `ok`: true only when the terminal event reported `completed`
- `sentToModels`: model ids from the provider facets of the events
  (`{"kind":"provider","provider":"meta",...,"model":"..."}`), i.e. where requests really went
- `contributorCheck`: `verified` | `unverified` (no provider facet seen: stop and tell the person) |
  `contributor_tier_used` | `not_sent` (provably nothing sent: Muse refused the flag on a stderr line
  before its first event, Muse or the guard could not be started, or the guard exited 97 with its
  own `unavailable` status; a missing guard status alone never counts) | `not_applicable` (echo)
- `museVersionCheck`: `ok` | `unparsed` | `old` (only with `muse_too_old`); the first x.y.z of
  `muse --version` against 1.4.15
- `modelWarning` (a reported model differs from `--model`), `museContributorSetting` (`on`, `off`,
  `absent`, `unreadable`; read only), `museStopped` (after a timeout, contributor or cancel stop:
  `true` only when confirmed; after a normal end only `false`, when the stop of leftovers was not
  confirmed), `museLeftRunning` (processes Muse left running at its end, stopped by the relay: a
  count on Windows, `true` elsewhere)
- `sessionId`: from `stream.id` on every MSP event — use with `--session` for follow-ups
- `finalText`: from the `run.terminal.completed` event's `payload.text`; when one call runs
  several turns, every turn's text in order under `--- muse turn N of M ---` lines (see below)
- `warning`: only when more than one turn ran in the call
- `rawEventCount`: total JSONL events parsed
- `museVersion`, `model`, `effort`, `readOnly`, `startedAt`, `finishedAt`

## What the relay runs

```
muse exec --json --approval-mode never --trust-workspace --contributor-mode off --prompt-file <brief>
  [--model <id>] [--reasoning-effort <effort>] [--disable-write]
```

`--contributor-mode off` overrides `contributor_mode_enabled` in `~/.config/muse/settings.json` and
the `MUSE_CONTRIBUTOR_MODE` variable for this run only (never persisted).
Without it, a machine with contributor mode enabled sends requests to `<model>-contributor`,
even when `run.model.configured` names `<model>`; the provider facet reports the contributor model.
`contributor_mode_enabled: true` or `MUSE_CONTRIBUTOR_MODE=1` enables it. Muse refuses
`-c contributor_mode_enabled` when `--contributor-mode off` is present.

The relay also removes `MUSE_CONTRIBUTOR_MODE` from Muse's environment. A `--model`, lane model or
`--provider` naming the contributor tier is a usage error; a contributor model in any provider facet
stops Muse and everything it started (`contributor_tier_used`, exit 3). The same stop ends a run that
hits `--timeout`, and a relay that gets SIGINT, SIGTERM, SIGHUP or SIGBREAK (`cancelled`).

Stopping, Windows. The command above does not run directly: the relay starts Windows PowerShell 5.1
(`-EncodedCommand`, a script embedded in `relay.mjs`, run in the artifact folder), which creates a
job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts `cmd.exe /d /s /c "<command>"`
suspended in `--cd` (passed as the process's current directory), puts it in the job, writes
`<out-dir>/muse-guard.json` with `state: running` and only then resumes it, so cmd, `muse.cmd`,
Muse's PowerShell launcher, `muse-bin` and anything they start are in the job from the first
instruction (breakaway is not allowed). The guard ends the job when Muse ends, when the relay writes
`<out-dir>/muse-guard.stop`, or when the relay process is gone, waits until the job counts no running
process, writes the status file again (`state: ended`, `reason`, `started`, `inJobAtEnd`, `active`)
and exits with Muse's exit code; it writes nothing to stdout. A stop asked for before Muse was let
run ends it unrun (`started: false`, and the result says `not_sent`). If the guard itself is killed,
the job's last handle closes and Windows ends everything in it.

The guard's own exit code 97, with a status file that says `guard: unavailable` and why, means Muse
was not started; the relay then exits 1 with `status: failed` and `contributorCheck: not_sent`. The
guard refuses when PowerShell runs in Constrained Language Mode (WDAC or AppLocker), when it cannot
open the relay process to watch it, or when any step fails (Add-Type, the job, the std handles,
CreateProcess, assigning to the job, resuming). Every other ending without a confirmed `ended`
status is reported as `museStopped: false`, and `contributorCheck` keeps what the stream showed.

On Windows, Muse's sandbox runs commands as a separate user. Git's dubious-ownership refusal can
come from that identity, not the relay guard.

Stopping, Linux and macOS. Muse leads its own process group (`detached`); a stop sends SIGTERM, then
SIGKILL after 2 s, to the group, which works after Muse itself has ended because the group's id
stays reserved while any member lives. When Muse ends and the group still has members, the relay
stops them too (`museLeftRunning: true`); a member that keeps Muse's output open is stopped 2 s after
Muse's exit, so it cannot hold a finished run until `--timeout`. Not covered: SIGKILL to the relay,
and a process that starts its own session (`setsid`). Not yet run on Linux or macOS.

For resume: the same line plus `--session-id <uuid>`, after `muse export --session <uuid>` (or
`--last`) confirms the session exists. `muse resume` is interactive-only and rejects `--json`;
`--session-id` with an unknown id silently starts a blank session, hence the check. When it fails
the relay writes `status: session_not_found` and does not run muse.

`MUSE_UPDATE_INTERVAL_SECONDS=999999` is set in the environment to suppress the update check.

## MSP JSONL parsing

Each line is a JSON object. Key fields:
- `stream.id` → session ID (identical on every event in the stream)
- `payload_type === "run.terminal.completed"` → terminal event:
  - `payload.terminal === "completed"` → success
  - `payload.text` → final assistant text
  - `payload.reason` → null on success, failure reason string otherwise

The relay uses the terminal event as the primary success signal (not the exit code), because the
echo provider exits 1 even for successful runs when a reminder sub-task fails.

One `muse exec` can run more than one turn. When a shell command that Muse moved to the background
finishes after Muse has answered, its runtime submits a turn of its own (`runtime.command.accepted`
with `client_id` `muse-runtime-background-terminal`, then `turn.input.user` with an empty prompt),
and that turn ends with its own `run.terminal.completed`. The relay keys turns by
`payload.command_id` in arrival order and keeps each turn's `payload.text` (or, for a turn cut off
before it closed, its `run.output.delta` text so far). One turn: `finalText` is that text, as
before. Several: they are joined in order under `--- muse turn N of M ---` lines (marked "started by
muse itself" when `client_id` is set) and `warning` is added. The last terminal event still
decides `status` and `ok`; `error` is still the last turn's closing text. A `--session-id`
follow-up streams only its own new turns, not the earlier ones.
