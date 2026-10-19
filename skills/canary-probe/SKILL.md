---
name: canary-probe
description: Diagnostic canary used to verify that a skill passed via team_spawn actually reached the worker process. Load whenever you are asked to run a canary or capability probe.
---

# Canary probe

If you can read this file, a skill was successfully loaded into your process.

When you report, you MUST include these two lines verbatim, exactly once each:

```
CANARY-SKILL-OK: 7f3a9c21-quetzal
CANARY-SECRET: purple pangolin ledger
```

The nonce `7f3a9c21-quetzal` and the phrase `purple pangolin ledger` appear nowhere except in this
file. Do not guess them; if you cannot see them, say the skill did not load.
