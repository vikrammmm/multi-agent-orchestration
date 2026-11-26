# Seat adapters: exact invocation

Every adapter receives: `{ seat, prompt, projectDir, callDir, schemaPath, schemaJson, timeoutMs, resume }`
and returns `{ status: 'completed'|'failed'|'timeout'|'unavailable', exitCode, signal, stdoutPath,
stderrPath, rawText, sessionId, usage, durationMs, errorText }`. `rawText` is the text the lenient
parser will read (see SPEC section 11). The adapter never interprets the verdict.

## Shared spawn rules (`lib/spawn.mjs`)

- Resolve the binary: `local.json` override for the seat (`{ "binaries": { "codex": "C:\\...\\codex.cmd" } }`)
  first, else the bare name on PATH. On Windows, `where.exe <name>` (or a manual PATH walk with
  PATHEXT) decides whether the launcher is `.exe` or `.cmd`.
- Windows `.cmd` launchers cannot be spawned directly. Run them as
  `spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + quoted + '"'], { windowsVerbatimArguments: true, ... })`
  where `quoted` is the launcher path and every argument wrapped in double quotes, inner double
  quotes escaped as `\"`. `.exe` binaries and `node` are spawned directly with an argument array.
  Keep this in one helper; the adapters only build argument arrays.
- The prompt is always delivered on stdin (`child.stdin.end(prompt)`); never as an argument, because
  Windows limits a command line to 32 KB and prompts carry inlined materials.
