# Delegation rulebook

Status: the rulebook every AI agent on this machine follows: whichever of Claude Code, Codex CLI,
Cursor Agent and Muse Code are installed (through the "Delegation (shared rulebook)" section of
Claude Code's `CLAUDE.md` and Codex's `AGENTS.md`, the `consensus` skill and the relay skills). It
was installed by the delegation team packet and is maintained by the packet owner in
one shared source; do not edit this copy. The facts about this particular machine (which tools
exist, which routes and seats are available) are in `profiles\team.md` next to this file.

## Ground rules that override everything below

- Every tool runs on its subscription login through its installed CLI. API keys are banned:
  never set, store, ask for or depend on one, and never use a "bring your own key" mode.
- Nothing runs as a background service. Every helper and every reviewer is a one-shot process
  that ends with its job.
- In desktop mode, the person in the chat decides when extra cost is worth it. An agent suggests a
  second opinion or a consensus run in one plain sentence and never spends the extra calls silently.
  See "Desktop mode and server mode" for unattended reviews.
- Every helper is trusted. Any task may be delegated to any
  route the profile lists, including work that uses the person's live accounts, logins, passwords
  or other credentials, commits, pushes, releases, deletions and the final review. Needing a login
  is never by itself a reason to keep work from an external worker. What still decides the route
  is what a worker can reach and do well: a tool that exists only inside the Claude Code session
  (its connectors, its browser pane) cannot be called by an external CLI, and a login that a
  worker's process cannot see (for example Muse's Windows sandbox, which runs commands as its own
  Windows user) cannot be used by that worker. Delegation adds no permission of its own and removes
  none: whatever needed the person's OK before (pushing, releasing, deleting, sending messages,
  production changes) still needs it, and once given, a worker may carry it out.

## Scope and precedence

User and session instructions have first priority. Repository `AGENTS.md` and `CLAUDE.md` files
and the active machine's global instructions remain authoritative for everything that is not
delegation. This file is the delegation contract read by each agent's local bootstrap; it does not
replace repository instructions or project-specific controls.

Before substantial tasks, read this policy and `profiles\team.md` from the paths given by the
local bootstrap. If either file is missing or unreadable, report that fact and stop the
delegation-specific phase; do not reconstruct the rules from memory.

## Desktop mode and server mode

The device profile says which mode this machine runs. Desktop mode follows the rest of this file.
In server mode, another program starts the agent. The agent runs unattended and nobody answers
questions.

- Wherever this rulebook says to suggest, offer or ask the person, decide for yourself. When a
  consensus trigger fires, run the review yourself. Use full mode when you may chair and advise mode
  otherwise. Skip the task-sizing trial.
- Allow at most 3 rounds to agree the finish line and at most 3 sign-off rounds. If the reviewers
  still disagree, the referee closes the task as `decided`. Make your best judgment and move
  forward. Say plainly in your result that the second reviewer did not agree and list the open
  points. Never present a split as agreement. In advise mode, settle a split the same way.
- If the referee pauses, for example because a seat is unavailable or times out, rerun the same
  command once. If it is still paused, use your own judgment and state that the work was not reviewed.
- Never wait for a person. Keep the answer format the calling program asked for. Put review notes
  only where that format allows.
- Server mode grants no permission. Pushing, releasing, deleting, sending messages, production
  changes and anything else that needs a person's OK may happen only when the instructions of the
  program that started you already authorize it.

## Working style: orchestrator plus cheap helpers

On any nontrivial task the agent in the conversation is the orchestrator. It keeps goal
understanding, planning, architecture, judgment calls, evaluating results, integrating them, and
final review. Context-heavy and mechanical work goes to cheaper workers so their tool output never
lands in the main conversation. The reason is context and judgment, not only price, but the price
gap always points the same way: a helper costs a fraction of the orchestrator. Never let
mechanical work occupy an orchestrator turn.

Two wallets. The Claude helpers (Haiku and Sonnet) spend the same Claude allowance as the Claude
Code session. The
external CLIs (Codex, Cursor, Muse) bill their own subscriptions. When the Claude limit is the
binding constraint and an external route exists on this machine, prefer it over a Claude helper.

How to delegate well:

- Let the task's structure set the fan-out, and keep working while workers run. Several cheap
  helpers in parallel are the default; a single owner is a choice, not a rule. Every dispatch must
  have a concrete deliverable. Do not repeat the same investigation for reassurance.
