# Delegation team packet

Installs working rules for AI coding agents that delegate to each other: a shared rulebook, five Claude Code
helpers, a second-opinion reviewer for big or risky work (consensus), and the role ladder (which
model to call for each kind of job). Everything goes into your own user folder: no administrator
rights, nothing running in the background, nothing hooked into your tools.

## What you need

- **At least one of these agents**, logged in with its own subscription: Claude Code, Codex CLI,
  Cursor Agent or Muse Code. Use Claude Code 2.1.293 or newer (`claude update`).
- **Node.js 18 or newer** (optional): turns on consensus, the role ladder and the relays between
  agents.
- **No API keys.** Every agent runs on its own subscription login; the installer never asks for a key.

## Install

1. Put the packet folder anywhere (download it, or unzip it).
2. **Windows:** double-click `install.cmd` (if SmartScreen asks: "More info", then "Run anyway").
   **macOS or Linux:** run `bash install.sh` in that folder.
3. Read the plan it shows, press Enter, wait for the summary.
4. Start a new agent session and ask: "which delegation routes and reviewers are available here?"

Rerun it whenever you update or log in to an agent; that is always safe.

Options (`install.cmd <option>` or `bash install.sh <option>`):

- `--dry-run`: show the plan, change nothing.
- `--unavailable <model ids>`: models your plan lacks (`--clear-unavailable` resets the list).
- `--repos <folder>`: where you keep your code, if it guessed wrong.
- `--uninstall`: remove everything it installed.

## What it installs

- Each tool gets what it can use. Claude Code: the five helpers and one section, "Delegation
  (shared rulebook)", in `.claude/CLAUDE.md`. Codex: the same section in `.codex/AGENTS.md`. With
  Node: consensus, the role ladder and the relay skills for the agents you have.
- That section is rewritten on every run: keep your own notes under your own headings. Every other
  byte of `AGENTS.md` stays as it is, and uninstall gives the file back as it was. A section it did
  not write is left alone. If `CODEX_HOME` points outside your user folder, it writes nothing there
  and tells you what to add.
- Files go under `.config/delegate-skills/`, `.claude/` and `.agents/`, with backups in
  `.config/delegate-skills/.backups/team/` and a receipt for updates and uninstall
  (`team-install.json`, plus `frontdesk-install.json` for the ladder). Nothing outside these
  folders is touched.
- Parts installed for a tool it can no longer find are kept ("KEEP"). Files it no longer needs are
  removed only if you haven't changed them.

## What changes for you

Your agent reads the rulebook before nontrivial work and hands routine slices to cheaper helpers,
keeping judgment calls in your chat. For big or risky tasks it suggests a consensus review; you
say yes or no. Muse finds the rulebook through the files above; if Cursor is your only agent, the
summary says which file to point it at.

## The role ladder

With Node you can ask which model to call for a job, for example
`node ~/.config/delegate-skills/frontdesk/bin/role.mjs plan "Developer"`. It names the first
approved model your machine can run, and only answers when asked. A role ladder you installed
some other way is left alone.

## If something is off

The summary says what to do. It contains no secrets, so it is safe to share when you ask for help.

## Updating

Run a newer packet's installer the same way; it updates what changed.

## Not verified yet

Tested on Windows and on native Ubuntu. Not yet on macOS, PowerShell 7 or the oldest
supported Node, or on a real machine whose only agent is Cursor Agent or Muse.