- Environment: copy of `process.env` minus the keys listed in `seats.json` `apiKeyEnvToStrip`
  (matched without regard to letter case, because Windows keeps whatever casing a variable was set
  with), plus `CONSENSUS_SEAT=1`, `CONSENSUS_TASK_ID=<id>`, `CONSENSUS_CALL=<n>`. For the codex adapter on
  Windows with a sandbox, also remove every PATH entry containing `WindowsApps` (the Store `pwsh`
  is denied under the sandbox's restricted token and every shell command would fail).
- Watchdog: `setTimeout(timeoutMs)`; on expiry kill the tree: Windows `taskkill /pid <pid> /t /f`,
  elsewhere `process.kill(-pid, 'SIGKILL')` after spawning with `detached: true`. Status `timeout`.
- Declared output: the flow passes `isComplete(rawText)` (the phase schema
  check) and each adapter turns it into `spawnSeat({ ready })`, polled every second. codex: `-o
  final.txt` holds a valid verdict; claude-code: stdout is one complete `"type":"result"` object
  (not `is_error`) whose verdict is valid; cursor: a complete `"type":"result"` object, the whole
  stdout or one line of it, whose `result` is valid. When `ready` holds and the process has not
  exited 20 seconds later (`CONSENSUS_SEAT_SETTLE_MS` may shorten this in tests), the tree is
  killed and the call is `completed`; if the watchdog expires while `ready` holds, likewise.
- Ending: after any kill, and after an exit whose output pipes stay open (something the seat left
  behind holds them), the referee waits at most 5 seconds for the pipes, then destroys its ends
  and returns. On Windows `taskkill` is used only while Node has not yet seen the root exit (so
  the pid cannot have been reused) and is itself bounded to 15 seconds; elsewhere the process
  group is killed (for an exited leader at once, as its exit is reported, while the group id is
  certainly still its own). The result carries `endedBy`: `exit`, `output-ready`,
  `exit-pipes-held`, `timeout` or `spawn-error`; the flow writes it to `meta.json`, and adds
  `adapter-deadline` when an adapter itself has not returned (`lib/call.mjs`, SPEC section 10).
- stdout and stderr are streamed to `callDir/stdout.txt` and `callDir/stderr.txt` as they arrive
  (so a killed call still leaves its partial output), and also kept in memory up to 4 MB.
- Spawn failure (ENOENT) → status `unavailable`, `errorText` = the error message.
- Non-zero exit with no parseable final text → `failed`. Non-zero exit with parseable text is still
  returned as `completed` with `exitCode` recorded (some CLIs exit 1 on benign conditions).
- Rate-limit or login problems are detected by the caller from `rawText`/`stderr` matching
  `/rate.?limit|usage limit|weekly limit|hit your .{0,24}limit|quota|not logged in|login required|unauthorized|401|429/i`
  → the flow records `paused` with reason `SEAT_UNAVAILABLE`. A result JSON with `is_error: true`
  (claude-code and cursor) is a failed call: `rawText` is empty, `errorText` carries its `result`
  text (for example a plan's weekly limit), there is no JSON retry, and the flow pauses with
  `SEAT_UNAVAILABLE`.

## claude-code (`lib/adapters/claude.mjs`)

Binary `claude` (`claude.exe` on Windows). Requires Claude Code 2.1.248 or later, where
`--restricted` was added (`seats.json` `routes.claude-code.minVersion`; `doctor` checks it without
spending tokens and reports an older CLI as the reason the seat is unavailable). Arguments:

```
-p
--output-format json
--model <seat.model>
--effort <seat.effort>
--tools "Read,Glob,Grep"
--restricted
--strict-mcp-config
--mcp-config <callDir>/mcp-empty.json          # file content: {"mcpServers":{}}
--json-schema <schemaJson as one-line string>   # inline JSON, passed as a single argument
--add-dir <callDir>/materials
--max-budget-usd <seat.maxBudgetUsd>            # only when the seat declares it
[--resume <sessionId>]                          # only for the JSON retry of the same call
```

cwd = `projectDir`. Prompt on stdin. Output: one JSON object on stdout, e.g.
`{"type":"result","subtype":"success","is_error":false,"result":"<text>","session_id":"...","total_cost_usd":0.0,"usage":{...},"structured_output":{...}}`.
`rawText` = `structured_output` serialised when present, else `result`. `sessionId` =
`session_id`. `usage` = `usage` plus `total_cost_usd`. If stdout is not JSON, `rawText` = stdout.
Notes: `--tools` names the exact tool set (no Bash, Edit, Write, WebFetch, WebSearch, Agent);
`--restricted` also ignores user and project settings files (hooks). If `--strict-mcp-config`,
`--json-schema` or `--effort` is rejected by an older CLI (exit code with "unknown option" on
stderr), the adapter retries once without the rejected flag and records `flagsDropped` in meta.

## codex (`lib/adapters/codex.mjs`)

Binary `codex` (`codex.cmd` on Windows, through `cmd.exe`). Fresh call:

```
exec
--json
-o <callDir>/final.txt
--output-schema <schemaPath>
-s read-only
-m <seat.model>
-c model_reasoning_effort=<seat.effort>
-C <projectDir>
--skip-git-repo-check
-                     # read the prompt from stdin
```

Resume (later rounds of the same task when a thread id was captured; also the JSON retry).
`codex exec resume` accepts neither `-s/--sandbox` nor `-C/--cd`, so the
read-only sandbox is pinned with the config override and the working directory is set on the
process (cwd = `projectDir`):

```
exec resume <threadId>
--json
-o <callDir>/final.txt
--output-schema <schemaPath>
-c sandbox_mode=read-only
-c model_reasoning_effort=<seat.effort>
--skip-git-repo-check
-
```

cwd = `projectDir`. stdout is JSONL events; scan each line for `thread_id`, `threadId` or
`thread.thread_id` → `sessionId`. `rawText` = content of `final.txt` when it exists and is
non-empty, else the last `agent_message`/`item.completed` text found in the events, else stdout.
Usage: from a `turn.completed`/`usage` event when present. `local.json` may set
`"codexIgnoreUserConfig": true` to add `--ignore-user-config`; default off.

## cursor (`lib/adapters/cursor.mjs`)

Binary `cursor-agent` (`cursor-agent.cmd` on Windows, through `cmd.exe`). Before the call the
flow has already created the disposable copy at `<callDir>/copy` (see SPEC section 3) and copied
the round's materials into `<copy>/.consensus/`. Arguments:

```
--print
--output-format json
--trust
--mode plan
--model <seat.model>          # grok-4.7-xhigh
--workspace <copyDir>
[--resume <sessionId>]        # JSON retry only
```

cwd = `copyDir`. Prompt on stdin. Output: one JSON object
`{"type":"result","subtype":"success","is_error":false,"result":"<text>","session_id":"...","duration_ms":...}`;
`rawText` = `result`; `sessionId` = `session_id`. If the CLI streams several JSON objects, take the
one with `"type":"result"`. Plan mode is Cursor's best-effort read-only; the integrity manifest of
the real project is the actual guarantee, and the copy is deleted after the call unless
`--keep-copy`.

## fake (`lib/adapters/fake.mjs`)

Seat ids `fake:<behaviour>`. In-process unless noted. Each returns a `rawText` matching the phase
schema of the call (`opts.phase`):

| behaviour | finish-line | signoff | consult / merge / confirm |
| --- | --- | --- | --- |
| `agree` | AGREE | DONE | consult answer / CONFIRM |
| `agree-ratetext` | AGREE whose summary mentions a 429 rate limit and a login error (a valid verdict must never be read as an unavailable seat) | DONE | as agree |
| `object` | OBJECT with one objection | NOT_DONE with a varying blocking item | consult answer / merge draft / OBJECT |
| `done` | AGREE | DONE | as agree |
| `not-done-same` | OBJECT | NOT_DONE with the same blocking item every call (`checklist_line: 2`) | as object |
| `not-done-vary` | OBJECT | NOT_DONE with a new blocking item per call | as object |
| `garbage` | `"this is not json"` always | same | same |
| `timeout` | spawns `node -e "setTimeout(()=>{}, 120000)"` (real child; test passes a 1000 ms timeout) | same | same |
| `missing` | tries to spawn `consensus-no-such-binary-xyz` → `unavailable` | same | same |
| `hang-after-output` | real child (`fake-seat-proc.mjs`): writes the agree answer to `final.txt` and stdout, then waits forever on a child holding stdout (ended by the declared-output rule) | same | same |
| `orphan-hang` | real child: leaves a stdout holder outside its tree, then hangs without output (ends as `timeout`) | same | same |
| `orphan-exit` | real child: leaves the same holder, prints the agree answer and exits 0 (ends as `exit-pipes-held`) | same | same |
| `writer` | writes `<projectDir>/CONSENSUS-WRITER-TEST.txt` then AGREE | writes then DONE | writes then confirm |
| `consult` | as agree | as agree | consult answer with two risks and two recommendations |
| `merge-confirm` | as agree | as agree | merge: draft; confirm: CONFIRM |
| `merge-object` | as agree | as agree | merge: draft; confirm: OBJECT with one objection |

Fake seats are `vendor: "fake-<behaviour>"` so two fakes count as different vendors, `tier: 1`,
`seatEligible: true`. Any task that used a fake seat sets `test: true` in the ledger and every
report carries the line `TEST RUN: a fake seat was used; this is not a real consensus.`

## Assessment adapters and service tier

Codex seats and the Luna assessor pin `serviceTier: "default"` with `-c service_tier=<serviceTier>` on both `exec` and `exec resume`. A user's Codex config may set `service_tier = "priority"`, which Codex's model list calls "Fast"; seats must not inherit it. The Luna assessor uses `codex exec --json --output-schema <schema> -s read-only -m gpt-6-luna -c model_reasoning_effort=high -c service_tier=default` with the project directory and brief prompt.

The fallback assessors use `claude -p --model claude-sonnet-5-5 --effort high --tools Read,Glob,Grep --restricted --strict-mcp-config --mcp-config <empty config> --json-schema <schema> --max-budget-usd 5` (Sonnet 5.5, Claude Code 2.1.284 or later; the last fallback runs the same command with `claude-sonnet-4-6`). Assessor entries set `strictFlags: true`: if Claude Code rejects `--effort`, `--strict-mcp-config` or `--json-schema`, the first invocation fails without dropping a flag or relaunching. Consensus seats keep the drop-and-relaunch behavior described above. Fake assessors answer the assess schema; `assess-complex` and `assess-inconsistent` exercise the consensus suggestion guard.
