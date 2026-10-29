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
 * The family backstop in `resolveEnterpriseAccess`: whatever grant, license or
 * development override names a family workspace, it resolves no enterprise
 * access. The per-route API gates are the primary refusal; this keeps every
 * capability-only consumer (cloud nodes, data controls) closed too.
 */

const ORG = "64b000000000000000000001";
const DEV_ORG = "64b000000000000000000002";

let kinds = new Map<string, string>();
let failKindRead = false;
const grantReads: string[] = [];

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
	if (ORIGINAL_DEV_ORG_IDS === undefined) {
		delete process.env.RYU_ENTERPRISE_ORG_IDS;
	} else {
		process.env.RYU_ENTERPRISE_ORG_IDS = ORIGINAL_DEV_ORG_IDS;
	}
});

beforeAll(async () => {
	// The development override is read from the raw process env.
	process.env.RYU_ENTERPRISE_ORG_IDS = DEV_ORG;
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
			findById: (id: string) =>
				chain(async () => {
					if (failKindRead) {
						throw new Error("organization store unavailable");
					}
					const kind = kinds.get(id);
					return kind === undefined
						? null
						: { metadata: JSON.stringify({ organizationKind: kind }) };
				}),
		},
	}));
	mock.module("@ryu/db/models/enterprise-entitlement.model", () => ({
		EnterpriseEntitlement: {
			findOne: (filter: { organizationId: string }) =>
				chain(async () => {
					grantReads.push(filter.organizationId);
					return {
						capabilities: ["enterprise.sso.oidc", "enterprise.scim"],
						expiresAt: null,
						organizationId: filter.organizationId,
						plan: "enterprise",
						source: "contract",
						status: "active",
					};
				}),
		},
	}));
	({ resolveEnterpriseAccess } = await import("./enterprise-entitlement.ts"));
});

beforeEach(() => {
	kinds = new Map();
	failKindRead = false;
	grantReads.length = 0;
});

describe("resolveEnterpriseAccess family backstop", () => {
	it("denies an active contract grant to a family workspace without reading it", async () => {
		kinds.set(ORG, "family");
		expect(await resolveEnterpriseAccess(ORG)).toEqual({
			capabilities: [],
			expiresAt: null,
			plan: null,
			source: null,
			status: null,
		});
		expect(grantReads).toEqual([]);
	});

	it("denies the development override to a family workspace", async () => {
		kinds.set(DEV_ORG, "family");
		expect((await resolveEnterpriseAccess(DEV_ORG)).capabilities).toEqual([]);
	});

	it("fails closed when the kind cannot be read", async () => {
		failKindRead = true;
		const errors = mock(() => undefined);
		const original = console.error;
		console.error = errors;
		try {
			expect((await resolveEnterpriseAccess(ORG)).capabilities).toEqual([]);
		} finally {
			console.error = original;
		}
		expect(errors).toHaveBeenCalledTimes(1);
		expect(grantReads).toEqual([]);
	});

	it("keeps Teams, personal and legacy-unset orgs on their grant", async () => {
		for (const kind of ["teams", "personal", undefined]) {
			kinds = new Map(kind ? [[ORG, kind]] : []);
			expect((await resolveEnterpriseAccess(ORG)).capabilities).toEqual([
				"enterprise.sso.oidc",
				"enterprise.scim",
			]);
		}
		kinds.set(DEV_ORG, "teams");
		expect((await resolveEnterpriseAccess(DEV_ORG)).source).toBe("development");
	});
});
