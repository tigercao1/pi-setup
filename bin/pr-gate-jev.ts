#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { evaluate, type Question } from "../extensions/jev/client.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

try {
	const input = JSON.parse(await readStdin()) as { state: string; questions: Record<string, Question> };
	const result = await evaluate(input.state, input.questions, { timeoutMs: 30_000, retries: 2 });
	process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
	process.stderr.write(`pr-gate-jev: ${(error as Error).message}\n`);
	process.exit(1);
}
