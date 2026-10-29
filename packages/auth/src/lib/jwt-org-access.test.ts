import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import {
	JWT_SESSION_CLAIM,
	jwtIdentityClaims,
	jwtSessionBindingClaims,
} from "./jwt-identity-claims.ts";
import {
	admitJwtOrgMemberships,
	JWT_ORG_ACCESS_UNAVAILABLE_CODE,
	type JwtOrgAccessInput,
	JwtOrgAccessUnavailableError,
	jwtOrgAccessUnavailable,
	registerJwtOrgAccessResolver,
	runWithAuthRequestPeer,
} from "./jwt-org-access.ts";

const SECRET = "jwt-org-access-test-secret-long-enough";
const PASSWORD = "correct-horse-battery";
const OPEN_ORG = "org-open";
const POLICY_ORG = "org-policy";
const ROWS = [
	{ organizationId: OPEN_ORG, role: "member" },
	{ organizationId: POLICY_ORG, role: "admin" },
];
const MINT = { session: { createdAt: new Date() }, user: { id: "user-1" } };

function decodePayload(token: string): Record<string, unknown> {
	const [, payload] = token.split(".");
	if (!payload) {
		throw new Error("token has no payload segment");
	}
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function sessionCookie(setCookies: string[]): string {
	return setCookies
		.map((setCookie) => setCookie.split(";")[0] ?? "")
		.filter((pair) => pair.includes("="))
		.join("; ");
}

afterEach(() => {
	registerJwtOrgAccessResolver(null);
});

describe("admitJwtOrgMemberships", () => {
	test("refuses the mint when no policy evaluator is registered", async () => {
		const refusal = await admitJwtOrgMemberships(ROWS, MINT).catch(
			(error: unknown) => error
		);
		expect(refusal).toBeInstanceOf(JwtOrgAccessUnavailableError);
		expect((refusal as JwtOrgAccessUnavailableError).reason).toBe(
			"unregistered"
		);
	});

	test("admits a user with no memberships without consulting the policy", async () => {
		let calls = 0;
		registerJwtOrgAccessResolver(() => {
			calls += 1;
			return Promise.reject(new Error("db down"));
		});
		expect(await admitJwtOrgMemberships([], MINT)).toEqual([]);
		registerJwtOrgAccessResolver(null);
		expect(await admitJwtOrgMemberships([], MINT)).toEqual([]);
		expect(calls).toBe(0);
	});

	test("keeps only the memberships the evaluator admits", async () => {
		let seen: string[] = [];
		registerJwtOrgAccessResolver(async ({ organizationIds }) => {
			seen = organizationIds;
			return [OPEN_ORG];
		});
		expect(await admitJwtOrgMemberships(ROWS, MINT)).toEqual([
			{ organizationId: OPEN_ORG, role: "member" },
		]);
		expect(seen).toEqual([OPEN_ORG, POLICY_ORG]);
	});

	test("refuses the mint when the evaluator throws or stalls", async () => {
		const reasonOf = async (work: Promise<unknown>) => {
			const refusal = await work.then(
				() => null,
				(error: unknown) => error
			);
			expect(refusal).toBeInstanceOf(JwtOrgAccessUnavailableError);
			return (refusal as JwtOrgAccessUnavailableError).reason;
		};
		registerJwtOrgAccessResolver(() => Promise.reject(new Error("db down")));
		expect(await reasonOf(admitJwtOrgMemberships(ROWS, MINT))).toBe("error");
		registerJwtOrgAccessResolver(() => {
			throw new Error("sync failure");
		});
		expect(await reasonOf(admitJwtOrgMemberships(ROWS, MINT))).toBe("error");
		registerJwtOrgAccessResolver(() => new Promise(() => undefined));
		expect(await reasonOf(admitJwtOrgMemberships(ROWS, MINT, 20))).toBe(
			"timeout"
		);
	});

	test("treats an evaluator's answer as authoritative, even an empty one", async () => {
		registerJwtOrgAccessResolver(async () => []);
		expect(await admitJwtOrgMemberships(ROWS, MINT)).toEqual([]);
	});

	test("the production mint and server boot route org claims through the policy", () => {
		const authSource = readFileSync(
			new URL("../index.ts", import.meta.url),
			"utf8"
		);
		// Every org claim (`orgs`, `teams`, `ryu_flags_org`) is derived from this
		// one roster promise, so admitting it is admitting all three.
		expect(authSource).toMatch(
			/const memberRows = Member\.find\(\{ userId: user\.id \}\)\s*\.lean\(\)\s*\.exec\(\)\s*\.then\(\(rows\) => admitJwtOrgMemberships\(rows, \{ session, user \}\)\);/
		);
		expect(
			authSource.match(/(?<!Team)Member\.find\(\{ userId: user\.id \}\)/g)
		).toHaveLength(1);
		// The boot seams live in start-background-work.ts, which index.ts awaits.
		const bootSource = readFileSync(
			new URL(
				"../../../../apps/server/src/start-background-work.ts",
				import.meta.url
			),
			"utf8"
		);
		expect(bootSource).toContain(
			"registerJwtOrgAccessResolver(organizationsAdmittingJwtMint);"
		);
		const serverSource = readFileSync(
			new URL("../../../../apps/server/src/index.ts", import.meta.url),
			"utf8"
		);
		expect(serverSource).toContain("await startBackgroundWork();");
		expect(serverSource).toMatch(
			/runWithAuthRequestPeer\(peerIpFromContext\(c\), \(\) =>\s*authHandler\(c\.req\.raw\)/
		);
	});

	test("a Better Auth token mint hands the evaluator its request, peer and session", async () => {
		const database: Pick<
			AuthFixtureDatabase,
			"account" | "jwks" | "session" | "user" | "verification"
		> = { account: [], jwks: [], session: [], user: [], verification: [] };
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: [
				jwt({
					jwt: {
						definePayload: async ({ user, session }) => ({
							orgs: (await admitJwtOrgMemberships(ROWS, { session, user })).map(
								(row) => row.organizationId
							),
						}),
					},
				}),
			],
			secret: SECRET,
		});
		await auth.api.signUpEmail({
			body: { email: "member@example.com", name: "Member", password: PASSWORD },
		});
		const signIn = await auth.api.signInEmail({
			asResponse: true,
			body: { email: "member@example.com", password: PASSWORD },
		});
		const cookie = sessionCookie(signIn.headers.getSetCookie());

		let seen: JwtOrgAccessInput | null = null;
		registerJwtOrgAccessResolver(async (input) => {
			seen = input;
			// The policy org admits only an allowlisted peer.
			return input.peerIp === "203.0.113.7"
				? input.organizationIds
				: [OPEN_ORG];
		});
		const mintThrough = async (peerIp: string) => {
			const response = await runWithAuthRequestPeer(peerIp, () =>
				auth.handler(
					new Request("http://localhost:3000/api/auth/token", {
						headers: { cookie, "x-forwarded-for": "203.0.113.7" },
					})
				)
			);
			const body = (await response.json()) as { token: string };
			return decodePayload(body.token);
		};

		expect((await mintThrough("198.51.100.9")).orgs).toEqual([OPEN_ORG]);
		const received = seen as JwtOrgAccessInput | null;
		expect(received?.peerIp).toBe("198.51.100.9");
		expect(received?.headers?.get("x-forwarded-for")).toBe("203.0.113.7");
		expect(
			(received?.session as { createdAt?: unknown } | undefined)?.createdAt
		).toBeInstanceOf(Date);
		expect((await mintThrough("203.0.113.7")).orgs).toEqual([
			OPEN_ORG,
			POLICY_ORG,
		]);
	});
});

