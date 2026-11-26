// apps/desktop/src/lib/gating/accountLimit.test.ts
//
// The numbers the desktop shows for the limit on connected accounts per
// provider, and how it reads Core's refusal. The limit itself is enforced and
// tested in Core; these tests pin what the desktop tells the person.

import { describe, expect, test } from "bun:test";
import { planLimit } from "@ryu/auth/lib/plans";
import { ApiError } from "@/src/lib/api/client-api-error.ts";
import {
	ACCOUNT_LIMIT_CODE,
	accountLimitForPlan,
	accountLimitForVerdict,
	accountLimitRefusal,
	accountLimitStanding,
	LICENSED_ACCOUNT_LIMIT,
} from "./accountLimit.ts";

const FREE = planLimit(null, "maxAccountsPerProvider");

describe("the limit for a plan", () => {
	test("free is 10 and a license or paid plan is 50, read from the one table", () => {
		expect(FREE).toBe(10);
		expect(accountLimitForPlan(null)).toBe(FREE);
		expect(LICENSED_ACCOUNT_LIMIT).toBe(50);
		expect(accountLimitForPlan("desktop-license")).toBe(50);
		expect(accountLimitForPlan("pro")).toBe(50);
		expect(accountLimitForPlan("teams")).toBe(50);
	});

	test("only a purchased plan raises it", () => {
		// Not resolved yet, signed out, the trial and the beta have no plan.
		expect(accountLimitForVerdict(null)).toBe(FREE);
		expect(accountLimitForVerdict(undefined)).toBe(FREE);
		expect(accountLimitForVerdict({ plan: null })).toBe(FREE);
		expect(accountLimitForVerdict({ plan: "desktop-license" })).toBe(50);
		expect(accountLimitForVerdict({ plan: "max" })).toBe(50);
	});
});

describe("where a provider stands", () => {
	test("9 of 10 has room", () => {
		expect(accountLimitStanding(9, 10)).toEqual({
			count: 9,
			extra: 0,
			liftable: true,
			limit: 10,
			state: "below",
		});
	});

	test("10 of 10 is full and one must go before a new one fits", () => {
		expect(accountLimitStanding(10, 10)).toEqual({
			count: 10,
			extra: 1,
			liftable: true,
			limit: 10,
			state: "full",
		});
	});

	test("11 and 12 of 10 are over: everything stays, 2 or 3 must go to add", () => {
		expect(accountLimitStanding(11, 10)).toMatchObject({
			extra: 2,
			state: "over",
		});
		expect(accountLimitStanding(12, 10)).toMatchObject({
			extra: 3,
			state: "over",
		});
	});

	test("the licensed limit is a limit too, and nothing raises it", () => {
		expect(accountLimitStanding(49, 50)).toMatchObject({
			liftable: false,
			state: "below",
		});
		expect(accountLimitStanding(50, 50)).toMatchObject({
			extra: 1,
			liftable: false,
			state: "full",
		});
	});
});

describe("Core's refusal", () => {
	const flat = {
		code: ACCOUNT_LIMIT_CODE,
		count: 10,
		error: "This provider already has the most accounts your plan allows.",
		limit: 10,
		provider: "anthropic",
	};

	test("is read from the flat body of the provider and Gateway routes", () => {
		const failure = new ApiError(
			"/api/pi-config/providers",
			409,
			flat.error,
			flat.code,
			flat
		);
		expect(accountLimitRefusal(failure)).toEqual({
			count: 10,
			limit: 10,
			provider: "anthropic",
		});
	});

	test("is read from the nested body of the plan account routes", () => {
		const body = {
			error: {
				code: ACCOUNT_LIMIT_CODE,
				count: 12,
				limit: 10,
				message: flat.error,
				provider: "openai",
			},
		};
		const failure = new ApiError(
			"/api/cloud-task-backends/accounts",
			409,
			flat.error,
			ACCOUNT_LIMIT_CODE,
			body
		);
		expect(accountLimitRefusal(failure)).toEqual({
			count: 12,
			limit: 10,
			provider: "openai",
		});
	});

	test("is not read from any other failure", () => {
		expect(accountLimitRefusal(new Error("offline"))).toBeNull();
		expect(accountLimitRefusal(null)).toBeNull();
		const otherCode = new ApiError("/x", 409, "Conflict", "conflict", flat);
		expect(accountLimitRefusal(otherCode)).toBeNull();
		// The right code without usable numbers: fall back to Core's sentence.
		const noNumbers = new ApiError("/x", 409, flat.error, ACCOUNT_LIMIT_CODE, {
			code: ACCOUNT_LIMIT_CODE,
			error: flat.error,
			limit: "10",
		});
		expect(accountLimitRefusal(noNumbers)).toBeNull();
		const noBody = new ApiError("/x", 409, flat.error, ACCOUNT_LIMIT_CODE);
		expect(accountLimitRefusal(noBody)).toBeNull();
	});
});
