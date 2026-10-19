---
name: pr-approval-review
description: "Review a pull request to answer one question: what must happen before it can be approved? Use for PR/code reviews when the user wants a concise verdict (approve, comment, or request changes) and copy-paste review comments without scope creep."
compatibility: Requires git and GitHub CLI (`gh`); project issue/docs tools may also be needed.
---

# PR Approval Review

Review toward an approval decision, not toward producing the largest possible list of observations.

## Governing principles

- Approval means the changed code is understood and is safe to ship for the PR's stated scope.
- Review the implementation against the ticket, PR description, supported product behavior, and repository conventions.
- A passing test suite is evidence, not proof of correctness.
- Do not require the author to solve adjacent problems or unsupported edge cases.
- Do not block on personal preference when the proposed approach is valid.
- Every blocking comment must describe an introduced, reproducible or strongly evidenced problem within scope.
- Every change in the diff must be needed by the PR's stated scope. An unnecessary change is an introduced problem, not a preference, and a PR that contains one is not approvable.
- Ask when missing context prevents approval; do not turn uncertainty into a claimed defect.
- Never submit, approve, request changes, or comment on the PR through GitHub. Always write the verdict and copy-paste comments for the user to post themselves, even if asked to post them directly.

If the loaded project rules name review guidelines (team PR guidelines, development process, PR best practices), read them; these principles are meant to align with them.

## Workflow

### 1. Establish the approval contract

Before inspecting details, identify:

1. The ticket's acceptance criteria and intended behavior.
2. What the PR claims to change and explicitly does not change.
3. Supported users, states, platforms, viewports, and migration/rollout paths affected by the change.
4. Repository and directory-local instructions (`AGENTS.md`, `CODEOWNERS`, domain docs).
5. Tests, manual validation, screenshots, rollout notes, or domain review required for this kind of change.

Start with the branch name and the associated ticket, then read the root `AGENTS.md` and any directory-local `AGENTS.md` files covering the changed paths. If the loaded project rules give repo-specific first steps for review, follow them.

### 2. Gather review evidence

Read:

- PR metadata, description, commits, checks, changed paths, full diff, and existing review threads.
- Base and head implementations for behavior being replaced.
- Callers, types, tests, dependencies, and framework/design-system implementation when their contract matters.
- The issue/design artifact when available.

Do not duplicate an existing active comment. Re-evaluate resolved comments only when there is concrete evidence the issue remains. GitHub access is read-only for this workflow.

### 3. Review only relevant risk angles

Choose angles based on the diff rather than mechanically commenting on every category:

- Requirements and user-visible behavior
- Regression from the base implementation
- State transitions, errors, loading, retries, and async races
- Data/API contracts and unnecessary fetching
- Authorization, privacy, and security boundaries
- Performance and scaling on realistic supported inputs
- Responsive layout, scrolling, accessibility, and design-system contracts for UI changes
- Persistence, migrations, rollout, rollback, and observability where applicable
- Test coverage of changed public behavior
- Repository architecture and domain conventions

Trace behavior through the complete call or layout chain. Do not infer behavior from a single changed line when an ancestor, caller, hook, CSS rule, or dependency determines the result.

### 4. Audit every hunk for necessity

This step is mandatory and runs over the whole diff, not only the hunks a risk angle led you to. For each hunk, name the ticket requirement or PR-stated goal it serves, then ask what breaks if it is removed. A hunk is **unnecessary** when no requirement needs it, or when removing it changes no supported behavior. The usual forms:

- **No-op code:** a filter, guard, `except`, constant, branch, validation or rescue whose removal changes nothing in any supported flow. It is either an over-engineered safeguard or a misreading of how the code behaves. A constant or method copied into a second file is a signal to check this. Tests cannot catch it: code with no effect passes every test both with it and without it.
- **Unrequested behavior change:** a new capability, permission, parameter, contract change or side effect that the ticket did not ask for, including one enabled "while here" (for example permitting a param that was previously dropped).
- **Drive-by edits:** refactors, renames, reformatting, or dependency bumps in code the change does not need.
- **Comments the repo rule forbids:** net-new comments that break the repo's comment convention (as stated in the repo's `AGENTS.md` or project rules, for example narration, reviewer-aimed rationale, dated notes), or that state something the code does not do. Durable comments that record a constraint the code cannot express are allowed. Functional directives and edits that keep an existing comment accurate do not count.

Verify the claim before raising it: trace the callers, casts and callbacks that decide whether the hunk has an effect. A guard that looks redundant on one line may be load-bearing through a caller. A justification in a code comment or the PR body does not make a hunk necessary. Check the behavior, not the author's explanation of it.

### 5. Control scope

Classify every observation:

#### Blocking

Report only when all are true:

