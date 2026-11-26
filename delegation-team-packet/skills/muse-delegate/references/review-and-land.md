# Review and land

Muse did the typing; you own the judgment. Verify against reality, not the self-report.

## Re-run the gates yourself

`result.json` carries Muse's claims. Re-run the project's actual test, lint, and build commands.

## Read the diff against the brief

- **Scope creep** — changes the brief excluded.
- **Scope shortfall** — missed behavior or edges.
- **Quiet judgment calls** — defensible but unasked decisions.

## The commit boundary

When gates pass and the diff holds, **the orchestrator commits**, never the relay. The relay
never runs `git add` or `git commit`.

## Rework: send the delta

```bash
echo "Fix: the test mocks the session. Use the real fixture." | \
  node "<skill-dir>/scripts/relay.mjs" --resume-last --cd /path/to/repo
```

Use `--session <id>` (from `result.json`) when resuming a specific session.
