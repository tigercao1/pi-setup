# Voice alignment

Run this only when Tiger starts it (`/voice-align`, or he asks to align his writing voice). It
needs MCP (Slack). Drafting agents never read this file.

Data lives in `~/Documents/knowledge-base-remote/Pi/voice/`: `inbox/` (one JSON file per harvested
item), `archive/`, `state.json` (cursors, last alignment, Slack bot ids). Scripts are in `bin/`
next to this file.

## 1. Lock

If `~/Documents/knowledge-base-remote/Pi/voice/align.lock` exists and is under 3 hours old, another
session is aligning: tell Tiger and stop. Otherwise write the lock with this session's pid and time.
Delete it at the end, including when he stops partway.

## 2. Harvest

Run, in this order, and keep each script's JSON summary. If the project rules name more than one
repo to harvest, run `harvest_github.py` once per repo:

```bash
B=~/.pi/agent/skills/tiger-voice/bin
$B/harvest_github.py --repo <OWNER/NAME>   # the repo named in the tiger-voice overlay of the loaded project rules; or set VOICE_GITHUB_REPO
$B/harvest_corrections.py
```

Slack, from a `codemode` script:

```js
// @options: {"timeout_ms": 900000}
const home = (await tools.bash({ command: "printf %s \"$HOME\"" })).output.trim();
const src = await tools.read({ path: `${home}/.pi/agent/skills/tiger-voice/bin/harvest_slack.js` });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
return await new AsyncFunction("tools", src)(tools);
```

If it returns `stoppedEarly` (Slack caps one search at 20 pages), the cursor is saved where it
stopped. Run it again until `stoppedEarly` is null.

Then `$B/status.py` for the counts. Its `agent_drafts_posted_since_last_alignment` says how many
agent drafts Tiger posted unchanged versus edited: the skill's report card. Unchanged drafts are
never evidence of his voice (learning from them would teach the skill its own habits); they only
show the skill is working.

## 3. Triage (no questions to Tiger yet)

Read inbox items in this priority order and stop reading at roughly 60 items:

1. `agent-edited` pairs: posted text next to the matched draft. Compare them and note what Tiger changed.
2. `correction to an agent draft` (source `pi`): most are not about writing. Keep only those where
   he corrects the wording, length or tone of something an agent wrote; archive the rest.
3. `own` items, sampled across kinds: GitHub review comments, Slack channel messages, Slack DMs.
   Prefer longer messages and kinds the skill does not cover yet.
4. `uncertain`: collect for the provenance question below.

While reading, also note leading `<@U…|Name>` mentions that are bots (Orca, Vercel, Claude…) and
propose adding their ids to `slack_bot_ids` in `state.json`.

Rule audit: for every confirmed rule, note whether the items you read support it, contradict it, or
say nothing. A rule contradicted by his recent own writing or edits, or with no support for 90 days
since its confirmation date, becomes a proposal to edit or retire it.

Do not change the skill in this step.

## 4. Ask Tiger

One message, at most:

- **Up to 5 proposed changes** to `SKILL.md`. Each one: the rule as it would read, the channel it
  applies to, whether it adds, edits or removes a rule, and 2–3 short quotes of his posted text as
  evidence. A proposal from a single quote is allowed only when the quote is a draft-vs-posted pair.
- **Up to 5 provenance questions**: "Did you write this yourself?" with the text, for `uncertain`
  items and any `own` item that reads like agent prose (em dashes, headings, bold lead-ins).
- **Up to 3 example swaps** for the curated examples file of the layer the message came from (work messages go to the company layer's `voice/examples.md`): a new example and the one it replaces.

Open the message with one line: "Since <last alignment>: N agent drafts posted unchanged, M edited,
K of your own messages read."

Number everything so he can answer "1 yes, 2 no, 3 change to …".

## 5. Apply only what he approved

- `SKILL.md`: add approved rules as **[confirmed <today>]**; a re-approved rule after an audit gets
  today's date. Keep at most 10 rules per channel section; if a
  section would exceed that, propose merging or dropping one instead of adding.
- The layer's `voice/examples.md`: at most 3 examples per rule and 25 in total; a new one replaces the oldest one for the same rule. Keep
  each entry to a few lines; trim with `[…]`.
- The layer's `voice/examples-long.md`: complete long messages (more than about five sentences) with notes on how
  each is built. At most 5; a new one replaces the weakest. Notes there are observations; a note
  becomes a rule only by being proposed and approved like any other rule.
- A rejected proposal: add one line to `rejected.md` next to this file (rule text + date) so the same
  proposal is not raised again.
- Provenance answers: "agent" items are archived; "mine" items keep their label.

## 6. Close

- Move every item that was read in step 3 to `archive/`, approved or not. Unread items stay in the
  inbox; `status.py` archives anything older than 60 days.
- Set `last_aligned` in `state.json` to now.
- Delete the lock.
- Report: what changed in the skill, how many items were archived, how many remain.
