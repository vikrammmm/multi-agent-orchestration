# Consensus referee

A neutral command-line referee for two-CTO consensus. It owns the ledger, counters,
timers and reports. It never edits project code and never runs as a service.

Requires Node 18+ (built-in modules only). Entry point: `referee.mjs`. Seat CLIs: Claude Code
2.1.248 or later (`--restricted`), Codex CLI, Cursor Agent; `doctor` reports a seat whose CLI is
too old, with the reason.

## Commands

```
node referee.mjs start --mode full --chair <seat> --project <dir> --goal <file> [--cochair <seat>] [--continue-from <id>]
node referee.mjs seal --task <id> --phase finish-line|signoff --file <chair-verdict.json>
node referee.mjs ask --task <id> --phase finish-line|signoff [--detach] [--keep-copy]
node referee.mjs job --task <id> --lane <lane> --note <text>
node referee.mjs consult --project <dir> --brief <file> --seats both|<seat>[,<seat>] [--task <id>] [--stage plan|review] [--detach]
node referee.mjs assess --project <dir> --brief <file> [--assessor <id>] [--rules-said suggest|no] [--triggers <text>] [--detach]
node referee.mjs assess-outcome --task <id> --files-changed <n> --gate-failures <n> --consensus used|declined|not-suggested [--owner-view right|too-low|too-high] [--note <text>]
node referee.mjs assess-report [--all]
node referee.mjs wait --task <id> [--minutes 9]
node referee.mjs status --task <id>
node referee.mjs list [--open]
node referee.mjs close --task <id> --outcome abandoned --reason <text>
node referee.mjs doctor
node referee.mjs init-project [--dir <project>] [--write]
node referee.mjs --help
node referee.mjs --version
```

`--json` is the default (one JSON object on stdout). `--human` prints a short summary.

## Full-mode walkthrough

1. Write the owner's goal into `goal.md`.
2. Start a task (chair and co-chair must be different vendors):

```
node referee.mjs start --mode full --chair claude-opus-5.5 --project . --goal goal.md
```

3. Write `plan.md` and a numbered `checklist.md` into the task `materials` folder printed by `start`.
4. Seal your finish-line verdict, then ask the co-CTO:

```
node referee.mjs seal --task <id> --phase finish-line --file chair-finish.json
node referee.mjs ask --task <id> --phase finish-line --detach
node referee.mjs wait --task <id> --minutes 9
```

`AGREE` freezes the checklist. `OBJECT` once: revise, seal round 2, ask again. A second `OBJECT` writes `reports/split-decision.md`.

5. Build with your usual workers. Log every dispatch:

```
node referee.mjs job --task <id> --lane impl --note "implement the checklist"
```

6. Put `diff.patch` and `tests.txt` in `materials`, seal sign-off, ask again:

```
node referee.mjs seal --task <id> --phase signoff --file chair-signoff.json
node referee.mjs ask --task <id> --phase signoff --detach
node referee.mjs wait --task <id>
```

Both `DONE`: `reports/final.md`. Otherwise fix the blocking items and repeat (3 rounds, or sooner if the blocking set repeats).

## Advise-mode walkthrough

Write a brief, then:

```
node referee.mjs consult --project . --brief brief.md --seats both --stage plan --detach
node referee.mjs wait --task <id> --minutes 9
```

Read only `reports/feedback.md` or `reports/split.md` (the raw seat answers of a split are in `reports/split-raw.md`, for the owner only). Reuse `--task <id>` for later consultations on the same job (at most 3). `--stage review` also picks up `diff.patch` and `tests.txt` next to the brief.

## Ledger

Default: `%USERPROFILE%\.config\delegate-skills\consensus-ledger\` on Windows,
`$HOME/.config/delegate-skills/consensus-ledger/` elsewhere.

Override with `CONSENSUS_LEDGER`. Task data lives under `tasks/<id>/` (`ledger.json`,
`materials/`, `calls/`, `reports/`). The referee never writes inside the project
except `init-project --write` (appends an `AGENTS.md` block).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Refusal (limit, guard, wrong state, missing seal) |
| 1 | Internal error |

## Environment

| Variable | Role |
| --- | --- |
| `CONSENSUS_LEDGER` | Ledger root |
| `CONSENSUS_SEAT` | Set on seat children; `ask`/`consult` refuse if set on the referee |
| `CONSENSUS_TASK_ID` | Set on seat children; `start` refuses if set (nested task) |
| `CONSENSUS_CALL` | Call index for the seat child |
| `DELEGATION_DISPATCHED` | `ask`/`consult` refuse (a worker must not consult) |
| `CONSENSUS_SEAT_TIMEOUT_MS` | Optional watchdog override for tests; it can only shorten the 45-minute watchdog |
| `CONSENSUS_SEAT_SETTLE_MS` | Optional override for tests; it can only shorten the 20 seconds a seat may keep running after its verdict is complete |

Seat children never receive `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`,
`XAI_API_KEY`, or `MUSE_API_KEY`. `local.json` next to `referee.mjs` may override binary paths.

## Tests

Fake seats only; no real CLI is invoked.

```
node --test
```

Do not pass the `tests` directory as an argument on Node 24.
