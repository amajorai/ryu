import { describe, expect, it } from "bun:test";
import {
	teamsSeatAllowanceFromContract,
	teamsSeatBonusExpiry,
	teamsSeatMinimum,
} from "./organization-seat-entitlement.ts";

describe("Teams negotiated seat allowance", () => {
	it("keeps the public billed quantity separate from bonus capacity", () => {
		expect(
			teamsSeatAllowanceFromContract({ contractedSeats: 5, bonusSeats: 5 })
		).toEqual({
			billedSeats: 5,
			bonusSeats: 5,
			includedSeats: 10,
			bonusExpiresAt: null,
		});
	});

	it("expires bonus seats without reducing the Polar quantity", () => {
		const expiry = new Date("2026-08-01T00:00:00.000Z");
		expect(
			teamsSeatAllowanceFromContract(
				{ contractedSeats: 5, bonusSeats: 5, bonusExpiresAt: expiry },
				new Date("2026-08-02T00:00:00.000Z")
			)
		).toMatchObject({ billedSeats: 5, bonusSeats: 0, includedSeats: 5 });
	});

	it("fails closed to the plan floor for malformed persisted values", () => {
		expect(teamsSeatMinimum()).toBe(5);
		expect(
			teamsSeatAllowanceFromContract({
				contractedSeats: "not-a-number",
				bonusSeats: -10,
			})
		).toMatchObject({ billedSeats: 5, bonusSeats: 0, includedSeats: 5 });
		expect(teamsSeatBonusExpiry("not-a-date")).toBeNull();
	});
});
