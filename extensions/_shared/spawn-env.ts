/**
 * The environment a spawned pi process gets.
 *
 * Deliberately a whitelist. A blind `{...process.env}` copy leaks two classes
 * of lie into the child: identity vars that make it impersonate its parent
 * (`PI_ORCH_*`, `PI_FORK_*`), and process-scoped vars that describe the
 * parent's model rather than the child's.
 */

/**
 * Vars that describe THIS process and would be a lie in a child running a
 * different model. Skills use `$PI_MODEL` to write git co-authorship trailers,
 * so inheriting the parent's value makes a child claim provenance it does not
 * have. The child's own pi sets these correctly.
 */
const PROCESS_SCOPED = new Set(["PI_MODEL", "PI_PROVIDER", "PI_THINKING_LEVEL", "PI_SESSION_ID"]);

/** Identity namespaces: never inherited, always set explicitly by the caller. */
const IDENTITY_PREFIX = /^PI_(ORCH|FORK)_/;

/** …except these, which are configuration rather than identity. */
const IDENTITY_KEEP = new Set(["PI_FORK_ROOT"]);

export function spawnEnv(identity: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	const passthrough = /_API_KEY$|_TOKEN$|^AWS_|^ANTHROPIC_|^OPENAI_|^GOOGLE_|^VERCEL_/;
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (IDENTITY_PREFIX.test(key) && !IDENTITY_KEEP.has(key)) continue;
		if (PROCESS_SCOPED.has(key)) continue;
		if (key === "PATH" || key === "HOME" || key === "SHELL" || key === "LANG") env[key] = value;
		else if (key.startsWith("PI_") || passthrough.test(key)) env[key] = value;
	}
	return { ...env, ...identity };
}