- Dispatch every read-only worker that must observe current state before any worker that changes
  it. Never let two workers edit the same files at once. While a worker owns a slice, run no
  parallel tools on that same scope; do independent work or wait.
- For follow-ups, resume the existing worker rather than spawning a fresh one.
- Hand every worker a work order: goal, exact paths and symbols, constraints and non-goals, the
  project's real gate commands as expected proof, and the return shape. External CLIs see only the
  brief: no session context, no memory. Ask for a short evidence-backed brief; have bulk output
  written to a scratch location and read back only what is needed.
- Run external dispatches in the background and read their result when notified. Use completion
  notifications or bounded waits, never polling loops. Treat every self-report as a claim: re-run
  the gates and read the diff yourself. A worker may commit, push or release when its brief says
  so; otherwise the orchestrator lands the change.
- Tiny edits are not worth the round trip; do them inline. If delegation is skipped on a large
  task, say why in one line.

Keep with the orchestrator: architectural decisions, ambiguous specs where writing the spec is the
real work, and the decision to accept the finished work (in a consensus task, that is the two-key
sign-off described below). Everything else may be delegated (see the ground rules above),
including work with the person's accounts, logins and credentials, commits, pushes, releases,
destructive operations and the final review itself.

Workers inherit existing authority, credentials, repository and production controls; delegation
grants no extra authority. Never disable, bypass, or raise a user-installed execution budget
without an explicit user request; if a budget is denied, delegate differently.

## Routes

Only the routes listed in `profiles\team.md` exist on this machine, and each lane there names the
model the installer found this machine's tools actually offer (the owner's first choice, or the
listed fallback). On a machine with Claude Code alone, every mechanical or context-heavy slice goes
to the Claude helpers (the Haiku helper first, then the Sonnet helpers) and everything else stays
with the orchestrator; that is a complete,
supported setup, not a degraded one. On a machine without Claude Code there are no Claude helper
routes and no Claude seats; the orchestrator (Codex, Cursor Agent or Muse) uses the relays the
profile lists and its own tools; everything else in this rulebook applies. Select the
model and effort explicitly whenever the interface supports it; if model selection is unavailable,
say so rather than labeling an inherited lead as the selected worker. Cheapest capable worker
first: Luna, then Muse, then Sol, then grok, then the Claude helpers (the Haiku helper first, then
the Sonnet helpers). The Cursor review lane (Grok 4.7 high)
is the fallback second reviewer when the Codex allowance is spent.

