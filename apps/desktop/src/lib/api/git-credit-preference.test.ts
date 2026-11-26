import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
	GIT_CREDIT_RYU_PREF_KEY,
	parseGitCreditRyu,
	RYU_COAUTHOR_TRAILER,
} from "./git-credit-preference.ts";

const coreSource = readFileSync(
	path.resolve(
		import.meta.dir,
		"../../../../../crates/core/workspace/src/git/credit.rs"
	),
	"utf8"
);

describe("git credit preference", () => {
	it("stays on when the preference is unset or malformed", () => {
		expect(parseGitCreditRyu(null)).toBe(true);
		expect(parseGitCreditRyu("")).toBe(true);
		expect(parseGitCreditRyu("not-a-boolean")).toBe(true);
	});

	it("parses saved booleans without depending on casing or whitespace", () => {
		expect(parseGitCreditRyu(" true ")).toBe(true);
		expect(parseGitCreditRyu("FALSE")).toBe(false);
		expect(parseGitCreditRyu(" false ")).toBe(false);
	});

	it("previews the same trailer and key that Core uses", () => {
		expect(coreSource).toContain(
			`RYU_COAUTHOR_TRAILER: &str = "${RYU_COAUTHOR_TRAILER}";`
		);
		expect(coreSource).toContain(
			`GIT_CREDIT_RYU_PREF_KEY: &str = "${GIT_CREDIT_RYU_PREF_KEY}";`
		);
	});
});
