import { describe, expect, it } from "bun:test";
import {
	decideSeatAdmission,
	organizationSeatUsage,
} from "./organization-seat-gate.ts";

describe("organization seat usage", () => {
	it("renders four active members against a five-seat contract", () => {
		expect(
			organizationSeatUsage({
				includedSeats: 5,
				memberCount: 4,
				reservedSeatCount: 0,
			})
		).toMatchObject({
			allocatedSeats: 4,
			atCapacity: false,
			availableSeats: 1,
			overAllocated: false,
		});
	});

	it("disables new invitations when a pending claim fills the last seat", () => {
		expect(
			organizationSeatUsage({
				includedSeats: 5,
				memberCount: 4,
				reservedSeatCount: 1,
			})
		).toMatchObject({
			allocatedSeats: 5,
			atCapacity: true,
			availableSeats: 0,
		});
	});

	it("has no invitation capacity without an active paid plan", () => {
		expect(
			organizationSeatUsage({
				includedSeats: null,
				memberCount: 1,
				reservedSeatCount: 0,
			})
		).toMatchObject({
			allocatedSeats: 1,
			atCapacity: false,
			availableSeats: null,
		});
	});

	it("surfaces an active-member over-allocation after an external downgrade", () => {
		expect(
			organizationSeatUsage({
				includedSeats: 5,
				memberCount: 6,
				reservedSeatCount: 0,
			})
		).toMatchObject({
			allocatedSeats: 6,
			atCapacity: true,
			availableSeats: 0,
			overAllocated: true,
		});
	});
});

describe("organization Teams seat admission", () => {
	it("allows a claim while a seat is free", () => {
		expect(
			decideSeatAdmission({
				billedSeats: 5,
				memberCount: 4,
				reservedSeatCount: 0,
			})
		).toEqual({ allowed: true });
	});

	it("blocks the last seat when another acceptance is in flight", () => {
		expect(
			decideSeatAdmission({
				billedSeats: 5,
				memberCount: 4,
				reservedSeatCount: 1,
			})
		).toEqual({
			allowed: false,
			reason:
				"No unassigned organization seat is available. Buy another seat or remove a member first.",
		});
	});

	it("never permits members to exceed the billed quantity", () => {
		expect(
			decideSeatAdmission({
				billedSeats: 5,
				memberCount: 6,
				reservedSeatCount: 0,
			})
		).toMatchObject({ allowed: false });
	});
});