| Route | Required model and effort | Claude Code reaches it via | Needs on this machine | Use |
| --- | --- | --- | --- | --- |
| Haiku helper | exact `claude-haiku-5-5`, effort `high` | subagent `haiku-helper` (installed in `~\.claude\agents\`) | Claude Code 2.1.293 or later | first Claude helper (Developer), about 20 times cheaper than the Sonnet helpers: quick lookups, extraction, bounded edits and fixes from a clear brief, routine checks of junior work; same last-route rule as the Sonnet helpers |
| Sonnet helpers | exact `claude-sonnet-5-5`, effort `high` (where Claude Code is older than 2.1.284 the installer puts in the previous copies: `claude-sonnet-4-6`, effort `max`) | subagents `Explore`, `researcher`, `implementer`, `verifier` (installed in `~\.claude\agents\`) | Claude Code (2.1.284 or later for Sonnet 5.5) | last route, after the Haiku helper (and in its place where Claude Code is older than 2.1.293): use only for work the external routes cannot reach (tools that exist only inside the Claude Code session, such as its connectors and browser pane) or when no suitable external route listed in the profile is usable (none is listed, or "When a model is missing" leaves none that can do the work); then exploration, multi-file synthesis, mechanical edits once the approach is frozen, fresh-context verification |
| Cursor grok | `grok-4.7-xhigh-fast` (Grok 4.7, effort xhigh, fast on) | lanes `cursor-grok-review`, `cursor-grok-implement` (skill `cursor-delegate`) | Cursor Agent, logged in | Cursor's default implementer and reviewer: bounded feature slices, fixes, reviews. A CTO-grade profile at about twice Grok 4.6's cost per task |
| Codex Luna | `gpt-6-luna`, effort `max` | lanes `codex-luna-review`, `codex-luna-implement`, `codex-bulk` (skill `codex-delegate`) | Codex CLI, logged in with ChatGPT | cheapest paid tier (Developer): bulk patches, large read-heavy audits, search, extraction, pattern work; weak at autonomous shell work |
| Meta Muse | `muse-spark-1.3`, effort `xhigh` (Standard tier only; never `muse-spark-1.3-contributor`, which trains on your data) | lanes `muse-review`, `muse-implement` (skill `muse-delegate`) | Muse Code, logged in | cheapest Tech-lead tier: large read-heavy work and bounded slices |
| Codex Sol | `gpt-6.2-sol`, effort `high` (fallbacks `gpt-6.1-sol`, then `gpt-6-sol`, both at high, where Codex lacks GPT-6.2 Sol) | lanes `codex-review`, `codex-implement` (skill `codex-delegate`) | Codex CLI, logged in with ChatGPT | middle tier (Tech lead): settled implementation with local judgment, and cross-model reviews |
| Cursor review (fallback) | `grok-4.7-high` (Grok 4.7, effort high, standard speed) through Cursor | Cursor lane `cursor-review` | Cursor Agent, logged in | outside second reviewer, and the fallback when the Codex allowance is spent |
| Consensus seat, GPT | `gpt-6.2-sol`, effort `xhigh`, read-only sandbox | referee seat `gpt-6.2-sol` | Codex CLI, logged in | co-CTO when Claude or Grok chairs |
| Consensus seat, GPT reserve | `gpt-6.1-sol`, effort `xhigh`, read-only sandbox | referee seat `gpt-6.1-sol` | Codex CLI, logged in | reserve co-CTO where GPT-6.2 Sol is unavailable |
| Consensus seat, Opus 5.5 | `claude-opus-5-5`, effort `xhigh` (CTO at high or above), tools Read, Glob, Grep only | referee seat `claude-opus-5.5` | Claude Code 2.1.280 or later | first-choice Claude co-CTO when GPT or Grok chairs |
| Consensus seat, Grok | `grok-4.7-xhigh` through Cursor plan mode in a disposable copy of the project | referee seat `grok-4.7` | Cursor Agent, logged in | backup seat when the preferred vendor is unavailable |
| Consensus seat, Opus | `claude-opus-5`, effort `xhigh`, tools Read, Glob, Grep only | referee seat `claude-opus` | Claude Code 2.1.248 or later | reserve: the Claude co-CTO where Claude Code is older than 2.1.280, and Opus 5.5's partner on Claude-only machines |
| Task-sizing assessor (trial) | `gpt-6-luna`, effort `high`, read-only sandbox, standard service tier; where Codex is missing `claude-sonnet-5-5` at `high` (Claude Code 2.1.284 or later; older builds `claude-sonnet-4-6` at `high`), tools Read, Glob, Grep only | referee `assess` | Codex CLI logged in with ChatGPT, or Claude Code | sizes a task before nontrivial work (trial); never a seat or a chair |

Retired models: GPT-6 Astra (`gpt-6-astra`) and Claude Fable 5.1 (`claude-fable-5-1`) are not used
by any route, lane, seat or helper; GPT-6.1 Sol and Claude Opus 5.5 took their places. When a CLI's
own default is one of them, pass the model explicitly.

Fast mode: Cursor's fast setting is part of its exact requested route; use the grok lanes freely.
No other route selects a fast variant: same work, two to two and a half times the metered cost.
Never substitute a model merely to obtain fast mode; report unavailable controls truthfully. The
referee pins every Codex call it makes (seats and the task-sizing assessor) to the standard
service tier with `-c service_tier=default`, whatever this machine's Codex settings say.

When a model is missing: use the lanes as the profile lists them; a lane marked "not verified"
may still fail. If a dispatch fails because the model is not offered (unknown model, not
available on this plan, not entitled), do not retry it unchanged: tell the person in one plain
sentence, hand the work to the next route in the cheapest-first order that is at the same tier or
higher, and ask the person to run the packet installer again after fixing the tool (updating it,
logging in, or declaring the model with `--unavailable <id>`). Never quietly use a lower tier than
the job needs.

Cursor edits: Cursor may edit files when dispatched through a write-capable lane in its own
session against the project's gates; the dispatching agent reviews the diff before anything lands.

Muse: pin the Standard model `muse-spark-1.3` on every lane; the contributor tier trains Meta's
models on prompts and completions and must never touch this team's code. Write lanes run headless
with a trusted workspace and `--approval-mode never`; review lanes add `--disable-write`. Give
Muse one module group per brief; very large single generations hit its idle timeout.

### Choosing a helper by role (the ladder)

Where Node 18 or newer is present, the packet also installs the role ladder: the packet owner's list
of engineers (a model at an effort) in four roles, Junior, Developer, Tech lead and CTO, holding
only the engineers the owner has approved, in the owner's order. `profiles\team.md` says whether it
is installed here and gives the exact command; it is
`node ~/.config/delegate-skills/frontdesk/bin/role.mjs plan "<role>"` (add `--json` for a
machine-readable answer; `role.mjs list` shows every role, `role.mjs doctor` checks the install).
Nothing is hooked into Claude Code, Codex or Muse; the ladder only answers when asked.

- Use it when you know the role a slice needs and want the first approved engineer this machine can
  run: the answer names the engineer that would be called and its route (tool), and lists the ones
  it skipped and why (tool not installed, tool too old, in a cooldown, switched off on this
  machine). Reach the named engineer through its lane or helper as listed in the profile.
- It checks the tools and versions installed here, not what each account offers. If a call fails
  because the model is not offered, follow "When a model is missing" above and suggest running the
  installer with `--unavailable <id>`; the ladder then switches that model off too.
- It never overrides the cheapest-first route order, a lane's or helper's fixed model and effort,
  a model or effort the person chose explicitly, or the consensus rules. Consensus seats and chairs
  come from the tier table in the consensus section, not from the ladder; the two lists disagree on
  some models on purpose.
- The ladder lists the local Qwen route (`qwen-local`) for Junior and Developer. The packet always
  switches it off. Never configure or call it.
- If `role.mjs` says the ladder is not installed or is BROKEN, use the routes above and tell the
  person to run the packet installer again.

## Agent-specific mechanics

### Claude Code

- The route order binds Claude Code too: the Agent tool and Workflow `agent()` calls, including
  ultracode workflows, start Claude-plan workers — the last route in the order above. Claude Code
  lists them prominently, which makes them the easy default; do not take it. Read-heavy
  investigation, search, extraction, document review, verification and bulk work go first to the
  external relays the profile lists, cheapest first (`codex-luna-review`, `codex-bulk`,
  `muse-review`, `muse-implement` where they exist), dispatched in parallel as background relay
  calls. Use a Claude subagent or workflow agent only for work those CLIs cannot reach
  (tools that exist only inside the Claude Code session, such as its connectors and browser pane;
  a login, account or credential is no such reason, see the ground rules) or when no suitable external route listed in the profile is usable (follow "When
  a model is missing" first), and say why in one line before dispatching. Ultracode
  raises thoroughness, not the route: fan out through the relays; a workflow agent may serve only
  as a thin dispatcher, at low effort, that runs one relay and returns its result. On a Claude-only
  machine the Claude helpers take that work instead (see Routes).
- When a Claude helper is justified, prefer the named subagents over unnamed `general-purpose`
  spawns, which inherit the session's own model: the Haiku helper (`haiku-helper`) first for work
  within its job, then the Sonnet helpers (Claude Sonnet 5.5, or Sonnet 4.6 where Claude Code is
  older than 2.1.284; synthesis across many files, root-cause analysis, fresh-eyes verification of
  substantial work, or where Claude Code is older than 2.1.293). A forked session is for side tasks
  that need the conversation's full context; a fork inherits the lead model and cannot pin a
  cheaper worker.
- Dispatch the external relays (`codex-delegate`, `cursor-delegate`, `muse-delegate`) with
  `--lane <name>` when the profile lists the route; explicit `--model` or `--effort` flags still
  win when passed. Without a lane the relay passes no model and the CLI falls back to its own
  default, which may be its most expensive model and effort.
- Lane definitions live in `~\.config\delegate-skills\config.json` and the subagent definitions in
  `~\.claude\agents\`; both are installed by the packet and refreshed by re-running it.

### Codex CLI, Cursor Agent, Muse Code

- These agents find the same rules through the `consensus` skill in `~\.agents\skills\`, which
  points at this file and the profile. As workers they use advise mode (below) to ask the CTOs;
  they never chair a full consensus task unless they run a Tier 1 profile at xhigh or above.

## Consensus mode (two CTOs)

In desktop mode, for big or risky tasks two top-tier models must agree the finish line before
workers build, and both must sign off before the task is finished. A neutral referee program counts
rounds, calls and time against fixed limits and stops with a one-page split decision for the owner
when they are reached. See "Desktop mode and server mode" for how splits are handled on a server.
The how-to is the installed `consensus` skill. The profile says whether this machine can run it
and at which grade (it needs Node 18+ and two different usable models).

Roles come from model plus effort, never from vendor:

| Tier | Trusted with | Profiles today |
| --- | --- | --- |
| 1 CTO | chair or seat in consensus, architecture, ambiguous requirements, judging other models' work, final sign-off | GPT-6.2 Sol at xhigh or above; Claude Opus 5.5 at high, xhigh or max (first-choice Claude seat); GPT-6.1 Sol at xhigh or above (reserve); Grok 4.7 at xhigh through Cursor (backup seat); Claude Opus 5 at xhigh or max (reserve) |
| 2 Tech lead | work needing local judgment, breaking work down, hard debugging, reviewing developers | GPT-6.2 Sol at high; GPT-6.1 Sol at high; Opus 5.5 at medium; GPT-6 Sol and GPT-5.6 Sol at high or above; Grok 4.7 at high; Grok 4.6; Muse Spark 1.3; Claude Sonnet 5.5 and Sonnet 5 at xhigh or max |
| 3 Developer | bounded features and fixes from a clear brief; routine review of junior work | Claude Haiku 5.5 at high or above (the Haiku helper runs it at high); Claude Sonnet 5.5 at medium or high (the Sonnet helpers run it at high); Sonnet 4.6 at high; GPT-6 Luna, GPT-5.6 Luna and Terra at high or above; the Sol models at medium |
| 4 Junior | fully specified mechanical work; never reviews; always verified | Sonnet 5.5 at low; Sonnet 4.6 below high; Haiku 5.5 below high and older Haiku models |

Reviewer seats: the five CTO seats (GPT-6.2 Sol, Claude Opus 5.5, Grok 4.7, Claude Opus 5,
and GPT-6.1 Sol as the GPT reserve, all at xhigh) and four fallback seats below CTO level
(GPT-6 Sol, Claude Sonnet 5, Grok 4.6 and GPT-5.6 Sol, all at xhigh, Tech lead), used only when
no CTO-level partner is usable.

Rules:

- Pairs and grades: the referee always pairs two different models (never the same model twice)
  and picks the best usable one: CTO before Tech lead, then a different vendor, then a different
  model family, then its preference order (GPT-6.2 Sol, Opus 5.5, Opus 5, Grok 4.7, GPT-6.1 Sol,
  then GPT-6 Sol, Sonnet 5, Grok 4.6 and GPT-5.6 Sol). Two CTOs from different vendors is the
  standard grade; two CTOs from one vendor is a lower grade (single vendor); a pair with a Tech-lead
  seat is a lower grade (below CTO
  level); one seat alone is a single reviewer, never a consensus. The grade is in the referee's
  output, in `doctor` and at the top of every report; the chair tells the person the grade, and any
  reviewer marked "not verified" on this machine, before the task starts. With fewer than two
  different usable models, consensus is off here.
- Who chairs: the session the person started from, when it runs a Tier 1 profile at xhigh or
  above (Opus 5.5 at high or above). Claude and GPT are interchangeable; a Cursor session on
  Grok 4.7 at xhigh may chair too. On a machine with no CTO-level model at all, the session running
  the best available model may chair, and the task is labelled below CTO level. The co-CTO is a
  headless, read-only seat chosen by the referee by the pairing rule above, unless the chair names
  one (a named seat must be usable here and a different model).
- When: in desktop mode the agent suggests it in one plain sentence on mechanical triggers (8 or
  more files or more than one repository; money, payments, security, credentials, personal data or
  production paths; gates failed twice; irreversible steps; unclear, contradictory or architectural
  tasks). The person may decline, and may ask for it at any time. In server mode, see "Desktop mode
  and server mode". Small tasks stay as today.
- Task sizing (desktop trial): before nontrivial work (tiny edits skip it) the agent also runs the
  referee's `assess` command, passing what the triggers above say. A cheap assessor (GPT-6 Luna at
  high, read-only; Claude Sonnet 5.5 at high where Codex is missing, Sonnet 4.6 where Claude Code
  is older than 2.1.284) sizes the task in a fixed form, and the agent records what happened with
  `assess-outcome` when the task is finished.
  During the trial the triggers above still decide and the suggested tier is advisory; the agent
  tells the person, in one plain sentence, only when the two disagree. After 20 recorded outcomes
  (`assess-report`) the owner of this rulebook, and only the owner, decides whether the assessment
  replaces the size trigger (8 or more files, more than one repository) and the unclear,
  contradictory or architectural trigger; reaching the count changes nothing by itself. The
  danger triggers (money, payments, security, credentials, personal data, production paths, gates
  failed twice, irreversible steps) stay fixed permanently. An assessor is never a seat or a
  chair.
- Worker-started sessions (Muse, Cursor on Grok 4.6 or on Grok 4.7 below xhigh, Codex on Luna,
  Terra, GPT-6 Sol, GPT-6.2 Sol or GPT-6.1 Sol below xhigh, Claude on Sonnet or Haiku) use advise
  mode. In desktop mode, on the same triggers the worker offers the person the opinion of one CTO
  or both. Both means one report from two different models. When the two cannot agree in desktop
  mode, the split goes to the person. The
  CTOs advise and review; they hold no veto over the worker's finishing unless the person asks for a
  sign-off. At most 3 consultations per worker task.
- Limits (Standard): 2 finish-line rounds in desktop mode (see "Desktop mode and server mode" for
  server rounds), 3 sign-off rounds, 15 calls and 4 hours per task, 45 minutes per seat call;
  6 seat calls per consultation. No model can extend a budget. In desktop mode, a
  stopped task continues only as a new task the chair starts with `--continue-from`, which the
  ledger links for the person to see.
- Seats are read-only: no file changes, no commands that change anything, no delegation, no
  consensus of their own. A seat or a dispatched worker (environment `CONSENSUS_SEAT` or
  `DELEGATION_DISPATCHED` set) must never run the referee, and the referee refuses them. Every
  seat bills its subscription login; the referee strips API-key variables from the seat
  environment.
- Sign-off is a two-key act: the chair seals its own verdict first and the seat answers without
  seeing it. In desktop mode, only two DONE verdicts in the same round finish the task. Blocking items must
  cite a checklist line or a concrete defect with evidence; everything else goes to a "later"
  list. The chair still lands the change; the referee never edits project code.
- A seat's verdict is a claim like any worker's: the chair reruns the gates and reads the diff
  itself before landing.
- Never a silent single sign-off or an unlabelled downgrade: a lower grade is always stated. If a
  seat fails because the account does not offer its model, the task pauses. In desktop mode, the
  chair tells the person, who runs the packet installer with `--unavailable <model id>`. The chair
  then starts a new task with `--continue-from`, which picks the next usable pair. The reviewers
  of a running task are never changed silently. A
  machine with Claude Code alone still has everything else in this rulebook.

## Execution and credential boundaries

Use trusted isolated checkouts for workers. Workers are trusted with the person's logins, accounts
and credentials when a task needs them (see the ground rules); let a worker use the login already
on this machine (the logged-in `gh`, git's credential manager, a tool's own sign-in) rather than
pasting a secret into its brief, because briefs and results are kept on disk. Never print
credentials into chat or logs; installed files must not contain credentials, tokens, cookies,
session data, raw logs, or private events. Skills, runtimes, binaries, and sessions remain local
to each machine. Do not silently update a skill, install a runtime, authenticate a provider, or
change a user's account.

Delegation adds no permission of its own and takes none away: production writes, deployment,
scheduling, credential transfer, direct edits to shared documents or spreadsheets and messages to
other people need the person's OK exactly as they would without a helper, and once given, a worker
may carry them out. Existing project and service controls still apply.

## Evidence, accounting, and completion

Use returned usage and session receipts. Count preparation, failed or unknown dispatches, lead
review, and repairs. Do not claim savings or costs that are not evidenced. Keep raw results
private and return compact evidence with artifacts, checks, risks, and failed dispatches. Login,
health, or telemetry-only checks do not prove completion. Do not retry unchanged failures.

If blocked, exhaust safe in-scope checks and alternatives, then report the precise blocker. Mark
work complete only when the bounded objective and its acceptance checks are satisfied. Keep
unverified routes explicitly unverified.

## Preserved operating safeguards

Keep the selected lead model and effort. Tiny tasks stay local. Verify a worker route's
availability when used; a route is available only when the profile lists it and the tool is
logged in. Review a worker's artifact and decisive checks once; broaden only for a failed check,
a contradiction, missing provenance, or a material unresolved risk. Authorize exact shell checks
only when needed; never bypass permissions. Do not create a bespoke skill or modify the installed
skills for this configuration; ask the packet owner for changes. Do not launch interactive
usage-only sessions. Unknown usage remains unknown.
