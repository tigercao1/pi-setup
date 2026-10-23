import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { TaskContract } from "./state.ts";

const REGEX_FIELD = /^\/(.+)\/([a-z]*)$/s;

export const normalisePath = (path: string, cwd: string): string =>
	resolve(cwd, path.replace(/^~(?=\/|$)/, homedir()));

export const absoluteContract = (contract: TaskContract, cwd: string): TaskContract =>
	contract.outputPath ? { ...contract, outputPath: normalisePath(contract.outputPath, cwd) } : contract;

export function requiredFieldMatcher(field: string): ((body: string) => boolean) | string {
	const regex = REGEX_FIELD.exec(field);
	if (!regex) {
		const needle = field.toLowerCase();
		return (body) => body.toLowerCase().includes(needle);
	}
	try {
		const re = new RegExp(regex[1]!, regex[2]!.replace(/g/g, ""));
		return (body) => re.test(body);
	} catch (error) {
		return `invalid regex ${field}: ${(error as Error).message}`;
	}
}

export function invalidRequiredFields(fields: string[] | undefined): string[] {
	return (fields ?? [])
		.map(requiredFieldMatcher)
		.filter((m): m is string => typeof m === "string");
}

function deliverableProblem(path: string): string | null {
	let stat;
	try {
		stat = statSync(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? `${path} does not exist` : `${path} cannot be read (${code ?? (error as Error).message})`;
	}
	if (!stat.isFile()) return `${path} is not a regular file`;
	return stat.size === 0 ? `${path} is empty` : null;
}

export function checkDone(output: string | undefined, contract: TaskContract | null, cwd: string): string | null {
	const expected = contract?.outputPath ? normalisePath(contract.outputPath, cwd) : null;
	if (!output) {
		return expected
			? `state 'done' needs output: your contract's outputPath is ${contract!.outputPath}. ` +
					"Write the deliverable there, then call team_write_status again with that path."
			: null;
	}
	const actual = normalisePath(output, cwd);
	if (expected && actual !== expected) {
		return `output ${output} does not match your contract's outputPath ${contract!.outputPath}. ` +
			"Write the deliverable to the contract path and report that path.";
	}
	const problem = deliverableProblem(actual);
	return problem ? `${problem}. Write the deliverable first, then report done.` : null;
}

export function missingFields(path: string | undefined, contract: TaskContract | null, cwd: string): string[] | null {
	const fields = contract?.requiredFields ?? [];
	if (fields.length === 0) return null;
	const target = path ?? contract?.outputPath;
	if (!target) return ["deliverable (no output path)"];
	let body: string;
	try {
		const full = normalisePath(target, cwd);
		if (statSync(full).isDirectory()) return ["deliverable (is a directory, cannot grep)"];
		body = readFileSync(full, "utf8");
	} catch {
		return [`deliverable (${target} unreadable)`];
	}
	return fields.filter((field) => {
		const matcher = requiredFieldMatcher(field);
		return typeof matcher === "string" || !matcher(body);
	});
}
