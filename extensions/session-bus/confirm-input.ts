/**
 * The session_send question: a one-line input that sends the summary as is
 * when the human never touches it. A countdown shows the time left; the first
 * key of any kind stops it for good, and the box then waits for Enter or Esc.
 */

import { type Focusable, getKeybindings, Input, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const DEFAULT_CONFIRM_WAIT_MS = 60_000;

export function confirmWaitMs(raw: string | undefined = process.env.PI_BUS_CONFIRM_WAIT_MS): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIRM_WAIT_MS;
}

export interface TimerClock {
	now: () => number;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}

export const systemClock: TimerClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class IdleCountdown {
	private readonly deadline: number;
	private readonly onTick: () => void;
	private readonly onExpire: () => void;
	private readonly clock: TimerClock;
	private handle: unknown;
	private active = true;

	constructor(waitMs: number, onTick: () => void, onExpire: () => void, clock: TimerClock = systemClock) {
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.clock = clock;
		this.deadline = clock.now() + waitMs;
		this.schedule();
	}

	get running(): boolean {
		return this.active;
	}

	secondsLeft(): number {
		return Math.max(0, Math.ceil((this.deadline - this.clock.now()) / 1000));
	}

	stop(): void {
		this.active = false;
		if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
		this.handle = undefined;
	}

	private schedule(): void {
		const left = this.deadline - this.clock.now();
		if (left <= 0) {
			this.stop();
			this.onExpire();
			return;
		}
		const untilNextSecond = left % 1000 || 1000;
		this.handle = this.clock.setTimeout(() => {
			this.handle = undefined;
			if (!this.active) return;
			this.onTick();
			this.schedule();
		}, untilNextSecond);
	}
}

export interface ConfirmTheme {
	accent: (text: string) => string;
	dim: (text: string) => string;
}

const plain: ConfirmTheme = { accent: (t) => t, dim: (t) => t };

export interface ConfirmInputOptions {
	title: string;
	placeholder?: string;
	waitMs: number;
	onDone: (value: string | undefined) => void;
	requestRender?: () => void;
	theme?: ConfirmTheme;
	clock?: TimerClock;
	signal?: AbortSignal;
}

export class ConfirmInput implements Focusable {
	private readonly input: Input;
	private readonly countdown: IdleCountdown | undefined;
	private readonly options: ConfirmInputOptions;
	private readonly theme: ConfirmTheme;
	private readonly onAbort = () => this.finish(undefined);
	private finished = false;
	private _focused = false;

	constructor(options: ConfirmInputOptions) {
		this.options = options;
		this.theme = options.theme ?? plain;
		this.input = new Input({ placeholder: options.placeholder, placeholderStyle: this.theme.dim });
		if (options.signal?.aborted) {
			this.finish(undefined);
			return;
		}
		options.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.countdown =
			options.waitMs > 0
				? new IdleCountdown(
						options.waitMs,
						() => options.requestRender?.(),
						() => this.finish(""),
						options.clock,
					)
				: undefined;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	get counting(): boolean {
		return this.countdown?.running ?? false;
	}

	handleInput(data: string): void {
		if (this.finished) return;
		this.countdown?.stop();
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.confirm") || data === "\n") this.finish(this.input.getValue());
		else if (keys.matches(data, "tui.select.cancel")) this.finish(undefined);
		else this.input.handleInput(data);
		this.options.requestRender?.();
	}

	render(width: number): string[] {
		const inner = Math.max(10, width - 2);
		const lines = wrapTextWithAnsi(this.theme.accent(this.options.title), inner).map((l) => ` ${l}`);
		lines.push("", ...this.input.render(width), "");
		lines.push(...wrapTextWithAnsi(this.theme.dim(this.hint()), inner).map((l) => ` ${l}`));
		return lines;
	}

	hint(): string {
		const keys = "enter send · esc summary only · type cancel: don't send";
		return this.counting ? `auto-sends in ${this.countdown!.secondsLeft()}s · any key stops the timer · ${keys}` : keys;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.countdown?.stop();
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}

	private finish(value: string | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.options.onDone(value);
	}
}
