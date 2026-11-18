const mod = await import("../index.ts");
const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
mod.default({
	on(event: string, fn: (event: unknown, ctx: unknown) => void) {
		handlers.set(event, [...(handlers.get(event) ?? []), fn]);
	},
} as never);
const ctx = { isIdle: () => false };
for (const event of ["session_start", "agent_start"]) for (const fn of handlers.get(event) ?? []) fn({}, ctx);
process.stdout.write("holding\n");
setInterval(() => {}, 1000);
