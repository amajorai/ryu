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
 * The real seat path in `index.ts` for a family org: the kind read, the
 * registered family capacity, and the family copy in `reserveSeatClaim`. Only
 * model I/O and the Polar client are stubbed, so a regression in the branch
 * itself (reading Polar for a family, or family copy leaking to Teams) fails.
 */
const FAMILY_ORG = "64b0000000000000000000f1";
const TEAMS_ORG = "64b0000000000000000000f2";

Object.assign(process.env, {
	BETTER_AUTH_SECRET: "family-seat-".repeat(4),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-family-seat-fixture",
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

const { Member, Organization } = await import(
	"@ryu/db/models/control-plane.model"
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
const { polarClient } = await import("./lib/payments.ts");
const {
	FAMILY_SHARING_FULL_MESSAGE,
	FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE,
	registerFamilySharingCapacityResolver,
} = await import("./lib/family-sharing.ts");
const { TEAMS_SEAT_COPY } = await import("./lib/family-admission.ts");
const { organizationSeatPathForTests } = await import("./index.ts");

/** A Mongoose-like query: chainable `select`/`lean`, awaitable itself. */
function query<T>(value: T) {
	const chain = Object.assign(Promise.resolve(value), {
		lean: () => Promise.resolve(value),
		select: () => chain,
	});
	return chain;
}

const kinds: Record<string, string> = {
	[FAMILY_ORG]: "family",
	[TEAMS_ORG]: "teams",
};
let memberCount = 1;
let familyCapacity: number | null = 6;
const created: Array<{ kind: string; seatIndex: number }> = [];

/** Narrow a fixture to the stubbed method's type; only its I/O is faked. */
function fake<Method>(implementation: unknown): Method {
	return implementation as Method;
}

const spies = [
	spyOn(Organization, "findById").mockImplementation(
		fake((id: string) =>
			query({ metadata: JSON.stringify({ organizationKind: kinds[id] }) })
		)
	),
	spyOn(Member, "countDocuments").mockImplementation(
		fake(() => Promise.resolve(memberCount))
	),
	spyOn(OrganizationSeatReservation, "findOne").mockImplementation(
		fake(() => query(null))
	),
	spyOn(OrganizationSeatReservation, "find").mockImplementation(
		fake(() => query([]))
	),
	spyOn(OrganizationSeatReservation, "create").mockImplementation(
		fake((row: { kind: string; seatIndex: number }) => {
			created.push({ kind: row.kind, seatIndex: row.seatIndex });
			return Promise.resolve(row);
		})
	),
	spyOn(OrganizationSeatEntitlement, "findOne").mockImplementation(
		fake(() => query(null))
	),
	spyOn(PolarBillingProjection, "findOne").mockImplementation(
		fake(() => query(null))
	),
];
const customerLookup = spyOn(
	polarClient.customers,
	"getExternal"
).mockImplementation(() =>
	Promise.reject(Object.assign(new Error("no customer"), { statusCode: 404 }))
);
const subscriptionList = spyOn(
	polarClient.subscriptions,
	"list"
).mockImplementation(() => {
	throw new Error("A family must never read a Polar seat quantity");
});
const consoleError = spyOn(console, "error").mockImplementation(
	() => undefined
);

registerFamilySharingCapacityResolver(async (organizationId) =>
	organizationId === FAMILY_ORG ? familyCapacity : null
);

beforeEach(() => {
	memberCount = 1;
	familyCapacity = 6;
	created.length = 0;
	customerLookup.mockClear();
	subscriptionList.mockClear();
});
afterAll(() => {
	for (const spy of [
		...spies,
		customerLookup,
		subscriptionList,
		consoleError,
	]) {
		spy.mockRestore();
	}
	mock.restore();
});

function reserve(organizationId: string) {
	return organizationSeatPathForTests.reserveSeatClaim({
		claimId: "pending_invitation:test",
		kind: "pending_invitation",
		organizationId,
	});
}

describe("family capacity on the real seat path", () => {
	it("resolves a family's capacity from the registered resolver, never Polar", async () => {
		expect(
			await organizationSeatPathForTests.activeOrganizationSeatCapacity(
				FAMILY_ORG
			)
		).toEqual({ kind: "family", seatCapacity: 6 });
		expect(customerLookup).not.toHaveBeenCalled();
		expect(subscriptionList).not.toHaveBeenCalled();
	});

	it("admits into the next free family place", async () => {
		memberCount = 2;
		await reserve(FAMILY_ORG);
		expect(created).toEqual([{ kind: "pending_invitation", seatIndex: 2 }]);
		expect(subscriptionList).not.toHaveBeenCalled();
	});

	it("refuses a full family with the family copy", async () => {
		memberCount = 6;
		await expect(reserve(FAMILY_ORG)).rejects.toThrow(
			FAMILY_SHARING_FULL_MESSAGE
		);
		expect(created).toEqual([]);
	});

	it("refuses a lapsed or withdrawn family with the eligibility copy", async () => {
		familyCapacity = null;
		await expect(reserve(FAMILY_ORG)).rejects.toThrow(
			FAMILY_SHARING_NOT_ELIGIBLE_MESSAGE
		);
		expect(customerLookup).not.toHaveBeenCalled();
	});

	it("still reads Polar and answers with Teams copy for a Teams org", async () => {
		await expect(reserve(TEAMS_ORG)).rejects.toThrow(
			TEAMS_SEAT_COPY.noCapacity
		);
		expect(customerLookup).toHaveBeenCalledTimes(1);
	});
});
