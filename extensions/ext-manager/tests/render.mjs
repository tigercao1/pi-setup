/**
 * Headless render check for /extensions.
 *
 * Drives the real component and asserts on what it prints, so the list can be
 * changed without opening a TUI. Toggling is NOT exercised here: persist()
 * writes to the live settings.json (learned the hard way — an earlier version
 * of this harness disabled an extension for real).
 */
import assert from "node:assert/strict";

const EXT = new URL("..", import.meta.url).pathname;
const { default: extManager } = await import(`${EXT}/index.ts`);
const commands = new Map();
extManager({ on(){}, registerCommand:(n,o)=>commands.set(n,o), registerTool(){}, registerMessageRenderer(){}, sendMessage(){} });

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let component = null;
const ctx = {
  cwd: process.cwd(), mode: "tui", hasUI: true,
  isProjectTrusted: () => true,
  ui: {
    notify(){}, confirm: async () => false,
    custom: async (factory) => {
      component = factory({ requestRender(){} }, { fg:(_c,t)=>t, bold:(t)=>t }, {}, () => {});
      return undefined;
    },
  },
  reload: async () => {},
};
await commands.get("extensions").handler("", ctx);
assert.ok(component, "component was created");
const first = component;
await commands.get("extensions").handler("", ctx);
const probe = component;
component = first;

const lines = component.render(96).map(plain);
const body = lines.join("\n");
let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.log(`FAIL  ${name}`); } };

check("header shows an enabled/total tally", /Extensions\s+\d+\/\d+ enabled/.test(lines[0]));
check("rows use mcp-style checkboxes", lines.some((l) => /^[› ] \[[✓ ]\] \S/.test(l)));
check("checkboxes are column-aligned", (() => {
  const cols = lines.filter((l) => /\[[✓ ]\]/.test(l)).map((l) => l.indexOf("["));
  return new Set(cols).size === 1;
})());
check("exactly one row is focused", lines.filter((l) => l.startsWith("›")).length === 1);
check("focused row gets a description", body.split("\n").some((l) => /^  \w.{20,}/.test(l)));
check("a row that registers commands or tools lists what it provides", (() => {
  for (let i = 0; i < 40; i++) {
    if (/Provides: /.test(probe.render(96).map(plain).join("\n"))) return true;
    probe.handleInput("\x1b[B");
  }
  return false;
})());
check("footer explains the keys", /space\/enter toggle/.test(body));
check("no line exceeds the width", lines.every((l) => l.length <= 96));

// Moving focus must change the details pane.
const before = component.render(96).map(plain).join("\n");
component.handleInput("\x1b[B");
const after = component.render(96).map(plain).join("\n");
check("moving focus updates the details pane", before !== after);

console.log(failures === 0 ? "\nall render checks passed" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
