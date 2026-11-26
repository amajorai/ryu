import { mock, spyOn } from "bun:test";

/**
 * In-memory stand-in for the Mongo collections and the Polar client behind the
 * real seat path, for the deployment-mode tests of `seat-capacity.ts`,
 * `seat-claims.ts` and `self-hosted-seats.ts`. Only model I/O and Polar are
 * faked: the organization hooks, the seat claims and the capacity resolver are
 * the production functions, wired as `admission.ts` wires them.
 *
 * A test sets `RYU_DEPLOYMENT_MODE` (and a license, when it needs one) on
 * `process.env` first and then imports this module, because the env module
 * reads the process env once, when it is first imported.
 */
Object.assign(process.env, {
	BETTER_AUTH_SECRET: "seat-path-fixture-".repeat(3),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-seat-path-fixture",
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

const { User } = await import("@ryu/db/models/auth.model");
const { Member, Organization } = await import(
	"@ryu/db/models/control-plane.model"
);
const { OrganizationInvitationPolicy } = await import(
	"@ryu/db/models/organization-invitation-policy.model"
);
const { OrganizationSeatEntitlement } = await import(
	"@ryu/db/models/organization-seat-entitlement.model"
);
const { OrganizationSeatReservation } = await import(
	"@ryu/db/models/organization-seat-reservation.model"
);
const { PolarBillingProjection } = await import(
	"@ryu/db/models/polar-billing-projection.model"
);
const { polarClient } = await import("../../lib/payments.ts");
// The package entry builds the Better Auth instance the way production does.
await import("../../index.ts");
const { settleSsoMembership } = await import("../../lib/sso-membership.ts");
const { organizationAdmission } = await import("../admission.ts");
const { DUPLICATE_KEY_ERROR_CODE } = await import("../schemas.ts");
const { directMemberClaimId } = await import("../seat-capacity.ts");

export type FixtureKind = "family" | "personal" | "teams" | null;

export interface FixtureReservation {
	_id: string;
	expiresAt: Date;
	invitationId: string;
	kind: string;
	organizationId: string;
	seatIndex: number;
}

/** Everything the faked collections hold. Reset with {@link resetSeatPath}. */
export const seatPath = {
	/** Reads that only the self-hosted install count performs. */
	installReads: 0,
	members: [] as Array<{ organizationId: string; userId: string }>,
	/** Organization id to its durable kind (null is a legacy unmarked org). */
	organizations: new Map<string, FixtureKind>(),
	reservations: [] as FixtureReservation[],
	/** Email to user id. */
	users: new Map<string, string>(),
};

let nextReservation = 0;

export function resetSeatPath(): void {
	seatPath.installReads = 0;
	seatPath.members.length = 0;
	seatPath.organizations.clear();
	seatPath.reservations.length = 0;
	seatPath.users.clear();
	customerLookup.mockClear();
	subscriptionList.mockClear();
}

/** A Mongoose-like query: chainable `select`/`lean`/`exec`, awaitable itself. */
function query<T>(value: T) {
	const chain = Object.assign(Promise.resolve(value), {
		exec: () => Promise.resolve(value),
		lean: () => chain,
		select: () => chain,
	});
	return chain;
}

/** Narrow a fake to the stubbed method's type; only its I/O is faked. */
function fake<Method>(implementation: unknown): Method {
	return implementation as Method;
}

type Filter = Record<string, unknown>;

function matchesCondition(value: unknown, condition: unknown): boolean {
	if (
		condition === null ||
		typeof condition !== "object" ||
		condition instanceof Date
	) {
		return String(value) === String(condition);
	}
	const operators = condition as {
		$gt?: Date;
		$in?: unknown[];
		$nin?: unknown[];
	};
	if (operators.$in) {
		return operators.$in.map(String).includes(String(value));
	}
	if (operators.$nin) {
		return !operators.$nin.map(String).includes(String(value));
	}
	if (operators.$gt) {
		return value instanceof Date && value.getTime() > operators.$gt.getTime();
	}
	throw new Error(`Unsupported fixture filter: ${JSON.stringify(condition)}`);
}

function matching<Row extends object>(rows: Row[], filter: Filter = {}): Row[] {
	return rows.filter((row) =>
		Object.entries(filter).every(([key, condition]) =>
			matchesCondition((row as Record<string, unknown>)[key], condition)
		)
	);
}

function storedOrganization(id: string) {
	const kind = seatPath.organizations.get(id);
	return {
		_id: id,
		metadata: JSON.stringify(kind ? { organizationKind: kind } : {}),
	};
}

spyOn(Organization, "findById").mockImplementation(
	fake((id: string) =>
		query(seatPath.organizations.has(id) ? storedOrganization(id) : null)
	)
);
spyOn(Organization, "find").mockImplementation(
	fake(() => {
		seatPath.installReads += 1;
		return query([...seatPath.organizations.keys()].map(storedOrganization));
	})
);
spyOn(Organization, "exists").mockImplementation(
	fake((filter: { _id: string }) => {
		seatPath.installReads += 1;
		return Promise.resolve(
			seatPath.organizations.has(String(filter._id))
				? { _id: filter._id }
				: null
		);
	})
);
spyOn(Member, "countDocuments").mockImplementation(
	fake((filter: Filter) =>
		Promise.resolve(matching(seatPath.members, filter).length)
	)
);
spyOn(Member, "find").mockImplementation(
	fake((filter: Filter) => {
		seatPath.installReads += 1;
		return query(matching(seatPath.members, filter));
	})
);
spyOn(Member, "exists").mockImplementation(
	fake((filter: Filter) =>
		Promise.resolve(matching(seatPath.members, filter)[0] ?? null)
	)
);
spyOn(User, "findOne").mockImplementation(
	fake((filter: { email: string }) => {
		const id = seatPath.users.get(filter.email);
		return query(id ? { _id: id } : null);
	})
);
spyOn(OrganizationSeatReservation, "findOne").mockImplementation(
	fake((filter: Filter) =>
		query(matching(seatPath.reservations, filter)[0] ?? null)
	)
);
spyOn(OrganizationSeatReservation, "find").mockImplementation(
	fake((filter: Filter) => query(matching(seatPath.reservations, filter)))
);
spyOn(OrganizationSeatReservation, "countDocuments").mockImplementation(
	fake((filter: Filter) => {
		seatPath.installReads += 1;
		return Promise.resolve(matching(seatPath.reservations, filter).length);
	})
);
spyOn(OrganizationSeatReservation, "create").mockImplementation(
	fake((row: Omit<FixtureReservation, "_id">) => {
		// The two unique indexes of the real collection.
		const taken = seatPath.reservations.some(
			(existing) =>
				existing.organizationId === row.organizationId &&
				(existing.seatIndex === row.seatIndex ||
					existing.invitationId === row.invitationId)
		);
		if (taken) {
			return Promise.reject(
				Object.assign(new Error("duplicate key"), {
					code: DUPLICATE_KEY_ERROR_CODE,
				})
			);
		}
		nextReservation += 1;
		const stored = { ...row, _id: `reservation-${nextReservation}` };
		seatPath.reservations.push(stored);
		return Promise.resolve(stored);
	})
);
spyOn(OrganizationSeatReservation, "deleteOne").mockImplementation(
	fake((filter: Filter) => {
		const doomed = new Set(matching(seatPath.reservations, filter));
		const kept = seatPath.reservations.filter((row) => !doomed.has(row));
		seatPath.reservations.length = 0;
		seatPath.reservations.push(...kept);
		return Promise.resolve({ deletedCount: doomed.size });
	})
);
spyOn(OrganizationSeatReservation, "findOneAndUpdate").mockImplementation(
	fake((filter: Filter, update: { $set?: Partial<FixtureReservation> }) => {
		const row = matching(seatPath.reservations, filter)[0] ?? null;
		if (row) {
			Object.assign(row, update.$set ?? {});
		}
		return Promise.resolve(row);
	})
);
// The invitation cooldown is outside the seat path: every send is a first send.
spyOn(OrganizationInvitationPolicy, "findOneAndUpdate").mockImplementation(
	fake(() =>
		Promise.resolve({
			lastErrorObject: { updatedExisting: false, upserted: "policy" },
			value: null,
		})
	)
);
// No organization has a legacy Teams seat contract.
spyOn(OrganizationSeatEntitlement, "findOne").mockImplementation(
	fake(() => query(null))
);
spyOn(PolarBillingProjection, "findOne").mockImplementation(
	fake(() => query(null))
);

/** The Polar customer lookup the hosted seat path starts with. */
export const customerLookup = spyOn(
	polarClient.customers,
	"getExternal"
).mockImplementation(() =>
	Promise.reject(Object.assign(new Error("no customer"), { statusCode: 404 }))
);
/** Reading a Polar seat quantity; no fixture organization has a subscription. */
export const subscriptionList = spyOn(
	polarClient.subscriptions,
	"list"
).mockImplementation(() => {
	throw new Error("The fixture has no Polar subscription to list");
});

export interface FixturePerson {
	email: string;
	emailVerified: boolean;
	id: string;
}

/** A person with a verified company mailbox, known to the user collection. */
export function person(id: string): FixturePerson {
	const email = `${id}@acme.example`;
	seatPath.users.set(email, id);
	return { email, emailVerified: true, id };
}

/** Add an organization of `kind` with these members (the first is its owner). */
export function addOrganization(
	id: string,
	kind: FixtureKind,
	memberIds: readonly string[]
): void {
	seatPath.organizations.set(id, kind);
	for (const userId of memberIds) {
		person(userId);
		seatPath.members.push({ organizationId: id, userId });
	}
}

/**
 * What Better Auth does once a before-hook passed: write the member row. The
 * after-hook then releases the join's short-lived claim.
 */
export function writeMember(organizationId: string, userId: string): void {
	seatPath.members.push({ organizationId, userId });
	const kept = seatPath.reservations.filter(
		(row) =>
			!(
				row.organizationId === organizationId &&
				(row.invitationId === directMemberClaimId(userId) ||
					row.kind === "accepting_invitation")
			)
	);
	seatPath.reservations.length = 0;
	seatPath.reservations.push(...kept);
}

/** The four ways a person joins an organization, through the real hooks. */
export const join = {
	/** An owner or admin sends an invitation (`beforeCreateInvitation`). */
	invite: async (
		organizationId: string,
		inviter: FixturePerson,
		email: string
	) => {
		await organizationAdmission.beforeCreateInvitation({
			invitation: { email, organizationId, role: "member" },
			inviter,
		});
	},
	/** The invited person accepts (`beforeAcceptInvitation`). */
	accept: async (
		organizationId: string,
		invitationId: string,
		invitee: FixturePerson
	) => {
		await organizationAdmission.beforeAcceptInvitation({
			invitation: {
				email: invitee.email,
				id: invitationId,
				organizationId,
				role: "member",
			},
			user: invitee,
		});
		writeMember(organizationId, invitee.id);
	},
	/** A trusted direct add (`beforeAddMember`). */
	directAdd: async (organizationId: string, added: FixturePerson) => {
		await organizationAdmission.beforeAddMember({
			member: { organizationId, role: "member" },
			organization: {},
			user: added,
		});
		writeMember(organizationId, added.id);
	},
	/**
	 * An SSO login (`settleSsoMembership`), whose `addMember` is the
	 * organization plugin's and so runs `beforeAddMember`.
	 */
	sso: (organizationId: string, arriving: FixturePerson) =>
		settleSsoMembership(
			{ organizationId, user: arriving },
			{
				addMember: async () => {
					await organizationAdmission.beforeAddMember({
						member: { organizationId, role: "member" },
						organization: {},
						user: arriving,
					});
					writeMember(organizationId, arriving.id);
				},
				hasPendingInvitation: async () => false,
				isMember: async (membership) =>
					seatPath.members.some(
						(member) =>
							member.organizationId === membership.organizationId &&
							member.userId === membership.userId
					),
			}
		),
};

/** Members of one organization. */
export function membersOf(organizationId: string): string[] {
	return seatPath.members
		.filter((member) => member.organizationId === organizationId)
		.map((member) => member.userId);
}

/** Restore every spy and module mock; call from `afterAll`. */
export function restoreSeatPath(): void {
	mock.restore();
}
