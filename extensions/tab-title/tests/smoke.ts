// Model-free smoke test for tab-title: node --experimental-strip-types tests/smoke.ts

import assert from "node:assert/strict";

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const tabTitle = (await import("../index.ts")).default;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SessionEntry = { type: string; customType?: string; data?: unknown; message?: unknown };

interface Harness {
	titles: string[];
	names: string[];
	notices: string[];
	widgets: Array<unknown>;
	modelCalls: number;
	entries: SessionEntry[];
	/** Queued answers for ui.select then ui.input; an empty queue means the user pressed Esc. */
	answers: Array<string | undefined>;
	prompts: string[];
	run: (args?: string) => Promise<void>;
	fire: (event: string, payload?: unknown) => Promise<void>;
	setReply: (text: string) => void;
}

function harness(options: { name?: string; reply?: string; entries?: SessionEntry[] } = {}): Harness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const titles: string[] = [];
	const names: string[] = [];
	const notices: string[] = [];
	const answers: Array<string | undefined> = [];
	const prompts: string[] = [];
	const widgets: Array<unknown> = [];
	const state = { reply: options.reply ?? "🐛 fix cart rounding bug", modelCalls: 0 };
	const entries: SessionEntry[] = [
		{ type: "message", message: { role: "user", content: "fix the cart rounding bug" } },
		...(options.entries ?? []),
	];
	let sessionName = options.name;

	const theme = {
		bold: (value: string) => value,
		fg: (_token: string, value: string) => value,
		bg: (_token: string, value: string) => value,
	};

	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setTitle: (text: string) => titles.push(text),
			setWidget: (_id: string, renderer: unknown) => widgets.push(renderer),
			setStatus: () => {},
			notify: (message: string) => notices.push(message),
			select: async (title: string) => (prompts.push(`select:${title}`), answers.shift()),
			input: async (title: string) => (prompts.push(`input:${title}`), answers.shift()),
			editor: async (title: string) => (prompts.push(`editor:${title}`), answers.shift()),
		},
		sessionManager: {
			getBranch: () => entries,
		},
		model: { provider: "stub", id: "stub-model" },
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => true,
			complete: async () => {
				state.modelCalls += 1;
				return { content: [{ type: "text", text: state.reply }] };
			},
		},
	} as unknown as never;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		setSessionName(name: string) {
			sessionName = name.replace(/[\r\n]+/g, " ").trim();
			names.push(sessionName);
		},
		getSessionName: () => sessionName,
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as Parameters<typeof tabTitle>[0];

	tabTitle(pi);

	return {
		titles,
		names,
		notices,
		widgets,
		entries,
		answers,
		prompts,
		get modelCalls() {
			return state.modelCalls;
		},
		setReply: (text: string) => {
			state.reply = text;
		},
		run: async (args = "") => {
			await commands.get("tab-title")?.handler(args, ctx);
		},
		fire: async (event: string, payload: unknown = {}) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	} as Harness;
}

// ------------------------------------------------------- auto-generated label

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.run("now");
	assert.deepEqual(h.names, ["🐛 fix cart rounding bug"]);
	assert.equal(h.titles.at(-1), "🐛 fix cart rounding bug");

	// pi echoes the write back as session_info_changed; it must not be adopted.
	await h.fire("session_info_changed", { name: "🐛 fix cart rounding bug" });
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(auto\): 🐛 fix cart rounding bug$/);
}

// ------------------------------------------------------------- user /name wins

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.run("now");
	const writesBefore = h.names.length;

	await h.fire("session_info_changed", { name: "release prep" });
	assert.equal(h.titles.at(-1), "release prep");
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(pinned\): release prep$/);

	// No emoji forced on, and auto-naming has stopped.
	await h.fire("agent_settled", {});
	await sleep(600);
	assert.equal(h.names.length, writesBefore);
	assert.equal(h.titles.at(-1), "release prep");

	// /tab-title auto resumes auto-naming and overwrites the adopted name.
	h.setReply("🚀 ship the release");
	await h.run("auto");
	assert.equal(h.names.at(-1), "🚀 ship the release");
	assert.equal(h.titles.at(-1), "🚀 ship the release");
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(auto\): 🚀 ship the release$/);
}

// ------------------------------------------- name normalization is accounted for

