import { afterEach, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import {
	type DeviceLimitContext,
	deviceTokenPreCheck,
	rememberGrantSurface,
	stampDeviceLimitSession,
	takeGrantSurface,
} from "./device-limit-plugin.ts";
import {
	type DeviceLimitPolicy,
	registerDeviceLimitPolicyResolver,
} from "./device-limit-policy.ts";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_LIMIT_REACHED_CODE,
	DEVICE_LIMIT_REACHED_ERROR,
	type DeviceSurface,
	deviceLimitReachedMessage,
} from "./device-limits.ts";
import { ryuClientSessionPlugin } from "./ryu-client-session.ts";

const BASE_URL = "http://localhost:3000";
const ALLOWED_CLIENTS = ["ryu-desktop", "ryu-cli", "ryu-mcp", "ryu-extension"];
const PASSWORD = "Device-limit-password-2026!";
const EMAIL = "limits@example.com";

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
		deviceCode: [],
		session: [],
		user: [],
		verification: [],
	};
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		secret: "device-limit-plugin-regression-secret-2026",
		plugins: [
			bearer(),
			deviceAuthorization({
				verificationUri: `${BASE_URL}/device`,
				validateClient: (clientId) => ALLOWED_CLIENTS.includes(clientId),
			}),
			ryuClientSessionPlugin(),
		],
	});
	const signup = await auth.api.signUpEmail({
		asResponse: true,
		body: { email: EMAIL, name: "Limits owner", password: PASSWORD },
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

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

async function startGrant(setup: Fixture, clientId: string, scope = "openid") {
	const start = await setup.auth.handler(
		postJson("/device/code", { client_id: clientId, scope })
	);
	return (await start.json()) as { device_code: string; user_code: string };
}

async function claim(setup: Fixture, userCode: string): Promise<void> {
	const response = await setup.auth.handler(
		new Request(
			`${BASE_URL}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
			{ headers: { cookie: setup.cookie, origin: BASE_URL } }
		)
	);
	requireOk(response, "claim");
}

function requireOk(response: Response, step: string): void {
	if (response.status !== 200) {
		throw new Error(`Device ${step} failed with status ${response.status}`);
	}
}

function approve(setup: Fixture, userCode: string): Promise<Response> {
	return setup.auth.handler(
		postJson("/device/approve", { userCode }, { cookie: setup.cookie })
	);
}

function redeem(
	setup: Fixture,
	clientId: string,
	deviceCode: string,
	headers: HeadersInit = {}
): Promise<Response> {
	return setup.auth.handler(
		postJson(
			"/device/token",
			{
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			},
			headers
		)
	);
}

/** Run a whole device grant and return the token response. */
async function deviceFlow(
	setup: Fixture,
	clientId: string,
	scope = "openid",
	tokenHeaders: HeadersInit = {}
): Promise<Response> {
	const grant = await startGrant(setup, clientId, scope);
	await claim(setup, grant.user_code);
	requireOk(await approve(setup, grant.user_code), "approve");
	return redeem(setup, clientId, grant.device_code, tokenHeaders);
}

function surfaces(setup: Fixture): unknown[] {
	return setup.db.session?.map((row) => row.surface) ?? [];
}

/** Status and body of a response, for one `toMatchObject` against a refusal. */
async function summary(
	response: Response
): Promise<{ body: unknown; status: number }> {
	return { body: await response.json(), status: response.status };
}

function refusal(surface: DeviceSurface, limit: number) {
	const message = deviceLimitReachedMessage(surface, limit);
	return {
		body: {
			code: DEVICE_LIMIT_REACHED_CODE,
			error: DEVICE_LIMIT_REACHED_ERROR,
			error_description: message,
			limit,
			message,
			surface,
		},
		status: 403,
	};
}

describe("device limit session stamping", () => {
	test("stamps every new session with its surface, flag off", async () => {
		const setup = await fixture();
		expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		expect((await deviceFlow(setup, "ryu-extension")).status).toBe(200);
		expect(
			(await deviceFlow(setup, "ryu-desktop", "openid ryu:surface:desktop"))
				.status
		).toBe(200);
		expect(
			(await deviceFlow(setup, "ryu-desktop", "openid", { origin: "" })).status
		).toBe(200);
		expect(surfaces(setup)).toEqual([
			"web",
			"cli",
			"extension",
			"desktop",
			"self_hosted",
		]);
	});

	test("never refuses while the flag is off", async () => {
		const setup = await fixture();
		registerDeviceLimitPolicyResolver(async () => ({
			enforced: false,
			limits: { ...DEVICE_LIMIT_DEFAULTS, cli: 0 },
		}));
		for (let index = 0; index < 3; index += 1) {
			expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		}
	});

	test("a failing policy lookup allows the sign-in", async () => {
		const setup = await fixture();
		registerDeviceLimitPolicyResolver(() =>
			Promise.reject(new Error("flags down"))
		);
		const original = console.error;
		console.error = () => undefined;
		try {
			expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		} finally {
			console.error = original;
		}
	});
});

describe("device limit enforcement", () => {
	test("refuses a browser sign-in over the web cap", async () => {
		const setup = await fixture();
		enforce({ web: 1 });
		const signIn = await setup.auth.handler(
			postJson("/sign-in/email", { email: EMAIL, password: PASSWORD })
		);
		expect(await summary(signIn)).toMatchObject(refusal("web", 1));
		expect(setup.db.session).toHaveLength(1);
	});

	test("/device/approve refuses before approving the grant", async () => {
		const setup = await fixture();
		enforce({ cli: 1 });
		expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		const grant = await startGrant(setup, "ryu-mcp");
		await claim(setup, grant.user_code);
		expect(await summary(await approve(setup, grant.user_code))).toMatchObject(
			refusal("cli", 1)
		);
		const row = setup.db.deviceCode?.find(
			(entry) => entry.deviceCode === grant.device_code
		);
		expect(row?.status).toBe("pending");
	});

	test("/device/approve classifies a declared desktop grant", async () => {
		const setup = await fixture();
		enforce({ desktop: 0 });
		const grant = await startGrant(
			setup,
			"ryu-desktop",
			"openid ryu:surface:desktop"
		);
		await claim(setup, grant.user_code);
		expect(await summary(await approve(setup, grant.user_code))).toMatchObject(
			refusal("desktop", 0)
		);
	});

	test("/device/token refuses without consuming the device code", async () => {
		const setup = await fixture();
		expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		const grant = await startGrant(setup, "ryu-cli");
		await claim(setup, grant.user_code);
		expect((await approve(setup, grant.user_code)).status).toBe(200);
		enforce({ cli: 1 });
		expect(
			await summary(await redeem(setup, "ryu-cli", grant.device_code))
		).toMatchObject(refusal("cli", 1));
		const row = setup.db.deviceCode?.find(
			(entry) => entry.deviceCode === grant.device_code
		);
		expect(row?.status).toBe("approved");
		// Once the cap is lifted the same device code still redeems.
		registerDeviceLimitPolicyResolver(null);
		expect((await redeem(setup, "ryu-cli", grant.device_code)).status).toBe(
			200
		);
		expect(surfaces(setup)).toEqual(["web", "cli", "cli"]);
	});

	test("other surfaces are not blocked by a full one", async () => {
		const setup = await fixture();
		enforce({ cli: 1 });
		expect((await deviceFlow(setup, "ryu-cli")).status).toBe(200);
		expect((await deviceFlow(setup, "ryu-extension")).status).toBe(200);
	});
});

const LIVE = () => new Date(Date.now() + 60_000);

function fakeContext(input: {
	anonymous?: boolean;
	sessions: Row[];
	deviceCodes?: Row[];
}): DeviceLimitContext {
	return {
		context: {
			adapter: {
				findMany: <T>() => Promise.resolve(input.sessions as T[]),
				findOne: <T>(query: { where: { field: string; value: string }[] }) => {
					const [clause] = query.where;
					const row = (input.deviceCodes ?? []).find(
						(entry) => clause && entry[clause.field] === clause.value
					);
					return Promise.resolve((row ?? null) as T | null);
				},
			},
			internalAdapter: {
				findUserById: (id: string) =>
					Promise.resolve({ id, isAnonymous: input.anonymous === true }),
			},
		},
		headers: new Headers({ origin: BASE_URL }),
		path: "/sign-in/email",
	};
}

const atCapPolicy = (): Promise<DeviceLimitPolicy> =>
	Promise.resolve({
		enforced: true,
		limits: { ...DEVICE_LIMIT_DEFAULTS, web: 1 },
	});

describe("device limit exemptions", () => {
	const fullWeb = [{ expiresAt: LIVE(), surface: "web" }];

	test("refuses an ordinary sign-in at the cap", async () => {
		const ctx = fakeContext({ sessions: fullWeb });
		await expect(
			stampDeviceLimitSession({ userId: "user-1" }, ctx, null, atCapPolicy)
		).rejects.toMatchObject({ body: { code: DEVICE_LIMIT_REACHED_CODE } });
	});

	test("an impersonated session is stamped but never refused", async () => {
		const ctx = fakeContext({ sessions: fullWeb });
		const data = await stampDeviceLimitSession(
			{ impersonatedBy: "support-1", userId: "user-1" },
			ctx,
			null,
			atCapPolicy
		);
		expect(data.surface).toBe("web");
	});

	test("an anonymous guest is never refused", async () => {
		const ctx = fakeContext({ anonymous: true, sessions: fullWeb });
		const data = await stampDeviceLimitSession(
			{ userId: "guest-1" },
			ctx,
			null,
			atCapPolicy
		);
		expect(data.surface).toBe("web");
	});

	test("a write without a request context is stamped, not refused", async () => {
		const data = await stampDeviceLimitSession(
			{ userId: "user-1" },
			null,
			null,
			atCapPolicy
		);
		expect(data.surface).toBe("web");
	});

	test("/device/token hands its surface to the session hook once", async () => {
		const ctx: DeviceLimitContext = {
			...fakeContext({
				deviceCodes: [
					{
						clientId: "ryu-desktop",
						deviceCode: "device-code-1",
						expiresAt: LIVE(),
						scope: "openid ryu:surface:desktop",
						status: "approved",
						userId: "user-1",
					},
				],
				sessions: [],
			}),
			body: { client_id: "ryu-desktop", device_code: "device-code-1" },
			headers: new Headers(),
			path: "/device/token",
		};
		await deviceTokenPreCheck(ctx, { lookupPolicy: atCapPolicy });
		const data = await stampDeviceLimitSession(
			{ userId: "user-1" },
			ctx,
			"ryu-desktop",
			atCapPolicy
		);
		expect(data.surface).toBe("desktop");
		expect(takeGrantSurface("device-code-1")).toBeNull();
	});

	test("remembered surfaces expire", () => {
		rememberGrantSurface("device-code-2", "cli", 0);
		expect(takeGrantSurface("device-code-2", 10 * 60_000)).toBeNull();
	});
});
