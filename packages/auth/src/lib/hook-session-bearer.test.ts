import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { z } from "zod";
import { resolveSessionForHook } from "./step-up-plugin.ts";

/** What the `/get-session` before-hook last resolved. */
const probe: {
	session?: Awaited<ReturnType<typeof resolveSessionForHook>>;
} = {};
function resetProbe() {
	probe.session = undefined;
}

const sessionBody = z
	.object({ session: z.object({ id: z.string() }) })
	.nullable();
const signInBody = z.object({ token: z.string() });

const PASSWORD = "Hook-session-bearer-password-2026!";

async function fixture() {
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
		}),
		emailAndPassword: { enabled: true },
		secret: "hook-session-bearer-regression-secret-2026",
		plugins: [
			bearer(),
			{
				id: "hook-session-probe",
				hooks: {
					before: [
						{
							matcher: (ctx) => ctx.path === "/get-session",
							handler: createAuthMiddleware(async (ctx) => {
								probe.session = await resolveSessionForHook(ctx);
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
			email: "bearer@example.com",
			name: "Bearer test",
			password: PASSWORD,
		},
	});
	if (signup.status !== 200) {
		throw new Error(`Sign-up failed with status ${signup.status}`);
	}
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";", 1).join(""))
		.join("; ");
	const cookieToken = signInBody.parse(await signup.json()).token;
	const signin = await auth.api.signInEmail({
		asResponse: true,
		body: { email: "bearer@example.com", password: PASSWORD },
	});
	const bearerToken = signInBody.parse(await signin.json()).token;
	const signedBearer = signin.headers.get("set-auth-token");
	if (!signedBearer || bearerToken === cookieToken) {
		throw new Error("Expected a second, distinct session");
	}
	/** The session the hook judged and the one the endpoint ran as. */
	const judge = async (headers: Record<string, string>) => {
		resetProbe();
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/get-session", { headers })
		);
		const endpoint = sessionBody.parse(await response.json());
		return {
			endpoint: endpoint?.session.id ?? null,
			hook: probe.session?.session.id ?? null,
		};
	};
	const context = await auth.$context;
	const idOf = async (token: string) =>
		(await context.internalAdapter.findSession(token))?.session.id ?? null;
	return {
		bearerId: await idOf(bearerToken),
		bearerToken,
		cookie,
		cookieId: await idOf(cookieToken),
		judge,
		signedBearer,
	};
}

describe("resolveSessionForHook judges the session the endpoint runs as", () => {
	test("a raw bearer token alone resolves its session", async () => {
		const f = await fixture();
		const seen = await f.judge({ authorization: `Bearer ${f.bearerToken}` });
		expect(seen.hook).toBe(f.bearerId);
		expect(seen.endpoint).toBe(f.bearerId);
	});

	test("a signed bearer token replaces the cookie session", async () => {
		const f = await fixture();
		const seen = await f.judge({
			authorization: `Bearer ${f.signedBearer}`,
			cookie: f.cookie,
		});
		expect(seen.hook).toBe(f.bearerId);
		expect(seen.endpoint).toBe(f.bearerId);
	});

	test("an unsigned dotted bearer leaves the cookie session in charge", async () => {
		// The primary-owner guard once vetted this bearer's session (and its
		// active organization) while the endpoint, which the bearer plugin left
		// on the cookie, acted as a different session.
		const f = await fixture();
		for (const forged of [
			`${f.bearerToken}.x`,
			`${f.bearerToken}.header.signature`,
		]) {
			const seen = await f.judge({
				authorization: `Bearer ${forged}`,
				cookie: f.cookie,
			});
			expect(seen.endpoint).toBe(f.cookieId);
			expect(seen.hook).toBe(f.cookieId);
		}
	});

	test("an unsigned dotted bearer alone resolves no session", async () => {
		const f = await fixture();
		const seen = await f.judge({ authorization: `Bearer ${f.bearerToken}.x` });
		expect(seen.endpoint).toBeNull();
		expect(seen.hook).toBeNull();
	});
});
