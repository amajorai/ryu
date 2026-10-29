import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
	bearer,
	deviceAuthorization,
	jwt,
	twoFactor,
} from "better-auth/plugins";
import { z } from "zod";

/**
 * The Better Auth half of mandatory 2FA, driven through a real Better Auth
 * instance so the matched paths, bearer resolution and adapter lookups are the
 * shipping ones: the status endpoint, the last-factor guard, and the refusal
 * of credential-minting endpoints while an account is unenrolled.
 */

// `step-up-plugin.ts` (for `resolveSessionForHook`) pulls in the step-up store
// and its emails; neither is exercised here.
mock.module("@ryu/db/models/step-up.model", () => ({
	StepUpAttempt: {},
	StepUpChallenge: {},
	StepUpGrant: {},
}));
mock.module("@ryu/email", () => ({
	StepUpMagicLinkEmail: () => null,
	StepUpOTPEmail: () => null,
	sendEmail: async () => undefined,
}));
const { mfaEnrollmentPlugin } = await import("./mfa-enrollment-plugin.ts");
const { MFA_ENROLLMENT_BLOCKED_AUTH_PATHS } = await import(
	"./mfa-enrollment.ts"
);

const previousFlag = process.env.AUTH_REQUIRE_MFA;
beforeAll(() => {
	process.env.AUTH_REQUIRE_MFA = "true";
});
afterAll(() => {
	if (previousFlag === undefined) {
		delete process.env.AUTH_REQUIRE_MFA;
	} else {
		process.env.AUTH_REQUIRE_MFA = previousFlag;
	}
	mock.restore();
});

type Row = Record<string, unknown>;
const PASSWORD = "test-password-1234";
const errorBody = z.object({ code: z.string().optional() }).passthrough();
const signUpBody = z.object({
	token: z.string(),
	user: z.object({ id: z.string() }),
});

let emailCounter = 0;

async function fixture(
	options: {
		initialRole?: string;
		/** What the org-policy lookup answers; a thrown error refuses. */
		mfaRequiredOrganization?: boolean | Error;
	} = {}
) {
	const database: Record<string, Row[]> = {
		account: [],
		apikey: [],
		deviceCode: [],
		jwks: [],
		passkey: [],
		session: [],
		twoFactor: [],
		user: [],
		verification: [],
	};
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "mfa-enrollment-plugin-test-secret-at-least-32-characters",
		database: memoryAdapter(database),
		emailAndPassword: { enabled: true },
		session: { cookieCache: { enabled: true, maxAge: 300 } },
		user: {
			additionalFields: {
				role: {
					type: "string",
					required: false,
					input: false,
					defaultValue: options.initialRole,
				},
			},
		},
		plugins: [
			bearer(),
			twoFactor(),
			passkey({ rpID: "localhost" }),
			jwt(),
			apiKey([{ configId: "default", references: "user" }]),
			deviceAuthorization({
				validateClient: (clientId) => clientId === "ryu-desktop",
			}),
			mfaEnrollmentPlugin({
				userInMfaRequiredOrganization: async () => {
					const answer = options.mfaRequiredOrganization ?? false;
					if (answer instanceof Error) {
						throw answer;
					}
					return answer;
				},
			}),
		],
	});
	emailCounter += 1;
	const email = `member${emailCounter}@example.com`;
	const signup = await auth.api.signUpEmail({
		body: {
			email,
			name: "Member",
			password: PASSWORD,
		},
		asResponse: true,
	});
	const body = signUpBody.parse(await signup.json());
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	const userRow = () => {
		const row = database.user?.find((user) => user.id === body.user.id);
		if (!row) {
			throw new Error("Expected the signed-up user row");
		}
		return row;
	};
	const addPasskey = (id: string, userId = body.user.id) => {
		database.passkey?.push({
			backedUp: false,
			counter: 0,
			createdAt: new Date(),
			credentialID: `credential-${id}`,
			deviceType: "singleDevice",
			id,
			publicKey: "public-key",
			userId,
		});
	};
	const request = (
		path: string,
		init: {
			body?: Row;
			cookie?: string;
			method?: "GET" | "POST";
			token?: string;
			transport?: "bearer" | "cookie";
		} = {}
	) => {
		const method = init.method ?? (init.body ? "POST" : "GET");
		let headers: Record<string, string> =
			init.transport === "cookie"
				? { cookie }
				: { authorization: `Bearer ${init.token ?? body.token}` };
		if (init.cookie !== undefined) {
			headers = { cookie: init.cookie };
		}
		if (init.body) {
			headers["content-type"] = "application/json";
		}
		return auth.handler(
			new Request(`http://localhost:3000/api/auth${path}`, {
				body: init.body ? JSON.stringify(init.body) : undefined,
				headers: { ...headers, origin: "http://localhost:3000" },
				method,
			})
		);
	};
	const sessionRow = (token: string) => {
		const row = database.session?.find((session) => session.token === token);
		if (!row) {
			throw new Error("Expected a stored session row");
		}
		return row;
	};
	return {
		addPasskey,
		database,
		email,
		request,
		sessionRow,
		token: body.token,
		userId: body.user.id,
		userRow,
	};
}

