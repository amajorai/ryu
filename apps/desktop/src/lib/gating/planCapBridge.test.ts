// apps/desktop/src/lib/gating/planCapBridge.test.ts
//
// Tests for the numeric-cap (Bucket-3) enforcement primitives the desktop
// entity-creation stores read through. The security-shaped invariants here are:
//   - OFF the managed path (no billing auth) every limit is Infinity — a
//     self-hoster who never signs in stays completely uncapped.
//   - Before the React layer first syncs the plan, caps FAIL OPEN (Infinity) so
//     a payer is never falsely blocked before the entitlement resolves.
//   - `enforcePlanCap` opens the upgrade modal AND throws so the cap holds even
//     when the modal requester has not been registered.
//
// Mocking:
//   - `@/src/lib/api/billing.ts` is stubbed to a toggleable `hasBillingAuth`
//     (a `let` the tests flip) so the managed-path branch is driven directly,
//     without the real billing client's `@/lib/auth-client.ts` → `@ryu/ui`
//     resolution chain. No test imports billing, so this module-wide mock has no
//     other victim.
//   - `useNodeStore.test.ts` registers a process-wide `mock.module` stub for
//     `@/src/lib/gating/planCapBridge.ts` (it needs only a no-op `enforcePlanCap`).
//     That mock leaks across files and would shadow the REAL module here. A
//     distinct `?real` query forces bun to key this as a separate module and load
//     the genuine implementation (its own singleton — exactly the isolation this
//     test wants).
//
// The singleton `state.plan` starts `undefined` and is reset to it only by
// syncing an unresolved verdict (no reset export), so the "unsynced → fail-open"
// case MUST be asserted before any `syncPlanCapState`.

import { beforeEach, describe, expect, mock, test } from "bun:test";

let billingAuthOn = false;

mock.module("@/src/lib/api/billing.ts", () => ({
	hasBillingAuth: () => billingAuthOn,
}));

const {
	capLimit,
	effectivePlan,
	enforcePlanCap,
	PlanCapError,
	resolveCapLimit,
	syncPlanCapState,
} = await import("./planCapBridge.ts");

beforeEach(() => {
	billingAuthOn = false;
});

