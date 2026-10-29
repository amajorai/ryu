import { describe, expect, setSystemTime, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
	authoritativeAuthContext,
	canUseSessionCookieCache,
	refreshSessionCookieFromStore,
	sessionCookieCache,
} from "./session-cache.ts";
import { resolveSessionForHook } from "./step-up-plugin.ts";

/** What the `/update-user` before-hook last resolved, for direct assertions. */
let lastHookSession:
	| Awaited<ReturnType<typeof resolveSessionForHook>>
	| undefined;

async function fixture(afterMutation: "clear-team" | "revoke" | null = null) {
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
		}),
		emailAndPassword: { enabled: true },
		secret: "session-cache-regression-test-secret-2026",
		session: {
			cookieCache: sessionCookieCache,
			additionalFields: { activeTeamId: { type: "string", required: false } },
		},
		hooks: {
			before: createAuthMiddleware(async (context) =>
				authoritativeAuthContext(context)
			),
			after: createAuthMiddleware(async (context) => {
				if (afterMutation && context.path === "/update-session") {
					const token = context.context.session?.session.token;
					if (token) {
						if (afterMutation === "revoke") {
							await context.context.internalAdapter.deleteSession(token);
						} else {
							await context.context.internalAdapter.updateSession(token, {
								activeTeamId: null,
							});
						}
						await refreshSessionCookieFromStore(context, token);
					}
				}
			}),
		},
		plugins: [
			{
				id: "native-auth-before-session",
				hooks: {
					before: [
						{
							matcher: (ctx) => ctx.path === "/update-user",
							handler: createAuthMiddleware(async (ctx) => {
								if (ctx.headers?.get("x-test-prepopulate") === "cache") {
									// Model an earlier hook that read the session through the
									// cookie cache and left it on the shared context.
									await getSessionFromCtx(ctx);
								}
								lastHookSession = await resolveSessionForHook(ctx);
							}),
						},
					],
				},
			},
		],
	});
	const signup = await auth.api.signUpEmail({
		asResponse: true,
		body: {
			email: "cache@example.com",
			name: "Cache test",
			password: "Cache-regression-password-2026!",
		},
	});
	if (signup.status !== 200) {
		throw new Error(`Sign-up failed with status ${signup.status}`);
	}
	const cookies = signup.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";", 1).join(""));
	const headers = new Headers({ cookie: cookies.join("; ") });
	const context = await auth.$context;
	return { auth, context, cookies, headers };
}

