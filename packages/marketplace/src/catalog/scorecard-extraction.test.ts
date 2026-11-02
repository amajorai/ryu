import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CATALOG_DIR = import.meta.dir;
// The extractor is untyped repo tooling; a runtime path keeps tsc off it.
const EXTRACTOR = join(
	CATALOG_DIR,
	"../../../../tools/i18n-extract/visitor.mjs"
);

async function extracted(file: string): Promise<Set<string>> {
	const extractor = (await import(EXTRACTOR)) as {
		extractFromSource: (path: string, text: string) => string[];
	};
	const path = join(CATALOG_DIR, file);
	return new Set(
		extractor.extractFromSource(
			`packages/marketplace/src/catalog/${file}`,
			readFileSync(path, "utf8")
		)
	);
}

// Scorecard check titles and details are positional check() arguments, which
// the extractor only collects when they go through tl(). These samples pin
// one label and one detail per rule module so a bare literal regresses loudly.
const SAMPLES: Record<string, string[]> = {
	"agent-scorecard.ts": [
		"Has an agent name",
		"Give the agent a name before saving it.",
		"Tool access is scoped",
	],
	"design-system-scorecard-source-rules.ts": [
		"Uses shared controls instead of local copies",
	],
	"design-system-scorecard.ts": [
		"Uses the Ryu App UI shell",
		"The Companion mounts through RyuAppShell and marks its host root.",
	],
	"plugin-scorecard-maintenance.ts": ["Issue tracker is open."],
	"publish-preflight.ts": [
		"Uses a supported package profile",
		"{count, plural, one {# declared artifact is} other {# declared artifacts are}} present in the inspected package.",
	],
	"scorecard-contract.ts": [
		"Passes every automated check.",
		"Not enough information to assess this listing.",
		"Review & provenance",
		"Whether anyone is still looking after it.",
	],
	"skill-scorecard.ts": ["Registry trust signal"],
};

describe("scorecard copy reaches the source catalog", () => {
	for (const [file, messages] of Object.entries(SAMPLES)) {
		test(file, async () => {
			const strings = await extracted(file);
			for (const message of messages) {
				expect(strings.has(message)).toBe(true);
			}
		});
	}
});
