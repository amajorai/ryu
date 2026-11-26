import { describe, expect, it } from "bun:test";
import {
	decideSelfHostedInstallAdmission,
	SELF_HOSTED_FREE_MEMBER_LIMIT,
	SELF_HOSTED_MEMBER_LIMIT_CODE,
	selfHostedAvailableSeats,
	selfHostedSeatAllowance,
	selfHostedSeatCopy,
	selfHostedSeatedPeople,
	selfHostedSharedOrganizations,
} from "./self-hosted-member-limit.ts";

describe("selfHostedSeatAllowance", () => {
	it("is three people without a license", () => {
		expect(SELF_HOSTED_FREE_MEMBER_LIMIT).toBe(3);
		expect(selfHostedSeatAllowance(null)).toEqual({
			licensed: false,
			limit: 3,
		});
	});

	it("keeps the free limit for a license that states no seat count", () => {
		expect(selfHostedSeatAllowance({ seats: null })).toEqual({
			licensed: false,
			limit: 3,
		});
	});

	it("takes the seat count of a license that states more", () => {
		expect(selfHostedSeatAllowance({ seats: 4 })).toEqual({
			licensed: true,
			limit: 4,
		});
		expect(selfHostedSeatAllowance({ seats: 250 })).toEqual({
			licensed: true,
			limit: 250,
		});
	});

	it("never lets a license lower the limit or set a broken one", () => {
		for (const seats of [
			0,
			1,
			2,
			3,
			-5,
			3.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(selfHostedSeatAllowance({ seats })).toEqual({
				licensed: false,
				limit: 3,
			});
		}
	});
});

describe("decideSelfHostedInstallAdmission", () => {
	const decide = (seatedPeople: number, reservedSeats = 0, limit = 3) =>
		decideSelfHostedInstallAdmission({
			candidateAlreadySeated: false,
			limit,
			reservedSeats,
			seatedPeople,
		}).allowed;

	it("admits the second and third person and refuses the fourth", () => {
		expect(decide(1)).toBe(true);
		expect(decide(2)).toBe(true);
		expect(decide(3)).toBe(false);
		expect(decide(4)).toBe(false);
	});

	it("counts a pending invitation or an in-flight join as a place", () => {
		expect(decide(1, 1)).toBe(true);
		expect(decide(2, 1)).toBe(false);
		expect(decide(1, 2)).toBe(false);
	});

	it("refuses new joins on an install already above the limit", () => {
		expect(decide(5)).toBe(false);
		expect(decide(5, 0, 5)).toBe(false);
		expect(decide(5, 0, 6)).toBe(true);
	});

	it("lets someone who already holds a place join another organization", () => {
		expect(
			decideSelfHostedInstallAdmission({
				candidateAlreadySeated: true,
				limit: 3,
				reservedSeats: 0,
				seatedPeople: 3,
			}).allowed
		).toBe(true);
	});

	it("follows a licensed limit", () => {
		expect(decide(3, 0, 10)).toBe(true);
		expect(decide(9, 0, 10)).toBe(true);
		expect(decide(10, 0, 10)).toBe(false);
		expect(decide(8, 2, 10)).toBe(false);
	});
});

describe("selfHostedAvailableSeats", () => {
	it("is what is left of the limit and never negative", () => {
		expect(
			selfHostedAvailableSeats({ limit: 3, reservedSeats: 0, seatedPeople: 1 })
		).toBe(2);
		expect(
			selfHostedAvailableSeats({ limit: 3, reservedSeats: 1, seatedPeople: 2 })
		).toBe(0);
		expect(
			selfHostedAvailableSeats({ limit: 3, reservedSeats: 0, seatedPeople: 5 })
		).toBe(0);
	});
});

describe("selfHostedSeatCopy", () => {
	it("names the two ways forward when there is no license", () => {
		const copy = selfHostedSeatCopy({ licensed: false, limit: 3 });
		expect(copy.code).toBe(SELF_HOSTED_MEMBER_LIMIT_CODE);
		expect(copy.full).toContain("All 3 member places");
		expect(copy.full).toContain("Add a license or move to Ryu Cloud");
		expect(copy.noCapacity).toBe(copy.full);
	});

	it("names the licensed count when a license set the limit", () => {
		const copy = selfHostedSeatCopy({ licensed: true, limit: 12 });
		expect(copy.full).toContain("All 12 licensed member places");
		expect(copy.full).toContain("extend the license");
		expect(copy.full).not.toContain("without a license");
	});

	it("uses no em dash in any sentence", () => {
		const copy = selfHostedSeatCopy({ licensed: false, limit: 3 });
		for (const sentence of [copy.capacityChanged, copy.full]) {
			expect(sentence).not.toContain("—");
		}
	});
});

describe("selfHostedSeatedPeople", () => {
	const organizations = [
		{ id: "personal-a", kind: "personal" as const },
		{ id: "personal-b", kind: "personal" as const },
		{ id: "teams-1", kind: "teams" as const },
		{ id: "teams-2", kind: "teams" as const },
		{ id: "family-1", kind: "family" as const },
		{ id: "legacy-solo", kind: null },
		{ id: "legacy-shared", kind: null },
	];

	it("counts each person once across shared organizations", () => {
		const seated = selfHostedSeatedPeople({
			members: [
				{ organizationId: "personal-a", userId: "a" },
				{ organizationId: "personal-b", userId: "b" },
				{ organizationId: "teams-1", userId: "a" },
				{ organizationId: "teams-1", userId: "b" },
				{ organizationId: "teams-2", userId: "a" },
				{ organizationId: "teams-2", userId: "c" },
			],
			organizations,
		});
		expect([...seated].sort()).toEqual(["a", "b", "c"]);
	});

	it("does not count people who only have a personal workspace", () => {
		const seated = selfHostedSeatedPeople({
			members: [
				{ organizationId: "personal-a", userId: "a" },
				{ organizationId: "personal-b", userId: "b" },
			],
			organizations,
		});
		expect(seated.size).toBe(0);
	});

	it("counts the owner of a shared organization with no one else in it", () => {
		const seated = selfHostedSeatedPeople({
			members: [{ organizationId: "teams-1", userId: "owner" }],
			organizations,
		});
		expect([...seated]).toEqual(["owner"]);
	});

	it("counts family members and a legacy organization once it is shared", () => {
		const seated = selfHostedSeatedPeople({
			members: [
				{ organizationId: "family-1", userId: "parent" },
				{ organizationId: "family-1", userId: "child" },
				{ organizationId: "legacy-solo", userId: "solo" },
				{ organizationId: "legacy-shared", userId: "x" },
				{ organizationId: "legacy-shared", userId: "y" },
			],
			organizations,
		});
		expect([...seated].sort()).toEqual(["child", "parent", "x", "y"]);
	});

	it("lists every non-personal organization for the pending-claim count", () => {
		const shared = selfHostedSharedOrganizations(organizations);
		expect(shared.map((organization) => organization.id).sort()).toEqual([
			"family-1",
			"legacy-shared",
			"legacy-solo",
			"teams-1",
			"teams-2",
		]);
	});

	it("ignores members of organizations it was not given", () => {
		const seated = selfHostedSeatedPeople({
			members: [{ organizationId: "unknown", userId: "ghost" }],
			organizations,
		});
		expect(seated.size).toBe(0);
	});
});
