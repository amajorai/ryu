import { afterEach, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { registerDeviceLimitPolicyResolver } from "./device-limit-policy.ts";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_LIMIT_REACHED_CODE,
	type DeviceSurface,
} from "./device-limits.ts";
import { ryuClientSessionPlugin } from "./ryu-client-session.ts";

/**
 * Real Better Auth (memory adapter) regressions for two counting rules:
 * a server-side REPLACEMENT of an existing session is not a new device, and
 * the count reads only live rows, so stale rows cannot hide live ones.
 */

const BASE_URL = "http://localhost:3000";
const PASSWORD = "Device-limit-password-2026!";
const EMAIL = "replacement@example.com";

afterEach(() => {
	registerDeviceLimitPolicyResolver(null);
});

function enforce(limits: Partial<Record<DeviceSurface, number>>): void {
	registerDeviceLimitPolicyResolver(async () => ({
		enforced: true,
		limits: { ...DEVICE_LIMIT_DEFAULTS, ...limits },
	}));
}

type Row = Record<string, unknown>;

async function fixture() {
	const db: Record<string, Row[]> = {
		account: [],
		session: [],
		twoFactor: [],
		user: [],
		verification: [],
	};
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		secret: "device-limit-replacement-regression-secret-2026",
		plugins: [
			twoFactor({ otpOptions: { sendOTP: async () => undefined } }),
			ryuClientSessionPlugin(),
		],
	});
	const signup = await auth.api.signUpEmail({
		asResponse: true,
		body: { email: EMAIL, name: "Replacement owner", password: PASSWORD },
	});
	if (signup.status !== 200) {
		throw new Error(`Sign-up failed with status ${signup.status}`);
	}
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";", 1).join(""))
		.join("; ");
	return { auth, cookie, db };
}

function postJson(path: string, body: unknown, headers: HeadersInit = {}) {
	return new Request(`${BASE_URL}/api/auth${path}`, {
		body: JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
			origin: BASE_URL,
			...headers,
		},
		method: "POST",
	});
}

describe("device limit session replacement", () => {
	test("enabling two-factor at the cap replaces the session and keeps its surface", async () => {
		const setup = await fixture();
		const [original] = setup.db.session ?? [];
		expect(original?.surface).toBe("web");
		enforce({ web: 1 });

		// Better Auth's two-factor enable calls
		// `internalAdapter.createSession(userId, false, currentSession)` and then
		// deletes the current session: same device, new token.
		const response = await setup.auth.handler(
			postJson(
				"/two-factor/enable",
				{ method: "otp", password: PASSWORD },
				{ cookie: setup.cookie }
			)
		);
		expect(response.status).toBe(200);
		expect(setup.db.session).toHaveLength(1);
		const [replacement] = setup.db.session ?? [];
		expect(replacement?.id).not.toBe(original?.id);
		expect(replacement?.surface).toBe("web");

		// A genuinely new sign-in on the same surface is still refused.
		const signIn = await setup.auth.handler(
			postJson("/sign-in/email", { email: EMAIL, password: PASSWORD })
		);
		expect(signIn.status).not.toBe(200);
	});

	test("a copied session keeps a non-request surface instead of being reclassified", async () => {
		const setup = await fixture();
		const [original] = setup.db.session ?? [];
		if (original) {
			original.surface = "desktop";
			original.issuedClientId = "ryu-desktop";
		}
		enforce({ desktop: 1, web: 0 });
		const response = await setup.auth.handler(
			postJson(
				"/two-factor/enable",
				{ method: "otp", password: PASSWORD },
				{ cookie: setup.cookie }
			)
		);
		expect(response.status).toBe(200);
		const [replacement] = setup.db.session ?? [];
		expect(replacement).toMatchObject({
			issuedClientId: "ryu-desktop",
			surface: "desktop",
		});
	});
});

describe("device limit live-row count", () => {
	test("hundreds of expired rows cannot hide live sessions at the cap", async () => {
		const setup = await fixture();
		const sessions = setup.db.session ?? [];
		expect(sessions).toHaveLength(1);
		const userId = sessions[0]?.userId;
		const now = Date.now();
		// Newer than the live row and stored ahead of it, so an unfiltered
		// bounded scan (by insertion order or newest first) would see only these.
		const expired: Row[] = Array.from({ length: 600 }, (_, index) => ({
			createdAt: new Date(now + index),
			expiresAt: new Date(now - 60_000),
			id: `expired-${index}`,
			ipAddress: "",
			surface: "web",
			token: `expired-token-${index}`,
			updatedAt: new Date(now + index),
			userAgent: "",
			userId,
		}));
		sessions.unshift(...expired);
		enforce({ web: 1 });

		const signIn = await setup.auth.handler(
			postJson("/sign-in/email", { email: EMAIL, password: PASSWORD })
		);
		expect(signIn.status).toBe(403);
		expect(await signIn.json()).toMatchObject({
			code: DEVICE_LIMIT_REACHED_CODE,
			limit: 1,
			surface: "web",
		});
	});
});