const cookiesOf = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");

async function codeOf(response: Response): Promise<string | undefined> {
	const text = await response.text();
	return text ? errorBody.parse(JSON.parse(text)).code : undefined;
}

describe("mfaEnrollmentPlugin status endpoint", () => {
	it("reports an account with no factor as required", async () => {
		const { request } = await fixture();
		const response = await request("/mfa-enrollment/status");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			code: "mfa_enrollment_required",
			enforced: true,
			passkeyCount: 0,
			required: true,
			twoFactorEnabled: false,
		});
	});

	it("reads the stored role when the cached session still says waitlist", async () => {
		// The signed cookie cache issued at sign-up carries the waitlisted role.
		const { request, userRow } = await fixture({ initialRole: "waitlist" });
		const queued = await request("/mfa-enrollment/status", {
			transport: "cookie",
		});
		expect(await queued.json()).toMatchObject({ required: false });
		// The approval lands in storage; the cookie cache still says waitlist.
		userRow().role = "user";
		const approved = await request("/mfa-enrollment/status", {
			transport: "cookie",
		});
		expect(await approved.json()).toMatchObject({
			enforced: true,
			required: true,
		});
	});

	it("counts a passkey as enrollment", async () => {
		const { addPasskey, request } = await fixture();
		addPasskey("pk-1");
		const response = await request("/mfa-enrollment/status");
		expect(await response.json()).toMatchObject({
			passkeyCount: 1,
			required: false,
		});
	});
});

describe("mfaEnrollmentPlugin last-factor guard", () => {
	for (const transport of ["bearer", "cookie"] as const) {
		it(`refuses disabling the authenticator app with no passkey (${transport})`, async () => {
			const { request, userRow } = await fixture();
			userRow().twoFactorEnabled = true;
			const response = await request("/two-factor/disable", {
				body: { password: PASSWORD },
				transport,
			});
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe("mfa_last_factor");
			expect(userRow().twoFactorEnabled).toBe(true);
		});

		it(`refuses deleting the only passkey (${transport})`, async () => {
			const { addPasskey, database, request } = await fixture();
			addPasskey("pk-only");
			const response = await request("/passkey/delete-passkey", {
				body: { id: "pk-only" },
				transport,
			});
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe("mfa_last_factor");
			expect(database.passkey).toHaveLength(1);
		});
	}

	it("allows deleting one of two passkeys", async () => {
		const { addPasskey, database, request } = await fixture();
		addPasskey("pk-a");
		addPasskey("pk-b");
		const response = await request("/passkey/delete-passkey", {
			body: { id: "pk-a" },
		});
		expect(response.status).toBe(200);
		expect(database.passkey?.map((row) => row.id)).toEqual(["pk-b"]);
	});

	it("leaves a passkey the caller does not own to the native not-found answer", async () => {
		const { addPasskey, database, request } = await fixture();
		addPasskey("pk-mine");
		addPasskey("pk-theirs", "someone-else");
		const response = await request("/passkey/delete-passkey", {
			body: { id: "pk-theirs" },
		});
		expect(response.status).not.toBe(200);
		expect(await codeOf(response)).not.toBe("mfa_last_factor");
		expect(database.passkey).toHaveLength(2);
	});
});

