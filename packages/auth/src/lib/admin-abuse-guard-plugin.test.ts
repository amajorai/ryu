import { afterAll, describe, expect, it, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { admin, bearer } from "better-auth/plugins";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

/**
 * BN-1 (managed guardrails spec 05.10): the Better Auth admin plugin's
 * account-control endpoints are unreachable as raw HTTP paths, even for a
 * `role: "admin"` session holding a fresh `platform.admin` step-up. The only
 * caller is a direct `auth.api.*` call inside `runInAdminAbuseContext`.
 */

const stepUpGrants: Array<{
	expiresAt: Date;
	scope: string;
	sessionId: string;
}> = [];

function queryResult<T>(value: T) {
	const result = {
		lean: async () => value,
		select: () => result,
		sort: () => result,
	};
	return result;
}

mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpChallenge: {},
	StepUpGrant: {
		findOne: (query: {
			expiresAt: { $gt: Date };
			scope: string;
			sessionId: string;
		}) =>
			queryResult(
				stepUpGrants.find(
					(row) =>
						row.scope === query.scope &&
						row.sessionId === query.sessionId &&
						row.expiresAt > query.expiresAt.$gt
				) ?? null
			),
	},
}));

mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));

const { adminAbuseGuardPlugin, ADMIN_ABUSE_GUARDED_PATHS } = await import(
	"./admin-abuse-guard-plugin.ts"
);
const { runInAdminAbuseContext, isInAdminAbuseContext } = await import(
	"./admin-abuse-context.ts"
);
const { stepUpGate } = await import("./step-up-plugin.ts");

const SECRET = "admin-abuse-guard-test-secret-at-least-32-characters";
const ADMIN_EMAIL = "operator@example.com";
const PASSWORD = "a-strong-test-password";
const BASE = "http://localhost:3000/api/auth";

function cookieJar(setCookies: string[]): string {
	return setCookies
		.map((setCookie) => setCookie.split(";")[0] ?? "")
		.filter((pair) => pair.includes("="))
		.join("; ");
}

async function fixture() {
	stepUpGrants.length = 0;
	const database: Pick<
		AuthFixtureDatabase,
		"account" | "session" | "user" | "verification"
	> = {
		account: [],
		session: [],
		user: [],
		verification: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		secret: SECRET,
		plugins: [adminAbuseGuardPlugin(), bearer(), admin(), stepUpGate()],
		user: {
			additionalFields: {
				twoFactorEnabled: { input: false, type: "boolean" },
			},
		},
	});

	// The fixture's own users are created inside the context: create-user is a
	// guarded path too.
	const { operator, target } = await runInAdminAbuseContext(async () => ({
		operator: (
			await auth.api.createUser({
				body: {
					email: ADMIN_EMAIL,
					name: "Operator",
					password: PASSWORD,
					role: "admin",
				},
			})
		).user,
		target: (
			await auth.api.createUser({
				body: {
					email: "customer@example.com",
					name: "Customer",
					password: PASSWORD,
				},
			})
		).user,
	}));
	const operatorRow = database.user.find((user) => user.id === operator.id);
	if (operatorRow) {
		operatorRow.twoFactorEnabled = true;
	}
	const signIn = await auth.api.signInEmail({
		asResponse: true,
		body: { email: ADMIN_EMAIL, password: PASSWORD },
	});
	const cookie = cookieJar(signIn.headers.getSetCookie());
	const session = await auth.api.getSession({
		headers: new Headers({ cookie }),
		query: { disableCookieCache: true },
	});
	if (!session) {
		throw new Error("operator session was not created");
	}
	return { auth, cookie, database, operator, session, target };
}

function grantStepUp(sessionId: string) {
	stepUpGrants.push({
		expiresAt: new Date(Date.now() + 60_000),
		scope: "platform.admin",
		sessionId,
	});
}

/** The union of the guarded endpoints' request bodies used here. */
interface AdminEndpointBody {
	data?: { banned: boolean; role: string };
	email?: string;
	name?: string;
	newPassword?: string;
	password?: string;
	role?: string;
	sessionToken?: string;
	userId?: string;
}

function rawPost(
	path: string,
	body: AdminEndpointBody,
	headers: Record<string, string>
): Request {
	return new Request(`${BASE}${path}`, {
		body: JSON.stringify(body),
		headers: {
			"content-type": "application/json",
			origin: "http://localhost:3000",
			...headers,
		},
		method: "POST",
	});
}

