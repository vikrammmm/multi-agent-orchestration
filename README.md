# multi-agent-orchestration

A one-step installer that gets your AI coding agents (Claude Code, Codex CLI, Cursor Agent,
Muse Code) working together, with a shared way of working:

- **A rulebook** the agents read before nontrivial work, so routine slices go to cheaper helpers
  and the judgment calls stay in your chat.
- **Five Claude Code helpers** for lookups, research, implementation and verification.
- **A second-opinion reviewer** ("consensus") for big or risky work: two top models agree the
  finish line before the work starts and both sign off at the end.
- **A role ladder** you can ask which model to call for a kind of job.
- **Relays** so one agent can hand a task to another.

Everything goes into your own user folder: no administrator rights, nothing running in the
background, no API keys.

## Install

1. Download this repository (or clone it) and open the `delegation-team-packet` folder.
2. **Windows:** double-click `install.cmd`.
   **macOS or Linux:** run `bash install.sh` in that folder.
3. Read the plan it shows, press Enter, wait for the summary.

To see the plan without changing anything, add `--dry-run`. To remove everything it installed,
add `--uninstall`.

## What you need

- At least one of the agents above, logged in with its own subscription.
- Node.js 18 or newer (optional): turns on consensus, the role ladder and the relays.

Options, what exactly gets installed and what has not been verified yet are in
[delegation-team-packet/README.md](delegation-team-packet/README.md).

## Rebuild it

The `delegation-team-packet` folder is built from `src`. To change something and rebuild you need
Windows with PowerShell 5.1 or newer and Node.js 18 or newer.

1. Edit the files under `src`. After changing a file in `src\frontdesk`, run
   `node src\frontdesk\seal.mjs`.
2. Run the tests: `node --test` inside `src\consensus`, `src\frontdesk` and `src\packet\setup`.
3. Run `powershell -File src\packet\build-packet.ps1 -SkipFixtures`. It rewrites the
   `delegation-team-packet` folder, writes a zip of it next to it, and ends with
   `RESULT=BUILD PASS`.

Without `-SkipFixtures` the build also practice-installs the result with both installers in
throwaway home folders. That needs Git Bash and takes much longer.

Never edit `delegation-team-packet` by hand: the installer checks every file against
`CHECKSUMS.txt`. `src\ladder` holds the ready-made role ladder release that ships in the
installer; the tool that generates a new release is not part of this repository.
