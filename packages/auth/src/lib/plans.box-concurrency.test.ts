import { afterEach, describe, expect, it } from "bun:test";
import {
	BOX_CONCURRENCY_CLAIM_MAX,
	boxConcurrencyFor,
	boxConcurrencyForEntitlement,
	boxConcurrencyTier,
	boxIncludedStorageGib,
	boxStoragePolicyFor,
	CORE_LIMITS_CLAIM,
	PLAN_BOX_CONCURRENCY,
	PLAN_IDS,
	planByProductId,
	registerCoreLimitsPlanResolver,
	resolveCoreLimitsClaim,
	resolveEntitlement,
	withCoreLimitsClaim,
} from "./plans.ts";

afterEach(() => {
	registerCoreLimitsPlanResolver(null);
});

describe("PLAN_BOX_CONCURRENCY", () => {
	it("caps running Boxes per plan at the signed-off numbers", () => {
		const running = (plan: Parameters<typeof boxConcurrencyFor>[0]) =>
			boxConcurrencyFor(plan, 1).maxRunning;
		expect(running(null)).toBe(1);
		expect(running("desktop-license")).toBe(1);
		expect(running("marketplace-membership")).toBe(1);
		expect(running("plus")).toBe(2);
		expect(running("pro")).toBe(2);
		expect(running("max")).toBe(4);
		expect(running("teams-lite")).toBe(10);
		expect(running("teams")).toBe(10);
		expect(running("business")).toBe(20);
	});

	it("signs the full limits for each plan", () => {
		expect(boxConcurrencyFor(null, 0)).toEqual({
			maxResourceUnits: 2,
			maxRunning: 1,
			maxStorageGib: 10,
			maxStored: 3,
		});
		expect(boxConcurrencyFor("plus", 1)).toEqual({
			maxResourceUnits: 4,
			maxRunning: 2,
			maxStored: 10,
		});
		expect(boxConcurrencyFor("pro", 1)).toEqual({
			maxResourceUnits: 4,
			maxRunning: 2,
			maxStored: 20,
		});
		expect(boxConcurrencyFor("max", 1)).toEqual({
			maxResourceUnits: 8,
			maxRunning: 4,
			maxStored: 40,
		});
		// Team plans: the running cap is per organization; stored is per seat.
		expect(boxConcurrencyFor("teams-lite", 5)).toEqual({
			maxResourceUnits: 20,
			maxRunning: 10,
			maxStored: 50,
		});
		expect(boxConcurrencyFor("teams", 5)).toEqual({
			maxResourceUnits: 20,
			maxRunning: 10,
			maxStored: 100,
		});
		expect(boxConcurrencyFor("business", 6)).toEqual({
			maxResourceUnits: 40,
			maxRunning: 20,
			maxStored: 120,
		});
	});

	it("keeps a team plan's running cap whatever the seat count", () => {
		for (const seats of [1, 3, 50, 1000]) {
			expect(boxConcurrencyFor("teams-lite", seats).maxRunning).toBe(10);
			expect(boxConcurrencyFor("teams", seats).maxRunning).toBe(10);
			expect(boxConcurrencyFor("business", seats).maxRunning).toBe(20);
		}
	});

	it("gives no plan and plans without managed capacity the trial row", () => {
		expect(boxConcurrencyTier("desktop-license")).toBe("trial");
		expect(boxConcurrencyTier("marketplace-membership")).toBe("trial");
		expect(boxConcurrencyTier(null)).toBe("trial");
		expect(boxConcurrencyFor("desktop-license", 1)).toEqual(
			boxConcurrencyFor(null, 0)
		);
	});

	it("keeps a paid plan in its free trial on the trial row until it converts", () => {
		for (const plan of ["plus", "pro", "max", "teams", "business"] as const) {
			expect(boxConcurrencyTier(plan, true)).toBe("trial");
			expect(boxConcurrencyFor(plan, 5, true)).toEqual(
				boxConcurrencyFor(null, 0)
			);
			expect(boxIncludedStorageGib(plan, true)).toBe(10);
			expect(boxStoragePolicyFor({ plan, trialing: true })).toEqual({
				beyondIncluded: false,
				includedGib: 10,
			});
			expect(boxConcurrencyFor(plan, 1).maxStorageGib).toBeUndefined();
			expect(boxStoragePolicyFor({ plan })).toEqual({
				beyondIncluded: true,
				includedGib: 25,
			});
		}
		expect(
			boxConcurrencyForEntitlement({ plan: "max", seats: 1, trialing: true })
				.maxRunning
		).toBe(1);
		expect(
			boxConcurrencyForEntitlement({ plan: "max", seats: 1 }).maxRunning
		).toBe(4);
	});

	it("marks a trialing Polar subscription on the entitlement", () => {
		const productId = [...planByProductId().entries()].find(
			([, entry]) => entry.plan.id === "pro"
		)?.[0];
		expect(productId).toBeDefined();
		const trialing = resolveEntitlement(
			{ productId, status: "trialing" },
			null
		);
		const active = resolveEntitlement({ productId, status: "active" }, null);
		expect(trialing.plan).toBe("pro");
		expect(trialing.trialing).toBe(true);
		expect(active.plan).toBe("pro");
		expect(active.trialing).toBeUndefined();
		expect(boxConcurrencyForEntitlement(trialing).maxRunning).toBe(1);
		expect(boxConcurrencyForEntitlement(active).maxRunning).toBe(2);
	});

	it("never yields a zero stored cap when a per-seat plan reports no seats", () => {
		expect(boxConcurrencyFor("teams", 0)).toEqual({
			maxResourceUnits: 20,
			maxRunning: 10,
			maxStored: 20,
		});
		expect(boxConcurrencyFor("business", Number.NaN).maxStored).toBe(20);
	});

	it("keeps resource units at twice the running cap, within the token bound", () => {
		for (const plan of PLAN_IDS) {
			const limits = boxConcurrencyFor(plan, 1_000_000);
			expect(limits.maxResourceUnits).toBe(2 * limits.maxRunning);
			expect(limits.maxResourceUnits).toBeLessThanOrEqual(
				BOX_CONCURRENCY_CLAIM_MAX
			);
			expect(limits.maxStored).toBeLessThanOrEqual(BOX_CONCURRENCY_CLAIM_MAX);
		}
	});

	it("has one row per tier", () => {
		expect(Object.keys(PLAN_BOX_CONCURRENCY).toSorted()).toEqual([
			"business",
			"max",
			"plus",
			"pro",
			"teams",
			"teams-lite",
			"trial",
		]);
	});
});

