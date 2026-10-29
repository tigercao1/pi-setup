import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";

const canonical = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

if (canonical(homedir()) === canonical(userInfo().homedir)) {
	console.error("smoke.ts refuses to run with your real HOME; run: HOME=$(mktemp -d) node --experimental-strip-types tests/smoke.ts");
	process.exit(2);
}
