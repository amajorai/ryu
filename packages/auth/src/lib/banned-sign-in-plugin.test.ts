import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import type { AuthFixtureDatabase } from "./auth-test-fixtures.ts";
import {
	BANNED_USER_ERROR_CODE,
	bannedSignInError,
	bannedSignInPlugin,
} from "./banned-sign-in-plugin.ts";

/**
 * Restricted sign-in (managed guardrails spec 05.9): a banned user's sign-in
 * is refused with Better Auth's `BANNED_USER` code plus the plain reason
 * label and the appeal path, instead of the admin plugin's bare message.
 */

const SECRET = "banned-sign-in-test-secret-at-least-32-characters";
const EMAIL = "customer@example.com";
const PASSWORD = "a-strong-test-password";

async function fixture() {
	const database: Pick<
		AuthFixtureDatabase,
		"account" | "session" | "user" | "verification"
	> = { account: [], session: [], user: [], verification: [] };
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		plugins: [bannedSignInPlugin(), admin()],
		secret: SECRET,
	});
	await auth.api.signUpEmail({
		body: { email: EMAIL, name: "Customer", password: PASSWORD },
	});
	const user = database.user.find((row) => row.email === EMAIL);
	if (!user) {
		throw new Error("fixture user was not created");
	}
	return { auth, user };
}

async function signIn(
	auth: Awaited<ReturnType<typeof fixture>>["auth"]
): Promise<{ body: Record<string, unknown>; status: number }> {
	const response = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-in/email", {
			body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
	);
	return {
		body: (await response.json()) as Record<string, unknown>,
		status: response.status,
	};
}

describe("banned sign-in", () => {
	it("refuses a banned user with the reason label and the appeal path", async () => {
		const { auth, user } = await fixture();
		Object.assign(user, {
			banExpires: null,
			banReason: "fraud",
			banned: true,
		});
		const refused = await signIn(auth);
		expect(refused.status).toBe(403);
		expect(refused.body).toMatchObject({
			appealPath: "/appeal",
			code: BANNED_USER_ERROR_CODE,
			message: "Your account is restricted",
			reasonLabel: "fraud",
		});
	});

	it("names child safety only by its plain label", async () => {
		const { auth, user } = await fixture();
		Object.assign(user, { banReason: "csam", banned: true });
		const refused = await signIn(auth);
		expect(refused.body.reasonLabel).toBe("child safety policy");
	});

	it("lets the admin plugin clear an expired ban and sign the user in", async () => {
		const { auth, user } = await fixture();
		Object.assign(user, {
			banExpires: new Date(Date.now() - 60_000),
			banReason: "spam",
			banned: true,
		});
		const signedIn = await signIn(auth);
		expect(signedIn.status).toBe(200);
		expect(user.banned).toBe(false);
	});

	it("only refuses rows that are banned", () => {
		const now = new Date();
		expect(bannedSignInError({ banned: false }, now)).toBeNull();
		expect(bannedSignInError(null, now)).toBeNull();
		expect(
			bannedSignInError({ banReason: "made_up", banned: true }, now)?.body
		).toMatchObject({ reasonLabel: "Ryu's usage policies" });
	});
});
