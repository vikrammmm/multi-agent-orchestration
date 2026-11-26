# Team packet: specification

The contract for the installer. The packet is built from this source folder by
`build-packet.ps1`; the sources under `packet\` are edited here only.

## 1. Purpose

Give a person, in one step, the same working rules the owner uses: the delegation rulebook, the
five helper definitions for Claude Code (the Haiku helper and four Sonnet helpers), and the two-CTO consensus referee. It must work on
a machine that has any one or more of Claude Code, Codex CLI, Cursor Agent and Muse Code, giving
each the parts it can use. It must cope with whatever the machine has: older or newer CLIs, accounts
that lack some models, no CTO-grade model at all, and an older or newer packet already installed.
It never needs administrator rights, never touches credentials or account settings, backs up
anything it overwrites or removes, can be re-run safely (idempotent) and can be undone.

## 2. Packet layout (as unzipped)

```
delegation-team-packet/
  README.md                        for the person installing: what it is, what you need, how to install
  VERSION                          packet version, e.g. 2026.09.24-1
  CHECKSUMS.txt                    "<sha256>  <relative path with forward slashes>" per file, all files except itself
  install.cmd                      Windows one-click: forwards to install.ps1 with -ExecutionPolicy Bypass
  install.ps1                      Windows installer (Windows PowerShell 5.1 and PowerShell 7)
  install.sh                       macOS and Linux installer (bash 3.2 or newer)
  policy/POLICY.md                 the team rulebook
  policy/profiles/team.md.template rendered into profiles/team.md at install time
  claude/CLAUDE-bootstrap.md       the "## Delegation (shared rulebook)" block, placeholders {{SHARED_ROOT}}, {{PROFILE}}
  codex/AGENTS-bootstrap.md        the same block for Codex's AGENTS.md (wording for any agent), same placeholders
  claude/agents/haiku-helper.md, explore.md, implementer.md, researcher.md, verifier.md   helper definitions: Haiku 5.5 and Sonnet 5.5 (team copies from packet\claude\agents\),
  claude/agents/sonnet-4-6/explore.md, implementer.md, researcher.md, verifier.md   the previous Sonnet 4.6 copies, installed where Claude Code is older than 2.1.284
  claude/delegate-lanes.json       the owner's lane file (each lane's first-choice model)
  claude/lane-fallbacks.json       per lane, the models to try next when the first choice is not offered
  setup/resolve.mjs                the machine check both installers run (Node 18+, no dependencies)
  setup/tests/                     its tests (node --test), run by --self-test and by the build
  skills/codex-delegate/, cursor-delegate/, muse-delegate/, delegate-setup/
                                   the MIT-licensed relay skills (each with SKILL.md, scripts/, references/)
  consensus/                       byte copy of the shared consensus\ folder minus BUILD-BRIEF.txt
  frontdesk/                       exactly the files frontdesk\code-manifest.json lists, plus code-manifest.json
  ladder/manifest.json, ladder/releases/<release>/<each file in manifest.installable>
                                   the current published ladder release, nothing else from ladder\
```

The fixture harness (`packet\tests\fixtures.mjs`, section 5) lives in the source folder and is run
by the build against the staged packet; it is not shipped.

## 3. Installer behaviour (both platforms, identical semantics)

Options: `-DryRun` / `--dry-run` (plan only, change nothing); `-Yes` / `--yes` (no pause);
`-Uninstall` / `--uninstall`; `-TargetRoot <dir>` / `--home <dir>` (defaults to the user's home;
used for testing); `-SelfTest` / `--self-test` (run the referee's and the machine check's own tests
and the referee's `doctor`; no tokens are spent); `-AllowDowngrade` / `--allow-downgrade`;
`-Unavailable <ids>` / `--unavailable <ids>` (comma-separated model ids, for example
`claude-opus-5-5,claude-opus-5`, that this person's accounts do not offer; added to the saved
list); `-ClearUnavailable` / `--clear-unavailable` (empties the saved list first); `-Repos <dir>` /
`--repos <dir>` (the folder that holds the person's repositories, instead of the detected one;
kept for later runs); `-Credentials <folder>` / `--credentials <folder>` and `-Knowledge <folder>` /
`--knowledge <folder>` (remember the two personal folders; sh also accepts `--credentials=...` and
`--knowledge=...`). The long names work for both installers.

Owned locations (the only places the installer ever writes or deletes; `<home>` = the target root,
made canonical by resolving symlinks and junctions): `<home>/.config/delegate-skills/` (the
policy folder, the runtime, the ledger folder is created but never deleted, `config.json`,
`team-install.json`, `team-settings.json`, `.backups/team/`), the five helper files in
`<home>/.claude/agents/`, the folders `consensus`, `codex-delegate`, `cursor-delegate`,
`muse-delegate`, `delegate-setup` under `<home>/.claude/skills/`, `<home>/.agents/skills/consensus/`,
and the one section of `<home>/.claude/CLAUDE.md`. The one section of `<home>/.codex/AGENTS.md` is
written and removed only under section 3.5's own containment and ownership rules; it is not part of this list, whose
locations are themselves made canonical. The ladder's locations, `<home>/.config/delegate-skills/frontdesk/`
and `<home>/.config/delegate-skills/frontdesk-install.json`, are written by the front desk's installer, not by the
packet's own copy step, and the packet removes them only under section 3.4's ownership rule.

Canonical paths: a path is made canonical by resolving every existing component, following
symlinks and junctions (a link in the last component too); components that do not exist yet are
kept as written. The owned locations themselves are made canonical the same way, so a person
whose `.claude` folder is a link still owns what the installer put there. A path is
"owned-and-inside" when its canonical form lies inside a canonical owned folder or equals a
canonical owned file. Nothing is ever deleted or written unless it is owned-and-inside: a target
reached through a link that leads elsewhere is `SKIP (a link leads outside the owned folders)`,
and a listed file behind such a link is ignored.

Relay folders: a relay skill folder (`codex-delegate`, `cursor-delegate`, `muse-delegate`,
`delegate-setup`) that already exists and holds no file of this packet's receipt was installed by the
person and is left as it is (`KEEP (installed by you; not replaced)`).

Steps, in order:

1. **Locate and verify the packet.** Every path in `CHECKSUMS.txt` must exist and hash to the
   listed value; otherwise stop with "packet damaged or incomplete; download it again" (exit 2).
2. **Detect tools** by PATH lookup: `claude`, `node` (18 or newer), `codex`, `cursor-agent`, `muse`,
   each with `--version` (8-second limit; a failed version call is "found (version unknown)"). At
   least one of the four agents (`claude`, `codex`, `cursor-agent`, `muse`) must be found; with none,
   stop before any change with "No supported agent tool found (Claude Code, Codex, Cursor Agent or
   Muse). Install one, log in, then run the installer again." (exit 2). `--uninstall` needs no agent
   tool. Each agent's own parts follow section 3.5. If any of `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `CURSOR_API_KEY`, `XAI_API_KEY`, `MUSE_API_KEY` is set, warn naming it (never its
   value) and go on. If `<home>/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`
   when `XDG_CONFIG_HOME` is set and `<home>` is the user's own home, as Muse itself reads it) says
   `"contributor_mode_enabled": true`
   (since 2026.11.10-1; the value may be on the line after its key), warn "WARNING: Muse contributor
   mode is ON in <file>: ..." (Meta may train on what Muse is sent; banned for team work; switch it
   off in Muse) and go on. The installer only reads that file, never changes it, and does not need
   Muse to be found to warn. Whether the installed Muse relay protects its jobs is said in the
   summary (step 14), from the relay file actually there.