describe("the production token mint", () => {
	const authSource = readFileSync(
		new URL("../index.ts", import.meta.url),
		"utf8"
	);

	test("mints only on /token and keeps hosted MCP tokens opaque", () => {
		// The per-`/get-session` JWT header stays off, so a mint that fails can
		// only ever answer `/api/auth/token`, never sign-in or a session read.
		expect(authSource).toMatch(/jwt\(\{[\s\S]*?disableSettingJwtHeader: true,/);
		expect(authSource).toContain("disableJwtPlugin: true,");
		// Every token is bound to its session, and an unreadable roster fails
		// the mint instead of dropping the org claims.
		expect(authSource).toMatch(
			/const base = \{\s*\.\.\.jwtIdentityClaims\(user\),\s*\.\.\.jwtSessionBindingClaims\(session\),\s*\};/
		);
		expect(authSource).toContain("throw jwtOrgAccessUnavailable();");
		expect(authSource).not.toContain(
			"return withCoreFlagClaim(base, await coreFlags);"
		);
	});

	/**
	 * A Better Auth instance whose `definePayload` composes the production
	 * pieces: identity and session-binding claims, then the memberships the
	 * org access policy admits, with an undecidable policy failing the mint.
	 */
	function mintingAuth(rows: () => typeof ROWS) {
		const database: Pick<
			AuthFixtureDatabase,
			"account" | "jwks" | "session" | "user" | "verification"
		> = { account: [], jwks: [], session: [], user: [], verification: [] };
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: [
				jwt({
					disableSettingJwtHeader: true,
					jwt: {
						definePayload: async ({ user, session }) => {
							const base = {
								...jwtIdentityClaims(user),
								...jwtSessionBindingClaims(session),
							};
							const admitted = await admitJwtOrgMemberships(rows(), {
								session,
								user,
							}).catch(() => {
								throw jwtOrgAccessUnavailable();
							});
							return {
								...base,
								orgs: admitted.map((row) => ({
									id: row.organizationId,
									role: row.role,
								})),
							};
						},
					},
				}),
			],
			secret: SECRET,
		});
		return { auth, database };
	}

	async function signedIn(auth: ReturnType<typeof mintingAuth>["auth"]) {
		await auth.api.signUpEmail({
			body: { email: "member@example.com", name: "Member", password: PASSWORD },
		});
		const signIn = await auth.api.signInEmail({
			asResponse: true,
			body: { email: "member@example.com", password: PASSWORD },
		});
		return sessionCookie(signIn.headers.getSetCookie());
	}

	test("binds the token to the session it was minted from", async () => {
		registerJwtOrgAccessResolver(
			async ({ organizationIds }) => organizationIds
		);
		const { auth, database } = mintingAuth(() => ROWS);
		const cookie = await signedIn(auth);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: { cookie },
			})
		);
		expect(response.status).toBe(200);
		const payload = decodePayload(
			((await response.json()) as { token: string }).token
		);
		const sessionRow = database.session.at(-1);
		expect(sessionRow?.id).toBeTruthy();
		expect(payload[JWT_SESSION_CLAIM]).toBe(sessionRow?.id);
		expect(payload[JWT_SESSION_CLAIM]).not.toBe(sessionRow?.token);
		expect(payload.sub).toBe(payload.id);
	});

	test("answers /token with a 503 while the policy is unavailable for an org member", async () => {
		registerJwtOrgAccessResolver(() => Promise.reject(new Error("db down")));
		const { auth } = mintingAuth(() => ROWS);
		const cookie = await signedIn(auth);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: { cookie },
			})
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("5");
		expect(((await response.json()) as { code?: string }).code).toBe(
			JWT_ORG_ACCESS_UNAVAILABLE_CODE
		);
	});

	test("still mints for a user with no memberships while the policy is down", async () => {
		registerJwtOrgAccessResolver(() => Promise.reject(new Error("db down")));
		const { auth } = mintingAuth(() => []);
		const cookie = await signedIn(auth);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/token", {
				headers: { cookie },
			})
		);
		expect(response.status).toBe(200);
		const payload = decodePayload(
			((await response.json()) as { token: string }).token
		);
		expect(payload.orgs).toEqual([]);
	});

	test("never mints on /get-session", async () => {
		registerJwtOrgAccessResolver(() => Promise.reject(new Error("db down")));
		const { auth } = mintingAuth(() => ROWS);
		const cookie = await signedIn(auth);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/get-session", {
				headers: { cookie },
			})
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-auth-jwt")).toBeNull();
		expect(await response.json()).not.toBeNull();
	});
});