- The PR introduces or preserves a defect in code it is changing.
- The trigger is part of stated requirements or a normally supported flow.
- The impact is meaningful: incorrect behavior, inaccessible UI, data/security risk, operational risk, or failure to meet acceptance criteria.
- A change is needed before safe approval.

Ask for the smallest in-scope correction. Do not prescribe an adjacent redesign.

#### Approval question

Use when missing context, evidence, or domain confirmation prevents approval but a defect is not yet proven. Ask one focused question that can resolve the uncertainty.

#### Non-blocking/out of scope

Do not turn discovered adjacent edge cases, cleanup, refactors, or preferences into required work. For code the PR does **not** change, usually omit them from the copy-paste review. If materially useful, include at most a short `Follow-up (non-blocking)` note that explicitly says it does not block this PR.

#### Unnecessary change

Code the PR **introduces** that step 4 found unnecessary is different: it is part of the change under review, not adjacent cleanup, so it is never omitted as low-value and never filed as a follow-up.

- **Proven unnecessary** (you traced it and nothing needs it): blocking. Ask for its removal.
- **Necessity unclear** (it might cover a case you could not trace): approval question naming what it would guard against, for example "Can an `order` have more than one active discount per customer? I'm not following why this window is needed." It blocks approval until answered.
- **Unrequested behavior change that may be wanted:** approval question asking the author to confirm it is in scope or move it to its own PR.

Examples:

- Supported viewport broken by this layout change: blocking.
- Hypothetical unsupported browser behavior: omit or non-blocking follow-up.
- Existing defect merely visible near changed code: non-blocking and separate-ticket territory.
- Naming preference with no maintainability/correctness impact: omit.

### 6. Validate each proposed comment

Before reporting a finding, verify:

- It is present on the PR head, not only an earlier commit.
- It is introduced by or directly relevant to the diff.
- Existing code, types, tests, or dependency source support the claim.
- The trigger and impact can be stated concretely.
- The requested change stays inside the PR's scope.
- The path and line refer to the PR head.
- Another reviewer has not already left the same active feedback.

Remove speculative, stylistic, and low-value comments, and comments that repeat another reviewer's. A comment about an unnecessary change the PR introduces is not low-value; see step 4.

## Verdict rules

Return exactly one verdict:

### `APPROVE`

Use when there are no blocking findings, no unanswered questions required for confidence, and every hunk passed the step 4 necessity audit. Do not withhold approval for optional improvements to code the PR needs.

### `COMMENT`

Use when no concrete blocker is proven, but approval still requires clarification, missing validation/context, or another owner's review. State precisely what answer/evidence is needed.

### `REQUEST CHANGES`

Use when one or more concrete, in-scope blocking findings must be corrected, including any proven-unnecessary change. Every required action must map to a copy-paste comment.

If the PR is not review-ready because required UI evidence, tests, or domain validation is missing, prefer `COMMENT` unless the missing artifact itself is an explicit merge requirement or conceals a demonstrated defect.

## Comment style

The comments under **Comments to post** are pasted by Tiger under his own name, so write them in his voice: read `~/.pi/agent/skills/tiger-voice/SKILL.md` and its `examples.md` first. Where they conflict with the template below, the voice skill wins (for example: no `:warning:` prefix, no bold title, observation or question instead of an instruction). The verdict and **To approve** list keep this skill's shape; only the comment wording follows the voice skill.

The template below describes what a comment must establish, not its wording:

```text
:warning: <imperative summary>

<Supported trigger> causes <user/system impact> because <brief evidence>. Please <smallest in-scope correction or behavior to preserve>.
```

For a question:

```text
<Focused question>? I need this confirmed because <specific approval risk>.
```

Rules:

- One defect per comment.
- Lead with impact, not implementation preference.
- State the triggering condition.
- Explain only enough causality to make the finding defensible.
- Request the outcome, not a broad redesign.
- Avoid praise, review narration, generic summaries, severity theater, and long solution proposals.
- Do not include a comment that the author cannot act on.

## Required output

Keep the response limited to this shape:

```markdown
## Verdict: APPROVE | COMMENT | REQUEST CHANGES

## To approve
- <minimal required action, answer, or evidence>

## Comments to post

`path/to/file.ts:123`
> <copy-paste comment>

## Follow-up (non-blocking)
- <only when an important out-of-scope observation is worth retaining>
```

Output rules:

- For `APPROVE`, write `None.` under **To approve** and **Comments to post**.
- For `COMMENT`, list only the questions/evidence required to reach approval.
- For `REQUEST CHANGES`, list only changes required to reach approval.
- Omit **Follow-up (non-blocking)** when empty.
- Do not add a review-process recap, exhaustive angle list, unchanged-code commentary, or repeated rationale.
- Mention passing checks only when they affect the verdict.
- Give exact PR-head paths and lines for inline comments.
