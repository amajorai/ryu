import { afterAll, describe, expect, it, mock } from "bun:test";
import { runWithRequestState } from "@better-auth/core/context";

/**
 * A member role update's audit row records the role it replaced. Better Auth
 * passes `previousRole` only to `afterUpdateMemberRole`; runs that real hook
 * from `index.ts` and reads the details the global after hook writes. Model
 * I/O and notification fan-out are stubbed.
 */
const ORG = "64b0000000000000000000a1";

Object.assign(process.env, {
	BETTER_AUTH_SECRET: "member-role-audit-".repeat(3),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-member-role-audit-fixture",
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

const canonicalNotifications = await import(
	"./lib/organization-notifications.ts"
);
mock.module("./lib/organization-notifications.ts", () => ({
	...canonicalNotifications,
	notifyOrganizationEvent: () => Promise.resolve(),
}));

const { auth } = await import("./index.ts");
const { organizationAuditDetails } = await import(
	"./lib/control-audit-recorder.ts"
);

afterAll(() => {
	mock.restore();
});

type Hook = (input: Record<string, unknown>) => Promise<unknown>;
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

describe("member role update audit", () => {
	it("records who was moved from which role to which", async () => {
		const details = await runWithRequestState(new WeakMap(), async () => {
			await organizationHook("afterUpdateMemberRole")({
				member: {
					id: "member_1",
					organizationId: ORG,
					role: "owner",
					userId: "user_a",
				},
				organization: { id: ORG, name: "Acme" },
				previousRole: "member",
				user: { email: "a@acme.example", id: "user_a", name: "A" },
			});
			return await organizationAuditDetails({
				memberId: "member_1",
				method: "POST",
				path: "/organization/update-member-role",
				role: "owner",
			});
		});
		expect(details).toEqual({
			method: "POST",
			newRole: "owner",
			previousRole: "member",
			status: "success",
		});
	});
});
