import { describe, expect, test } from "bun:test";
import {
	assertPendingPasskeyMatches,
	decideLoginFactor,
	LOGIN_PENDING_COOKIE,
	LOGIN_TRUST_COOKIE,
	LOGIN_TRUST_MAX_AGE_SECONDS,
	type LoginAssuranceChallenge,
	loginAssuranceAfterFactor,
	loginAssuranceAfterMagicLinkRequest,
	loginAssuranceAfterPassword,
} from "./login-assurance.ts";

interface MockContextOptions {
	body?: unknown;
	passkeyCount?: number;
	path?: string;
	rememberDevice?: boolean;
	trustedDevice?: string;
	twoFactorEnabled?: boolean;
}

function cookie(name: string) {
	return {
		attributes: {
			httpOnly: true,
			path: "/",
			secure: false,
		},
		name,
	};
}

function mockContext(options: MockContextOptions = {}) {
	const signedCookies = new Map<string, string>();
	const responseCookies = new Map<string, { maxAge?: number; value: string }>();
	const deletedSessions: string[] = [];
	const newSession = {
		session: { token: "session-token" },
		user: {
			email: "user@example.com",
			id: "user-1",
			twoFactorEnabled: options.twoFactorEnabled ?? false,
		},
	};
	let currentSession: typeof newSession | null = newSession;
	const context = {
		adapter: {
			findMany: async () =>
				Array.from({ length: options.passkeyCount ?? 0 }, () => ({
					id: "fixture",
				})),
			findOne: async ({ model }: { model: string }) =>
				model === "user"
					? { email: "user@example.com", id: "user-1" }
					: { userId: "user-1" },
		},
		authCookies: {
			accountData: cookie("account_data"),
			dontRememberToken: cookie("dont_remember"),
			sessionData: cookie("session_data"),
			sessionToken: cookie("session_token"),
		},
		createAuthCookie: (name: string, overrides?: { maxAge?: number }) => ({
			...cookie(name),
			attributes: {
				...cookie(name).attributes,
				...overrides,
			},
		}),
		internalAdapter: {
			deleteSession: async (token: string) => {
				deletedSessions.push(token);
			},
		},
		get newSession() {
			return currentSession;
		},
		options: { account: { storeAccountCookie: false } },
		oauthConfig: { storeStateStrategy: "database" as const },
		secret: "test-secret",
		setNewSession: (value: null) => {
			currentSession = value;
		},
	};
	const ctx = {
		body: options.body,
		context,
		getSignedCookie: async (name: string) => {
			if (name === LOGIN_TRUST_COOKIE && options.trustedDevice) {
				return options.trustedDevice;
			}
			return signedCookies.get(name) ?? null;
		},
		request: new Request("https://ryu.test/api/auth", {
			headers: options.rememberDevice
				? { "x-ryu-remember-device": "true" }
				: undefined,
		}),
		json: async (body: LoginAssuranceChallenge) => body,
		path: options.path ?? "/sign-in/email",
		setCookie: (
			name: string,
			value: string,
			valueOptions: { maxAge?: number }
		) => {
			responseCookies.set(name, { maxAge: valueOptions.maxAge, value });
		},
		setSignedCookie: async (
			name: string,
			value: string,
			_secret: string,
			valueOptions: { maxAge?: number }
		) => {
			signedCookies.set(name, value);
			responseCookies.set(name, { maxAge: valueOptions.maxAge, value });
			return value;
		},
	};
	return { ctx, deletedSessions, responseCookies, signedCookies };
}

describe("decideLoginFactor", () => {
	test("prefers a passkey over configured 2FA", () => {
		expect(
			decideLoginFactor({
				hasPasskey: true,
				trustedDevice: false,
				twoFactorEnabled: true,
			})
		).toEqual({ factor: "passkey", fallbackFactor: "two-factor" });
	});

	test("uses a passkey even when 2FA is not configured", () => {
		expect(
			decideLoginFactor({
				hasPasskey: true,
				trustedDevice: false,
				twoFactorEnabled: false,
			})
		).toEqual({ factor: "passkey", fallbackFactor: "email" });
	});

	test("falls back to 2FA before email when no passkey exists", () => {
		expect(
			decideLoginFactor({
				hasPasskey: false,
				trustedDevice: false,
				twoFactorEnabled: true,
			})
		).toEqual({ factor: "two-factor", fallbackFactor: "two-factor" });
	});

	test("uses email when neither passkey nor 2FA exists", () => {
		expect(
			decideLoginFactor({
				hasPasskey: false,
				trustedDevice: false,
				twoFactorEnabled: false,
			})
		).toEqual({ factor: "email", fallbackFactor: "email" });
	});

	test("lets a valid trusted device skip all three factors", () => {
		expect(
			decideLoginFactor({
				hasPasskey: true,
				trustedDevice: true,
				twoFactorEnabled: true,
			})
		).toEqual({ factor: "none", fallbackFactor: "two-factor" });
	});

	test("only accepts an explicit 2FA fallback when 2FA is enabled", () => {
		expect(
			decideLoginFactor({
				fallback: "two-factor",
				hasPasskey: true,
				trustedDevice: false,
				twoFactorEnabled: true,
			})
		).toEqual({ factor: "two-factor", fallbackFactor: "two-factor" });
		expect(
			decideLoginFactor({
				fallback: "email",
				hasPasskey: true,
				trustedDevice: false,
				twoFactorEnabled: true,
			})
		).toEqual({ factor: "passkey", fallbackFactor: "two-factor" });
	});
});