// ---------------------------------------------------------------------------
// This block MUST run first: the singleton `state.plan` is `undefined` only
// until the first `syncPlanCapState`, and nothing can restore it. Once any
// later block syncs, this branch is unreachable.
// ---------------------------------------------------------------------------
describe("resolveCapLimit — fail-open before the plan is synced", () => {
	test("unsynced + billing auth on → Infinity (payer never falsely blocked)", () => {
		billingAuthOn = true;
		expect(resolveCapLimit("maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
	});

	test("off the managed path is Infinity regardless of sync state", () => {
		billingAuthOn = false;
		expect(resolveCapLimit("maxSpaces")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("effectivePlan", () => {
	test("null verdict → undefined (unknown plan, not the free plan)", () => {
		expect(effectivePlan(null)).toBeUndefined();
	});

	test("a purchased plan is returned verbatim", () => {
		expect(
			effectivePlan({
				plan: "max",
				proUnlocked: true,
				managedInference: true,
				marketplaceApps: true,
				reason: "subscription",
			})
		).toBe("max");
	});

	test("a desktop license holder keeps the license plan", () => {
		expect(
			effectivePlan({
				plan: "desktop-license",
				proUnlocked: true,
				managedInference: false,
				marketplaceApps: false,
				reason: "license",
			})
		).toBe("desktop-license");
	});

	test("a free (personal use) desktop resolves to the free (null) row", () => {
		expect(
			effectivePlan({
				plan: null,
				proUnlocked: true,
				managedInference: false,
				marketplaceApps: false,
				reason: "free",
			})
		).toBeNull();
	});
});

describe("a free account has no desktop caps", () => {
	test("tabs, remote nodes, agents, runs and Spaces are unlimited and never prompt", () => {
		let upgrades = 0;
		syncPlanCapState(null, () => {
			upgrades += 1;
		});
		billingAuthOn = true;
		for (const field of [
			"maxOpenTabs",
			"maxRemoteNodes",
			"maxAgents",
			"maxConcurrentRuns",
			"maxSpaces",
		] as const) {
			expect(resolveCapLimit(field)).toBe(Number.POSITIVE_INFINITY);
			expect(capLimit(null, field)).toBe(Number.POSITIVE_INFINITY);
			expect(() => enforcePlanCap(field, 10_000)).not.toThrow();
		}
		expect(upgrades).toBe(0);
	});

	test("ten tabs and three remote nodes open with no prompt", () => {
		let upgrades = 0;
		syncPlanCapState(null, () => {
			upgrades += 1;
		});
		billingAuthOn = true;
		for (let open = 0; open < 10; open += 1) {
			expect(() => enforcePlanCap("maxOpenTabs", open)).not.toThrow();
		}
		for (let nodes = 0; nodes < 3; nodes += 1) {
			expect(() => enforcePlanCap("maxRemoteNodes", nodes)).not.toThrow();
		}
		expect(upgrades).toBe(0);
	});
});

// The enforcement primitives still hold for a quota with a finite number. The
// only one left is hosted Space storage (1 GB free, 10 GB on Pro), which costs
// money per user, so it is the field these tests drive.
describe("resolveCapLimit — after sync", () => {
	test("off the managed path is Infinity even with a free plan synced", () => {
		syncPlanCapState(null, () => undefined);
		billingAuthOn = false;
		// A finite free quota would apply on the managed path, but not off it.
		expect(resolveCapLimit("spaceStorageLimitGb")).toBe(
			Number.POSITIVE_INFINITY
		);
	});

	test("managed path + free plan reads the finite FREE_TIER_LIMITS value", () => {
		syncPlanCapState(null, () => undefined);
		billingAuthOn = true;
		expect(resolveCapLimit("spaceStorageLimitGb")).toBe(1);
	});

	test("a paid plan reads its own row on the managed path", () => {
		syncPlanCapState("pro", () => undefined);
		billingAuthOn = true;
		expect(resolveCapLimit("spaceStorageLimitGb")).toBe(10);
		expect(resolveCapLimit("maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("an unresolved verdict", () => {
	test("re-syncing an unknown plan fails open again on the managed path", () => {
		syncPlanCapState(null, () => undefined);
		billingAuthOn = true;
		expect(resolveCapLimit("spaceStorageLimitGb")).toBe(1);
		syncPlanCapState(effectivePlan(null), () => undefined);
		expect(resolveCapLimit("spaceStorageLimitGb")).toBe(
			Number.POSITIVE_INFINITY
		);
		expect(() => enforcePlanCap("spaceStorageLimitGb", 10_000)).not.toThrow();
	});

	test("capLimit is Infinity for an unknown plan and the free number for null", () => {
		expect(capLimit(undefined, "spaceStorageLimitGb")).toBe(
			Number.POSITIVE_INFINITY
		);
		expect(capLimit(null, "spaceStorageLimitGb")).toBe(1);
	});
});

describe("enforcePlanCap", () => {
	test("under the cap is a silent no-op (no throw, no upgrade prompt)", () => {
		let upgrades = 0;
		syncPlanCapState("pro", () => {
			upgrades += 1;
		});
		billingAuthOn = true; // Pro row: spaceStorageLimitGb === 10
		expect(() => enforcePlanCap("spaceStorageLimitGb", 9)).not.toThrow();
		expect(upgrades).toBe(0);
	});

	test("at the cap opens the upgrade modal AND throws PlanCapError", () => {
		let upgrades = 0;
		syncPlanCapState(null, () => {
			upgrades += 1;
		});
		billingAuthOn = true;
		let caught: unknown;
		try {
			enforcePlanCap("spaceStorageLimitGb", 1);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlanCapError);
		// SAFETY: The preceding matcher established the caught instance of the real PlanCapError thrown by enforcePlanCap; its constructor owns this field.
		expect((caught as InstanceType<typeof PlanCapError>).field).toBe(
			"spaceStorageLimitGb"
		);
		// SAFETY: This is the same caught PlanCapError already checked above; its real constructor assigns the numeric limit without an intervening write.
		expect((caught as InstanceType<typeof PlanCapError>).limit).toBe(1);
		expect(upgrades).toBe(1);
	});

	test("throws even when the registered requester is a no-op (cap still holds)", () => {
		syncPlanCapState(null, () => undefined);
		billingAuthOn = true;
		expect(() => enforcePlanCap("spaceStorageLimitGb", 999)).toThrow(
			PlanCapError
		);
	});

	test("off the managed path never throws — self-host stays uncapped", () => {
		syncPlanCapState(null, () => undefined);
		billingAuthOn = false;
		expect(() => enforcePlanCap("spaceStorageLimitGb", 10_000)).not.toThrow();
	});
});

describe("PlanCapError", () => {
	test("carries field + limit and a descriptive message", () => {
		const err = new PlanCapError("maxOpenTabs", 3);
		expect(err.name).toBe("PlanCapError");
		expect(err.field).toBe("maxOpenTabs");
		expect(err.limit).toBe(3);
		expect(err.message).toContain("maxOpenTabs");
		expect(err.message).toContain("3");
		expect(err).toBeInstanceOf(Error);
	});
});
