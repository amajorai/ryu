import { describe, expect, test } from "bun:test";
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

const SECRET = "jwt-identity-claims-test-secret-long-enough";
const PASSWORD = "correct-horse-battery";
const DEFINE_PAYLOAD_CALLBACK_PATTERN =
	/definePayload: async \(\{[^}]*\buser\b[^}]*\}\) => \{/;

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

describe("jwtIdentityClaims", () => {
	test("marks a mailbox the user proved as email_verified", () => {
		expect(
			jwtIdentityClaims({
				email: "owner@example.com",
				emailVerified: true,
				id: "user-1",
			})
		).toEqual({
			email: "owner@example.com",
			email_verified: true,
			id: "user-1",
		});
	});

	test("never marks an unproven or unknown mailbox verified", () => {
		for (const emailVerified of [false, null, undefined]) {
			expect(
				jwtIdentityClaims({
					email: "victim@example.com",
					emailVerified,
					id: "u",
				}).email_verified
			).toBe(false);
		}
	});

	test("the production token payload is built from these claims", () => {
		const source = readFileSync(
			new URL("../index.ts", import.meta.url),
			"utf8"
		);
		// The callback may destructure more than `user` (it also reads the
		// session's active org for the flag claim); only its first statement
		// matters here.
		const definePayload = source.split(DEFINE_PAYLOAD_CALLBACK_PATTERN)[1];
		expect(definePayload?.trimStart()).toMatch(
			/^const base = \{\s*\.\.\.jwtIdentityClaims\(user\),\s*\.\.\.jwtSessionBindingClaims\(session\),\s*\};/
		);
	});

	test("tokens Better Auth issues carry the user's verification state", async () => {
		const database: Pick<
			AuthFixtureDatabase,
			"account" | "jwks" | "session" | "user" | "verification"
		> = {
			account: [],
			jwks: [],
			session: [],
			user: [],
			verification: [],
		};
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			database: memoryAdapter(database),
			emailAndPassword: { enabled: true },
			plugins: [
				jwt({ jwt: { definePayload: ({ user }) => jwtIdentityClaims(user) } }),
			],
			secret: SECRET,
		});
		const mint = async () => {
			const signIn = await auth.api.signInEmail({
				asResponse: true,
				body: { email: "member@example.com", password: PASSWORD },
			});
			const { token } = await auth.api.getToken({
				headers: new Headers({
					cookie: sessionCookie(signIn.headers.getSetCookie()),
				}),
			});
			return decodePayload(token);
		};

		await auth.api.signUpEmail({
			body: { email: "member@example.com", name: "Member", password: PASSWORD },
		});
		const unverified = await mint();
		expect(unverified.email).toBe("member@example.com");
		expect(unverified.email_verified).toBe(false);

		const stored = database.user.find(
			(user) => user.email === "member@example.com"
		);
		if (!stored) {
			throw new Error("signed-up user was not stored");
		}
		stored.emailVerified = true;
		const verified = await mint();
		expect(verified.email_verified).toBe(true);
	});
});

describe("jwtSessionBindingClaims", () => {
	test("names the session row the token is minted from, never its token", () => {
		expect(JWT_SESSION_CLAIM).toBe("ryu_sid");
		expect(
			jwtSessionBindingClaims({ id: "session-1", token: "secret-token" })
		).toEqual({ ryu_sid: "session-1" });
	});

	test("refuses to bind a token to a session without a usable id", () => {
		for (const session of [
			null,
			undefined,
			{},
			{ id: "" },
			{ id: 42 },
			{ id: "x".repeat(129) },
		]) {
			expect(() => jwtSessionBindingClaims(session)).toThrow();
		}
	});
});
