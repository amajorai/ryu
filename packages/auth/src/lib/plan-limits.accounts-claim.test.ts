import { afterEach, describe, expect, it } from "bun:test";
import {
	CORE_LIMITS_CLAIM,
	PLAN_IDS,
	planLimit,
	registerCoreLimitsPlanResolver,
	registerCoreLimitsUserPlanResolver,
	resolveCoreLimitsClaim,
	withCoreLimitsClaim,
} from "./plans.ts";

const FREE = planLimit(null, "maxAccountsPerProvider");
const LICENSED = planLimit("desktop-license", "maxAccountsPerProvider");
const billingDown = () => Promise.reject(new Error("billing down"));

afterEach(() => {
	registerCoreLimitsPlanResolver(null);
	registerCoreLimitsUserPlanResolver(null);
});

describe("ryu_limits.accountsPerProvider", () => {
	it("signs the free number for a user and an org with no plan", async () => {
		registerCoreLimitsPlanResolver(async () => ({ plan: null, seats: 0 }));
		registerCoreLimitsUserPlanResolver(async () => null);
		const claim = await resolveCoreLimitsClaim("org-1", 50, "user-1");
		expect(claim).toEqual({ accountsPerProvider: FREE, boxConcurrency: 1 });
		expect(FREE).toBe(10);
	});

	it("signs the licensed number for the user's own desktop license", async () => {
		const seen: string[] = [];
		registerCoreLimitsPlanResolver(async () => ({ plan: null, seats: 0 }));
		registerCoreLimitsUserPlanResolver(async (userId) => {
			seen.push(userId);
			return "desktop-license";
		});
		const claim = await resolveCoreLimitsClaim("org-1", 50, "user-1");
		expect(claim).toEqual({
			accountsPerProvider: LICENSED,
			boxConcurrency: 1,
		});
		expect(seen).toEqual(["user-1"]);
		expect(LICENSED).toBe(50);
		expect(withCoreLimitsClaim({ sub: "user-1" }, claim)).toEqual({
			[CORE_LIMITS_CLAIM]: {
				accountsPerProvider: LICENSED,
				boxConcurrency: 1,
			},
			sub: "user-1",
		});
	});

	it("signs the licensed number for every plan, on the user or the org", async () => {
		for (const plan of PLAN_IDS) {
			registerCoreLimitsPlanResolver(async () => ({ plan: null, seats: 0 }));
			registerCoreLimitsUserPlanResolver(async () => plan);
			const own = await resolveCoreLimitsClaim("org-1", 50, "user-1");
			expect(own?.accountsPerProvider).toBe(LICENSED);

			registerCoreLimitsPlanResolver(async () => ({ plan, seats: 3 }));
			registerCoreLimitsUserPlanResolver(async () => null);
			const org = await resolveCoreLimitsClaim("org-1", 50, "user-1");
			expect(org?.accountsPerProvider).toBe(LICENSED);
		}
	});

	it("signs the user's number alone when the token has no org", async () => {
		registerCoreLimitsPlanResolver(async () => ({ plan: "teams", seats: 3 }));
		registerCoreLimitsUserPlanResolver(async () => "desktop-license");
		const claim = await resolveCoreLimitsClaim(null, 50, "user-1");
		expect(claim).toEqual({ accountsPerProvider: LICENSED });
		expect(withCoreLimitsClaim({ sub: "user-1" }, claim)).toEqual({
			[CORE_LIMITS_CLAIM]: { accountsPerProvider: LICENSED },
			sub: "user-1",
		});
	});

	it("leaves the number out when the user's plan could not be read", async () => {
		registerCoreLimitsPlanResolver(async () => ({ plan: null, seats: 0 }));
		// A billing outage must not sign "free" for a user who may be paying.
		registerCoreLimitsUserPlanResolver(billingDown);
		expect(await resolveCoreLimitsClaim("org-1", 50, "user-1")).toEqual({
			boxConcurrency: 1,
		});
		registerCoreLimitsUserPlanResolver(
			() =>
				new Promise(() => {
					// never settles
				})
		);
		expect(await resolveCoreLimitsClaim("org-1", 10, "user-1")).toEqual({
			boxConcurrency: 1,
		});
		expect(await resolveCoreLimitsClaim(null, 10, "user-1")).toBeNull();
	});

	it("leaves the number out when the org's plan could not be read", async () => {
		registerCoreLimitsPlanResolver(billingDown);
		registerCoreLimitsUserPlanResolver(async () => null);
		expect(await resolveCoreLimitsClaim("org-1", 50, "user-1")).toBeNull();
		// The user's own paid plan is not enough either: one rule, no guessing.
		registerCoreLimitsUserPlanResolver(async () => "pro");
		expect(await resolveCoreLimitsClaim("org-1", 50, "user-1")).toBeNull();
	});

	it("reads the org's plan alone when no user is given", async () => {
		registerCoreLimitsPlanResolver(async () => ({ plan: "max", seats: 1 }));
		registerCoreLimitsUserPlanResolver(async () => {
			throw new Error("not called without a user");
		});
		expect(await resolveCoreLimitsClaim("org-1")).toEqual({
			accountsPerProvider: LICENSED,
			boxConcurrency: 4,
		});
	});
});
