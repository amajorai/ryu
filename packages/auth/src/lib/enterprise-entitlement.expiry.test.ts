import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";

/**
 * Enterprise expiry is date-based: nothing rewrites a stored `active` or
 * `trialing` grant once its `expiresAt` passes. `resolveEnterpriseAccess`
 * must report the effective `expired` status (and no capabilities) so
 * consumers that read only `status` cannot treat a lapsed grant as live.
 */

const ORG = "64b000000000000000000011";

interface StoredGrant {
	capabilities: string[];
	expiresAt: Date | null;
	status: string;
}

let grant: StoredGrant | null = null;

function chain<T>(value: () => Promise<T>) {
	const query = {
		exec: value,
		lean: () => query,
		select: () => query,
		// biome-ignore lint/suspicious/noThenProperty: a thenable Mongoose query stand-in.
		then: <R>(resolve: (result: T) => R, reject?: (error: unknown) => R) =>
			value().then(resolve, reject),
	};
	return query;
}

let resolveEnterpriseAccess: typeof import("./enterprise-entitlement.ts").resolveEnterpriseAccess;

const ORIGINAL_DEV_ORG_IDS = process.env.RYU_ENTERPRISE_ORG_IDS;

afterAll(() => {
	if (ORIGINAL_DEV_ORG_IDS !== undefined) {
		process.env.RYU_ENTERPRISE_ORG_IDS = ORIGINAL_DEV_ORG_IDS;
	}
});

beforeAll(async () => {
	// No development override: the raw process env must not grant access here.
	delete process.env.RYU_ENTERPRISE_ORG_IDS;
	mock.module("@ryu/env/server", () => ({
		env: {
			NODE_ENV: "test",
			RYU_ENTERPRISE_LICENSE: "",
			RYU_ENTERPRISE_LICENSE_PUBLIC_KEY: "",
		},
	}));
	mock.module("@ryu/db/models/control-plane.model", () => ({
		Member: {},
		Organization: {
			findById: () => chain(async () => null),
		},
	}));
	mock.module("@ryu/db/models/enterprise-entitlement.model", () => ({
		EnterpriseEntitlement: {
			findOne: (filter: { organizationId: string }) =>
				chain(async () =>
					grant
						? {
								...grant,
								organizationId: filter.organizationId,
								plan: "enterprise",
								source: "contract",
							}
						: null
				),
		},
	}));
	({ resolveEnterpriseAccess } = await import("./enterprise-entitlement.ts"));
});

beforeEach(() => {
	grant = null;
});

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 86_400_000);

describe("resolveEnterpriseAccess expiry", () => {
	it("reports a date-lapsed active grant as expired with no capabilities", async () => {
		grant = {
			capabilities: ["enterprise.sso.oidc"],
			expiresAt: past(),
			status: "active",
		};
		const access = await resolveEnterpriseAccess(ORG);
		expect(access.status).toBe("expired");
		expect(access.capabilities).toEqual([]);
	});

	it("reports a date-lapsed trial as expired", async () => {
		grant = {
			capabilities: ["enterprise.scim"],
			expiresAt: past(),
			status: "trialing",
		};
		const access = await resolveEnterpriseAccess(ORG);
		expect(access.status).toBe("expired");
		expect(access.capabilities).toEqual([]);
	});

	it("keeps a suspended grant's stored status", async () => {
		grant = {
			capabilities: ["enterprise.scim"],
			expiresAt: future(),
			status: "suspended",
		};
		const access = await resolveEnterpriseAccess(ORG);
		expect(access.status).toBe("suspended");
		expect(access.capabilities).toEqual([]);
	});

	it("keeps a current active grant live", async () => {
		grant = {
			capabilities: ["enterprise.sso.oidc"],
			expiresAt: future(),
			status: "active",
		};
		const access = await resolveEnterpriseAccess(ORG);
		expect(access.status).toBe("active");
		expect(access.capabilities).toEqual(["enterprise.sso.oidc"]);
	});
});
