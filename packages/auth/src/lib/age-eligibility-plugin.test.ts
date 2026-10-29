import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
	CURRENT_TERMS_VERSION,
	meetsMinimumAccountAge,
} from "./age-eligibility.ts";
import { ageEligibilityPlugin } from "./age-eligibility-plugin.ts";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";

function fixture(requireEmailVerification = false) {
	const database: Pick<
		AuthFixtureDatabase,
		"user" | "session" | "account" | "verification"
	> = {
		user: [],
		session: [],
		account: [],
		verification: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "age-eligibility-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true, requireEmailVerification },
		emailVerification: {
			sendOnSignUp: true,
			sendVerificationEmail: async () => undefined,
		},
		plugins: [ageEligibilityPlugin()],
	});
	const OMIT = Symbol("omit");
	const age = (
		dateOfBirth: string,
		cookie = "",
		acceptedTerms: unknown = true
	) =>
		auth.handler(
			new Request("http://localhost:3000/api/auth/age-eligibility", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: cookie,
				},
				body: JSON.stringify(
					acceptedTerms === OMIT
						? { dateOfBirth }
						: { dateOfBirth, acceptedTerms }
				),
			})
		);
	const signup = (cookie = "") =>
		auth.handler(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: cookie,
				},
				body: JSON.stringify({
					name: "Adult",
					email: "adult@example.com",
					password: "strong-password-1234",
				}),
			})
		);
	return { auth, database, age, signup, OMIT };
}

const cookieFrom = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");

describe("age eligibility", () => {
	it("rejects unchecked signup before verification mode can return a false success", async () => {
		const app = fixture(true);
		expect((await app.signup()).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});
	it("checks exact birthdays, leap dates, future dates and invalid inputs", () => {
		const today = new Date("2026-10-01T08:00:00Z");
		expect(meetsMinimumAccountAge("2013-10-01", today)).toBe(true);
		expect(meetsMinimumAccountAge("2013-10-02", today)).toBe(false);
		expect(meetsMinimumAccountAge("2000-02-29", today)).toBe(true);
		for (const value of [
			"2013-02-29",
			"2000-13-01",
			"2027-01-01",
			"",
			null,
			"1900-01-01",
		]) {
			expect(meetsMinimumAccountAge(value, today)).toBe(false);
		}
	});
	it("rejects direct signup without collecting a user record", async () => {
		const app = fixture();
		expect((await app.signup()).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});
	it("allows checked signup without saving date of birth", async () => {
		const app = fixture();
		const eligibility = await app.age("1990-01-01");
		expect(eligibility.status).toBe(200);
		expect((await app.signup(cookieFrom(eligibility))).status).toBe(200);
		expect(app.database.user).toHaveLength(1);
		expect(JSON.stringify(app.database)).not.toContain("1990-01-01");
		const [user] = app.database.user as Record<string, unknown>[];
		expect(user?.termsVersion).toBe(CURRENT_TERMS_VERSION);
		expect(user?.termsAcceptedAt).toBeInstanceOf(Date);
	}, 30_000);
	it("requires explicit acceptance of the Terms before the age check passes", async () => {
		const app = fixture();
		for (const acceptedTerms of [false, null, "true", app.OMIT]) {
			const response = await app.age("1990-01-01", "", acceptedTerms);
			expect(response.status).toBe(400);
			expect(response.headers.getSetCookie()).toHaveLength(0);
		}
		expect((await app.signup()).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});
	it("rejects an eligibility cookie issued for an older terms version", async () => {
		const app = fixture();
		const eligibility = await app.age("1990-01-01");
		const [name, value = ""] = cookieFrom(eligibility).split("=");
		const decoded = decodeURIComponent(value);
		const stale = decoded.replace(`:${CURRENT_TERMS_VERSION}`, ":2000-01-01");
		expect(stale).not.toBe(decoded);
		// Re-signing is impossible without the secret, so a tampered version fails
		// signature verification just like a forged cookie.
		expect(
			(await app.signup(`${name}=${encodeURIComponent(stale)}`)).status
		).toBe(403);
	});
	it("denies underage signup and changing the answer in the same browser", async () => {
		const app = fixture();
		const rejected = await app.age("2020-01-01");
		expect(rejected.status).toBe(403);
		const cookie = cookieFrom(rejected);
		expect((await app.signup(cookie)).status).toBe(403);
		expect((await app.age("1990-01-01", cookie)).status).toBe(403);
		expect(app.database.user).toHaveLength(0);
	});
	it("rejects a forged cookie", async () => {
		const app = fixture();
		expect(
			(await app.signup(`better-auth.age_eligibility=${Date.now() + 60_000}`))
				.status
		).toBe(403);
	});
});
