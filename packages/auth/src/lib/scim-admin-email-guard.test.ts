import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BetterAuthPlugin } from "better-auth";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import {
	isScimProvisioningPath,
	SCIM_ADMIN_EMAIL_REFUSED,
	scimAdminEmailGuardPlugin,
	scimCreatesAdminEmail,
	scimRenamesToAdminEmail,
} from "./scim-admin-email-guard.ts";

const SECRET = "scim-admin-email-guard-test-secret-0123456789";
const ADMIN = "admin@ryu.example";
const ENV_KEYS = ["ADMIN_EMAILS", "WAITLIST_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	process.env.ADMIN_EMAILS = ADMIN;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
});

describe("SCIM admin-email predicates", () => {
	it("recognises only the SCIM 2.0 endpoints", () => {
		expect(isScimProvisioningPath("/scim/v2/Users")).toBe(true);
		expect(isScimProvisioningPath("/scim/v2/Users/abc")).toBe(true);
		expect(isScimProvisioningPath("/sign-up/email")).toBe(false);
		expect(isScimProvisioningPath(undefined)).toBe(false);
	});

	it("refuses a SCIM create for an allowlisted address, whatever its case", () => {
		expect(scimCreatesAdminEmail("/scim/v2/Users", { email: ADMIN })).toBe(
			true
		);
		expect(
			scimCreatesAdminEmail("/scim/v2/Users", {
				email: "Admin@Ryu.Example",
				emailVerified: false,
			})
		).toBe(true);
		expect(
			scimCreatesAdminEmail("/scim/v2/Users", { email: "ada@acme.com" })
		).toBe(false);
		// Other sign-up paths are not this guard's business.
		expect(scimCreatesAdminEmail("/sign-up/email", { email: ADMIN })).toBe(
			false
		);
	});

	it("refuses a SCIM rename to an allowlisted address but not an unchanged address", () => {
		expect(
			scimRenamesToAdminEmail("/scim/v2/Users/s1", {
				email: ADMIN,
				emailVerified: false,
			})
		).toBe(true);
		// The SCIM plugin omits `emailVerified` when the address is unchanged,
		// so the directory can still deactivate an account it holds.
		expect(scimRenamesToAdminEmail("/scim/v2/Users/s1", { email: ADMIN })).toBe(
			false
		);
		expect(
			scimRenamesToAdminEmail("/scim/v2/Users/s1", {
				email: "ada@acme.com",
				emailVerified: false,
			})
		).toBe(false);
		expect(
			scimRenamesToAdminEmail("/change-email", {
				email: ADMIN,
				emailVerified: false,
			})
		).toBe(false);
	});
});

/**
 * Drive the guard through Better Auth's real database hooks with endpoints on
 * the SCIM paths that make the same internal-adapter calls as
 * `@better-auth/scim` 1.7.1 (`createUser(..., { method: "scim" })` and
 * `updateManagedBetterAuthUser`).
 */
function scimFixture() {
	const database: Record<string, Record<string, unknown>[]> = {
		account: [],
		session: [],
		user: [],
		verification: [],
	};
	const scimProbe = {
		id: "scim-probe",
		endpoints: {
			scimCreateProbe: createAuthEndpoint(
				"/scim/v2/Users",
				{ method: "POST", body: z.object({ email: z.string() }) },
				async (ctx) => {
					const user = await ctx.context.internalAdapter.createUser(
						{ email: ctx.body.email, name: "Directory user" },
						{ method: "scim" }
					);
					return ctx.json({ userId: user.id });
				}
			),
			scimUpdateProbe: createAuthEndpoint(
				"/scim/v2/Users/:userId",
				{ method: "PUT", body: z.object({ email: z.string() }) },
				async (ctx) => {
					const current = database.user?.find(
						(row) => row.id === ctx.params.userId
					);
					await ctx.context.internalAdapter.updateUser(ctx.params.userId, {
						email: ctx.body.email,
						name: "Directory user",
						...(current?.email === ctx.body.email
							? {}
							: { emailVerified: false }),
					});
					return ctx.json({ ok: true });
				}
			),
		},
	} satisfies BetterAuthPlugin;
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		plugins: [scimProbe, scimAdminEmailGuardPlugin()],
		secret: SECRET,
	});
	return { auth, database };
}

function scimRequest(path: string, method: string, email: string): Request {
	return new Request(`http://localhost:3000/api/auth${path}`, {
		body: JSON.stringify({ email }),
		headers: { "content-type": "application/json" },
		method,
	});
}

describe("SCIM admin-email guard through Better Auth hooks", () => {
	it("creates a directory account for an ordinary address", async () => {
		const { auth, database } = scimFixture();
		const response = await auth.handler(
			scimRequest("/scim/v2/Users", "POST", "ada@acme.com")
		);
		expect(response.status).toBe(200);
		expect(database.user?.map((user) => user.email)).toEqual(["ada@acme.com"]);
	});

	it("refuses to create a directory account for an allowlisted address", async () => {
		const { auth, database } = scimFixture();
		const response = await auth.handler(
			scimRequest("/scim/v2/Users", "POST", ADMIN)
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: SCIM_ADMIN_EMAIL_REFUSED,
		});
		expect(database.user).toHaveLength(0);
	});

	it("refuses a directory rename to an allowlisted address and keeps the old one", async () => {
		const { auth, database } = scimFixture();
		const created = await auth.api.scimCreateProbe({
			body: { email: "mallory@acme.com" },
		});
		const response = await auth.handler(
			scimRequest(`/scim/v2/Users/${created.userId}`, "PUT", ADMIN)
		);
		expect(response.status).toBe(403);
		expect(database.user?.map((user) => user.email)).toEqual([
			"mallory@acme.com",
		]);
	});

	it("still lets the directory update an account whose address is unchanged", async () => {
		const { auth, database } = scimFixture();
		const created = await auth.api.scimCreateProbe({
			body: { email: "ada@acme.com" },
		});
		// A legacy directory account that already holds an allowlisted address.
		const stored = database.user?.find((user) => user.id === created.userId);
		if (!stored) {
			throw new Error("SCIM user was not created");
		}
		stored.email = ADMIN;
		const response = await auth.handler(
			scimRequest(`/scim/v2/Users/${created.userId}`, "PUT", ADMIN)
		);
		expect(response.status).toBe(200);
	});
});
