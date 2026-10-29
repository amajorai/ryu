import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";
import { z } from "zod";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

const grants: Array<{ sessionId: string; scope: string; expiresAt: Date }> = [];
mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpChallenge: {},
	StepUpGrant: {
		findOne: (query: {
			sessionId: string;
			scope: string;
			expiresAt: { $gt: Date };
		}) => ({
			select: () => ({
				lean: async () =>
					grants.find(
						(grant) =>
							grant.sessionId === query.sessionId &&
							grant.scope === query.scope &&
							grant.expiresAt > query.expiresAt.$gt
					) ?? null,
			}),
		}),
	},
}));
mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));
const { stepUpGate } = await import("./step-up-plugin.ts");

afterAll(() => mock.restore());
beforeEach(() => {
	grants.length = 0;
});

const signUpBody = z.object({
	token: z.string(),
	user: z.object({ id: z.string() }),
});

async function fixture() {
	const database: Pick<
		AuthFixtureDatabase,
		| "user"
		| "session"
		| "account"
		| "verification"
		| "organization"
		| "member"
		| "invitation"
	> = {
		user: [],
		session: [],
		account: [],
		verification: [],
		organization: [],
		member: [],
		invitation: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "step-up-plugin-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		hooks: {
			// Ryu's own config-level hook reads the cookie session for the
			// primary-owner guard before `bearer` has rewritten the request.
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/organization/delete") {
					await getSessionFromCtx(ctx);
				}
			}),
		},
		plugins: [bearer(), organization(), stepUpGate()],
	});
	const signUp = async (email: string) => {
		const response = await auth.api.signUpEmail({
			body: { name: email, email, password: "test-password-1234" },
			asResponse: true,
		});
		const body = signUpBody.parse(await response.json());
		const session = database.session.find((row) => row.token === body.token);
		if (!session) {
			throw new Error(`Expected a session for ${email}`);
		}
		return {
			cookie: response.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; "),
			sessionId: String(session.id),
			signedToken: z.string().parse(response.headers.get("set-auth-token")),
			token: body.token,
			userId: body.user.id,
		};
	};
	const victim = await signUp("victim@example.com");
	const attacker = await signUp("attacker@example.com");
	database.organization.push({
		id: "org-1",
		name: "Victim workspace",
		slug: "victim-workspace",
		createdAt: new Date(),
	});
	database.member.push({
		id: "member-1",
		userId: victim.userId,
		organizationId: "org-1",
		role: "owner",
		createdAt: new Date(),
	});
	return {
		attacker,
		grant: (sessionId: string) =>
			grants.push({
				sessionId,
				scope: "org.delete",
				expiresAt: new Date(Date.now() + 60_000),
			}),
		organizationExists: () =>
			database.organization.some((row) => row.id === "org-1"),
		deleteOrganization: (headers: Record<string, string>) =>
			auth.handler(
				new Request("http://localhost:3000/api/auth/organization/delete", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						...headers,
					},
					body: JSON.stringify({ organizationId: "org-1" }),
				})
			),
		victim,
	};
}

describe("step-up gate session resolution", () => {
	it("checks the cookie session when the bearer signature does not verify", async () => {
		const f = await fixture();
		// The attacker stepped up on their own session, then replays it beside a
		// stolen cookie. Better Auth's bearer plugin rejects the forged signature
		// and leaves the endpoint on the victim's cookie session.
		f.grant(f.attacker.sessionId);
		const response = await f.deleteOrganization({
			cookie: f.victim.cookie,
			authorization: `Bearer ${f.attacker.token}.AAAA`,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "STEP_UP_REQUIRED",
			scope: "org.delete",
		});
		expect(f.organizationExists()).toBe(true);
	});

	it("checks the cookie session when the bearer plugin does not accept the scheme", async () => {
		const f = await fixture();
		f.grant(f.attacker.sessionId);
		const response = await f.deleteOrganization({
			cookie: f.victim.cookie,
			authorization: `Bearer\t${f.attacker.token}`,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
		expect(f.organizationExists()).toBe(true);
	});

	for (const form of ["raw", "signed"] as const) {
		it(`runs the endpoint as the ${form} bearer session it authorized, not a cookie session an earlier hook read`, async () => {
			const f = await fixture();
			f.grant(f.attacker.sessionId);
			const response = await f.deleteOrganization({
				cookie: f.victim.cookie,
				authorization: `Bearer ${
					form === "raw" ? f.attacker.token : f.attacker.signedToken
				}`,
			});
			// The gate passes on the attacker's own grant, so the endpoint must act
			// as the attacker, who is not a member of the victim's workspace.
			expect(response.status).toBe(400);
			expect(f.organizationExists()).toBe(true);
		});
	}

	for (const authorization of [
		(token: string) => `Bearer ${token}`,
		(token: string) => `bearer ${token}`,
	]) {
		for (const form of ["raw", "signed"] as const) {
			it(`still gates and then honours a ${form} bearer token (${authorization("…")})`, async () => {
				const f = await fixture();
				const headers = {
					authorization: authorization(
						form === "raw" ? f.victim.token : f.victim.signedToken
					),
				};
				const rejected = await f.deleteOrganization(headers);
				expect(rejected.status).toBe(403);
				expect(await rejected.json()).toMatchObject({
					code: "STEP_UP_REQUIRED",
				});
				expect(f.organizationExists()).toBe(true);
				f.grant(f.victim.sessionId);
				expect((await f.deleteOrganization(headers)).status).toBe(200);
				expect(f.organizationExists()).toBe(false);
			});
		}
	}

	it("still gates and then honours the cookie session", async () => {
		const f = await fixture();
		const headers = { cookie: f.victim.cookie };
		expect((await f.deleteOrganization(headers)).status).toBe(403);
		expect(f.organizationExists()).toBe(true);
		f.grant(f.victim.sessionId);
		expect((await f.deleteOrganization(headers)).status).toBe(200);
		expect(f.organizationExists()).toBe(false);
	});
});