describe("mfaEnrollmentPlugin credential minting", () => {
	it("pins the refused Better Auth paths", () => {
		expect([...MFA_ENROLLMENT_BLOCKED_AUTH_PATHS].sort()).toEqual([
			"/api-key/create",
			"/device/approve",
			"/mcp/authorize",
			"/oauth2/authorize",
			"/oauth2/client/rotate-secret",
			"/oauth2/consent",
			"/oauth2/continue",
			"/oauth2/create-client",
			"/one-time-token/generate",
			"/organization/create",
			"/organization/invite-member",
			"/token",
		]);
	});

	for (const transport of ["bearer", "cookie"] as const) {
		it(`refuses an API key and a Core JWT until a factor is enrolled (${transport})`, async () => {
			const { addPasskey, database, request } = await fixture();
			const key = await request("/api-key/create", {
				body: { name: "Personal" },
				transport,
			});
			expect(key.status).toBe(403);
			expect(await codeOf(key)).toBe("mfa_enrollment_required");
			expect(database.apikey).toHaveLength(0);

			const token = await request("/token", { transport });
			expect(token.status).toBe(403);
			expect(await codeOf(token)).toBe("mfa_enrollment_required");

			addPasskey(`pk-${transport}`);
			const enrolledKey = await request("/api-key/create", {
				body: { name: "Personal" },
				transport,
			});
			expect(enrolledKey.status).toBe(200);
			expect((await request("/token", { transport })).status).toBe(200);
		});
	}

	it("strips the get-session JWT header only while unenrolled", async () => {
		const { addPasskey, request } = await fixture();
		const unenrolled = await request("/get-session");
		expect(unenrolled.status).toBe(200);
		expect(unenrolled.headers.get("set-auth-jwt")).toBeNull();
		expect(
			unenrolled.headers.get("access-control-expose-headers") ?? ""
		).not.toContain("set-auth-jwt");

		addPasskey("pk-session");
		const enrolled = await request("/get-session");
		expect(enrolled.headers.get("set-auth-jwt")).toBeTruthy();
	});

	it("does not refuse anything while the mandate is off", async () => {
		const { request } = await fixture();
		process.env.AUTH_REQUIRE_MFA = "false";
		try {
			const key = await request("/api-key/create", {
				body: { name: "Personal" },
			});
			expect(key.status).toBe(200);
			const session = await request("/get-session");
			expect(session.headers.get("set-auth-jwt")).toBeTruthy();
		} finally {
			process.env.AUTH_REQUIRE_MFA = "true";
		}
	});
	it("still refuses an unenrolled platform admin while the mandate is off", async () => {
		const { addPasskey, request } = await fixture({ initialRole: "admin" });
		process.env.AUTH_REQUIRE_MFA = "false";
		try {
			const status = await request("/mfa-enrollment/status");
			expect(await status.json()).toMatchObject({
				enforced: true,
				required: true,
			});
			const key = await request("/api-key/create", {
				body: { name: "Personal" },
			});
			expect(key.status).toBe(403);
			expect(await codeOf(key)).toBe("mfa_enrollment_required");
			const session = await request("/get-session");
			expect(session.headers.get("set-auth-jwt")).toBeNull();

			// Enrolled, but this session was signed in with a password alone.
			addPasskey("pk-admin");
			const weakKey = await request("/api-key/create", {
				body: { name: "Personal" },
			});
			expect(weakKey.status).toBe(403);
			expect(await codeOf(weakKey)).toBe("staff_session_factor_required");
		} finally {
			process.env.AUTH_REQUIRE_MFA = "true";
		}
	});
});