3. **Read the previous install.** First, the control files (`RECEIPT`, `SETTINGS`, the backup folder `.backups/team` and the
   ledger folder) must be owned-and-inside; if a link makes one lead outside, stop with
   exit 2 before any change ("<path> leads outside the installer's folders through a link; remove
   that link and run again"). If `RECEIPT` exists, read its `home`, `packetVersion` and `files`
   (PowerShell: `ConvertFrom-Json`; bash: the receipt's line format, as the uninstaller reads it).
   The receipt is ours only when its `home`, made canonical, equals the canonical target home;
   otherwise print "the receipt at <path> belongs to <home>; ignored" (or "... names no home;
   ignored" when it has none) and treat it as absent (no pruning, no recovery). Each listed path is used only when, made canonical (resolving every existing parent),
   it lies inside one of the owned locations; any other path is reported "outside the owned
   folders; ignored" and never touched. Compare versions (section 3.1): if the installed packet is
   newer than this one, stop with "A newer packet (<installed>) is installed; this one is <this>.
   Use the newer packet, or run again with --allow-downgrade." (exit 2). An unreadable receipt is
   reported and treated as absent.
4. **Settings.** `SETTINGS = <home>/.config/delegate-skills/team-settings.json` holds
   `{ "unavailable": [ "<model id>", ... ] }` (ids match `[A-Za-z0-9._-]+`). The saved list is
   only ever emptied by `--clear-unavailable`; nothing else may drop an exclusion. The file is
   readable only when the whole document is exactly that shape (a leading byte-order mark and
   whitespace between tokens allowed, none inside a string, no other keys); `{}`, a `null` or
   missing list, other keys, an invalid id or a truncated file are unreadable. Both installers
   apply this same rule:
   - the file exists and is readable: that list;
   - the file exists but is unreadable: without `--clear-unavailable`, stop with exit 2
     before any change: "team-settings.json could not be read; fix or delete it, or run again with
     --clear-unavailable to reset the list of unavailable models";
   - the file is missing and the previous receipt (ours, step 3) is schema 2 with a non-empty
     `unavailable`: that list, recovered, with the plan line "Recovered the unavailable models from
     the previous install: <ids>";
   - otherwise: empty.
   Then apply `--clear-unavailable` (empty the list) and `--unavailable` (add), sort and dedupe. The
   settings file is a target whenever the list is not empty; it is removed (a `REMOVE`) only when
   `--clear-unavailable` left the list empty. The receipt records the list (step 12), so a deleted
   settings file is always recoverable.
4a. **Find and decide the personal folders**, after receipt recovery and before rendering any entry
   section or showing the plan. With Node 18+ (the machine check's Node), run `setup/folders.mjs find
   --home <home> [--repos <dir>] --out <json>`; flags pass `--credentials <folder>
   --credentials-from set` and `--knowledge <folder> --knowledge-from set`. Without flags, pass the
   previous owned receipt's paths with `--credentials-from kept` / `--knowledge-from kept`.
   Existing set/kept directories bypass searching for that folder. A missing flag stays unset and
   advises `The folder given with --credentials does not exist: X.` (or `--knowledge`), while still
   collecting candidates; a missing remembered path searches again and advises `The remembered
   credentials folder X no longer exists; searched again.` (or `knowledge`).
   The general walk searches home to depth 4, repos to depth 2, then extra roots to depth 5.
   Defined `TEAM_FOLDER_ROOTS` (platform path delimiter; empty or `none` disables extras) replaces
   defaults: Windows D:–Z: `My Drive` and `Other computers`; macOS `~/Library/CloudStorage/*`;
   Linux none. Credential candidates have the exact
   case-insensitive name `credentials` (strong), or a token creds/cred/credentials/secret/secrets
   delimited by whitespace, dot, underscore or hyphen (weak). Only strong candidates auto-select.
   Knowledge candidates are git repositories named SecondBrain, second-brain, second_brain or
   second brain (any case), with a `.git` directory or gitdir file. Rank by SecondBrain origin URL
   suffix (knowledge only), absence of an `Other computers` ancestor, newest activity (credentials'
   own mtime; knowledge's newest `.git/index`, `.git/logs/HEAD`, `.git/FETCH_HEAD` mtime), shorter path.
   Offer at most nine candidates, including the choice. Never list a credentials candidate, follow
   links/junctions, enter repositories, dot/dollar folders or AppData, Library (except the explicit
   macOS cloud roots), node_modules, Windows, Program Files, Program Files (x86), ProgramData, venv,
   __pycache__. Read only git config/gitdir text and those mtimes, never credential contents.
   Stop after 40,000 directory listings or 30 seconds, mark `searchIncomplete`, and advise:
   `The folder search stopped early (too many folders); set the folders with --credentials and
   --knowledge if one is missing.` Tests can lower the directory budget with `TEAM_FOLDER_BUDGET`
   and seconds with `TEAM_FOLDER_SECONDS`.
   First list children at the roots and common parents: Documents, Documents/GitHub, GitHub,
   source/repos, repos, src, code/Code, projects/Projects, dev, work, workspace, git, Desktop;
   under an Other computers root also try each PC and its Documents, Documents/GitHub, GitHub,
   Desktop. The same pruning/privacy rules apply to these parent paths. Keep quick-pass findings
   if the subsequent walk hits its budget. Walk all roots breadth-first, interleaving roots within
   each level and reusing quick-pass listings; no directory is listed twice.
   Without Node use existing flags/remembered paths, otherwise unset; skip search.
   Prompt for each null path only with terminal stdin, without `--yes`, `--dry-run` or `--uninstall`
   (PowerShell also requires UserInteractive). Show numbered candidates and ask `Type a number,
   a folder path, or press Enter to skip:`. A candidate number or existing directory becomes
   source `asked`; Enter skips; invalid paths print `That folder does not exist.` and retry,
   at most three times. Noninteractive runs never wait for input, including install confirmation.
   Write the decided JSON, then `folders.mjs render --decided <json> --out <dir>` emits:
   - `folders.md`: exactly two profile lines, Credentials folder and Knowledge base (SecondBrain
     repository), with a backticked native path and found / set with --credentials (or --knowledge) /
     chosen by you / kept from the last run; unset lines say to run the installer with that flag.
   - `folders-section.md`: the remembered-folders paragraph with forward-slash paths; credentials
     are the person's logins, keys and account details, used when needed; search SecondBrain for
     project and background knowledge before asking. Unset lines say to ask once and rerun with the flag.
     Fill `{{FOLDERS}}` just before each bootstrap's final ownership paragraph, and in the profile.
     Unknown placeholders remain errors. Node-free rendering has identical wording.
   - `folders-summary.txt`: selected/unset paths, alternatives/candidates and every advice line,
     printed after Repositories. Repeat runs preserve unchanged content when only provenance
     changes to kept (the profile keeps the original discovery wording); the receipt records kept.
5. **Run the machine check** (only when Node 18+ is present): `node <packet>/setup/resolve.mjs
   --packet <packet> --home <home> --settings <file with the new list> --out <new temp folder>
   [--repos <dir>]` (`--repos` when given, else the folder the previous receipt recorded)
   with the detected tools in the environment (section 3.2). It decides the lane file, the seat
   file (`local.json`) and the consensus grade, and writes them as text files (section 3.3). It
   succeeded when it exited 0 and every required output exists (`lanes.json` too whenever codex,
   cursor-agent or muse was found).
6. **Degraded mode** (no Node, or the machine check failed; print its first output line):
   - on a machine that has a previous install of ours: every file of the runtime (with the two
     consensus skill copies), the relays, the lane file and `local.json` that the previous receipt
     lists is kept exactly as it is (plan
     `KEEP (machine check failed)` or `KEEP (needs Node 18+)`; no update, no removal), so earlier
     restrictions stay in force;
   - on a fresh install without Node: no runtime, no relays, no lane file (`SKIP (needs Node 18+)`);
   - on a fresh install with Node but a failed check: the runtime is installed with `local.json`
     `{ "disabled": "machine check failed: <first line>", "seats": {} }` (written by a JSON
     serializer, so any first line stays valid JSON), which switches consensus
     off in the referee until the installer runs again successfully; relays and the lane file are
     `SKIP (machine check failed: <first line>)`.
   The core (rulebook, profile, and for each agent found its own parts of section 3.5: the helper
   definitions and `CLAUDE.md` section, the Codex `AGENTS.md` section) installs in every case.
7. **Compute the targets.**
   - `POLICY_DIR = <home>/.config/delegate-skills/team-policy/` with `POLICY.md` (copied) and
     `profiles/team.md` (rendered). This folder is `{{SHARED_ROOT}}`.
   - `AGENTS_DIR = <home>/.claude/agents/` with the five helper files (copied). The four
     Sonnet helper files come from `claude/agents/sonnet-4-6/` (the previous
     Sonnet 4.6 copies) where this machine's Claude Code is older than 2.1.284, else from
     `claude/agents/` (Sonnet 5.5); `haiku-helper.md` always comes from `claude/agents/`.
     Which set the machine check picked is its `sonnet-helpers.txt` (`5.5` or `4.6`); when
     the check did not run or failed, the installer's own Claude Code version decides
     (known and below 2.1.284: 4.6, otherwise 5.5). Both sets use the same installed target names,
     so ownership, receipts and uninstall stay as they are.
   - `CLAUDE_MD = <home>/.claude/CLAUDE.md`: the section rendered from `claude/CLAUDE-bootstrap.md`.
   - `RUNTIME_DIR = <home>/.config/delegate-skills/consensus/` (Node 18+ only): the packet's
     `consensus/` without `tests/` and `skill/`, plus `local.json` (from the machine check, or the
     disabled one of step 6). `LEDGER = <home>/.config/delegate-skills/consensus-ledger/` is created.
   - Skill copies with the runtime: `<home>/.claude/skills/consensus/SKILL.md` and
     `<home>/.agents/skills/consensus/SKILL.md`, rendered from `consensus/skill/consensus/SKILL.md`.
   - Relay skills (Node 18+ and a successful check only): `codex-delegate` when `codex` was found,
     `cursor-delegate` when `cursor-agent` was found, `muse-delegate` when `muse` was found,
     `delegate-setup` when at least one relay is installed; every file of the packet's folder is a
     target of its own.
   - `LANES = <home>/.config/delegate-skills/config.json` = the machine check's `lanes.json`, when
     at least one relay skill is installed.
   - `SETTINGS` as in step 4; `RECEIPT = <home>/.config/delegate-skills/team-install.json`.
8. **Prune what the previous install left behind.** Every owned-and-inside path of the previous
   receipt that is not a target of this run and not kept by step 6: unchanged since installed
   (hash equals the receipt) → `REMOVE`; changed by someone → `KEEP (changed since install)`, left
   byte-identical in place; missing → ignored. This applies inside relay folders too: files the
   packet no longer ships are removed only when unchanged, and files that were never ours are not
   touched. `CLAUDE.md` is never pruned.
9. **Render placeholders.** `{{SHARED_ROOT}}`, `{{PROFILE}}`, `{{REFEREE}}`, `{{LEDGER}}` and the
   profile's date, OS, home, packet and tool versions as v1 (backslashes become forward slashes
   on macOS and Linux); `{{REPOS}}` and `{{OTHER_TOOLS}}` = the machine check's `repos.md` and
   `tools.md` (in degraded mode `- Repositories: <--repos folder>` or `- Repositories: not detected
   (the model check did not run)`, and `- not checked (the model check did not run)`);
   `{{ROUTES}}`, `{{LANES}}`, `{{CONSENSUS}}` = the machine check's
   `routes.md`, `lanes.md`, `consensus.md`. In degraded mode the installer writes them itself:
   `{{ROUTES}}` = `- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to
   try; needs Claude Code 2.1.293 or newer` and the Sonnet line by the installer's own Claude
   Code version (known and below 2.1.284: `- Sonnet helpers (explore, researcher, implementer,
   verifier): Claude Sonnet 4.6 here, because Claude Code <version> is older than 2.1.284;
   update Claude Code and run this installer again for Sonnet 5.5`, otherwise `- Sonnet helpers
   (explore, researcher, implementer, verifier, Claude Sonnet 5.5): always available`) (two lines);
   `{{LANES}}` = `- none: the relays need Node 18+`, `- none: the machine check failed`
   or, when the previous setup is kept, `- unchanged: the previous lanes are kept (machine check
   failed)`; `{{CONSENSUS}}` = `off: no Node 18+`, `off: the machine check failed`, or `unchanged:
   the previous reviewer setup is kept (machine check failed)`. Any `{{` left in a rendered file is
   an error (exit 1).
10. **CLAUDE.md splice rule.** As v1.
11. **Plan.** One line per target: `CREATE`, `UPDATE`, `UNCHANGED`, `REMOVE`, `KEEP (<why>)`, or
    `SKIP (<reason>)`; then exactly one version line ("Upgrading from X to Y", "Re-installing Y",
    "Downgrading from X to Y (allowed)" or "New install of Y"); the detected tools; the models
    declared unavailable; and the machine check's `summary.txt` lines. The profile's date line is
    neutralised as in v1. `--dry-run` stops here (exit 0); otherwise, unless `--yes`, wait for Enter.
12. **Apply.** First back up every file that will be updated or removed to
    `<home>/.config/delegate-skills/.backups/team/<stamp>/<path relative to home, separators
    replaced by "-">` and re-hash each backup; if any backup cannot be written or does not match,
    stop with exit 1 before any file is written or deleted. Then write (byte copies; rendered files
    UTF-8 without BOM with LF), delete the `REMOVE` files, remove owned folders left empty, and
    re-hash every written file (mismatch: exit 1; backups stay). Receipt (schema 2): `{ schema: 2,
    packetVersion, previousPacketVersion, installedAt, platform, home, tools: {...}, unavailable:
    [...], refresh: { status, reason, at }, consensus, lanes, repos: { path, count } | null,
    folders: { credentials: { path, source } | null, knowledge: { path, source } | null },
    relays: [names], files: {
    "<absolute path>": "<sha256>" }, backupDir }`. `refresh` records this run's machine check
    separately from what is installed: `{ "status": "ok", "at": ... }` after a successful check;
    `{ "status": "failed", "reason": "<first line>", "at": ... }` after a failed one;
    `{ "status": "skipped", "reason": "no Node 18+", "at": ... }` without Node. `consensus` (`{
    grade, pair, reason }`) and `lanes` (`{ <lane>: "<model> <effort>" }`) always describe the
    setup that is actually installed: after a successful check, from its `receipt.json`; when
    degraded mode keeps a previous setup, copied unchanged from the previous schema 2 receipt, or
    `null` (unknown, not reconstructed) when the previous receipt is schema 1; on a fresh degraded
    install, where reviewers and lanes are really absent or disabled, `{ "grade": "off", "pair":
    [], "reason": "<the rendered consensus text>" }` and `{}`. `files` includes every kept file
    with its previous hash, so ownership is never lost. Both installers ignore the `sharedRoot`
    and `profile` fields in older receipts.
13. **Post-install check.** When the runtime is installed, run `node <REFEREE> doctor --human`
    (no tokens) and print it.
14. **Summary**, in plain words: the model check's result on its own line ("Model check: done",
    "Model check: failed (<reason>); your previous reviewer and lane setup is kept unchanged", or
    "Model check: failed (<reason>); reviews are off until it succeeds", or "Model check: skipped
    (no Node 18+)"); then (since 2026.11.10-1) the Muse contributor lines, from
    `<home>/.claude/skills/muse-delegate/scripts/relay.mjs` as it is after this run (installed, updated, kept
    from before or the person's own): when it is byte-identical (SHA-256) to this packet's
    `skills/muse-delegate/scripts/relay.mjs` and the setting is on, the setting warning again with "The Muse
    relay at <file> switches it off for every job it runs; what you run in Muse yourself is not covered, ...";
    when it is another file that contains `"--contributor-mode", "off"`, "WARNING: the Muse relay at <file> is
    not this packet's relay (...). It mentions --contributor-mode off, but the installer cannot confirm that it
    switches off Meta's contributor tier for its jobs. ..."; when it does not contain it, "WARNING: the Muse
    relay at <file> does not switch off Meta's contributor tier (...)"; with no relay and the setting on, "...
    no Muse relay is installed here to switch it off ..."; when the Muse found reports a version older than
    1.4.15, "WARNING: Muse <x.y.z> is older than 1.4.15: the Muse relay refuses it ..."; what was installed,
    updated, removed, kept or skipped and why; the
    lane choices and substitutions; the reviewer grade, the seats that are not verified, and what
    would raise the grade; the declared-unavailable models and how to change them; where the
    backups are; how to undo; and "After you update Claude Code, Codex or Cursor, or log in to one
    of them, run this installer again: it re-checks your models." Next step: start a new Claude
    Code session.
15. **Uninstall.** Read the receipt (schema 1 or 2). A receipt whose `home` is not the canonical
    target home: stop with "the receipt belongs to <home>; nothing removed" (exit 2); a receipt
    without a `home`: stop with "the receipt names no home; nothing removed" (exit 2). Delete every
    owned-and-inside listed file whose current hash still matches (a changed file is left and
    reported); remove owned folders left empty; remove the "## Delegation (shared rulebook)"
    section from `CLAUDE.md`, and from `.codex/AGENTS.md` when the receipt lists it, with the splice
    rule; no agent tool needs to be installed; keep the backups and the ledger; delete the
    receipt last. Without a receipt: stop with "nothing to uninstall" (exit 2).
16. **Self-test.** With Node: run `node --test` inside the packet's `consensus/` (with
    `CONSENSUS_LEDGER` set to a fresh temporary folder) and inside `setup/`, print each suite's
    tests, pass and fail counts, then `doctor --human` from the installed runtime if present. The
    self-test exits 1 when any suite fails or cannot run, naming it; 0 only when all pass. Without
    Node: say so and exit 0.
17. **Exit codes:** 0 success; 2 precondition (Claude Code missing, damaged packet, ambiguous
    `CLAUDE.md`, nothing to uninstall, a newer packet installed, a receipt of another home or of
    no home at uninstall, an unreadable settings file, a control file behind an outside link);
    1 unexpected error or a failed self-test.
18. **Never:** read or copy credentials, write or delete outside the owned locations, run any agent
    with a real prompt, change account settings, write a hook into any tool's settings, or require
    administrator rights. The only network
    traffic is the machine check's `cursor-agent models` call (lists the person's models; spends no
    tokens; skipped when `cursor-agent` is absent).

### 3.1 Packet versions

A version is `YYYY.MM.DD` optionally followed by `-N`. Compare the date parts numerically, then
`N` (missing `N` counts as 0). A receipt without `packetVersion` counts as older than any packet.

### 3.2 Machine check inputs

The codex-review/codex-implement first choice is gpt-6.2-sol high, then gpt-6.1-sol high,
then their existing fallbacks (beginning with gpt-6-sol high). The CTO preference order is
GPT-6.2 Sol, Opus 5.5, Opus 5, Grok 4.7, GPT-6.1 Sol (reserve), GPT-6 Sol, Sonnet 5, Grok 4.6,
GPT-5.6 Sol. Both GPT CTO seats use xhigh, the read-only sandbox and standard service tier;
GPT-6.1 keeps its id, eligibility and tier 1 grade for existing ledgers and unavailable marks.

`node resolve.mjs --packet <dir> --home <dir> --settings <file> --out <dir>`. Environment set by
the installer: `TEAM_CLAUDE`, `TEAM_CODEX`, `TEAM_CURSOR`, `TEAM_MUSE` (the detected launcher path,
empty when not found) and `TEAM_CLAUDE_VERSION`, `TEAM_CODEX_VERSION`, `TEAM_CURSOR_VERSION`,
`TEAM_MUSE_VERSION` (the `x.y.z` found, empty when unknown); `CODEX_HOME` (Codex's own variable)
locates the Codex model cache. Test hooks, used only by the harness: a non-empty `TEAM_SETUP_FAIL` makes the
check exit 1 at once (its value other than `1` appears in the error line); `TEAM_DESKTOP_CLAUDE_ROOT`
points the desktop-app Claude search at another folder; `TEAM_SETUP_SKIP=<output file name>` makes it skip writing that file.

What it discovers, without spending tokens:
- **Codex models**: `<CODEX_HOME or <home>/.codex>/models_cache.json`, written by Codex itself.
  Offered = models with `visibility` "list" and the effort among `supported_reasoning_levels`.
  Missing or unreadable file: "unknown" (reason "Codex has no model list yet").
- **Cursor models**: `<TEAM_CURSOR> models` with a 20-second limit (on Windows a `.cmd` launcher
  runs through `cmd.exe /d /s /c`), parsed as `<id> - <label>` lines (a BOM and zero-width
  characters removed, `Tip:` lines skipped). Exit non-zero, timeout or no model lines: "unknown"
  (reason = the first line of its output, for example not logged in).
- **Claude models**: the Claude Code version only; access through the person's plan cannot be
  checked without a paid call, so Claude seats are marked "not verified" unless declared unavailable.
- **Muse models**: `muse-spark-1.3` when `muse` was found.
- **Declared unavailable** (from `--settings`): treated as not offered, whatever the lists say.

### 3.3 Machine check outputs (files in `--out`; UTF-8, LF, each ending with a newline)

- `local.json` (always): `{ "seats": { "<id>": { "unavailable": "<reason>" } | { "unverified":
  "<reason>" } } }`. Unavailable: a Codex seat whose (model, effort) the known Codex list does not
  offer; a Cursor seat whose model the known Cursor list lacks; any seat whose model is declared
  unavailable. Unverified: every Claude seat not declared unavailable ("Claude plan access to
  <model> is not verified"), and Codex or Cursor seats whose list is unknown. Seats whose CLI is
  missing or too old are left to the shared eligibility rule.
- Eligibility, pairing and grades come from the referee's own code, imported from
  `<packet>/consensus/lib/select.mjs` (`seatEligibility` with facts built from the environment
  and this `local.json`, `pickPair`, `gradeOf`), so the installer and the installed referee make
  the same decisions (section 5 checks it).
- `lanes.json` (only when codex, cursor-agent or muse was found): the lane file
  (`delegate-fleet.v1`). For each lane of `claude/delegate-lanes.json` whose implementer's tool was
  found, in that order: candidates = the lane's own model and effort, then its entries in
  `claude/lane-fallbacks.json`; declared-unavailable models are skipped; the first candidate the
  tool offers wins; with an unknown list the first candidate wins, marked not verified; with a
  known list offering none the lane is left out. Other lane fields are copied unchanged.
- `routes.md`: `- Haiku helper (haiku-helper, Claude Haiku 5.5): the first Claude helper to try`
  (Claude Code 2.1.293 or newer, its version unknown, or no Claude Code found; otherwise `...: needs
  Claude Code 2.1.293 or newer (found <version>); use the Sonnet helpers until then` plus the matching
  advice line), `- Sonnet helpers (explore, researcher, implementer, verifier, Claude Sonnet 5.5):
  always available` (Claude Code 2.1.284 or newer, its version unknown, or no Claude Code found;
  otherwise `- Sonnet helpers (explore, researcher, implementer, verifier): Claude Sonnet 4.6 here,
  because Claude Code <version> is older than 2.1.284; update Claude Code and run this installer
  again for Sonnet 5.5` plus the matching advice line),
  then `- Codex CLI via codex-delegate: <kept lanes>`, `- Cursor Agent via cursor-delegate: ...`,
  `- Muse Code via muse-delegate: ...` for each found tool with at least one kept lane.
  The effective Claude Code version is the desktop app's newer engine when it serves the reviewers.
- `lanes.md`: one bullet per lane of the found tools: `- <lane>: <model> at <effort>` (or `-
  <lane>: <model>`), plus ` (fallback: <first choice> is not offered here)` when a fallback was
  chosen and ` (not verified: <reason>)` when the tool's list is unknown (both can apply, for
  example a declared-unavailable first choice on a Codex without a model list); a left-out lane `- <lane>: left out (none of <candidates> is offered here)`. No lanes:
  `- none: no Codex, Cursor or Muse CLI was found`.
- `consensus.md`: the best pair from `pickPair` over the eligible seats. First line:
  `on, standard grade (best pair: A + B)`, `on, lower grade: single vendor (A + B)`,
  `on, lower grade: below CTO level (A + B)`, or `off: fewer than two different models are usable
  here`; then the grade note when not standard; then `Not verified here: <seat> (<reason>)` for
  each pair seat marked unverified; then the advice lines as `- <text>`.
- `summary.txt`: `Lanes: <kept> ready (<f> on a fallback, <v> not verified, <o> left out)`, one
  line per fallback, not-verified or left-out lane, `Consensus: <first line of consensus.md>`, the
  not-verified lines, then each advice text.
- `repos.md`: `- Repositories: <folder> (<n> git repositories[, set with --repos])`, or `- Repositories:
  not found; run this installer with --repos <folder> to set it`. The folder is `--repos` when given,
  else the usual place (`Documents/GitHub`, `GitHub`, `source/repos`, `repos`, `src`, `code`,
  `Code`, `projects`, `Projects`, `dev`, `Developer`, `workspace`, `git`, `OneDrive*/Documents/GitHub`
  under the home) holding the most git repositories one or two levels down.
- `tools.md`: one line per other tool found on PATH (git, GitHub CLI, Gemini CLI, Qwen Code, Aider)
  with its version, "no relay; use it directly"; or that none was found.
- A newer Claude Code in the desktop app (Windows `%APPDATA%/Claude/claude-code/<version>/claude.exe`;
  macOS, not verified, `~/Library/Application Support/Claude/claude-code/<version>/claude`) whose
  version is above the command line's: `local.json` gets `binaries.claude` pointing at it, the
  reviewer picks use its version, and an advice line says so (update the command line, then run
  the installer again, since the app replaces that folder when it updates).
- `summary.txt` also carries `Repositories: ...` and `Other tools: ...` lines.
- `receipt.json`: one line, `{"consensus":{"grade":"<level or off>","pair":[...],"reason":"<first line>"},"lanes":{"<lane>":"<model> <effort>"},"repos":{"path":"<folder>","count":<n>}|null,"sonnetHelpers":"5.5"|"4.6"}`.
- `sonnet-helpers.txt`: `5.5` or `4.6` (which Sonnet helper set the installer must install;
  the installers use it when the check wrote it and otherwise fall back to their own Claude
  Code version).

Advice (each only when it applies): Claude Code below the route minimum ("Update Claude Code to
2.1.248 or newer to use the Claude reviewers (found <v>)."), else below 2.1.280 ("Update Claude Code
to 2.1.280 or newer to enable the Opus 5.5 reviewer (found <v>)."); Claude Code below 2.1.284
("Update Claude Code to 2.1.284 or newer to get the Sonnet 5.5 helpers (found <v>); until then the
Sonnet helpers run Claude Sonnet 4.6."); Claude Code below 2.1.293 ("Update Claude Code to 2.1.293
or newer to use the Haiku helper (found <v>); until then use the Sonnet helpers."); Codex found without a list
("Open Codex once so it downloads its model list, then run this installer again."); a known Codex
list missing a GPT-6 model a lane or seat wants ("Your Codex does not offer <models> yet: update
Codex or check your ChatGPT plan, then run this installer again."); Cursor list unknown ("Log in to
Cursor Agent (cursor-agent login), then run this installer again (<reason>)."); Cursor grok lanes on
Grok 4.6 ("Your Cursor plan does not offer Grok 4.7; the Cursor lanes use Grok 4.6."); Claude seats
not verified ("If your Claude plan does not include <models>, run this installer with --unavailable
<ids> so the reviewers skip them."); grade single vendor, below CTO or off (what would raise it);
Claude version unreadable ("Claude Code's version could not be read; the Claude reviewers are
assumed available.").

### 3.4 The role ladder

The role ladder is the packet owner's list of approved engineers (a model at an effort) in four roles, read with the
front desk's `role.mjs` (`plan`, `list`, `doctor`). The packet installs it **without hooks**: no Claude Code, Codex or
Muse settings file is ever changed for it.

**When.** After the core, runtime and relays are written (step 12) and before the summary, both
installers decide the ladder step in this order, and print the result under a `Ladder` heading:
2. no Node 18 or newer (missing, or a major version below 18): `SKIP (needs Node 18+)`;
3. containment: `<home>/.config/delegate-skills/frontdesk`, its existing children (`bin`, `bin.prev`, `generations` and
   every generation folder, `state`, `logs`, `current.json`), `frontdesk-install.json` and `.backups/frontdesk` must be
   owned-and-inside under the canonical-path rule of section 3; otherwise `SKIP (a link leads outside the owned folders)`
   (checked again right before the front desk runs);
4. ownership (never adopt): the front desk runs only when (a) neither the `frontdesk` folder nor `frontdesk-install.json`
   exists, or (b) the packet receipt has `ladder.owned` true and the front desk receipt is absent or is readable with
   `installedBy` `team-packet` and no hooks; otherwise `KEEP (a front desk installed outside this packet is here; left
   as it is)`.

**What runs.** `node <packet>/frontdesk/install-frontdesk.mjs install --no-hooks --no-live-check --installed-by team-packet
--exclude-required qwen-local --exclude-declared <the saved unavailable ids joined by commas, or -> --shared-root <packet>
--home <home> --yes` (without `--yes` in `--dry-run`, whose output is shown and which writes nothing). The front desk
installer verifies its own code manifest and the release manifest, installs its program and one generation, and
records in its receipt `installedBy: team-packet` and `exclusions: { required, declared }`; `required` always contains
`qwen-local` and is sticky. Its exit codes: 0 success; 1 refused before any change or failed
with the prior state restored; 4 failed with an incomplete rollback. A failure never aborts the packet install or
changes its exit code: the summary says `Ladder: not installed (<first error line>); the previous state is kept` or
`Ladder: install failed and its rollback is incomplete (<first error line>); see the front desk backups`. The harness
variable `TEAM_LADDER_TEST_FAIL=<point>` passes `FRONTDESK_TEST_HOOKS=1` and `FRONTDESK_TEST_FAIL=<point>` to that one
call; nothing else sets them.

**Receipt.** The packet receipt gains `ladder: { owned, lastInstalled: { release, generation, frontdesk, at } | null,
lastAttempt: { status, reason, at } }`, written on one line so the bash installer can read it without Node. Status is
`installed`, `unchanged`, `skipped`, `kept`, `failed` or `failed-rollback-incomplete`. `owned` becomes true after the
first successful install into an empty location and is carried forward with `lastInstalled` by every later run
whatever its outcome; only `--uninstall` ends it. A receipt from an older packet has no `ladder` and counts as not
owned. The front desk's files are not listed in `files`; the front desk keeps its own receipt. On an unchanged repeat
the front desk receipt, program and generation are byte-identical, and the packet receipt may differ only in these
operational fields: `installedAt`, `previousPacketVersion`, `refresh.at`, `ladder.lastAttempt`, and `backupDir` only
when a backup was made (otherwise the previous value is kept).

**Profile.** `{{LADDER}}` renders as `- Role ladder: installed (release <r>, front desk <v>); ask it with node
"<home>/.config/delegate-skills/frontdesk/bin/role.mjs" plan "<role>"` or `- Role ladder: not installed (<why>)`.
The profile is written after the ladder step, so it shows the real result.

**Uninstall.** When `ladder.owned` is true, containment passes, and the front desk receipt is absent or readable with
`installedBy` `team-packet` and no hooks, `--uninstall` removes `<home>/.config/delegate-skills/frontdesk/` and
`frontdesk-install.json`, deleting links themselves and never what they point to; otherwise it keeps them and says
why (bash without Node 18+ keeps a front desk whose receipt it cannot read). The front desk's own `uninstall` is not
called.

**What the ladder checks.** `role plan` refuses (exit 2 not installed, exit 3 broken) when the front desk receipt is
missing or broken; a receipt with `installedBy` `team-packet` whose `exclusions` are missing or lack `qwen-local` is
broken. It checks installed tools and versions, not what an account offers; declared unavailable ids switch off both an
engineer whose family matches and any route whose model matches.

### 3.5 Agents present

A machine may have any one or more of Claude Code, Codex, Cursor Agent and Muse (step 2 refuses only when none is
found). Every machine gets the rulebook and profile, `team-settings.json` and the receipt; with Node 18+ the machine
check, the runtime, both consensus skill copies, the relays (each when its agent is found), the lane file and the
ladder, by the rules above. Per agent:

- **Claude Code** (found): the five helper files and the `CLAUDE.md` section. Not found: each is
  `SKIP (needs Claude Code)`; the machine check offers no Claude lane, helper or seat, and the grade comes from the
  remaining seats by section 3.3's rules.
- **Codex** (found): the `## Delegation (shared rulebook)` section in `<home>/.codex/AGENTS.md`, rendered
  from `codex/AGENTS-bootstrap.md` with the same placeholders, with its own byte-level splice (not the `CLAUDE.md`
  code, which normalizes line endings):
  - A UTF-8 BOM is kept and ignored when matching line 1; the file's line ending is CRLF when its first line break is
    CRLF, else LF. The section runs from its heading line (exact text, trailing spaces or tabs allowed) to the start of
    the next line beginning with `## `, or to the end of the file. The rendered section uses the file's line ending,
    holds no other `## ` line, ends with one line break, and is followed by a blank line when another heading follows.
  - Replace an owned section in place (a repeat is byte-identical). Append when there is none, after a separator: none
    for an empty file, one line break when the file ends with one, two when it does not. Create the file when missing
    (no BOM). More than one such heading: the run refuses before any change (exit 2).
  - `--uninstall` deletes the section's bytes, and also the recorded separator when the section ran to the end of the
    file and the separator is still just before it (never when other text follows, so no lines are joined); it deletes
    the file only when the packet created it and it is now empty. With nothing else changed, the original bytes come
    back exactly.
  - Ownership: the receipt records `codexSection` on one line (`{"owned": true, "path": "<canonical file path>",
    "created": <bool>, "separator": "<escaped>"}`, or null). The packet writes only a section it appends now or that the
    previous receipt, valid and for the same canonical home, records as owned at the same canonical path. A section it
    does not own is `KEEP (a "Delegation (shared rulebook)" section the packet did not write is here; left as it is)`.
    `--uninstall` removes only an owned section at that path; skipped runs never create ownership, and an owned section
    stays recorded when Codex disappears, so `--uninstall` still removes it with no agent tool found.
  - Containment: `AGENTS.md` is not in the canonicalized owned list. Before any planning, write or removal, the
    canonical form of `<home>/.codex/AGENTS.md`, resolving every existing component including the file itself, must lie
    inside the canonical home; otherwise `SKIP (a link leads outside this home)` for the section only, ownership
    unchanged. `CODEX_HOME` set and not resolving to `<home>/.codex`: `SKIP (CODEX_HOME points to <path>, outside this
    home: add the section there yourself)`, and the summary names the file and section.
- **Muse** and **Cursor Agent**: no file of their own. Muse reads Claude Code's and Codex's instruction files and the
  consensus skill; Cursor keeps its user rules in its app settings, which the installer never touches. When neither
  Claude Code nor Codex is found, the summary and the profile say: "No instructions file written: tell your agent to
  read <home>/.config/delegate-skills/team-policy/POLICY.md before nontrivial work (Muse also finds the consensus
  skill)."

A tool that was found by an earlier run and is not found now: the helper files, the `CLAUDE.md` section and the Codex
section that the previous receipt lists are kept exactly as they are (`KEEP (Claude Code not found; left as
installed)`, `KEEP (Codex not found; left as installed)`): not updated, not pruned, carried forward in the receipt;
`--uninstall` removes them as usual. The profile's `{{ENTRY}}` line names the instruction files written
(`- Rulebook entry: Claude Code (CLAUDE.md section), Codex (AGENTS.md section)`, whichever apply) or carries the
sentence above, and the tools line shows `Claude Code: not found` when it is missing.

## 4. Platform notes

As v1, plus: the installers never parse JSON in bash beyond the receipt's line format; everything
model-dependent is decided by the machine check and read back as text. Canonical paths: PowerShell
`[System.IO.Path]::GetFullPath` plus resolving reparse points of existing parents; bash `cd -P` /
`pwd -P` on the existing parent. Resolver outputs are UTF-8 with LF line endings.

## 5. Fixture harness (must pass before the packet is built)

`packet\tests\fixtures.mjs` (Node 18+) runs the installers against a staged packet: on Windows both
`install.ps1` (through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`) and `install.sh`
(through Git for Windows' `bash.exe` when present), on macOS and Linux `install.sh`. Each scenario
uses a fresh temporary home and a PATH made of a fake-tools folder, the folder of the real `node`
(only when the scenario wants Node) and the system folders; fake tools answer `--version` and, for
`cursor-agent`, `models`. Codex model lists are fake `models_cache.json` files. After every
scenario that leaves the runtime installed, the harness runs the installed `referee.mjs doctor`
with the same PATH and checks that its best pair and grade equal the last install's consensus line
(or, after a degraded run that prints none, the receipt's `consensus`); the pair's order may differ
only by the drafting rule, and with grade `off` only the grade is compared. It prints one PASS or
FAIL line per scenario and installer and exits non-zero on any failure.

1. `--dry-run`: every target `CREATE`, the two unrelated `CLAUDE.md` sections untouched, nothing written.
2. install: all targets created; receipt schema 2 lists them; `CLAUDE.md` has the section plus the
   two original sections; `profiles/team.md` has no `{{`.
3. install again: every target `UNCHANGED`, no new backup folder.
4. hand edit inside `## Notes`, install again: section refreshed, hand edit kept.
5. `--uninstall`: owned files gone (including `local.json`, the relays and the settings file),
   original sections and hand edit intact, backups kept, receipt gone.
6. no Node, no codex, cursor-agent or muse: runtime, consensus skill, relays and lanes `SKIP`,
   consensus `off: no Node 18+`, install succeeds.
7. Node but no codex or cursor-agent, Claude Code 2.1.280: consensus
   `on, lower grade: single vendor (claude-opus-5.5 + claude-opus)`, Claude seats not verified.
8. every tool, all models offered, Claude Code 2.1.280: every lane on its first choice; consensus
   `on, standard grade`; an `ANTHROPIC_API_KEY` in the environment gives the warning only.
9. damaged packet (one byte of `consensus/VERSION` changed in a copy): stops before any change.
10. Claude Code 2.1.259: the Opus 5.5 advice line; consensus standard with Opus 5 (`claude-opus`).
11. Codex list without GPT-6: the Codex lanes on their GPT-5.6 fallbacks with the fallback note;
    `local.json` marks `gpt-6.2-sol`, `gpt-6.1-sol` and `gpt-6-sol` unavailable.
12. Codex found without a model list: Codex lanes on their first choice "not verified", the
    "open Codex once" advice, Codex seats not verified.
13. Cursor list without Grok 4.7: the Cursor grok lanes on `cursor-grok-4.6-xhigh-fast`;
    `local.json` marks `grok-4.7` unavailable.
14. `cursor-agent models` fails ("not logged in"): Cursor lanes "not verified", the log-in advice.
15. no CTO usable (Claude Code 2.1.200; Codex list with only `gpt-6-sol`; Cursor list with only
    Grok 4.6 ids): consensus `on, lower grade: below CTO level (gpt-6-sol + grok-4.6)`.
16. codex found but no Node: relays and lanes `SKIP (needs Node 18+)`.
17. upgrade from the previous packet (`--previous <zip>`; the build passes the newest other zip in
    `dist\`, when present): `Upgrading from <its VERSION> to`; changed files `UPDATE` (the harness
    edits the first file the old receipt lists, mapping Git Bash receipt paths to Windows paths, so
    there is always one); receipt schema 2 with that `previousPacketVersion`; files only the old
    packet owned are removed when unchanged.
18. downgrade guard: a receipt claiming packet `2099.01.01-1` stops with exit 2; with
    `--allow-downgrade` the install proceeds and says "Downgrading".
19. only the two Sol models (Claude Code 2.1.200; Codex list with `gpt-6-sol` and `gpt-5.6-sol`
    only): consensus `on, lower grade: below CTO level (gpt-6-sol + gpt-5.6-sol)`, note "same family".
20. declared unavailable: Claude Code 2.1.280, `--unavailable claude-opus-5-5,claude-opus-5`,
    Codex list with `gpt-6-sol` only: consensus below CTO level with `gpt-6-sol + claude-sonnet-5`;
    a second install without the option keeps the list and the result; `--clear-unavailable`
    removes the settings file and the pair returns to single vendor with Opus 5.5.
21. machine check failure (`TEAM_SETUP_FAIL` set to a text with a backslash and quotes), fresh:
    core installed; `local.json` valid JSON and disabled with that text; doctor says consensus is
    off; relays and lanes skipped; profile says the check failed.
22. machine check failure after a successful install that has an enabled reviewer pair, installed
    lanes and `local.json` marks (scenario 11's state): runtime, relays, lane file and `local.json`
    byte-identical afterwards; `KEEP (machine check failed)` lines; the new receipt still lists them,
    its `consensus` and `lanes` equal the previous receipt's, and `refresh.status` is `failed` with
    the reason; the summary says the previous setup is kept. The same with
    `TEAM_SETUP_SKIP=consensus.md` and with `TEAM_SETUP_SKIP=lanes.json`.
23. obsolete files: install; change one relay file by hand; install a copy of the packet from
    which that file and another relay file are removed (its `CHECKSUMS.txt` regenerated): the
    changed file is `KEEP (changed since install)` and byte-identical, the unchanged one is
    `REMOVE` and present in the backup folder.
24. backup failure: after an install, make `<home>/.config/delegate-skills/.backups/team` a file,
    then install a packet copy that changes a file: exit 1 and every installed file byte-identical.
25. foreign receipt: a receipt whose `home` is another folder and whose files list a sentinel file
    outside the home, plus a symlink or junction inside an owned folder pointing outside: install
    and uninstall leave the sentinels byte-identical (install ignores the receipt; uninstall exits 2);
    a receipt that names no home makes uninstall exit 2 and remove nothing; with
    `.config/delegate-skills/.backups` (and then the ledger folder) a link to the sentinel folder,
    install exits 2 and writes nothing there.
26. self-test honesty: a copy of the packet with an extra failing test in `consensus/tests/`, and
    another with one in `setup/tests/`: `--self-test` exits 1 and names the suite.
27. exclusions never silently lost: after scenario 20's first install (three Claude models
    declared), (a) make `team-settings.json` unparsable: a plain re-install exits 2 and every
    installed file is byte-identical; (b) delete `team-settings.json`: a plain re-install recovers
    the three ids from the receipt, says so, writes the settings file again, and the reviewer pair is
    unchanged (`gpt-6-sol + claude-sonnet-5`), agreeing with the installed doctor; (c) with the
    file unparsable, `--clear-unavailable` proceeds and resets the list (settings file gone, the
    receipt's `unavailable` empty). Also: `{}`, `{"unavailable":null}` and a truncated
    `{"unavailable":[]` each exit 2 with every installed file byte-identical, and a hand-formatted
    valid file (spaces and new lines) is read normally.

28. repositories folder, other tools and desktop Claude: a home with `code/` holding two
    repositories and `elsewhere/` one, a fake Gemini CLI, Claude Code 2.1.259 on the command line
    and a desktop copy 2.1.290: the profile shows `code` (2 repositories) and Gemini CLI 0.9.1,
    `local.json` points the reviewers at the desktop copy and Opus 5.5 is in the pair; with
    `--repos elsewhere` the profile shows it, and a later run without the option keeps it.
30. old Claude Code (2.1.283): the installed Sonnet helpers are the 4.6 copies (`model:
    claude-sonnet-4-6` in each of the four files), the profile carries the Sonnet 4.6 routes
    line and the 2.1.284 update advice.
31. new Claude Code (2.1.293): the installed Sonnet helpers are the 5.5 copies (`model:
    claude-sonnet-5-5` in each of the four files) and the profile carries the Sonnet 5.5
    routes line.
32. no Node (no machine check) with Claude Code 2.1.293: the installer's own version picks the
    5.5 copies, and the degraded routes text carries the Sonnet 5.5 line. Scenarios 30 to 32 also
    check the installer's closing line naming the installed set.

Ladder scenarios (section 3.4), each for both installers:

33. Node, fresh, a fake `qwen` on PATH: ladder installed, front desk receipt with no hooks, `installedBy`
    `team-packet` and `required` `[qwen-local]`; `role.mjs plan Junior` and `plan Developer` skip `qwen-local|high`
    with `excluded_here`; no `--fd-guard` in any Claude, Codex or Muse settings file; `ladder.owned` true; a repeat run
    is all UNCHANGED, the front desk says `already installed, nothing to do`, its receipt, program and generation are
    byte-identical, and the packet receipt differs only in the operational fields of section 3.4.
34. no Node, and a fake `node` reporting v16: `SKIP (needs Node 18+)`, no `frontdesk/`.
35. `--unavailable claude-haiku-5-5` (and, with a fake `cursor-agent`, `grok-4.7-xhigh-fast`): `declared` lists them and
    `role plan` skips them with `excluded_here`; they survive a plain re-run; `--clear-unavailable` empties `declared`
    while `required` keeps `qwen-local`.
36. `--uninstall` after 33 removes `frontdesk/` and `frontdesk-install.json`; the rest as scenario 5.
38. upgrade from the previous packet zip: the ladder is installed on upgrade and owned (taken over
    from a packet older than the ladder, kept from 2026.10.27-1 or later).
39. dry runs on a fresh home and with a valid, a malformed and an unreadable front desk receipt: the whole home tree
    (backups included) is byte-identical.
40. tampering: deleting `state/` files keeps `qwen-local` excluded; deleting `exclusions`, emptying both lists, removing
    `qwen-local` from `required` or corrupting the receipt makes `role plan` and `role list` refuse with exit 3; an
    owner-style receipt keeps the 0.1.6 behaviour; `qwen-local` is never named for Junior or Developer.
41. durable ownership: runs with no Node, Node v16 and `TEAM_LADDER_TEST_FAIL=before-commit` keep `owned` and
    `lastInstalled`; a later `--uninstall` still removes the packet's ladder.
42. a separately installed front desk (no hooks, sentinel data, an extra generation) stays byte-identical through
    install, repeat and `--uninstall` (`KEEP`).
43. links (junction on Windows, symlink elsewhere) at `frontdesk`, `frontdesk/state`, `frontdesk/generations`,
    `frontdesk-install.json`, `.backups/frontdesk/<stamp>` and a file link inside a backup folder: outside sentinels
    byte-identical through install, dry run and `--uninstall`; nothing created outside the home (file-symlink sub-cases
    SKIP with the reason where Windows refuses to create them).
44. injected failures (fresh, upgrade, exclusion-only update): exit 1 keeps the previous install and exclusions active;
    an injected restore failure gives exit 4 and `lastAttempt.status` `failed-rollback-incomplete`.
45. retry after a failed first install: no `frontdesk/` and no receipt are left; the next run installs, owns and keeps
    `qwen-local` excluded; `--uninstall` removes it.
46. packet-to-packet upgrade with an owned ladder: `Upgrading from`, still owned, `lastInstalled` names the new
    release and front desk, `required` keeps `qwen-local`.

Agent scenarios (since 2026.10.27-1, section 3.5; both installers):

47. Codex only, with Node: exit 0; no helper files and no `CLAUDE.md`; `.codex/AGENTS.md` has the section with no
    `{{`; the profile says Claude Code is not found and names the Codex entry; the ladder installs without hooks and
    selects no Claude engineer; a repeat is UNCHANGED; `--uninstall` removes everything the packet wrote.
48. an existing `.codex/AGENTS.md` as LF, CRLF, with a UTF-8 BOM, with trailing blank lines and without a final
    newline: install, unchanged repeat and uninstall give back the original bytes exactly; the person's own heading
    added after the section is kept byte-identical; two sections refuse before any change.
49. no agent tool (Node present): exit 2 before any change, home byte-identical, the message names the four agents.
50. Claude Code and Codex installed, then Claude Code missing: the helper files and the `CLAUDE.md` section are
    byte-identical, `KEEP (Claude Code not found; left as installed)`, still in the receipt; then Codex missing too:
    the Codex section kept likewise; `--uninstall` with no agent tool found removes all of it.
51. `CODEX_HOME` outside the home: SKIP with the reason, nothing written there; a link at `<home>/.codex` leading
    outside, and an `AGENTS.md` file symlink to an outside file (before any install and after an owned install): SKIP
    (link), the outside sentinel tree byte-identical through dry run, install and uninstall. On Windows the file-symlink
    sub-cases may be SKIP with the EPERM reason; the strict Ubuntu run has none.
52. Muse only, with Node: exit 0; no instructions file written; the summary and profile tell the person which file
    to point the agent at; both consensus skill copies and `muse-delegate` installed.
53. a pre-existing section the packet did not write stays byte-identical through install, repeat and uninstall
    when Codex is absent or `CODEX_HOME` points outside the home.
54. Codex only, no Node: the core and the Codex section install; runtime, relays, lanes and ladder
    `SKIP (needs Node 18+)`.
55. with Codex found and a section the packet does not own: `KEEP`, byte-identical through install, repeat
    and uninstall, never recorded as owned.
56. Cursor Agent only, with Node: exit 0; no instructions file written; the summary and profile tell the person which
    file to point the agent at; `cursor-delegate` and both consensus skill copies installed; repeat UNCHANGED;
    `--uninstall` removes it all.

Muse privacy scenarios (since 2026.11.10-1; both installers):

58. Muse found and `.config/muse/settings.json` with `"contributor_mode_enabled": true`: install and repeat print
    `WARNING: Muse contributor mode is ON`, and the summary says the installed relay switches it off for every job
    and never calls the packet's relay unguarded; the same warning when the value is on the line after its key; the
    settings file is byte-identical after every run and after `--uninstall`.
59. no Muse settings file, then one with `"contributor_mode_enabled": false`: no contributor warning and no unguarded
    relay warning; the file is byte-identical.
60. upgrade from the previous packet zip with Muse found: when the previous Muse relay lacks the guard, the plan
    `UPDATE`s `muse-delegate/scripts/relay.mjs`; afterwards the installed relay contains `"--contributor-mode", "off"`
    and no unguarded warning is printed (SKIP without `--previous`).
61. a `muse-delegate` folder the person installed, whose relay lacks the guard: `KEEP (installed by you; not
    replaced)`, the summary warns that it does not switch off Meta's contributor tier, and both files are
    byte-identical.
62. contributor mode on and a `muse-delegate` folder the person installed whose relay only mentions
    `"--contributor-mode", "off"` (in a comment): `KEEP`, the summary says the installer cannot confirm it switches
    the tier off, never that it "switches it off for every job it runs", never that it lacks the flag; the relay is
    byte-identical.
63. Muse 1.4.14 found and the setting on only under `XDG_CONFIG_HOME` (`HOME` and `USERPROFILE` = the target home):
    the contributor warning and "Muse 1.4.14 is older than 1.4.15"; the file is byte-identical; without
    `XDG_CONFIG_HOME` that file is not read.

64. Both folders found under fake-home Documents/GitHub: both agent sections, profile and receipt
    contain the paths (source found); a repeat is all unchanged and records kept.
65. No folders with --yes: unset instructions include ask-once/rerun guidance; exits 0 without input.
66. Folder flags record set; rerun without flags records kept; a missing flag advises and stays unset.
67. Home SecondBrain outranks Other computers in a fake extra root; summary lists both; weak
    personal creds is offered but not auto-selected with --yes.
68. Delete a remembered folder between runs: search again, select the replacement, print advice.

70. Codex offers GPT-6.1 Sol but not GPT-6.2 Sol: both review/implement lanes use gpt-6.1-sol
    high marked as fallback, and the standard-grade consensus summary names the reserve seat.

Every fixture sets TEAM_FOLDER_ROOTS to `none` (empty can be lost through PowerShell) unless it
supplies its own fake root. Folder unit tests (`node --test` in setup) also cover ranking,
privacy, pruning/depth, gitdir files, links, budgets,
root overrides and every rendered source.

The Muse relay's own guard (relay skills 2026.11.10) is tested by `packet\tests\muse-relay.test.mjs` (node:test, a
fake `muse` on PATH, no network): every run passes `--contributor-mode off`, `MUSE_CONTRIBUTOR_MODE` never reaches
Muse and Muse runs in `--cd`; a contributor `--model` or `--provider` is a usage error before Muse starts; a provider facet naming a
contributor model (also in an incident-shaped stream and in a last line without a newline) stops the run with
`status: contributor_tier_used` (exit 3); that stop and the `--timeout` stop end every process Muse started (a fake
whose grandchild would write a marker file), confirmed with `museStopped: true` and no stand-in process left; a fake
that exits at once, leaving a grandchild behind, with a contributor facet in its unterminated last line gives exit 3
and leaves nothing running; a process left running at a normal end is stopped and reported (`museLeftRunning`: 1
on Windows, true elsewhere), also one that keeps Muse's output open, without the run waiting for `--timeout`; a
`--cd` that does not exist gives `failed` and `not_sent` with Muse never run (on Windows through the guard's exit
97); on Windows a guard that loses its status file after letting Muse run is `unverified` with `museStopped: false`,
never `not_sent`; the guard on its own starts Muse in the folder it is given, writes nothing to stdout, and refuses
to start it (exit 97, status `unavailable`) in Constrained Language Mode and when it cannot watch the relay, and a
stop asked for before Muse ran leaves it unrun (`started: false`); killing the relay itself ends everything Muse
started (Windows); on Linux and macOS SIGINT and SIGTERM to the relay give `cancelled` (130, 143) with nothing left
running (skipped on Windows); a Muse reporting 1.4.14 is `muse_too_old` and not run, an unreadable version runs with
`museVersionCheck: unparsed`; a run that names no model is `contributorCheck: unverified`; another model than the
requested one gives `modelWarning`; a Muse that refuses the flag fails with an update message and
`contributorCheck: not_sent`, without the stop alarm, while stderr that only mentions the flag after Muse reported
its model keeps `verified`.

Harness isolation (since 2026.10.27-1): every scenario has its own `PATH`, `APPDATA` and `LOCALAPPDATA`; on Linux and
macOS the system part of `PATH` is a scenario-local folder of links to the needed system commands without `node`, and
no-Node scenarios assert that `node` is not found; the previous zip is extracted with `unzip`, `python3 -m zipfile -e`
or `bsdtar` outside Windows; the ladder scenarios assert that every tool path `role.mjs` reports lies in the scenario's
folders. `--strict` turns every SKIP into a FAIL, and every run ends with the scenario inventory. The proof on a real
Ubuntu machine is `node packet/tests/fixtures.mjs --packet <fresh unzip> --previous <previous zip> --only sh --strict`.

## 6. Build

`build-packet.ps1` stages the packet (section 2), copying `setup\` and `claude\lane-fallbacks.json`
as well, and (since 2026.10.27-1) `frontdesk\` exactly as its code manifest lists it and the current ladder release
exactly as `ladder\manifest.json` lists its installable files, each copy verified against its manifest hash (a
mismatch fails the build), and before zipping checks: every lane in `lane-fallbacks.json` exists in
`delegate-lanes.json` and no fallback repeats its lane's first choice; `node --test` passes in the
staged `consensus\` and `setup\`; (since 2026.11.10-1) the staged `muse-delegate` relay contains
`"--contributor-mode", "off"` and `packet\tests\muse-relay.test.mjs` passes against it (gate "muse relay
tests", `MUSE_RELAY` set to the staged relay); the fixture harness passes against the stage for both installers
(unless `-SkipFixtures`, which the result line names; Git Bash is required, since without it the
harness could not test `install.sh`; the harness runs with `--jobs 8`, parallel shards that each
use their own temporary homes). Any failing or unrunnable gate stops the build with a
non-zero exit and no `RESULT=BUILD PASS`. `-SkillsSource` names where the relay skills come from
(default: the `skills` folder next to `packet`); the relay checks of v1 stay (the
`DELEGATION_DISPATCHED` marker, no `--disable-sandbox`, MIT license). Since 2026.10.06-2 the
helper definitions come from `packet\claude\agents\`, alongside the packet's own rulebook and bootstrap.
