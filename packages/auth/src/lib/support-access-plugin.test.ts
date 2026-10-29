import { afterAll, describe, expect, it, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import { sessionCookieCache } from "./session-cache.ts";

interface GrantRow {
	_id: string;
	expiresAt: Date;
	scopes: string[];
	status: string;
	userId: string;
}

interface AuditRow {
	_id: string;
	actorEmail: string;
	actorId: string;
	endedAt?: Date | null;
	endedReason?: string;
	grantId: string;
	reason: string;
	scopes: string[];
	sessionId: string;
	startedAt: Date;
	userId: string;
}

const grants: GrantRow[] = [];
const audits: AuditRow[] = [];
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

mock.module("@ryu/db/models/support-access.model", () => ({
	SUPPORT_ACCESS_MAX_DURATION_MS: 60 * 60 * 1000,
	SUPPORT_ACCESS_SCOPES: [
		"billing",
		"subscription",
		"organization",
		"sync-status",
		"channels",
		"marketplace",
	],
	SupportAccessAudit: {
		create: async (row: AuditRow) => {
			audits.push(row);
			return row;
		},
		findOne: (query: Partial<AuditRow>) =>
			queryResult(
				audits.find(
					(row) =>
						(!query.actorId || row.actorId === query.actorId) &&
						(!query.grantId || row.grantId === query.grantId) &&
						(!query.sessionId || row.sessionId === query.sessionId) &&
						(!query.userId || row.userId === query.userId) &&
						(query.endedAt === undefined || row.endedAt == null)
				) ?? null
			),
		updateMany: async (
			query: { actorId?: string; endedAt?: null; sessionId?: string },
			update: { $set: { endedAt: Date; endedReason: string } }
		) => {
			for (const row of audits) {
				if (
					(query.actorId === undefined || row.actorId === query.actorId) &&
					(query.sessionId === undefined ||
						row.sessionId === query.sessionId) &&
					(query.endedAt === undefined || row.endedAt == null)
				) {
					row.endedAt = update.$set.endedAt;
					row.endedReason = update.$set.endedReason;
				}
			}
			return { modifiedCount: 1 };
		},
	},
	SupportAccessGrant: {
		findOne: (query: { status?: string; userId?: string; _id?: string }) =>
			queryResult(
				grants.find(
					(row) =>
						(query.status === undefined || row.status === query.status) &&
						(query.userId === undefined || row.userId === query.userId) &&
						(query._id === undefined || row._id === query._id)
				) ?? null
			),
	},
}));

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

const { supportAccessPlugin } = await import("./support-access-plugin.ts");

const SECRET = "support-access-plugin-test-secret-at-least-32-characters";
const ACTOR_EMAIL = "support@example.com";
const ACTOR_PASSWORD = "a-strong-test-password";

function cookieJar(setCookies: string[]): string {
	const values = new Map<string, string>();
	for (const setCookie of setCookies) {
		const [pair, ...attributes] = setCookie.split(";");
		if (!pair) {
			continue;
		}
		const separator = pair.indexOf("=");
		if (separator < 1) {
			continue;
		}
		const name = pair.slice(0, separator);
		const value = pair.slice(separator + 1);
		if (
			attributes.some(
				(attribute) => attribute.trim().toLowerCase() === "max-age=0"
			)
		) {
			values.delete(name);
		} else {
			values.set(name, value);
		}
	}
	return [...values.entries()]
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

async function fixture() {
	grants.length = 0;
	audits.length = 0;
	stepUpGrants.length = 0;
	process.env.ADMIN_EMAILS = ACTOR_EMAIL;
	const database: Pick<
		AuthFixtureDatabase,
		"account" | "jwks" | "session" | "twoFactor" | "user" | "verification"
	> = {
		account: [],
		jwks: [],
		session: [],
		twoFactor: [],
		user: [],
		verification: [],
	};
	const auth = betterAuth({
		session: { cookieCache: sessionCookieCache },
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		secret: SECRET,
		plugins: [bearer(), admin(), jwt(), supportAccessPlugin()],
		user: {
			additionalFields: {
				twoFactorEnabled: { input: false, type: "boolean" },
			},
		},
	});

	const actorResult = await auth.api.createUser({
		body: {
			email: ACTOR_EMAIL,
			name: "Support Actor",
			password: ACTOR_PASSWORD,
			role: "admin",
		},
	});
	const actor = actorResult.user;
	const actorRecord = database.user.find((user) => user.id === actor.id);
	if (actorRecord) {
		actorRecord.emailVerified = true;
		actorRecord.twoFactorEnabled = true;
	}
	const targetResult = await auth.api.createUser({
		body: {
			email: "customer@example.com",
			name: "Customer",
			password: ACTOR_PASSWORD,
		},
	});
	const target = targetResult.user;
	const signIn = await auth.api.signInEmail({
		asResponse: true,
		body: { email: ACTOR_EMAIL, password: ACTOR_PASSWORD },
	});
	const actorCookie = cookieJar(signIn.headers.getSetCookie());
	const actorSession = await auth.api.getSession({
		headers: new Headers({ cookie: actorCookie }),
		query: { disableCookieCache: true },
	});
	if (!actorSession) {
		throw new Error("actor session was not created");
	}
	stepUpGrants.push({
		expiresAt: new Date(Date.now() + 60_000),
		scope: "platform.admin",
		sessionId: actorSession.session.id,
	});
	grants.push({
		_id: "grant-1",
		expiresAt: new Date(Date.now() + 5 * 60_000),
		scopes: ["billing", "channels"],
		status: "active",
		userId: target.id,
	});
	return { actor, actorCookie, actorSession, auth, database, target };
}

afterAll(() => {
	mock.restore();
	delete process.env.ADMIN_EMAILS;
});

describe("hosted support Better Auth integration", () => {
	it("refuses an allowlisted admin actor whose address is unverified", async () => {
		const f = await fixture();
		const actorRecord = f.database.user.find((user) => user.id === f.actor.id);
		if (!actorRecord) {
			throw new Error("actor record missing");
		}
		actorRecord.emailVerified = false;
		const signIn = await f.auth.api.signInEmail({
			asResponse: true,
			body: { email: ACTOR_EMAIL, password: ACTOR_PASSWORD },
		});
		const unverifiedCookie = cookieJar(signIn.headers.getSetCookie());
		const unverifiedSession = await f.auth.api.getSession({
			headers: new Headers({ cookie: unverifiedCookie }),
			query: { disableCookieCache: true },
		});
		if (!unverifiedSession) {
			throw new Error("unverified actor session was not created");
		}
		// Everything else a support start needs is in place (admin role, 2FA, a
		// fresh step-up), so only the unverified address can refuse it.
		stepUpGrants.push({
			expiresAt: new Date(Date.now() + 60_000),
			scope: "platform.admin",
			sessionId: unverifiedSession.session.id,
		});
		const refused = await f.auth.api.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate billing",
				scopes: ["billing"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: unverifiedCookie }),
		});
		expect(refused.status).toBe(403);
		expect(await refused.text()).toContain("not an allowlisted support actor");
		expect(audits).toHaveLength(0);
	});

	it("closes native impersonation, keeps the issuer server-only, and hands off a bounded session", async () => {
		const f = await fixture();
		const rawNative = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/admin/impersonate-user", {
				body: JSON.stringify({ userId: f.target.id }),
				headers: {
					"content-type": "application/json",
					cookie: f.actorCookie,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(rawNative.status).toBe(403);
		const rawNativeBearer = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/admin/impersonate-user", {
				body: JSON.stringify({ userId: f.target.id }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${f.actorSession.session.token}`,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(rawNativeBearer.status).toBe(403);

		const rawSupport = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/support/impersonate-user", {
				body: JSON.stringify({
					reason: "Investigate billing",
					scopes: ["billing"],
					userId: f.target.id,
				}),
				headers: {
					"content-type": "application/json",
					cookie: f.actorCookie,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(rawSupport.status).toBe(404);

		const supportApi = f.auth.api;
		const liveGrant = grants[0];
		grants.length = 0;
		const noGrant = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "No consent",
				scopes: ["billing"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		expect(noGrant.status).toBe(403);
		if (liveGrant) {
			grants.push(liveGrant);
		}
		const emptyScopes = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "Empty scope list",
				scopes: [],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		expect(emptyScopes.status).toBe(400);
		const started = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate billing",
				scopes: ["billing"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		expect(started.status).toBe(200);
		const startedBody = z
			.object({
				auditId: z.string(),
				expiresAt: z.string(),
				scopes: z.array(z.string()),
				session: z.object({
					expiresAt: z.string(),
					id: z.string(),
					token: z.string(),
				}),
			})
			.parse(await started.json());
		expect(startedBody.scopes).toEqual(["billing"]);
		expect(startedBody.session.token.length).toBeGreaterThan(20);
		expect(
			new Date(startedBody.session.expiresAt).getTime()
		).toBeLessThanOrEqual(grants[0]?.expiresAt.getTime() ?? 0);
		expect(audits).toHaveLength(1);
		expect(audits[0]?.sessionId).toBe(startedBody.session.id);
		expect(
			started.headers
				.getSetCookie()
				.some((value) => value.includes("admin_session"))
		).toBe(true);

		const targetSession = await f.auth.api.getSession({
			headers: new Headers({
				authorization: `Bearer ${startedBody.session.token}`,
			}),
			query: { disableCookieCache: true },
		});
		expect(targetSession?.user.id).toBe(f.target.id);
		expect(targetSession?.session.impersonatedBy).toBe(f.actor.id);

		const bearerStarted = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate channels",
				scopes: ["channels"],
				userId: f.target.id,
			},
			headers: new Headers({
				authorization: `Bearer ${f.actorSession.session.token}`,
			}),
		});
		expect(bearerStarted.status).toBe(200);
		const bearerBody = z
			.object({
				scopes: z.array(z.string()),
				session: z.object({ id: z.string(), token: z.string() }),
			})
			.parse(await bearerStarted.json());
		expect(bearerBody.scopes).toEqual(["channels"]);
		const bearerTargetSession = await f.auth.api.getSession({
			headers: new Headers({
				authorization: `Bearer ${bearerBody.session.token}`,
			}),
			query: { disableCookieCache: true },
		});
		expect(bearerTargetSession?.session.impersonatedBy).toBe(f.actor.id);
		const bearerStopStarted = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "Stop bearer session",
				scopes: ["channels"],
				userId: f.target.id,
			},
			headers: new Headers({
				authorization: `Bearer ${f.actorSession.session.token}`,
			}),
		});
		const bearerStopBody = z
			.object({ session: z.object({ id: z.string(), token: z.string() }) })
			.parse(await bearerStopStarted.json());
		const bearerStop = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/admin/stop-impersonating", {
				headers: {
					authorization: `Bearer ${bearerStopBody.session.token}`,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(bearerStop.status).toBe(200);
		const bearerStopResult = z
			.object({
				message: z.string(),
				restored: z.boolean(),
				requiresActorSession: z.boolean(),
				success: z.boolean(),
			})
			.parse(await bearerStop.json());
		expect(bearerStopResult).toMatchObject({
			requiresActorSession: true,
			restored: false,
			success: true,
		});
		expect(bearerStopResult.message).toContain("retained support credential");
		expect(bearerStopResult).not.toHaveProperty("token");
		expect(bearerStop.headers.get("set-auth-token")).toBeNull();
		expect(
			await f.auth.api.getSession({
				headers: new Headers({
					authorization: `Bearer ${bearerStopBody.session.token}`,
				}),
				query: { disableCookieCache: true },
			})
		).toBeNull();
		expect(
			audits.some(
				(row) =>
					row.sessionId === bearerStopBody.session.id &&
					row.endedReason === "stopped"
			)
		).toBe(true);
		const actorAfterBearerStop = await f.auth.api.getSession({
			headers: new Headers({
				authorization: `Bearer ${f.actorSession.session.token}`,
			}),
		});
		expect(actorAfterBearerStop?.user.id).toBe(f.actor.id);
		const bearerSignOut = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/sign-out", {
				headers: {
					authorization: `Bearer ${bearerBody.session.token}`,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(bearerSignOut.status).toBe(200);
		expect(
			await f.auth.api.getSession({
				headers: new Headers({
					authorization: `Bearer ${bearerBody.session.token}`,
				}),
				query: { disableCookieCache: true },
			})
		).toBeNull();
	});

	it("serves ordinary get-session reads from the cookie cache but keeps support sessions live", async () => {
		const f = await fixture();
		const context = await f.auth.$context;
		const findSession = context.internalAdapter.findSession;
		let reads = 0;
		context.internalAdapter.findSession = (...args) => {
			reads += 1;
			return findSession(...args);
		};
		const getSession = (headers: Record<string, string>) =>
			f.auth.handler(
				new Request("http://localhost:3000/api/auth/get-session", {
					headers,
					method: "GET",
				})
			);

		// Every client polls this route; a warm signed cache needs no store read.
		const ordinary = await getSession({ cookie: f.actorCookie });
		expect(ordinary.status).toBe(200);
		expect(
			z
				.object({ user: z.object({ id: z.string() }) })
				.parse(await ordinary.json()).user.id
		).toBe(f.actor.id);
		expect(reads).toBe(0);

		const started = await f.auth.api.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate billing",
				scopes: ["billing"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		const body = z
			.object({ session: z.object({ token: z.string() }) })
			.parse(await started.json());
		const supportCookie = cookieJar(started.headers.getSetCookie());

		// A support session's cache carries `impersonatedBy`, so it is checked
		// against the store and its grant on every read.
		reads = 0;
		expect((await getSession({ cookie: supportCookie })).status).toBe(200);
		expect(reads).toBeGreaterThan(0);
		reads = 0;
		expect(
			(await getSession({ authorization: `Bearer ${body.session.token}` }))
				.status
		).toBe(200);
		expect(reads).toBeGreaterThan(0);

		await f.auth.api.revokeUserSession({
			body: { sessionToken: body.session.token },
			headers: new Headers({ cookie: f.actorCookie }),
		});
		// Neither the still-valid signed cache nor a bearer token keeps a revoked
		// support session alive.
		expect((await getSession({ cookie: supportCookie })).status).toBe(403);
		const bearerAfterRevoke = await getSession({
			authorization: `Bearer ${body.session.token}`,
		});
		expect(await bearerAfterRevoke.json()).toBeNull();
	});

	it("keeps the get-session cache shortcut away from any bearer source", async () => {
		const f = await fixture();
		const started = await f.auth.api.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate billing",
				scopes: ["billing"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		const body = z
			.object({ session: z.object({ token: z.string() }) })
			.parse(await started.json());
		// Consent is withdrawn while the native support session row still exists.
		grants.length = 0;

		// The bearer plugin falls back to the context headers when the request's
		// own Authorization header is empty, so this still authenticates as the
		// support session and must face the grant check, not the cookie shortcut.
		const status = await f.auth.api
			.getSession({
				asResponse: true,
				headers: new Headers({
					authorization: `Bearer ${body.session.token}`,
				}),
				request: new Request("http://localhost:3000/api/auth/get-session", {
					headers: { authorization: "" },
				}),
			})
			.then(
				(response) => response.status,
				(error: unknown) =>
					z.object({ statusCode: z.number() }).parse(error).statusCode
			);
		expect(status).toBe(401);
	});

	it("removes the JWT handoff and restores the original native session after target deletion", async () => {
		const f = await fixture();
		const supportApi = f.auth.api;
		const started = await supportApi.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate channels",
				scopes: ["channels"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		const body = z
			.object({
				scopes: z.array(z.string()),
				session: z.object({ id: z.string(), token: z.string() }),
			})
			.parse(await started.json());
		const supportCookie = cookieJar(started.headers.getSetCookie());

		const getSession = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/get-session", {
				headers: { cookie: supportCookie },
				method: "GET",
			})
		);
		expect(getSession.status).toBe(200);
		expect(getSession.headers.get("set-auth-jwt")).toBeNull();
		const rawJwtToken = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: {
					authorization: `Bearer ${body.session.token}`,
					origin: "http://localhost:3000",
				},
				method: "GET",
			})
		);
		expect(rawJwtToken.status).toBe(403);
		const rawJwtCookie = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: {
					cookie: supportCookie,
					origin: "http://localhost:3000",
				},
				method: "GET",
			})
		);
		expect(rawJwtCookie.status).toBe(403);

		await f.auth.api.revokeUserSession({
			body: { sessionToken: body.session.token },
			headers: new Headers({ cookie: f.actorCookie }),
		});
		const restored = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/admin/stop-impersonating", {
				headers: {
					cookie: supportCookie,
					origin: "http://localhost:3000",
				},
				method: "POST",
			})
		);
		expect(restored.status).toBe(200);
		const restoredBody = z
			.object({ user: z.object({ id: z.string() }) })
			.parse(await restored.json());
		expect(restoredBody.user.id).toBe(f.actor.id);
		expect(audits[0]?.endedReason).toBe("stopped");
	});

	it("checks the support cookie session when a bearer signature does not verify", async () => {
		const f = await fixture();
		const started = await f.auth.api.startSupportSession({
			asResponse: true,
			body: {
				reason: "Investigate channels",
				scopes: ["channels"],
				userId: f.target.id,
			},
			headers: new Headers({ cookie: f.actorCookie }),
		});
		expect(started.status).toBe(200);
		const supportCookie = cookieJar(started.headers.getSetCookie());
		// The operator's own unrestricted token with a forged signature: Better
		// Auth's bearer plugin ignores it and runs the endpoint as the support
		// session in the cookie, so the support checks must judge that session.
		const response = await f.auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: {
					authorization: `Bearer ${f.actorSession.session.token}.AAAA`,
					cookie: supportCookie,
					origin: "http://localhost:3000",
				},
				method: "GET",
			})
		);
		expect(response.status).toBe(403);
	});
});
