/**
 * ext-manager — interactive enable/disable of pi extensions.
 *
 *   /extensions   checkbox list of every discovered extension, with a
 *                 description panel for whatever is focused
 *
 * Toggling writes `+path` / `-path` override patterns into the `extensions`
 * array of the matching settings file:
 *   - user-scope extensions  → ~/.pi/agent/settings.json
 *   - project-scope ones     → <cwd>/.pi/settings.json
 * which is exactly what `pi config` does, so both stay in sync.
 *
 * Extensions provided by installed packages (npm:/git:) are shown read-only —
 * those are filtered per-package and are best managed with `pi config`.
 *
 * Changes take effect after a reload; the dialog offers to reload on exit.
 */

import { relative } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	getAgentDir,
	getSettingsListTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describeExtension, wrap } from "./describe.ts";

type Scope = "user" | "project";

interface Row {
	id: string;
	resource: ResolvedResource;
	scope: Scope;
	/** Override pattern used in settings (relative to the resource base dir). */
	pattern: string;
	/** Package-provided resources cannot be toggled here. */
	locked: boolean;
	label: string;
	description: string;
}

const ENABLED = "enabled";
const DISABLED = "disabled";

const isPattern = (entry: string) =>
	entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");

const patternTarget = (entry: string) => (isPattern(entry) ? entry.slice(1) : entry);

