---
name: reflect
description: "Mine the current session for durable learnings: three parallel reviewers (judgment, tooling, divergent), one verifier over their union, then a synthesizer that routes each learning to an edit on an existing skill. Accepted edits wait for Tiger's approval; Backlog goes to a local file. Use for /skill:reflect."
disable-model-invocation: true
---

# Reflect

Adapted from pstack (MIT, Lauren Tan).

Mine the current conversation for durable learnings, then route them into skill edits.

Run only when Tiger types `/skill:reflect` or says "reflect". Skip when the conversation is
trivial, off-topic, or already covered by an existing skill the session followed correctly. One-offs
are not learnings.

`/voice-align` (`~/.pi/agent/skills/tiger-voice/ALIGN.md`) stays the voice-specific instance of
this loop. Wording corrections to Tiger's drafts go there, not here.

## Spawn settings

Every agent below is a `team_spawn` with `extensions: ["mcp"]` and `contextFiles: true`, and a
`taskContract.outputPath` in the run folder. No agent writes anything except its own output file:
no skill edits, comments, labels or posts in any tool.

Run folder: `$HOME/Documents/knowledge-base-remote/<Project>/docs/plans/reflect/<YYYY-MM-DD>-<session-id>/`,
where `<Project>` is the project of the session's cwd (the project rules name it; `Pi` for work in
`~/.pi`).

| Role | Count | Profile | Template |
|---|---|---|---|
| Judgment reviewer | 1 | none (the default model, `thinkingLevel: "high"`) | `references/judgment-reviewer.md` |
| Tooling reviewer | 1 | `researcher` | `references/tooling-reviewer.md` |
| Divergent reviewer | 1 | none (the default model, `thinkingLevel: "high"`) | `references/divergent-reviewer.md` |
| Verifier | 1, over the union | `verifier-mcp` | `references/verifier.md` |
| Synthesizer | 1 | none (the default model) | `references/synthesizer.md` |

Five worker sessions per run, each reading a full digest. Run on demand only.

## 1. Locate the active transcript

Use this session's own file, never a search across projects:

```bash
echo "$PI_SESSION_FILE"
```

If that is empty, list the current project's folder only. The folder name is the cwd with every `/`
replaced by `-`, wrapped in `--` (`/Users/ycao` is `--Users-ycao--`):

```bash
ls -t ~/.pi/agent/sessions/<cwd-slug>/*.jsonl | head -10
```

Read the first `"role":"user"` line of each candidate and take the file whose text matches this
conversation's opening prompt. Never read other folders under `~/.pi/agent/sessions/`; they hold
other projects' private sessions. If nothing matches, write a tight digest of the session yourself
instead.

Then make the readable digest the reviewers get:

```bash
~/.pi/agent/skills/reflect/bin/transcript-digest.py <session.jsonl> <run-folder>/transcript.md
```

It keeps user and assistant text, tool calls and truncated tool results, numbered by user turn, and
drops thinking blocks and the system prompt (about a tenth of the raw size). Pass the digest path
and the raw JSONL path; reviewers read the raw file only to check a detail the digest truncated.

## 2. Spawn three reviewers in parallel

All three in one turn. Pass each template verbatim, substituting the transcript paths and the
reviewer's output path where marked. Each reviewer writes its numbered findings to its own file.

## 3. Verify before synthesizing

When all three have reported, read their files and build one findings list over the union: each
finding's Principle, Evidence and Routing word for word, findings that two or three reviewers share
merged into one line that names every reviewer who raised it, contradicting findings kept as
separate lines marked as a pair. Do not judge or reconcile them yourself. Spawn the one verifier on
that list with `references/verifier.md`. Never use `team_verify`: its skeptics cannot open the
tickets and threads the transcript cites.

## 4. Synthesize

Spawn the synthesizer with `references/synthesizer.md`, the three reviewer files and the verifier's
verdict file inlined where marked. It returns an Accepted / Rejected / Backlog list. Findings the
verifier disproved go to Rejected with reason `disproved`.

## 5. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag or runtime check would enforce more
reliably to Backlog. See `references/encode-lessons-in-structure.md` in the `principles` skill
(`~/.pi/agent/skills/principles/`).

## 6. Backlog and approval

Append every Backlog item to
`$HOME/Documents/knowledge-base-remote/<Project>/docs/plans/reflect-backlog.md` without
waiting; it is a local file, never a tracker. Create the file with a `# reflect backlog` heading if
it is missing. One entry per item:

```markdown
## <YYYY-MM-DD> · <short pattern name>
- Session: <session id>
- Pattern: <what keeps happening>
- Hit: <what happened in this session, with the turn number>
- Mechanism: <the lint, script, flag or check that would enforce it>
- Status: open
```

The `correct` skill reads this file as an input. Never file a Backlog item to Linear, GitHub or any
other tracker unless Tiger asks for that specific item.

Then present the synthesizer's full Accepted / Rejected / Backlog output to Tiger and wait for his
explicit approval before applying any Accepted edit. He picks the subset and may redirect routings.
Skill changes affect every future session. Do not auto-apply.

## 7. Apply the approved rows

Follow each approved row's Routing exactly:

- Trivial edit to an existing skill (a one-line bullet, a tightened sentence, a stale fact
  corrected): make it directly.
- Substantive edit (a new section, a new table, more than about 10 lines): draft it, show Tiger the
  diff, and apply after he accepts it.
- `tune description: <skill path>` (the skill exists but did not trigger): rewrite the
  `description:` so its trigger words come first; show Tiger the old and new line.
- `new skill: <kebab-name>`: create `~/.pi/agent/skills/<name>/SKILL.md` (a project-specific skill goes
  in the project layer's skill directory), never inside a repo.

Generic content goes in `~/.pi/agent/...`; project-specific values (module paths, repo names) go in
the skill's section of the project layer's skill-overlays file. Other sessions may have
uncommitted edits in those trees: re-read a file right before editing it, make targeted edits, and
never `git checkout`, `restore`, `stash`, `reset` or commit unless Tiger asks.

Check that every touched skill still loads:

```bash
node --input-type=module -e "
import { loadSkillsFromDir } from '$(npm root -g)/@earendil-works/pi-coding-agent/dist/core/skills.js';
const r = loadSkillsFromDir({ dir: process.argv[1], source: 'user' });
console.log(r.skills.map(s => s.name), r.diagnostics);
" <skill-dir>
```

## 8. Summarize for Tiger

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog appended to `<reflect-backlog.md path>`: one line per item.
- Dropped: one line per rejected finding with the synthesizer's reason.
