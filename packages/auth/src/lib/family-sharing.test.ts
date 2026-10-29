import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

/**
 * Ryu Max family sharing: product constants, the families-per-account cap, and the
 * capacity seam `apps/server` registers.
 *
 * THE CAPACITY SLOT IS MODULE STATE and nothing unregisters it, so the
 * unregistered case is asserted FIRST in its describe block. Moving it down the
 * file would make it assert whatever an earlier test registered.
 */

const FAMILY_ID = "64b000000000000000000001";
const OTHER_FAMILY_ID = "64b000000000000000000002";
const PERSONAL_ID = "64b000000000000000000003";
const TEAMS_ID = "64b000000000000000000004";
const USER_ID = "64b0000000000000000000aa";

const organizationMetadata = new Map<string, string>([
	[FAMILY_ID, JSON.stringify({ organizationKind: "family" })],
	[OTHER_FAMILY_ID, JSON.stringify({ organizationKind: "family" })],
	[PERSONAL_ID, JSON.stringify({ organizationKind: "personal" })],
	[TEAMS_ID, JSON.stringify({ organizationKind: "teams" })],
]);
const organizationNames = new Map<string, string>([
	[FAMILY_ID, " The Smiths "],
	[OTHER_FAMILY_ID, "Cousins"],
]);
const membershipRoles = new Map<string, string>([[FAMILY_ID, "owner"]]);
let membershipIds: string[] = [];
/**
 * Membership `createdAt` by org id; a missing entry uses its storage position,
 * so storage order and age agree unless a test says otherwise.
 */
let membershipCreatedAt = new Map<string, number>();
const membershipSorts: unknown[] = [];
const organizationQueries: string[][] = [];

interface MembershipRow {
	createdAt: Date;
	organizationId: string;
	role: string;
	userId: string;
}

/** The Member.find chain; `sort` records its spec and orders by `createdAt`. */
function membershipChain(rows: MembershipRow[]) {
	const query = Object.assign(Promise.resolve(rows), {
		lean: () => Promise.resolve(rows),
		select: () => query,
		sort: (spec: { createdAt?: 1 | -1 }) => {
			membershipSorts.push(spec);
			const direction = spec.createdAt ?? 0;
			return membershipChain(
				direction === 0
					? rows
					: rows.toSorted(
							(left, right) =>
								(left.createdAt.getTime() - right.createdAt.getTime()) *
								direction
						)
			);
		},
	});
	return query;
}

function chain<T>(value: T) {
	const query = Object.assign(Promise.resolve(value), {
		lean: () => Promise.resolve(value),
		select: () => query,
		sort: () => query,
	});
	return query;
}

let familySharing: typeof import("./family-sharing.ts");
const consoleError = spyOn(console, "error").mockImplementation(
	() => undefined
);

beforeAll(async () => {
	mock.module("@ryu/db/models/control-plane.model", () => ({
		Member: {
			find: () =>
				membershipChain(
					membershipIds.map((organizationId, index) => ({
						createdAt: new Date(
							membershipCreatedAt.get(organizationId) ?? index
						),
						organizationId,
						role: membershipRoles.get(organizationId) ?? "member",
						userId: USER_ID,
					}))
				),
		},
		Organization: {
			find: (filter: { _id: { $in: string[] } }) => {
				organizationQueries.push(filter._id.$in);
				return chain(
					filter._id.$in.flatMap((id) => {
						const metadata = organizationMetadata.get(id);
						return metadata === undefined
							? []
							: [{ _id: id, metadata, name: organizationNames.get(id) }];
					})
				);
			},
		},
	}));
	familySharing = await import("./family-sharing.ts");
});

afterAll(() => {
	consoleError.mockRestore();
});

beforeEach(() => {
	membershipIds = [];
	membershipCreatedAt = new Map();
	membershipSorts.length = 0;
	organizationQueries.length = 0;
	consoleError.mockClear();
});