/** Pretty name: "extensions/ding/index.ts" → "ding", "foo.ts" → "foo". */
function displayName(path: string, baseDir: string): string {
	const rel = (relative(baseDir, path) || path).replace(/^extensions\//, "");
	const parts = rel.split("/");
	const last = parts.at(-1) ?? rel;
	if (parts.length > 1 && /^index\.[tj]s$/.test(last)) return parts.slice(0, -1).join("/");
	return rel.replace(/\.[tj]s$/, "");
}

function buildRows(resources: ResolvedResource[], agentDir: string, cwd: string): Row[] {
	const topLevelBase = (scope: Scope) =>
		scope === "project" ? `${cwd}/${CONFIG_DIR_NAME}` : agentDir;

	return resources
		.map((resource, index) => {
			const scope: Scope = resource.metadata.scope === "project" ? "project" : "user";
			const baseDir = resource.metadata.baseDir ?? topLevelBase(scope);
			const locked = resource.metadata.origin === "package";
			const source = resource.metadata.source;
			return {
				id: `${index}`,
				resource,
				scope,
				pattern: relative(baseDir, resource.path) || resource.path,
				locked,
				label: displayName(resource.path, baseDir),
				description: [
					scope,
					locked ? `package ${source}` : source === "auto" ? "auto-discovered" : source,
					locked ? "(read-only — use `pi config`)" : resource.path,
				].join(" · "),
			} satisfies Row;
		})
		.sort(
			(a, b) =>
				Number(a.locked) - Number(b.locked) ||
				a.scope.localeCompare(b.scope) ||
				a.label.localeCompare(b.label),
		);
}

/** Rewrite the settings `extensions` array so `row` ends up enabled/disabled. */
function persist(settings: SettingsManager, row: Row, enabled: boolean): void {
	const current = (
		row.scope === "project"
			? (settings.getProjectSettings().extensions ?? [])
			: (settings.getGlobalSettings().extensions ?? [])
	) as string[];

	// Drop any existing override for this resource, then add the new one.
	const kept = current.filter((entry) => {
		if (!isPattern(entry)) return true;
		const target = patternTarget(entry);
		return target !== row.pattern && target !== row.resource.path;
	});
	kept.push(`${enabled ? "+" : "-"}${row.pattern}`);

	if (row.scope === "project") settings.setProjectExtensionPaths(kept);
	else settings.setExtensionPaths(kept);
}

async function loadRows(ctx: ExtensionCommandContext): Promise<{
	rows: Row[];
	settings: SettingsManager;
}> {
	const agentDir = getAgentDir();
	const settings = SettingsManager.create(ctx.cwd, agentDir, {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const packageManager = new DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir,
		settingsManager: settings,
	});
	// Never install anything just to render the list.
	const resolved = await packageManager.resolve(async () => "skip");
	return { rows: buildRows(resolved.extensions, agentDir, ctx.cwd), settings };
}

export default function extManager(pi: ExtensionAPI) {
	pi.registerCommand("extensions", {
		description: "Enable/disable extensions (writes settings.json)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/extensions requires TUI mode", "error");
				return;
			}

			const { rows, settings } = await loadRows(ctx);
			if (rows.length === 0) {
				ctx.ui.notify("No extensions discovered", "warning");
				return;
			}

			const state = new Map(rows.map((row) => [row.id, row.resource.enabled]));
			let changed = false;

			let selected = 0;

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const toggle = (row: Row): void => {
					if (row.locked) {
						ctx.ui.notify(`${row.label} is package-provided — manage it with \`pi config\``, "warning");
						return;
					}
					if (row.scope === "project" && !ctx.isProjectTrusted()) {
						ctx.ui.notify("Project is not trusted — cannot write .pi/settings.json", "error");
						return;
					}
					const next = !state.get(row.id);
					try {
						persist(settings, row, next);
					} catch (error) {
						ctx.ui.notify(`Failed to save: ${(error as Error).message}`, "error");
						return;
					}
					state.set(row.id, next);
					changed = true;
				};

				const render = (width: number): string[] => {
					const enabledCount = rows.filter((row) => state.get(row.id)).length;
					const lines: string[] = [
						theme.fg("accent", theme.bold("Extensions")) +
							theme.fg("dim", `  ${enabledCount}/${rows.length} enabled`),
					];

					// [✓] / [ ] mirrors the /mcp server list.
					const budget = Math.max(4, Math.min(rows.length, 12));
					const first = Math.max(0, Math.min(selected - Math.floor(budget / 2), rows.length - budget));
					for (let i = first; i < Math.min(rows.length, first + budget); i++) {
						const row = rows[i] as Row;
						const on = state.get(row.id) === true;
						const focused = i === selected;
						const box = on ? "[✓]" : "[ ]";
						const name = row.locked ? `${row.label} 🔒` : row.label;
						const meta = row.scope === "project" ? " · project" : "";
						// Every row keeps the same two leading columns so the
						// checkboxes line up in one column.
						const clipped = truncateToWidth(`${focused ? "›" : " "} ${box} ${name}${meta}`, width);
						lines.push(
							focused
								? theme.fg("accent", clipped)
								: on
									? clipped.replace(box, theme.fg("success", box))
									: theme.fg("dim", clipped),
						);
					}
					if (rows.length > budget) lines.push(theme.fg("dim", `  ${selected + 1}/${rows.length}`));

					// What the focused extension is, and how to use it.
					const row = rows[selected] as Row | undefined;
					if (row) {
						const doc = describeExtension(row.resource.path);
						const inner = Math.max(20, width - 2);
						lines.push("");
						for (const line of wrap(doc.summary, inner)) lines.push(theme.fg("text", `  ${line}`));
						for (const paragraph of doc.detail) {
							for (const line of wrap(paragraph, inner).slice(0, 3)) {
								lines.push(theme.fg("dim", `  ${line}`));
							}
						}
						const provides = [
							...doc.commands.map((command) => `/${command}`),
							...doc.tools,
							...doc.shortcuts,
						];
						if (provides.length > 0) {
							for (const line of wrap(`Provides: ${provides.join("  ")}`, inner)) {
								lines.push(theme.fg("mdLink", `  ${line}`));
							}
						}
						lines.push(
							theme.fg(
								"dim",
								truncateToWidth(
									`  ${row.locked ? "package (read-only — use `pi config`)" : row.resource.path}`,
									width,
								),
							),
						);
					}

					lines.push("");
					lines.push(
						theme.fg(
							"dim",
							truncateToWidth("↑↓ move · space/enter toggle · esc close (applies after reload)", width),
						),
					);
					return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
				};

				return {
					render,
					invalidate: () => {},
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up) || data === "k") selected = Math.max(0, selected - 1);
						else if (matchesKey(data, Key.down) || data === "j")
							selected = Math.min(rows.length - 1, selected + 1);
						else if (matchesKey(data, Key.enter) || data === " ") {
							const row = rows[selected];
							if (row) toggle(row);
						} else if (matchesKey(data, Key.escape) || data === "q") {
							done(undefined);
							return;
						}
						tui.requestRender();
					},
				};
			});

			if (!changed) return;
			await settings.flush();

			const summary = rows
				.filter((row) => state.get(row.id) !== row.resource.enabled)
				.map((row) => `${state.get(row.id) ? "+" : "-"}${row.label}`)
				.join(", ");
			ctx.ui.notify(`Saved: ${summary || "no net change"}`, "info");

			if (await ctx.ui.confirm("Reload now?", "Apply extension changes immediately")) {
				await ctx.reload();
				return;
			}
			ctx.ui.notify("Run /reload (or restart pi) to apply", "warning");
		},
	});
}