test("trusted-device retention is 30 days", () => {
	expect(LOGIN_TRUST_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
});

test("username passwords require the same passkey or email factor as email passwords", async () => {
	for (const passkeyCount of [0, 1]) {
		const mock = mockContext({ path: "/sign-in/username", passkeyCount });
		expect(await loginAssuranceAfterPassword(mock.ctx)).toEqual({
			fallbackFactor: "email",
			loginFactor: passkeyCount ? "passkey" : "email",
		});
		expect(mock.deletedSessions).toEqual(["session-token"]);
	}
});

test("replaces a password session with a passkey challenge", async () => {
	const mock = mockContext({ passkeyCount: 1 });
	const response = await loginAssuranceAfterPassword(mock.ctx);

	expect(response).toEqual({ fallbackFactor: "email", loginFactor: "passkey" });
	expect(mock.deletedSessions).toEqual(["session-token"]);
	expect(mock.ctx.context.newSession).toBeNull();
	expect(mock.signedCookies.has(LOGIN_PENDING_COOKIE)).toBe(true);
});

test("keeps the built-in 2FA path ahead of email fallback", async () => {
	const mock = mockContext({ twoFactorEnabled: true });
	const response = await loginAssuranceAfterPassword(mock.ctx);

	expect(response).toBeUndefined();
	expect(mock.deletedSessions).toEqual([]);
	expect(mock.signedCookies.has(LOGIN_PENDING_COOKIE)).toBe(true);
});

test("replaces a password session with email OTP when no stronger factor exists", async () => {
	const mock = mockContext();
	const response = await loginAssuranceAfterPassword(mock.ctx);

	expect(response).toEqual({ fallbackFactor: "email", loginFactor: "email" });
	expect(mock.deletedSessions).toEqual(["session-token"]);
});

test("a trusted device skips the factor challenge", async () => {
	const expiresAt = Date.now() + 60_000;
	const trustedDevice = JSON.stringify({ expiresAt, userId: "user-1" });
	const mock = mockContext({ passkeyCount: 1, trustedDevice });

	expect(await loginAssuranceAfterPassword(mock.ctx)).toBeUndefined();
	expect(mock.deletedSessions).toEqual([]);
	expect(mock.signedCookies.has(LOGIN_PENDING_COOKIE)).toBe(false);
});

test("a trust cookie minted after factor success skips the next challenge", async () => {
	const password = mockContext({ body: { rememberDevice: true } });
	await loginAssuranceAfterPassword(password.ctx);
	const factor = mockContext({ path: "/sign-in/email-otp" });
	factor.signedCookies.set(
		LOGIN_PENDING_COOKIE,
		password.signedCookies.get(LOGIN_PENDING_COOKIE) ?? ""
	);
	await loginAssuranceAfterFactor(factor.ctx);
	const trust = factor.signedCookies.get(LOGIN_TRUST_COOKIE);
	expect(trust).toBeString();

	const next = mockContext({ passkeyCount: 1, trustedDevice: trust ?? "" });
	expect(await loginAssuranceAfterPassword(next.ctx)).toBeUndefined();
	expect(next.deletedSessions).toEqual([]);
});

test("a password-login pending cookie replayed as the trust cookie still requires the factor", async () => {
	const password = mockContext({ body: { rememberDevice: true } });
	await loginAssuranceAfterPassword(password.ctx);
	const pending = password.signedCookies.get(LOGIN_PENDING_COOKIE);
	expect(pending).toBeString();

	// Both cookies share one signing secret and the signature does not cover
	// the cookie name, so only the payload separates the two purposes.
	const replay = mockContext({
		body: { rememberDevice: true },
		trustedDevice: pending ?? "",
	});
	expect(await loginAssuranceAfterPassword(replay.ctx)).toEqual({
		fallbackFactor: "email",
		loginFactor: "email",
	});
	expect(replay.deletedSessions).toEqual(["session-token"]);
	expect(replay.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(false);
	expect(replay.responseCookies.get(LOGIN_TRUST_COOKIE)?.maxAge).toBe(0);
});

test("a magic-link pending cookie replayed as the trust cookie still requires the factor", async () => {
	const request = mockContext({
		body: { email: "user@example.com" },
		path: "/sign-in/magic-link",
		rememberDevice: true,
	});
	await loginAssuranceAfterMagicLinkRequest(request.ctx);
	const pending = request.signedCookies.get(LOGIN_PENDING_COOKIE);
	expect(pending).toBeString();

	const replay = mockContext({
		body: { rememberDevice: true },
		passkeyCount: 1,
		trustedDevice: pending ?? "",
	});
	expect(await loginAssuranceAfterPassword(replay.ctx)).toEqual({
		fallbackFactor: "email",
		loginFactor: "passkey",
	});
	expect(replay.deletedSessions).toEqual(["session-token"]);
	expect(replay.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(false);
});

test("binds the pending passkey assertion to the password account", async () => {
	const mock = mockContext({ passkeyCount: 1 });
	await loginAssuranceAfterPassword(mock.ctx);

	const matching = mockContext({ path: "/passkey/verify-authentication" });
	matching.signedCookies.set(
		LOGIN_PENDING_COOKIE,
		mock.signedCookies.get(LOGIN_PENDING_COOKIE) ?? ""
	);
	await expect(
		assertPendingPasskeyMatches({
			...matching.ctx,
			body: { response: { id: "credential-1" } },
		})
	).resolves.toBeUndefined();
});

test("trusts and clears the pending login only after factor success", async () => {
	const password = mockContext({
		passkeyCount: 1,
		body: { rememberDevice: true },
	});
	await loginAssuranceAfterPassword(password.ctx);

	const factor = mockContext({ path: "/sign-in/email-otp" });
	factor.signedCookies.set(
		LOGIN_PENDING_COOKIE,
		password.signedCookies.get(LOGIN_PENDING_COOKIE) ?? ""
	);
	await loginAssuranceAfterFactor(factor.ctx);

	expect(factor.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(true);
	expect(factor.responseCookies.get(LOGIN_PENDING_COOKIE)?.maxAge).toBe(0);
});

test("remembers a magic-link browser only after the same browser verifies the link", async () => {
	const request = mockContext({
		body: { email: " USER@example.com " },
		path: "/sign-in/magic-link",
		rememberDevice: true,
	});
	await loginAssuranceAfterMagicLinkRequest(request.ctx);
	const pending = request.signedCookies.get(LOGIN_PENDING_COOKIE);
	expect(pending).toContain('"flow":"magic-link"');
	expect(pending).toContain('"rememberDevice":true');

	const callback = mockContext({ path: "/magic-link/verify" });
	callback.signedCookies.set(LOGIN_PENDING_COOKIE, pending ?? "");
	await loginAssuranceAfterFactor(callback.ctx);

	expect(callback.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(true);
	expect(callback.responseCookies.get(LOGIN_TRUST_COOKIE)?.maxAge).toBe(
		LOGIN_TRUST_MAX_AGE_SECONDS
	);
	expect(callback.responseCookies.get(LOGIN_PENDING_COOKIE)?.maxAge).toBe(0);
});

test("does not remember a magic-link login opened in another browser", async () => {
	const request = mockContext({
		body: { email: "user@example.com" },
		path: "/sign-in/magic-link",
		rememberDevice: true,
	});
	await loginAssuranceAfterMagicLinkRequest(request.ctx);

	const otherBrowser = mockContext({ path: "/magic-link/verify" });
	await loginAssuranceAfterFactor(otherBrowser.ctx);

	expect(otherBrowser.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(false);
});

test("does not reuse password-login trust consent for a magic-link callback", async () => {
	const password = mockContext({
		body: { rememberDevice: true },
		passkeyCount: 1,
	});
	await loginAssuranceAfterPassword(password.ctx);

	const callback = mockContext({ path: "/magic-link/verify" });
	callback.signedCookies.set(
		LOGIN_PENDING_COOKIE,
		password.signedCookies.get(LOGIN_PENDING_COOKIE) ?? ""
	);
	await loginAssuranceAfterFactor(callback.ctx);

	expect(callback.signedCookies.has(LOGIN_TRUST_COOKIE)).toBe(false);
});