describe("mfaEnrollmentPlugin staff session assurance", () => {
	const enrollWithBackupCodes = async (
		staff: Awaited<ReturnType<typeof fixture>>
	) => {
		// First enrollment stays open to a password-only staff session.
		const enable = await staff.request("/two-factor/enable", {
			body: { password: PASSWORD },
		});
		if (enable.status !== 200) {
			throw new Error(`Expected first enrollment to open: ${enable.status}`);
		}
		const { backupCodes } = z
			.object({ backupCodes: z.array(z.string()) })
			.parse(await enable.json());
		staff.userRow().twoFactorEnabled = true;
		return backupCodes;
	};

	it("refuses an enrolled staff session that signed in without its factor", async () => {
		const staff = await fixture({ initialRole: "admin" });
		staff.addPasskey("pk-staff");
		const status = await staff.request("/mfa-enrollment/status");
		expect(await status.json()).toMatchObject({
			code: "staff_session_factor_required",
			required: true,
			sessionFactorRequired: true,
		});
		const token = await staff.request("/token");
		expect(token.status).toBe(403);
		expect(await codeOf(token)).toBe("staff_session_factor_required");
		const session = await staff.request("/get-session");
		expect(session.status).toBe(200);
		expect(session.headers.get("set-auth-jwt")).toBeNull();
	});

	it("admits the session once its row carries a strong-factor stamp", async () => {
		const staff = await fixture({ initialRole: "admin" });
		staff.addPasskey("pk-staff");
		// What a successful authenticator step-up writes.
		staff.sessionRow(staff.token).strongFactor = "totp";
		expect((await staff.request("/token")).status).toBe(200);
		const status = await staff.request("/mfa-enrollment/status");
		expect(await status.json()).toMatchObject({
			code: null,
			required: false,
			sessionFactorRequired: false,
		});
	});

	it("stamps a session signed in with a recovery code, not one signed in by password", async () => {
		const staff = await fixture({ initialRole: "admin" });
		const backupCodes = await enrollWithBackupCodes(staff);

		const signIn = await staff.request("/sign-in/email", {
			body: { email: staff.email, password: PASSWORD },
			cookie: "",
		});
		expect(signIn.status).toBe(200);
		expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });

		const verified = await staff.request("/two-factor/verify-backup-code", {
			body: { code: backupCodes[0] },
			cookie: cookiesOf(signIn),
		});
		expect(verified.status).toBe(200);
		const { token } = z
			.object({ token: z.string() })
			.parse(await verified.json());
		expect(staff.sessionRow(token).strongFactor).toBe("backup");
		expect((await staff.request("/token", { token })).status).toBe(200);

		// The password-only sign-up session stays refused.
		expect(staff.sessionRow(staff.token).strongFactor).toBeUndefined();
		const weak = await staff.request("/token");
		expect(weak.status).toBe(403);
		expect(await codeOf(weak)).toBe("staff_session_factor_required");
	});

	it("keeps a mailbox-only staff session from provisioning a new factor", async () => {
		const staff = await fixture({ initialRole: "admin" });
		staff.addPasskey("pk-staff");
		for (const path of [
			"/two-factor/enable",
			"/two-factor/get-totp-uri",
			"/two-factor/generate-backup-codes",
		]) {
			const response = await staff.request(path, {
				body: { password: PASSWORD },
			});
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe("staff_session_factor_required");
		}
		const register = await staff.request("/passkey/generate-register-options");
		expect(register.status).toBe(403);
		expect(await codeOf(register)).toBe("staff_session_factor_required");
	});

	it("keeps a mailbox-only session of a member whose org requires two-factor from adding a factor", async () => {
		const member = await fixture({ mfaRequiredOrganization: true });
		member.userRow().twoFactorEnabled = true;
		for (const path of [
			"/two-factor/enable",
			"/two-factor/get-totp-uri",
			"/two-factor/generate-backup-codes",
		]) {
			const response = await member.request(path, {
				body: { password: PASSWORD },
			});
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe("org_mfa_session_required");
		}
		for (const path of [
			"/passkey/generate-register-options",
			"/passkey/verify-registration",
		]) {
			const response = await member.request(path, {
				body: path.endsWith("verify-registration")
					? { response: {} }
					: undefined,
			});
			expect(response.status).toBe(403);
			expect(await codeOf(response)).toBe("org_mfa_session_required");
		}
		expect(member.database.passkey).toHaveLength(0);
	});

	it("lets that member add a passkey once the session proved a factor", async () => {
		const member = await fixture({ mfaRequiredOrganization: true });
		member.userRow().twoFactorEnabled = true;
		// What a successful authenticator step-up (`session.confirm`) writes.
		member.sessionRow(member.token).strongFactor = "totp";
		const register = await member.request("/passkey/generate-register-options");
		expect(register.status).toBe(200);
	});

	it("leaves first enrollment open, and fails closed when the org lookup fails", async () => {
		const unenrolled = await fixture({ mfaRequiredOrganization: true });
		const first = await unenrolled.request(
			"/passkey/generate-register-options"
		);
		expect(first.status).toBe(200);

		const unknown = await fixture({
			mfaRequiredOrganization: new Error("settings unavailable"),
		});
		unknown.addPasskey("pk-unknown");
		const refused = await unknown.request("/passkey/generate-register-options");
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe("org_mfa_session_required");
	});

	it("lets a member outside such orgs add a factor from any session", async () => {
		const member = await fixture({ mfaRequiredOrganization: false });
		member.addPasskey("pk-free");
		const register = await member.request("/passkey/generate-register-options");
		expect(register.status).toBe(200);
	});

	it("leaves ordinary members' password sessions alone", async () => {
		const member = await fixture();
		member.addPasskey("pk-member");
		expect((await member.request("/token")).status).toBe(200);
		const status = await member.request("/mfa-enrollment/status");
		expect(await status.json()).toMatchObject({
			required: false,
			sessionFactorRequired: false,
		});
	});

	const runDeviceFlow = async (
		staff: Awaited<ReturnType<typeof fixture>>
	): Promise<{ approve: Response; token: string | null }> => {
		const code = await staff.request("/device/code", {
			body: { client_id: "ryu-desktop" },
			cookie: "",
		});
		const { device_code: deviceCode, user_code: userCode } = z
			.object({ device_code: z.string(), user_code: z.string() })
			.parse(await code.json());
		await staff.request(`/device?user_code=${encodeURIComponent(userCode)}`);
		const approve = await staff.request("/device/approve", {
			body: { userCode },
		});
		if (approve.status !== 200) {
			return { approve, token: null };
		}
		const issued = await staff.request("/device/token", {
			body: {
				client_id: "ryu-desktop",
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			},
			cookie: "",
		});
		const { access_token: token } = z
			.object({ access_token: z.string() })
			.parse(await issued.json());
		return { approve, token };
	};

	it("lets only a strongly signed-in staff session approve a device, and stamps the device session", async () => {
		const staff = await fixture({ initialRole: "admin" });
		staff.addPasskey("pk-staff");

		const weak = await runDeviceFlow(staff);
		expect(weak.approve.status).toBe(403);
		expect(await codeOf(weak.approve)).toBe("staff_session_factor_required");

		staff.sessionRow(staff.token).strongFactor = "passkey";
		const strong = await runDeviceFlow(staff);
		expect(strong.approve.status).toBe(200);
		expect(strong.token).not.toBeNull();
		const deviceToken = strong.token ?? "";
		expect(staff.sessionRow(deviceToken).strongFactor).toBe("delegated");
		expect((await staff.request("/token", { token: deviceToken })).status).toBe(
			200
		);
	});

	it("does not stamp a member's device session, so a later promotion is not grandfathered", async () => {
		const member = await fixture();
		member.addPasskey("pk-member");
		const { approve, token } = await runDeviceFlow(member);
		expect(approve.status).toBe(200);
		expect(member.sessionRow(token ?? "").strongFactor).toBeUndefined();
	});

	it("stamps a member's device session approved from a strongly signed-in session, once", async () => {
		const member = await fixture();
		member.addPasskey("pk-member");
		// What a passkey sign-in (or an authenticator step-up) writes.
		member.sessionRow(member.token).strongFactor = "passkey";
		const { approve, token } = await runDeviceFlow(member);
		expect(approve.status).toBe(200);
		expect(member.sessionRow(token ?? "").strongFactor).toBe("delegated");
		// The approval proof is single-use and never stores the raw device code.
		expect(
			member.database.verification?.filter((row) =>
				String(row.identifier).startsWith("ryu-device-strong-approval:")
			)
		).toHaveLength(0);
	});
});
