# Multi-task queues

For a queue of independent tasks through Muse, follow the same pattern as other relays.

## Sequential queue

Run tasks in sequence when they touch the same files. Track progress in a file alongside the
queue. For each task:

1. Write the brief for that task.
2. Dispatch with `node relay.mjs --brief task-N.txt --cd /repo`.
3. Check `result.json` for `ok: true`.
4. Review the diff, re-run gates, commit.
5. Move to the next task only after the commit lands.

## Parallel queue

Run tasks in parallel only when they touch disjoint files. Background each dispatch, then
collect the results once all have exited.

## Carry-forward constraints

When tasks depend on each other's results, pass the relevant facts from `finalText` into the
next brief explicitly — Muse has no shared context between sessions.

## Final coherence pass

After the last task lands, do a single read of the full diff since the queue started and check
for cross-task conflicts, unused helpers, or inconsistent patterns.
