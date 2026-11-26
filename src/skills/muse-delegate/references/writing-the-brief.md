# Writing the brief

A brief is the entire task as Muse will see it. It runs in a separate headless session with no
memory of your conversation. Include the goal, current state, what to change, what to leave
untouched, the project's real gates, and a report contract.

## Structure

```xml
<task>
One or two sentences: the concrete job and where it lives. Specifics: current state, what to
change, and what to leave untouched.
</task>

<verification_loop>
Run these before finishing and fix anything they surface:
  <the project's real test command>
  <the project's real lint/format command>
Confirm the working tree shows only the intended changes.
</verification_loop>

<action_safety>
Keep changes scoped to the task. No unrelated refactors. Do NOT run git add or git commit —
the orchestrator commits after reviewing. Leave the work uncommitted.
</action_safety>

<structured_output_contract>
End with a report:
  1. What changed and why
  2. Files touched
  3. Gate outcomes
  4. Anything left open or needing a decision
</structured_output_contract>
```

## Model choice and sessions

Default effort is `high`; pass `--effort xhigh` or `--effort max` for harder tasks. A resumed
session keeps context; send only the delta brief with `--resume-last` or `--session <id>`.

## Delivery

The relay writes the brief to a file and passes it to muse via `--prompt-file`. Large context
is better referenced than inlined — put it in the workspace and tell Muse which file to read.
