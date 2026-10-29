import { describe, expect, it } from "bun:test";
import {
	currentMembershipGrantFilter,
	grantedInCurrentMembership,
} from "./membership-grant-filter.ts";

const JOINED = new Date("2026-10-01T00:00:00Z");

describe("membership grant filter", () => {
	it("limits stored grants to the current membership", () => {
		expect(currentMembershipGrantFilter({ createdAt: JOINED })).toEqual({
			createdAt: { $gte: JOINED },
		});
		expect(currentMembershipGrantFilter({})).toEqual({});
	});

	it("refuses a grant written before the membership began", () => {
		const member = { createdAt: JOINED };
		expect(
			grantedInCurrentMembership(
				{ createdAt: new Date("2026-09-30T23:59:59Z") },
				member
			)
		).toBe(false);
		expect(grantedInCurrentMembership({}, member)).toBe(false);
		expect(grantedInCurrentMembership({ createdAt: JOINED }, member)).toBe(
			true
		);
	});

	it("keeps every grant for a legacy member row without a createdAt", () => {
		expect(
			grantedInCurrentMembership(
				{ createdAt: new Date(0) },
				{ createdAt: null }
			)
		).toBe(true);
	});
});
