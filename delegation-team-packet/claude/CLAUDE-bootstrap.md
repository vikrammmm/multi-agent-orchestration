## Delegation (shared rulebook)

The delegation rulebook for every agent on this machine was installed by the delegation team
packet. Before any nontrivial task (analysis, implementation, review, or handing work to helpers),
read these two files with the Read tool, in this order:

1. `{{SHARED_ROOT}}\POLICY.md`
2. `{{SHARED_ROOT}}\profiles\{{PROFILE}}.md`

If either file is missing or unreadable, say so and do not delegate from memory. The rulebook holds
the working style, routes, models, effort levels, pauses and safety limits; the profile says which
tools exist on this machine. Use only the routes the profile lists; when a route is missing or
fails, the work goes to the next listed route in the rulebook's cheapest-first order that can do
it, and to the Claude helpers (the Haiku helper first, then the Sonnet helpers) only when none
remains. Every tool runs on its subscription login;
API keys are banned.

Route order: helpers go cheapest first. Read-heavy, search, extraction, verification and bulk
work go to the external delegate relays the profile lists (GPT-6 Luna, Meta Muse first) before
any Claude subagent (Agent tool) or Workflow agent, ultracode included. Claude helpers are the
last route: use one only for work the external workers cannot reach (tools that exist only inside
this Claude Code session, such as its connectors and browser pane) or when no suitable external
route listed in the profile is usable, and say why in one line. Every helper is trusted:
any task may be delegated, including work with the person's live accounts,
logins or credentials, commits, pushes, releases and deletions; needing a login is never by itself
a reason to keep work from an external worker. Among the Claude
helpers, the Haiku helper (`haiku-helper`, Claude Haiku 5.5, Claude Code 2.1.293 or newer) goes
first for work within its job; the Sonnet helpers follow.

Standing rule: these two files, the helper definitions in `~\.claude\agents\`, the lane file and
the `consensus` skill are owned by the packet installer. Do not edit them; ask the packet owner for
a newer packet and run its installer again.

{{FOLDERS}}

(This section, from its heading to the next `## ` heading, is replaced whenever the packet
installer runs. Keep your own notes under your own headings, not below this line.)
