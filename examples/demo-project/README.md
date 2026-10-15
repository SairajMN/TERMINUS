# Demo project for TERMINUS

A minimal date utility with one failing test. The demo task:

> Add formatForTimezone(iso, timeZone) to src/date.mjs so `npm test` passes.

TERMINUS researches the timezone API (web_research), cites what it found,
plans, implements, watches `npm test` fail, corrects the implementation,
and re-runs verification until both assertions pass.

Run it yourself:

```bash
bun run terminus --dir examples/demo-project \
  "add formatForTimezone(iso, timeZone) so the test passes"
```
