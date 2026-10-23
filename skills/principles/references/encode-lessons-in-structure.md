# Encode Lessons in Structure

When you catch yourself writing the same instruction a second time, or notice a recurring correction, encode the rule as a lint, metadata flag, runtime check or script instead of more text. Text is read only when an agent happens to open it; a check fails every time.

If the lesson needs judgment and cannot be encoded, make the instruction more prominent and add an example of the failure mode.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.

The `correct` skill (`~/.pi/agent/skills/correct/SKILL.md`) applies this to a repo's repeated mistakes, and `reflect` moves any finding a mechanism could enforce to its backlog.