{
	const h = harness({ reply: "📝  write   the docs " });
	await h.fire("session_start", { reason: "startup" });
	await h.run("now");
	const written = h.names.at(-1) ?? "";
	await h.fire("session_info_changed", { name: written });
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(auto\): /);
}

// ------------------------------------------------------- clearing returns to auto

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.fire("session_info_changed", { name: "manual name" });
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /\(pinned\)/);

	await h.fire("session_info_changed", { name: undefined });
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(auto\)/);
}

// ----------------------------------------------- resumed session keeps its name

{
	const h = harness({ name: "team:worker-3" });
	await h.fire("session_start", { reason: "resume" });
	await sleep(600);
	assert.deepEqual(h.names, []);
	assert.equal(h.modelCalls, 0);
	assert.equal(h.titles.at(-1), "team:worker-3");
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(pinned\): team:worker-3$/);

	// A rename after resume is still adopted verbatim.
	await h.fire("session_info_changed", { name: "team:worker-3 (renamed)" });
	assert.equal(h.titles.at(-1), "team:worker-3 (renamed)");
	assert.deepEqual(h.names, []);
}

// ------------------------- resumed external name ignores format/emoji/refresh

{
	process.env.PI_TAB_TITLE_FORMAT = "[{emoji} {summary}]";
	process.env.PI_TAB_TITLE_REFRESH = "always";
	const h = harness({ name: "team:worker-3" });
	delete process.env.PI_TAB_TITLE_FORMAT;
	delete process.env.PI_TAB_TITLE_REFRESH;

	await h.fire("session_start", { reason: "resume" });
	await h.fire("agent_settled", {});
	await sleep(600);
	assert.equal(h.titles.at(-1), "team:worker-3");
	assert.deepEqual(h.names, []);
	assert.equal(h.modelCalls, 0);
}

// ------------------------ resumed own name stays auto and is not self-pinned

{
	const own = "🐛 fix cart rounding bug";
	const h = harness({ name: own, entries: [{ type: "custom", customType: "tab-title", data: { name: own } }] });
	await h.fire("session_start", { reason: "resume" });
	await sleep(600);
	assert.deepEqual(h.names, []);
	assert.equal(h.modelCalls, 0);
	assert.equal(h.titles.at(-1), own);
	await h.run();
	assert.equal(h.notices.at(-1), `Tab title (auto): ${own}`);

	await h.fire("session_info_changed", { name: own });
	assert.equal(h.titles.at(-1), own);
	await h.run();
	assert.equal(h.notices.at(-1), `Tab title (auto): ${own}`);
}

// ------------------------------- own name is persisted as a session entry

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.run("now");
	const stored = h.entries.filter((entry) => entry.customType === "tab-title");
	assert.deepEqual(stored.map((entry) => entry.data), [{ name: "🐛 fix cart rounding bug" }]);
}

// ---------------------------------------------------------------- /tab-title off

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await h.run("now");
	await h.run("off");
	const titlesBefore = h.titles.length;
	await h.fire("session_info_changed", { name: "ignored while off" });
	assert.equal(h.titles.length, titlesBefore);
}

// ------------------------------------------------------ /tab-title selection

{
	const h = harness();
	await h.fire("session_start", { reason: "startup" });

	h.answers.push("Pin my own text…", "📌 my pinned title");
	await h.run();
	assert.deepEqual(
		h.prompts.map((p) => p.split(":")[0]),
		["select", "input"],
	);
	assert.equal(h.titles.at(-1), "📌 my pinned title");
	assert.match(h.notices.at(-1) ?? "", /pinned/);

	h.answers.push("Auto-name it now");
	await h.run();
	assert.equal(h.modelCalls, 1, "auto-naming generates a fresh label");
	assert.equal(h.titles.at(-1), "🐛 fix cart rounding bug");

	h.answers.push("Turn auto-naming off");
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /disabled/);

	const before = h.prompts.length;
	await h.run("off");
	assert.equal(h.prompts.length, before, "a typed argument skips the selection");

	h.answers.push(undefined);
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(off\)/, "Esc only shows the current title");

	h.answers.push("Pin my own text…", "");
	await h.run();
	assert.match(h.notices.at(-1) ?? "", /^Tab title \(off\)/, "an empty pin changes nothing");
}

console.log("tab-title smoke: all checks passed");
