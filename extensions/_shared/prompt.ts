/**
 * Shared prompt steps for slash commands, so every extension asks for options
 * the same way:
 *
 * - `choose` is one single-option selection. Commands with several options ask
 *   one `choose` per option rather than a multi-select.
 * - `askMessage` asks for a message. Enter with nothing typed returns "" (the
 *   command's no-message behaviour); Esc returns null (abort the command).
 *
 * Without a UI (headless, RPC, spawned agents) neither prompts: `choose`
 * returns the first choice and `askMessage` returns "", so orchestrated
 * sessions never block on a dialog.
 */

export interface PromptContext {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
	};
}

export interface Choice<T> {
	label: string;
	value: T;
}

/** The first choice is the default used when there is no UI. */
export async function choose<T>(
	ctx: PromptContext,
	title: string,
	choices: ReadonlyArray<Choice<T>>,
): Promise<{ value: T } | null> {
	const fallback = choices[0];
	if (!fallback) return null;
	if (!ctx.hasUI) return { value: fallback.value };
	const picked = await ctx.ui.select(title, choices.map((choice) => choice.label));
	const hit = choices.find((choice) => choice.label === picked);
	return hit ? { value: hit.value } : null;
}

export async function askMessage(
	ctx: PromptContext,
	title: string,
	options: { multiline?: boolean } = {},
): Promise<string | null> {
	if (!ctx.hasUI) return "";
	const typed = options.multiline ? await ctx.ui.editor(title, "") : await ctx.ui.input(title);
	return typed === undefined ? null : typed.trim();
}
