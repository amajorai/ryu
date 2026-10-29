import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

/**
 * Team-scoped custom-role grants must not outlive the team membership they
 * were issued against. Runs the real Better Auth organization hooks from
 * `index.ts`; only model I/O and notification fan-out are stubbed.
 */
const ORG = "64b0000000000000000000a1";
const TEAM = "64b0000000000000000000b1";

Object.assign(process.env, {
	BETTER_AUTH_SECRET: "team-grants-".repeat(4),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-team-grants-fixture",
	NODE_ENV: "test",
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
});

// No database. Better Auth's plugin init reads (and may seed) a collection at
// construction; every driver call answers empty so nothing reaches Mongo.
function emptyCursor() {
	const cursor = {
		limit: () => cursor,
		next: async () => null,
		project: () => cursor,
		skip: () => cursor,
		sort: () => cursor,
		toArray: async () => [],
		async *[Symbol.asyncIterator]() {
			// An empty result set.
		},
	};
	return cursor;
}
const emptyCollection = new Proxy(
	{},
	{
		get: (_target, method) => {
			if (method === "find" || method === "aggregate") {
				return emptyCursor;
			}
			if (method === "insertOne") {
				return async () => ({ acknowledged: true, insertedId: "fixture" });
			}
			return async () => null;
		},
	}
);
mock.module("@ryu/db", () => ({
	client: { collection: () => emptyCollection },
	mongoClient: {},
}));

const notifications: string[] = [];
const canonicalNotifications = await import(
	"./lib/organization-notifications.ts"
);
mock.module("./lib/organization-notifications.ts", () => ({
	...canonicalNotifications,
	notifyOrganizationEvent: (input: { dedupeKey: string }) => {
		notifications.push(input.dedupeKey);
		return Promise.resolve();
	},
}));

const { GatewayCredential, RoleAssignment } = await import(
	"@ryu/db/models/control-plane.model"
);
const { FleetEnrollmentToken, ManagedNode } = await import(
	"@ryu/db/models/fleet.model"
);
const { FamilyMembershipSlot } = await import(
	"@ryu/db/models/family-membership-slot.model"
);
const { VaultPolicyBinding } = await import("@ryu/db/models/vault.model");
const { OrganizationSeatReservation } = await import(
	"@ryu/db/models/organization-seat-reservation.model"
);
const { auth } = await import("./index.ts");

type DeleteFilter = Record<string, unknown>;
const deletes: DeleteFilter[] = [];
let deleteFails = false;
const deleteMany = spyOn(RoleAssignment, "deleteMany").mockImplementation(((
	filter: DeleteFilter
) => {
	if (deleteFails) {
		return Promise.reject(new Error("synthetic outage"));
	}
	deletes.push(filter);
	return Promise.resolve({ acknowledged: true, deletedCount: 1 });
}) as unknown as typeof RoleAssignment.deleteMany);
const vaultDeletes: DeleteFilter[] = [];
const vaultDeleteMany = spyOn(
	VaultPolicyBinding,
	"deleteMany"
).mockImplementation(((filter: DeleteFilter) => {
	vaultDeletes.push(filter);
	return Promise.resolve({ acknowledged: true, deletedCount: 1 });
}) as unknown as typeof VaultPolicyBinding.deleteMany);
const seatDeleteMany = spyOn(
	OrganizationSeatReservation,
	"deleteMany"
).mockImplementation((() =>
	Promise.resolve({
		acknowledged: true,
		deletedCount: 0,
	})) as unknown as typeof OrganizationSeatReservation.deleteMany);
// Member exit also revokes personal node credentials; answer those offline.
const nodeRevocations = [
	FleetEnrollmentToken,
	ManagedNode,
	GatewayCredential,
].map((model) =>
	spyOn(model, "updateMany").mockImplementation((() =>
		Promise.resolve({
			acknowledged: true,
			matchedCount: 0,
			modifiedCount: 0,
		})) as never)
);
const enrollmentRead = spyOn(
	FleetEnrollmentToken,
	"distinct"
).mockImplementation((() => Promise.resolve([])) as never);
const familySlotDelete = spyOn(
	FamilyMembershipSlot,
	"deleteOne"
).mockImplementation((() =>
	Promise.resolve({ acknowledged: true, deletedCount: 0 })) as never);
const consoleError = spyOn(console, "error").mockImplementation(
	() => undefined
);

afterAll(() => {
	deleteMany.mockRestore();
	vaultDeleteMany.mockRestore();
	seatDeleteMany.mockRestore();
	familySlotDelete.mockRestore();
	for (const revocation of nodeRevocations) {
		revocation.mockRestore();
	}
	enrollmentRead.mockRestore();
	consoleError.mockRestore();
	mock.restore();
});

beforeEach(() => {
	deletes.length = 0;
	vaultDeletes.length = 0;
	notifications.length = 0;
	deleteFails = false;
});

type HookInput = Record<string, unknown>;
type Hook = (input: HookInput) => Promise<unknown>;
function organizationHook(name: string): Hook {
	const plugin = (auth.options.plugins ?? []).find(
		(candidate) => candidate.id === "organization"
	) as
		| { options?: { organizationHooks?: Record<string, unknown> } }
		| undefined;
	const hook = plugin?.options?.organizationHooks?.[name];
	if (typeof hook !== "function") {
		throw new Error(`organization hook ${name} is not configured`);
	}
	return hook as Hook;
}

const organization = { id: ORG, name: "Acme" };
const team = { id: TEAM, name: "Alpha", organizationId: ORG };
const user = { email: "member@acme.example", id: "user_a", name: "Member" };
const teamMember = {
	createdAt: new Date(0),
	id: "tm_1",
	teamId: TEAM,
	userId: "user_a",
};

describe("team-scoped role grants follow team membership", () => {
	it("revokes only the removed user's grants on that team", async () => {
		await organizationHook("afterRemoveTeamMember")({
			organization,
			team,
			teamMember,
			user,
		});
		expect(deletes).toEqual([
			{ organizationId: ORG, teamId: TEAM, userId: "user_a" },
		]);
		// The org-wide (teamId null) grants are untouched and notification still runs.
		expect(notifications).toHaveLength(1);
	});

	it("revokes every grant scoped to a deleted team", async () => {
		await organizationHook("afterDeleteTeam")({ organization, team });
		expect(deletes).toEqual([{ organizationId: ORG, teamId: TEAM }]);
		expect(notifications).toHaveLength(1);
	});

	it("does not fail the removal when revocation storage is unavailable", async () => {
		deleteFails = true;
		await organizationHook("afterRemoveTeamMember")({
			organization,
			team,
			teamMember,
			user,
		});
		expect(deletes).toEqual([]);
		expect(notifications).toHaveLength(1);
	});
});

describe("member exit revokes user-bound grants", () => {
	// Not an ObjectId, so the family-workspace lookup short-circuits offline.
	const exitOrg = { id: "org_member_exit", name: "Acme" };

	it("revokes the member's role grants and user-bound vault policies", async () => {
		await organizationHook("afterRemoveMember")({
			member: {
				id: "member_1",
				organizationId: exitOrg.id,
				updatedAt: new Date(0),
				userId: "user_a",
			},
			organization: exitOrg,
			user,
		});
		expect(deletes).toEqual([{ organizationId: exitOrg.id, userId: "user_a" }]);
		// A re-invited user must not regain vault policies bound to `user:<id>`;
		// team and role bindings are left to their own lifecycles.
		expect(vaultDeletes).toEqual([
			{ organizationId: exitOrg.id, subject: "user:user_a" },
		]);
		expect(notifications).toHaveLength(1);
	});
});
