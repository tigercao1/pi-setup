// Run with the codemode tool (needs extensions: ["mcp"]). Paste this file's contents as the script.
// Fetches Tiger's Slack messages (public, private and DMs) since the slack cursor and ingests them.
const HOME = (await tools.bash({ command: "printf %s \"$HOME\"" })).output.trim();
const BIN = `${HOME}/.pi/agent/skills/tiger-voice/bin`;
const status = JSON.parse((await tools.bash({ command: `python3 -c "import sys; sys.path.insert(0,'${BIN}'); import voicelib as v, json; s=v.load_state(); print(json.dumps({'c': v.cursor(s,'slack').isoformat(), 'u': s['slack_user_id']}))"` })).output);
if (!status.u) throw new Error("slack_user_id is not set in the voice state.json; set it to your Slack user id first");
const startedAt = new Date().toISOString();
const after = status.c.slice(0, 10);
const items = [];
let cursor;
let stoppedEarly = null;
for (let page = 0; page < 50; page++) {
  let r;
  try {
    r = await tools.mcp__slack__slack_search_public_and_private({
    filters: `from:<@${status.u}> after:${after}`, natural_language_query: "", limit: 20,
    include_context: false, response_format: "detailed", sort: "timestamp", sort_dir: "asc", cursor,
    });
  } catch (e) { stoppedEarly = String(e).slice(0, 200); break; }
  const raw = r.content.map((c) => c.text).join("");
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { stoppedEarly = raw.slice(0, 200); break; }
  const body = parsed.results ?? raw;
  for (const block of body.split(/### Result \d+ of \d+/).slice(1)) {
    const channel = (block.match(/Channel: (.*)/) || [])[1] || "";
    const ts = (block.match(/Message_ts: ([\d.]+)/) || [])[1];
    const link = (block.match(/Permalink: \[link\]\(([^)]+)\)/) || [])[1];
    const text = (block.split(/\nText: ?\n?/)[1] || "").replace(/\n---\s*$/, "").trim();
    if (!ts || !text) continue;
    const created = new Date(parseFloat(ts) * 1000).toISOString();
    if (created <= status.c) continue;
    const isDm = /^(DM|Direct|Group DM|mpdm)|^@/i.test(channel) || !channel.startsWith("#");
    items.push({ kind: isDm ? "slack DM or group DM" : "slack channel message", url: link, ref: ts, created_at: created, text, context: channel });
  }
  const next = (parsed.pagination_info || "").match(/cursor `([^`]+)`/);
  if (!next) break;
  cursor = next[1];
}
const file = `/tmp/voice-slack-${Date.now()}.jsonl`;
await tools.write({ path: file, content: items.map((i) => JSON.stringify(i)).join("\n") + "\n" });
const newCursor = stoppedEarly ? (items.length ? items[items.length - 1].created_at : status.c) : startedAt;
const out = await tools.bash({ command: `${BIN}/ingest_jsonl.py slack ${file} ${newCursor}`, timeout: 900 });
return { fetched: items.length, stoppedEarly, cursorNow: newCursor, ingest: out.output };
