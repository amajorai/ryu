import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readRustDefaultAllowlist } from "./__tests__/host-direct-scan.ts";
import { DEFAULT_GRANT_ALLOWLIST } from "./default-grant-allowlist.ts";

// The copy must equal the Gateway's Rust list. The reader knows two layouts
// of that list: the array inside fn default_grant_allowlist (mod.rs), and a
// body that joins `<module>::<function>()` calls, each an array in its own
// file. It throws on anything else, so a new layout fails here by name.
const ROOT = join(import.meta.dir, "../../..");

const sorted = (grants: readonly string[]) => [...new Set(grants)].sort();

describe("the TypeScript copy of the Gateway default grant allowlist", () => {
	test("holds exactly the grants the Rust list holds", () => {
		const rust = readRustDefaultAllowlist(ROOT);
		// The Rust list names chat.sendFollowUp twice, so compare as sets.
		expect(sorted(DEFAULT_GRANT_ALLOWLIST)).toEqual(sorted(rust));
	});

	test("names each grant once", () => {
		expect(DEFAULT_GRANT_ALLOWLIST).toHaveLength(
			new Set(DEFAULT_GRANT_ALLOWLIST).size
		);
	});

	test("the Rust reader found a real list", () => {
		// A reader that returned too little would make the comparison above
		// say that the copy has extra rows. These are fixed points of the list.
		const rust = readRustDefaultAllowlist(ROOT);
		expect(rust.length).toBeGreaterThan(50);
		expect(rust).toContain("mcp.tools");
		expect(rust).toContain("storage:kv");
	});
});
