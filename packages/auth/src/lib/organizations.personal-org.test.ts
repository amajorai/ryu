import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * `resolvePersonalOrgId` against an in-memory stand-in for the control-plane
 * models. The earliest membership is the personal org unless it is a Teams
 * conversion, or a family the user does not own: the owner's Max subscription,
 * gifts and payouts stay on their family org, and a member's payouts never land
 * in someone else's family pool.
 */

const USER_ID = "64b0000000000000000000aa";
const EARLIEST_ID = "64b000000000000000000001";
const LATER_ID = "64b000000000000000000002";

let memberships: Array<{
	createdAt: Date;
	organizationId: string;
	role: string;
	userId: string;
}> = [];
const organizationMetadata = new Map<string, string>();
const organizationKindFields = new Map<string, string>();

function chain<T>(value: T) {
	const query = Object.assign(Promise.resolve(value), {
		lean: () => Promise.resolve(value),
		select: () => query,
		sort: () => query,
	});
	return query;
}

let resolvePersonalOrgId: typeof import("./organizations.ts")["resolvePersonalOrgId"];

beforeAll(async () => {
	mock.module("@ryu/db/models/auth.model", () => ({ User: {} }));
	mock.module("@ryu/db/models/control-plane.model", () => ({
		Member: {
			findOne: (filter: { userId: string }) =>
				chain(
					memberships
						.filter((member) => member.userId === filter.userId)
						.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
						.at(0) ?? null
				),
		},
		Organization: {
			findById: (id: string) => {
				const metadata = organizationMetadata.get(id);
				const organizationKind = organizationKindFields.get(id);
				return chain(
					metadata === undefined && organizationKind === undefined
						? null
						: { metadata, organizationKind }
				);
			},
		},
		// Only the personal-org heal claims; resolving the personal org never does.
		PersonalOrganizationClaim: {},
	}));
	({ resolvePersonalOrgId } = await import("./organizations.ts"));
});

beforeEach(() => {
	memberships = [];
	organizationMetadata.clear();
	organizationKindFields.clear();
});

function joinEarliest(kind: string | null, role: string): void {
	organizationMetadata.set(
		EARLIEST_ID,
		JSON.stringify(kind ? { organizationKind: kind } : {})
	);
	organizationMetadata.set(
		LATER_ID,
		JSON.stringify({ organizationKind: "personal" })
	);
	memberships.push(
		{
			createdAt: new Date(Date.UTC(2026, 0, 2)),
			organizationId: LATER_ID,
			role: "owner",
			userId: USER_ID,
		},
		{
			createdAt: new Date(Date.UTC(2026, 0, 1)),
			organizationId: EARLIEST_ID,
			role,
			userId: USER_ID,
		}
	);
}

describe("resolvePersonalOrgId", () => {
	it("returns null for a user with no membership", async () => {
		expect(await resolvePersonalOrgId(USER_ID)).toBeNull();
	});

	it("returns the earliest personal or legacy-unset membership", async () => {
		joinEarliest("personal", "owner");
		expect(await resolvePersonalOrgId(USER_ID)).toBe(EARLIEST_ID);
		memberships = [];
		joinEarliest(null, "owner");
		expect(await resolvePersonalOrgId(USER_ID)).toBe(EARLIEST_ID);
	});

	it("returns null when the earliest membership converted to Teams", async () => {
		joinEarliest("teams", "owner");
		expect(await resolvePersonalOrgId(USER_ID)).toBeNull();
	});

	it("keeps a family as its owner's personal org", async () => {
		joinEarliest("family", "owner");
		expect(await resolvePersonalOrgId(USER_ID)).toBe(EARLIEST_ID);
	});

	it("returns null for a family the user joined as a non-owner", async () => {
		for (const role of ["admin", "member"]) {
			memberships = [];
			joinEarliest("family", role);
			expect(await resolvePersonalOrgId(USER_ID)).toBeNull();
		}
	});

	it("reads the authoritative kind field over stale personal metadata", async () => {
		// A Better Auth org update raced the family enable and wrote back
		// personal metadata; the top-level field still says family.
		joinEarliest("personal", "member");
		organizationKindFields.set(EARLIEST_ID, "family");
		expect(await resolvePersonalOrgId(USER_ID)).toBeNull();
		organizationKindFields.set(EARLIEST_ID, "personal");
		expect(await resolvePersonalOrgId(USER_ID)).toBe(EARLIEST_ID);
	});
});
