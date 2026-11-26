import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { KERNEL_QUOTAS } from "./plan-quotas.ts";

/**
 * Core (Rust) cannot import the plan catalog, so it mirrors the free account
 * limit in `apps/core/src/server/access_gate/plan_limits.rs`. This fails when the two differ.
 */
const CORE_PLAN_LIMITS = new URL(
	"../../../../apps/core/src/server/access_gate/plan_limits.rs",
	import.meta.url
);
const FREE_CONSTANT = /const FREE_ACCOUNTS_PER_PROVIDER: usize = (\d+);/u;

describe("Core's mirror of the free account limit", () => {
	it("matches KERNEL_QUOTAS.maxAccountsPerProvider.free", () => {
		const source = readFileSync(CORE_PLAN_LIMITS, "utf8");
		const match = FREE_CONSTANT.exec(source);
		expect(match).not.toBeNull();
		expect(Number(match?.[1])).toBe(KERNEL_QUOTAS.maxAccountsPerProvider.free);
	});
});
