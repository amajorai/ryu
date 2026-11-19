// The section notices are handed to `section()` positionally, where the
// catalog extractor never looks; held as named copy, every one is collected.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as notices from "./agentAccountCatalog-notices.ts";

const relativePath = "apps/cli/src/core/agentAccountCatalog-notices.ts";
const repositoryRoot = join(import.meta.dir, "../../../..");
const visitorPath = join(repositoryRoot, "tools/i18n-extract/visitor.mjs");

describe("account section notices", () => {
	test("the extractor collects every notice", async () => {
		const { extractFromSource } = (await import(visitorPath)) as {
			extractFromSource: (path: string, source: string) => Iterable<string>;
		};
		const extracted = new Set(
			extractFromSource(
				relativePath,
				readFileSync(join(repositoryRoot, relativePath), "utf8")
			)
		);
		const missing = Object.values(notices).filter(
			(notice) => !extracted.has(notice)
		);
		expect(missing).toEqual([]);
		expect(Object.values(notices).length).toBe(12);
	});
});