describe("session cookie cache", () => {
	test("native mutations reject revoked cookies while active sessions still work", async () => {
		const { auth, context, headers } = await fixture();
		const request = () =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/update-user", {
					method: "POST",
					headers: {
						cookie: headers.get("cookie") ?? "",
						"Content-Type": "application/json",
						origin: "http://localhost:3000",
					},
					body: JSON.stringify({ name: "Updated" }),
				})
			);
		expect((await request()).status).toBe(200);
		const session = await auth.api.getSession({ headers });
		if (!session) {
			throw new Error("Expected session");
		}
		await context.internalAdapter.deleteSession(session.session.token);
		expect((await request()).status).toBe(401);
		expect(
			(await request()).headers
				.getSetCookie()
				.some(
					(cookie) =>
						cookie.includes("session_data=") && !cookie.includes("Max-Age=0")
				)
		).toBe(false);
	});
	test("a hook session lookup reads the session store once per request", async () => {
		const { auth, context, headers } = await fixture();
		const findSession = context.internalAdapter.findSession;
		let reads = 0;
		context.internalAdapter.findSession = (...args) => {
			reads += 1;
			return findSession(...args);
		};
		const request = () =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/update-user", {
					method: "POST",
					headers: {
						cookie: headers.get("cookie") ?? "",
						"Content-Type": "application/json",
						origin: "http://localhost:3000",
					},
					body: JSON.stringify({ name: "Updated" }),
				})
			);
		expect((await request()).status).toBe(200);
		// The hook's authoritative lookup already read the store; a second read
		// of the same token only doubled the load on every gated request.
		expect(reads).toBe(1);
		expect(lastHookSession?.user.email).toBe("cache@example.com");
	});
	test("a cache-populated hook session is still re-read from the store", async () => {
		const { auth, context, headers } = await fixture();
		const session = await auth.api.getSession({ headers });
		if (!session) {
			throw new Error("Expected sign-up session");
		}
		await context.internalAdapter.deleteSession(session.session.token);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/update-user", {
				method: "POST",
				headers: {
					cookie: headers.get("cookie") ?? "",
					"Content-Type": "application/json",
					origin: "http://localhost:3000",
					"x-test-prepopulate": "cache",
				},
				body: JSON.stringify({ name: "Updated" }),
			})
		);
		// The signed cache still describes the revoked session; the resolver must
		// not trust it.
		expect(lastHookSession).toBeNull();
		expect(response.status).toBe(401);
	});
	test("serves a cached session without reading the session store", async () => {
		const { auth, context, headers } = await fixture();
		const findSession = context.internalAdapter.findSession;
		let reads = 0;
		context.internalAdapter.findSession = (...args) => {
			reads += 1;
			return findSession(...args);
		};
		expect((await auth.api.getSession({ headers }))?.user.email).toBe(
			"cache@example.com"
		);
		expect(reads).toBe(0);
		await auth.api.getSession({ headers, query: { disableCookieCache: true } });
		expect(reads).toBe(1);
	});

	test("a revoked session cannot authorize an authoritative request", async () => {
		const { auth, context, headers } = await fixture();
		const session = await auth.api.getSession({ headers });
		expect(session).not.toBeNull();
		if (!session) {
			throw new Error("Expected sign-up session");
		}
		await context.internalAdapter.deleteSession(session.session.token);
		expect(await auth.api.getSession({ headers })).not.toBeNull();
		expect(
			await auth.api.getSession({
				headers,
				query: { disableCookieCache: true },
			})
		).toBeNull();
	});

	test("rejects a tampered cache and falls back to the live session", async () => {
		const { auth, context, cookies } = await fixture();
		const session = await auth.api.getSession({
			headers: new Headers({ cookie: cookies.join("; ") }),
		});
		if (!session) {
			throw new Error("Expected sign-up session");
		}
		const tampered = cookies.map((cookie) => {
			if (!cookie.includes("session_data=")) {
				return cookie;
			}
			const separator = cookie.indexOf("=");
			const decoded = Buffer.from(
				cookie.slice(separator + 1),
				"base64url"
			).toString("utf8");
			if (!decoded.includes("Cache test")) {
				throw new Error("Expected the signed compact cache payload");
			}
			const changed = decoded.replace("Cache test", "Injected name");
			return `${cookie.slice(0, separator + 1)}${Buffer.from(changed).toString("base64url")}`;
		});
		const tamperedHeaders = new Headers({ cookie: tampered.join("; ") });
		expect(
			(await auth.api.getSession({ headers: tamperedHeaders }))?.user.name
		).toBe("Cache test");
		await context.internalAdapter.deleteSession(session.session.token);
		expect(
			await auth.api.getSession({
				headers: tamperedHeaders,
			})
		).toBeNull();
	});

	test("defaults mutations, sensitive reads, and new API routes to live checks", () => {
		for (const path of [
			"/api/billing",
			"/api/admin/usage",
			"/api/control-plane/nodes",
			"/api/support-access",
			"/api/key-vault",
			"/api/sessions",
			"/api/waitlist/status",
			"/api/new-route",
		]) {
			expect(canUseSessionCookieCache("GET", path)).toBe(false);
		}
		for (const path of [
			"/api/marketplace",
			"/api/catalog/models",
			"/help/article",
		]) {
			expect(canUseSessionCookieCache("GET", path)).toBe(true);
			expect(canUseSessionCookieCache("POST", path)).toBe(false);
		}
		expect(canUseSessionCookieCache("GET", "/api/marketplace-transfers")).toBe(
			false
		);
	});

	test("an expired cache rechecks the server after 60 seconds", async () => {
		const { auth, context, headers } = await fixture();
		const session = await auth.api.getSession({ headers });
		if (!session) {
			throw new Error("Expected sign-up session");
		}
		await context.internalAdapter.deleteSession(session.session.token);
		try {
			setSystemTime(new Date(Date.now() + 61_000));
			expect(await auth.api.getSession({ headers })).toBeNull();
		} finally {
			setSystemTime();
		}
	});

	test("session changes made by an after-hook immediately refresh the signed cache", async () => {
		const { auth, headers, cookies } = await fixture("clear-team");
		const response = await auth.api.updateSession({
			asResponse: true,
			headers,
			body: { activeTeamId: "old-team" },
		});
		expect(response.status).toBe(200);
		const jar = new Map(
			cookies.map((cookie) => {
				const separator = cookie.indexOf("=");
				return [cookie.slice(0, separator), cookie.slice(separator + 1)];
			})
		);
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";", 1).join("");
			const separator = pair.indexOf("=");
			jar.set(pair.slice(0, separator), pair.slice(separator + 1));
		}
		const refreshed = await auth.api.getSession({
			headers: new Headers({
				cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
			}),
		});
		expect(refreshed?.session.activeTeamId).toBeNull();
	});

	test("session deletion during an after-hook clears the browser cache", async () => {
		const { auth, headers } = await fixture("revoke");
		const response = await auth.api.updateSession({
			asResponse: true,
			headers,
			body: { activeTeamId: "old-team" },
		});
		expect(response.status).toBe(200);
		const expired = response.headers
			.getSetCookie()
			.filter((cookie) => cookie.includes("Max-Age=0"));
		expect(expired.some((cookie) => cookie.includes("session_token="))).toBe(
			true
		);
		expect(expired.some((cookie) => cookie.includes("session_data="))).toBe(
			true
		);
	});
});
