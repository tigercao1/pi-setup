/**
 * Routing tree tests (offline, deterministic) plus one live classification.
 *
 *   node --experimental-strip-types tests/classify.test.ts
 */

import {
	classify,
	decisionMass,
	distribution,
	parseLedger,
	RUBRIC_DIGEST,
	RUBRIC_VERSION,
	DEFAULT_THRESHOLDS,
	type Dimension,
	type DimensionScore,
	ledgerEntry,
	route,
} from "../classify.ts";

let failures = 0;

function check(name: string, condition: unknown, detail = ""): void {
	if (condition) console.log(`  ok   ${name}`);
	else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** A distribution peaked on the two rungs adjacent to `score`, as Jev returns. */
const s = (score: number, confidence = 0.9): DimensionScore => {
	const low = Math.floor(score);
	const frac = score - low;
	const probabilities: Record<string, number> = {};
	if (frac > 0) {
		probabilities[String(low)] = 1 - frac;
		probabilities[String(low + 1)] = frac;
	} else {
		probabilities[String(low)] = 1;
	}
	return { score, confidence, probabilities };
};

/** Explicit distribution, for the cases where the spread is the point. */
const spread = (score: number, probabilities: Record<string, number>, confidence = 0.9): DimensionScore => ({
	score,
	confidence,
	probabilities,
});

function scores(partial: Partial<Record<Dimension, DimensionScore>>): Record<Dimension, DimensionScore> {
	return {
		clarity: s(3.5),
		blast_radius: s(1.0),
		unknowns: s(0.5),
		parallelism: s(2.0),
		...partial,
	};
}

console.log("routing tree (offline)");

check("well-defined and small routes to EXECUTE", route(scores({})).route === "EXECUTE");

check(
	"well-defined and large routes to SPLIT",
	route(scores({ blast_radius: s(3.2) })).route === "SPLIT",
);

check("low clarity routes to SCOPE", route(scores({ clarity: s(1.2) })).route === "SCOPE");

check("unknowns route to SPIKE", route(scores({ unknowns: s(3.1) })).route === "SPIKE");

check(
	"unknowns beat low clarity — SPIKE is checked first",
	route(scores({ unknowns: s(3.1), clarity: s(0.4) })).route === "SPIKE",
	"planning around unknowns produces fiction, so SPIKE must win",
);

check(
	"large and ambiguous routes to SCOPE, not SPLIT",
	route(scores({ clarity: s(1.0), blast_radius: s(3.9) })).route === "SCOPE",
);

console.log("\nboundaries");
check("clarity exactly at the floor is not low", route(scores({ clarity: s(2.0) })).route === "EXECUTE");
check("blast radius exactly at the threshold splits", route(scores({ blast_radius: s(2.0) })).route === "SPLIT");
check(
	"unknowns exactly on the threshold with mass either side is UNCERTAIN, not SPIKE",
	route(scores({ unknowns: s(2.5) })).route === "UNCERTAIN",
	"s(2.5) puts 0.5 on rung 2 and 0.5 on rung 3 — that is a genuine coin flip",
);
check(
	"unknowns on the threshold with one-sided mass does spike",
	route(scores({ unknowns: spread(2.5, { "3": 0.8, "4": 0.1, "2": 0.1 }) })).route === "SPIKE",
);

console.log("\ndecision mass gate");
{
	check(
		"mass split across the threshold blocks",
		(() => {
			const r = route(scores({ blast_radius: spread(1.9, { "1": 0.45, "2": 0.55 }) }));
			return r.route === "UNCERTAIN" && r.blockedOn === "blast_radius";
		})(),
	);

	check(
		"a score near the threshold still decides when the mass is one-sided",
		(() => {
			const r = route(scores({ blast_radius: spread(1.4, { "0": 0.68, "1": 0.09, "2": 0.23 }) }));
			return r.route === "EXECUTE" && (r.mass ?? 0) > 0.7;
		})(),
		"the real measured distribution for a one-file change",
	);

	check(
		"low rung-level confidence does NOT block when the mass is one-sided",
		route(scores({ blast_radius: spread(0.54, { "0": 0.68, "1": 0.09, "2": 0.23 }, 0.54) })).route === "EXECUTE",
		"rung 0 vs rung 1 is a distinction the threshold does not care about",
	);

	check(
		"a blocked branch never silently becomes EXECUTE",
		route(scores({ unknowns: spread(2.4, { "2": 0.5, "3": 0.5 }) })).route === "UNCERTAIN",
	);

	check(
		"parallelism spread never blocks — it decides nothing",
		route(scores({ parallelism: spread(2.0, { "0": 0.5, "4": 0.5 }, 0.01) })).route === "EXECUTE",
	);

	check(
		"a decided branch is not blocked by a later dimension's spread",
		route(scores({ unknowns: s(3.1), blast_radius: spread(2.0, { "1": 0.5, "2": 0.5 }) })).route === "SPIKE",
	);

	check("mass on an empty distribution is 0", decisionMass({}, () => true) === 0);
	check("mass normalises an unnormalised distribution", decisionMass({ "0": 2, "3": 2 }, (r) => r >= 2) === 0.5);
}

console.log("\nledger entry");
{
	const sample = {
		scores: scores({ clarity: spread(3.4, { "3": 0.6, "4": 0.4 }) }),
		route: "EXECUTE" as const,
		reason: "test",
		mass: 0.91,
		thresholds: DEFAULT_THRESHOLDS,
		rubricVersion: RUBRIC_VERSION,
		rubricDigest: RUBRIC_DIGEST,
		model: "typesafe-ai/jev",
		usage: { inputTokens: 600, outputTokens: 40 },
	};
	const entry = ledgerEntry(sample, "ABC-1");
	check("entry is dated and greppable", /^## \d{4}-\d{2}-\d{2}T[\d:]+Z · classify · ABC-1/.test(entry));
	check("entry names the route", entry.includes("route: **EXECUTE**"));
	check("entry carries every dimension", (["clarity", "blast_radius", "unknowns", "parallelism"] as Dimension[]).every((d) => entry.includes(d)));
	check("entry records the thresholds it used", entry.includes("mass-floor=0.6"));
	check("entry records the rubric version and digest", entry.includes(`rubric v${RUBRIC_VERSION} (${RUBRIC_DIGEST})`));
	check("entry shows the per-rung spread", entry.includes("0.00 0.00 0.00 0.60 0.40"));

	const parsed = parseLedger(`prose\n${entry}\nmore prose\n${ledgerEntry(sample, "ABC-2")}`);
	check("both records parse back out", parsed.length === 2);
	check("record keeps the full distribution", JSON.stringify((parsed[0] as any).scores.clarity.p) === "[0,0,0,0.6,0.4]");
	check("record keeps the rubric digest", (parsed[0] as any).rubric.digest === RUBRIC_DIGEST);
	check("record keeps the units", (parsed[0] as any).unit === "ABC-1" && (parsed[1] as any).unit === "ABC-2");
	check("record keeps the deciding mass", (parsed[0] as any).mass === 0.91);
	check("a hand-mangled record does not break the rest", parseLedger(`<!-- jev-classify {broken -->\n${entry}`).length === 1);

	check("distribution is dense over the rubric's rungs", distribution("clarity", sample.scores).length === 5);
}

console.log("\nrubric identity");
{
	check("digest is 8 hex chars", /^[0-9a-f]{8}$/.test(RUBRIC_DIGEST));
	check("digest is stable within a process", RUBRIC_DIGEST === RUBRIC_DIGEST);
	// Pinned on purpose: an accidental rung edit should fail here. When the
	// rubric changes deliberately, bump RUBRIC_VERSION and this pin together.
	check(
		"digest matches the pinned rubric",
		RUBRIC_DIGEST === "7ee06e35",
		`got ${RUBRIC_DIGEST} — if you meant to change the rubric, bump RUBRIC_VERSION and this pin`,
	);
}

console.log("\nlive classification");

const smallWellDefined = [
	"TICKET ABC-5301: the product list shows an em dash for a missing price; product wants 'Not specified'.",
	"",
	"Recon: one component, src/catalog/ProductRow.tsx line 64, renders `price ?? '—'`.",
	"No other caller formats price. One existing test file covers the row.",
	"Acceptance criteria in the ticket: show 'Not specified' when price is null, keep existing",
	"formatting when it is present, update the snapshot.",
	"Nothing unknown: the null case is reproducible locally and the copy is agreed in the ticket.",
].join("\n");

const largeUnknown = [
	"TICKET ABC-5188: invoice exports are occasionally missing line items for multi-region customers.",
	"",
	"Recon: reports from 3 customers over 6 weeks. No reproduction. The export path spans",
	"modules/billing, modules/orders and a shared LineItem aggregate used by 40+ callers.",
	"It is not established whether the cause is the export query, the timezone normalisation,",
	"or an upstream data problem in order publication. No one has checked whether the missing",
	"line items exist in the database at all.",
].join("\n");

const small = await classify(smallWellDefined);
console.log(`\n${ledgerEntry(small, "ABC-5301")}`);
check(
	"small well-defined unit never routes to SPLIT or SPIKE",
	small.route === "EXECUTE" || small.route === "UNCERTAIN",
	`got ${small.route}: ${small.reason}`,
);
if (small.route !== "EXECUTE") console.log(`  note  expected EXECUTE, got ${small.route} — check the mass floor`);

const large = await classify(largeUnknown);
console.log(ledgerEntry(large, "ABC-5188"));
check(
	"large unreproduced bug routes to SPIKE or SCOPE, never EXECUTE",
	large.route === "SPIKE" || large.route === "SCOPE",
	`got ${large.route}: ${large.reason}`,
);
check("live scores carry confidences", Object.values(large.scores).every((v) => v.confidence > 0));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