describe("ryu_limits claim", () => {
	it("mints the plan's boxConcurrency for the evaluated org", async () => {
		const seen: string[] = [];
		registerCoreLimitsPlanResolver(async (organizationId) => {
			seen.push(organizationId);
			return { plan: "teams", seats: 7 };
		});
		const claim = await resolveCoreLimitsClaim("org-1");
		expect(claim).toEqual({ boxConcurrency: 10 });
		expect(seen).toEqual(["org-1"]);
		expect(withCoreLimitsClaim({ sub: "user-1" }, claim)).toEqual({
			[CORE_LIMITS_CLAIM]: { boxConcurrency: 10 },
			sub: "user-1",
		});
	});

	it("carries each plan's running cap", async () => {
		const expected = {
			business: 20,
			max: 4,
			plus: 2,
			pro: 2,
			teams: 10,
			"teams-lite": 10,
		} as const;
		for (const [plan, cap] of Object.entries(expected)) {
			registerCoreLimitsPlanResolver(async () => ({
				plan: plan as keyof typeof expected,
				seats: 12,
			}));
			expect(await resolveCoreLimitsClaim("org-1")).toEqual({
				boxConcurrency: cap,
			});
		}
	});

	it("is the trial cap for an org with no plan", async () => {
		registerCoreLimitsPlanResolver(async () => ({ plan: null, seats: 0 }));
		expect(await resolveCoreLimitsClaim("org-free")).toEqual({
			boxConcurrency: 1,
		});
	});

	it("is omitted with no org, no resolver, a failure or a timeout", async () => {
		expect(await resolveCoreLimitsClaim("org-1")).toBeNull();
		registerCoreLimitsPlanResolver(async () => ({ plan: "pro", seats: 1 }));
		expect(await resolveCoreLimitsClaim(null)).toBeNull();
		registerCoreLimitsPlanResolver(() =>
			Promise.reject(new Error("billing down"))
		);
		expect(await resolveCoreLimitsClaim("org-1")).toBeNull();
		registerCoreLimitsPlanResolver(
			() =>
				new Promise(() => {
					// never settles
				})
		);
		expect(await resolveCoreLimitsClaim("org-1", 10)).toBeNull();
		const payload = { sub: "user-1" };
		expect(withCoreLimitsClaim(payload, null)).toBe(payload);
	});
});