function bodyFor(path: string, userId: string): AdminEndpointBody {
	if (path === "/admin/set-role") {
		return { role: "admin", userId };
	}
	if (path === "/admin/set-user-password") {
		return { newPassword: "another-strong-password", userId };
	}
	if (path === "/admin/revoke-user-session") {
		return { sessionToken: "token" };
	}
	if (path === "/admin/create-user") {
		return {
			email: "new@example.com",
			name: "New",
			password: PASSWORD,
			role: "admin",
		};
	}
	if (path === "/admin/update-user") {
		return { data: { banned: true, role: "admin" }, userId };
	}
	return { userId };
}

/** The status a direct `auth.api` call ends with, thrown or returned. */
async function statusOf(call: Promise<Response>): Promise<number> {
	try {
		return (await call).status;
	} catch (error) {
		if (error instanceof APIError) {
			return error.statusCode;
		}
		throw error;
	}
}

afterAll(() => {
	mock.restore();
});

describe("admin-abuse guard (BN-1)", () => {
	it("answers 404 to every guarded raw HTTP path for a stepped-up admin", async () => {
		const f = await fixture();
		grantStepUp(f.session.session.id);
		for (const path of ADMIN_ABUSE_GUARDED_PATHS) {
			const cookieResponse = await f.auth.handler(
				rawPost(path, bodyFor(path, f.target.id), { cookie: f.cookie })
			);
			expect({ path, status: cookieResponse.status }).toEqual({
				path,
				status: 404,
			});
			const bearerResponse = await f.auth.handler(
				rawPost(path, bodyFor(path, f.target.id), {
					authorization: `Bearer ${f.session.session.token}`,
				})
			);
			expect({ path, status: bearerResponse.status }).toEqual({
				path,
				status: 404,
			});
		}
		const target = f.database.user.find((user) => user.id === f.target.id);
		expect(target?.banned ?? false).toBe(false);
		expect(target?.role).toBe("user");
	});

	it("answers 404, not a step-up 403, without step-up or without a session", async () => {
		const f = await fixture();
		const noStepUp = await f.auth.handler(
			rawPost("/admin/ban-user", { userId: f.target.id }, { cookie: f.cookie })
		);
		expect(noStepUp.status).toBe(404);
		const anonymous = await f.auth.handler(
			rawPost("/admin/unban-user", { userId: f.target.id }, {})
		);
		expect(anonymous.status).toBe(404);
	});

	it("refuses a server-side call made outside the admin-abuse context", async () => {
		const f = await fixture();
		grantStepUp(f.session.session.id);
		const status = await statusOf(
			f.auth.api.banUser({
				asResponse: true,
				body: { banReason: "fraud", userId: f.target.id },
				headers: new Headers({ cookie: f.cookie }),
			})
		);
		expect(status).toBe(404);
		expect(
			f.database.user.find((user) => user.id === f.target.id)?.banned ?? false
		).toBe(false);
	});

	it("lets the console ban and unban through auth.api inside the context", async () => {
		const f = await fixture();
		grantStepUp(f.session.session.id);
		const headers = new Headers({ cookie: f.cookie });
		const banned = await runInAdminAbuseContext(() =>
			f.auth.api.banUser({
				asResponse: true,
				body: { banReason: "fraud", userId: f.target.id },
				headers,
			})
		);
		expect(banned.status).toBe(200);
		const target = () =>
			f.database.user.find((user) => user.id === f.target.id);
		expect(target()?.banned).toBe(true);
		expect(target()?.banReason).toBe("fraud");

		// The marker ends with the context.
		expect(isInAdminAbuseContext()).toBe(false);
		const afterContext = await statusOf(
			f.auth.api.unbanUser({
				asResponse: true,
				body: { userId: f.target.id },
				headers,
			})
		);
		expect(afterContext).toBe(404);
		expect(target()?.banned).toBe(true);

		const unbanned = await runInAdminAbuseContext(() =>
			f.auth.api.unbanUser({
				asResponse: true,
				body: { userId: f.target.id },
				headers,
			})
		);
		expect(unbanned.status).toBe(200);
		expect(target()?.banned).toBe(false);
	});

	it("refuses an HTTP request even when it is handled inside the context", async () => {
		const f = await fixture();
		grantStepUp(f.session.session.id);
		const response = await runInAdminAbuseContext(() =>
			f.auth.handler(
				rawPost(
					"/admin/ban-user",
					{ userId: f.target.id },
					{ cookie: f.cookie }
				)
			)
		);
		expect(response.status).toBe(404);
	});

	it("leaves the read-only admin endpoints alone", async () => {
		const f = await fixture();
		const response = await f.auth.handler(
			new Request(`${BASE}/admin/list-users`, {
				headers: { cookie: f.cookie, origin: "http://localhost:3000" },
			})
		);
		expect(response.status).toBe(200);
	});
});
