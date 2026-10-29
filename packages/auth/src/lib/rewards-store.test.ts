import { describe, expect, it } from "bun:test";
import {
	REWARDS_STORE,
	storeCreditReward,
	storeEntitlementReward,
	storeItemByKey,
} from "./rewards-store.ts";

describe("REWARDS_STORE catalog", () => {
	it("has unique stable keys with positive costs", () => {
		const keys = REWARDS_STORE.map((item) => item.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const item of REWARDS_STORE) {
			expect(item.key).toMatch(/^[a-z0-9-]+$/);
			expect(item.costPoints).toBeGreaterThan(0);
		}
	});

	it("keeps the entitlement items expensive — plans and nodes cost real points", () => {
		const max = storeItemByKey("max-1m");
		const node = storeItemByKey("node-1m");
		const credit5 = storeItemByKey("credit-5");
		expect(max?.costPoints).toBeGreaterThan(credit5?.costPoints ?? 0);
		expect(node?.costPoints).toBeGreaterThan(credit5?.costPoints ?? 0);
		expect(max?.reward.kind).toBe("plan_time");
		expect(node?.reward.kind).toBe("node_time");
	});

	it("resolves credit items to a positive grant with a known pool", () => {
		const credit5 = storeItemByKey("credit-5");
		const reward = storeCreditReward(credit5!);
		expect(reward).not.toBeNull();
		expect(reward?.creditMicroUsd).toBeGreaterThan(0);
		expect(reward?.pool).toBe("cloudflare");
	});

	it("returns null credit reward for entitlement items", () => {
		expect(storeCreditReward(storeItemByKey("max-1m")!)).toBeNull();
		expect(storeItemByKey("nope")).toBeUndefined();
	});

	it("maps every non-credit item to a fulfilment path", () => {
		for (const item of REWARDS_STORE) {
			const credit = storeCreditReward(item);
			const entitlement = storeEntitlementReward(item);
			expect(Boolean(credit) !== Boolean(entitlement)).toBe(true);
		}
		expect(storeEntitlementReward(storeItemByKey("desktop-1m")!)).toEqual({
			kind: "plan",
			months: 1,
			plan: "plus",
		});
		expect(storeEntitlementReward(storeItemByKey("max-1m")!)).toEqual({
			kind: "plan",
			months: 1,
			plan: "max",
		});
		expect(storeEntitlementReward(storeItemByKey("node-1m")!)).toEqual({
			kind: "node",
			months: 1,
		});
	});
});
