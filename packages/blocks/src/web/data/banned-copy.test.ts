import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BANNED_COPY as BANNED_COPY_SOURCE } from "./banned-copy.test-support.ts";
import { BANNED_COPY, bannedCopyHits } from "./banned-copy.ts";

test("hits are reported once each, case-sensitively", () => {
	expect(
		bannedCopyHits(["Runs as a sidecar", "Another sidecar", "Workcell"])
	).toEqual(["sidecar"]);
	expect(bannedCopyHits(["Hundreds of tools, 20+ tools"]).sort()).toEqual([
		"20+ tools",
		"Hundreds of",
	]);
	expect(bannedCopyHits(["Run agents with the tools they need."])).toEqual([]);
	expect(bannedCopyHits([])).toEqual([]);
});

test("the catalog copy check in products.test.ts uses this one list", () => {
	const source = readFileSync(
		new URL("./products.test.ts", import.meta.url),
		"utf8"
	);
	expect(source).toContain('import { BANNED_COPY } from "./banned-copy.ts";');
	expect(source).not.toMatch(/const BANNED_COPY\b/);
});

test("the guard list stays off the i18n extraction surface", () => {
	const shim = readFileSync(
		new URL("./banned-copy.ts", import.meta.url),
		"utf8"
	);
	expect(shim).not.toContain('"Palantir"');
	expect(shim).toContain('from "./banned-copy.test-support.ts"');
	expect(BANNED_COPY).toBe(BANNED_COPY_SOURCE);
	expect(BANNED_COPY).toContain("Palantir");
});