describe("family sharing product constants", () => {
	it("caps a family at six people and rides on Max only", () => {
		expect(familySharing.FAMILY_SHARING_MAX_MEMBERS).toBe(6);
		expect(familySharing.FAMILY_SHARING_MAX_FAMILIES_PER_ACCOUNT).toBe(5);
		expect(familySharing.FAMILY_SHARING_PLAN_IDS).toEqual(["max"]);
		expect(familySharing.isFamilySharingPlan("max")).toBe(true);
		for (const planId of ["pro", "teams", "family", "", null, undefined]) {
			expect(familySharing.isFamilySharingPlan(planId)).toBe(false);
		}
	});

	it("never says Teams in family copy", () => {
		const copy = [
			familySharing.FAMILY_SHARING_FULL_MESSAGE,
			familySharing.FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
			familySharing.FAMILY_SHARING_MEMBER_FAMILY_LIMIT_MESSAGE,
			familySharing.FAMILY_SHARING_SELF_FAMILY_LIMIT_MESSAGE,
			familySharing.FAMILY_SHARING_DELETE_REFUSED_MESSAGE,
			familySharing.FAMILY_SHARING_REMOVE_MEMBERS_FIRST_MESSAGE,
		];
		for (const message of copy) {
			expect(message).not.toMatch(/teams?\b/i);
		}
		expect(familySharing.FAMILY_SHARING_FULL_MESSAGE).toBe(
			"Family sharing is full. A family can have up to 6 people, including you."
		);
	});
});

function familySharingCapacity(organizationId: string) {
	return familySharing.familySharingCapacity(organizationId);
}

describe("familySharingCapacity", () => {
	it("fails closed when nothing is registered", async () => {
		// `@ryu/auth` loads alone in scripts and tests, where no API resolver
		// exists; admitting with no eligibility check would bypass the plan gate.
		expect(await familySharingCapacity(FAMILY_ID)).toBeNull();
	});

	it("passes the org id to the registered resolver and returns its capacity", async () => {
		const calls: string[] = [];
		familySharing.registerFamilySharingCapacityResolver((organizationId) => {
			calls.push(organizationId);
			return Promise.resolve(6);
		});
		expect(await familySharingCapacity(FAMILY_ID)).toBe(6);
		expect(calls).toEqual([FAMILY_ID]);
	});

	it("returns null when the resolver says the family may admit no one", async () => {
		familySharing.registerFamilySharingCapacityResolver(() =>
			Promise.resolve(null)
		);
		expect(await familySharingCapacity(FAMILY_ID)).toBeNull();
	});

	it("fails closed and logs when the resolver throws", async () => {
		familySharing.registerFamilySharingCapacityResolver(() =>
			Promise.reject(new Error("entitlement lookup failed"))
		);
		expect(await familySharingCapacity(FAMILY_ID)).toBeNull();
		expect(consoleError).toHaveBeenCalledTimes(1);
	});

	it("fails closed on a non-positive or fractional capacity", async () => {
		for (const capacity of [0, -1, 2.5, Number.NaN]) {
			familySharing.registerFamilySharingCapacityResolver(() =>
				Promise.resolve(capacity)
			);
			expect(await familySharingCapacity(FAMILY_ID)).toBeNull();
		}
	});

	it("clamps a resolver answer above the family cap", async () => {
		familySharing.registerFamilySharingCapacityResolver(() =>
			Promise.resolve(25)
		);
		expect(await familySharingCapacity(FAMILY_ID)).toBe(6);
	});

	it("uses the last registration only", async () => {
		familySharing.registerFamilySharingCapacityResolver(() =>
			Promise.resolve(3)
		);
		familySharing.registerFamilySharingCapacityResolver(() =>
			Promise.resolve(5)
		);
		expect(await familySharingCapacity(FAMILY_ID)).toBe(5);
	});
});

describe("decideFamilyMembership", () => {
	const fourOthers = [
		OTHER_FAMILY_ID,
		"64b000000000000000000005",
		"64b000000000000000000006",
		"64b000000000000000000007",
	];

	it("allows a person in no family", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: [],
				targetOrganizationId: FAMILY_ID,
			})
		).toEqual({ allowed: true, familyCount: 1 });
	});

	it("allows re-admission into the same family without counting it twice", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: [FAMILY_ID, ...fourOthers],
				targetOrganizationId: FAMILY_ID,
			})
		).toEqual({ allowed: true, familyCount: 5 });
	});

	it("allows joining a fifth family", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: fourOthers,
				targetOrganizationId: FAMILY_ID,
			})
		).toEqual({ allowed: true, familyCount: 5 });
	});

	it("refuses a sixth family", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: [
					...fourOthers,
					"64b000000000000000000008",
				],
				targetOrganizationId: FAMILY_ID,
			})
		).toEqual({
			allowed: false,
			familyCount: 5,
			limit: 5,
			reason: "family_limit_reached",
		});
	});

	it("counts duplicate ids once", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: [...fourOthers, ...fourOthers],
				targetOrganizationId: FAMILY_ID,
			}).allowed
		).toBe(true);
	});

	it("honours an explicit limit", () => {
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds: [OTHER_FAMILY_ID],
				limit: 1,
				targetOrganizationId: FAMILY_ID,
			})
		).toEqual({
			allowed: false,
			familyCount: 1,
			limit: 1,
			reason: "family_limit_reached",
		});
	});
});

describe("userFamilyOrganizationIds", () => {
	it("returns only family orgs among the user's memberships", async () => {
		membershipIds = [PERSONAL_ID, FAMILY_ID, TEAMS_ID, OTHER_FAMILY_ID];
		expect(await familySharing.userFamilyOrganizationIds(USER_ID)).toEqual([
			FAMILY_ID,
			OTHER_FAMILY_ID,
		]);
	});

	it("excludes the family the user is being admitted into", async () => {
		membershipIds = [PERSONAL_ID, FAMILY_ID];
		expect(
			await familySharing.userFamilyOrganizationIds(USER_ID, {
				excludeOrganizationId: FAMILY_ID,
			})
		).toEqual([]);
		expect(organizationQueries).toEqual([[PERSONAL_ID]]);
	});

	it("skips the organization query for a user with no other memberships", async () => {
		membershipIds = [FAMILY_ID];
		expect(
			await familySharing.userFamilyOrganizationIds(USER_ID, {
				excludeOrganizationId: FAMILY_ID,
			})
		).toEqual([]);
		expect(organizationQueries).toEqual([]);
	});

	it("feeds the families-per-account decision end to end", async () => {
		membershipIds = [PERSONAL_ID, OTHER_FAMILY_ID];
		const existingFamilyOrganizationIds =
			await familySharing.userFamilyOrganizationIds(USER_ID, {
				excludeOrganizationId: FAMILY_ID,
			});
		expect(existingFamilyOrganizationIds).toEqual([OTHER_FAMILY_ID]);
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds,
				limit: 1,
				targetOrganizationId: FAMILY_ID,
			}).allowed
		).toBe(false);
		expect(
			familySharing.decideFamilyMembership({
				existingFamilyOrganizationIds,
				targetOrganizationId: FAMILY_ID,
			}).allowed
		).toBe(true);
	});

	it("lists each family once, in membership order", async () => {
		membershipIds = [OTHER_FAMILY_ID, PERSONAL_ID, FAMILY_ID, OTHER_FAMILY_ID];
		expect(await familySharing.userFamilyOrganizationIds(USER_ID)).toEqual([
			OTHER_FAMILY_ID,
			FAMILY_ID,
		]);
		expect(organizationQueries).toEqual([
			[OTHER_FAMILY_ID, PERSONAL_ID, FAMILY_ID],
		]);
	});
});

describe("userFamilyMemberships", () => {
	it("returns each family with the user's role and the trimmed name", async () => {
		membershipIds = [PERSONAL_ID, FAMILY_ID, TEAMS_ID, OTHER_FAMILY_ID];
		expect(await familySharing.userFamilyMemberships(USER_ID)).toEqual([
			{ name: "The Smiths", organizationId: FAMILY_ID, role: "owner" },
			{ name: "Cousins", organizationId: OTHER_FAMILY_ID, role: "member" },
		]);
	});

	it("lists families oldest membership first, whatever the storage order", async () => {
		membershipIds = [OTHER_FAMILY_ID, PERSONAL_ID, FAMILY_ID];
		membershipCreatedAt = new Map([
			[FAMILY_ID, Date.parse("2026-01-01T00:00:00Z")],
			[PERSONAL_ID, Date.parse("2026-02-01T00:00:00Z")],
			[OTHER_FAMILY_ID, Date.parse("2026-03-01T00:00:00Z")],
		]);
		expect(await familySharing.userFamilyMemberships(USER_ID)).toEqual([
			{ name: "The Smiths", organizationId: FAMILY_ID, role: "owner" },
			{ name: "Cousins", organizationId: OTHER_FAMILY_ID, role: "member" },
		]);
		expect(membershipSorts).toEqual([{ createdAt: 1 }]);
	});

	it("keeps the first membership row for a duplicated org", async () => {
		membershipIds = [OTHER_FAMILY_ID, OTHER_FAMILY_ID];
		expect(await familySharing.userFamilyMemberships(USER_ID)).toEqual([
			{ name: "Cousins", organizationId: OTHER_FAMILY_ID, role: "member" },
		]);
		expect(organizationQueries).toEqual([[OTHER_FAMILY_ID]]);
	});

	it("skips the organization query for a user with no memberships", async () => {
		expect(await familySharing.userFamilyMemberships(USER_ID)).toEqual([]);
		expect(organizationQueries).toEqual([]);
	});
});
