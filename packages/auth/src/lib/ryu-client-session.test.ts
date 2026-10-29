import { describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import {
	deviceGrantClientId,
	ryuAgentSessionRefusal,
	ryuClientSessionPlugin,
	sessionIssuedClientId,
	sessionIssuedToRyuAgentClient,
} from "./ryu-client-session.ts";

const BASE_URL = "http://localhost:3000";
const ALLOWED_CLIENTS = ["ryu-desktop", "ryu-cli", "ryu-mcp", "ryu-extension"];

async function fixture() {
	const auth = betterAuth({
		baseURL: BASE_URL,
		database: memoryAdapter({
			account: [],
			deviceCode: [],
			session: [],
			user: [],
			verification: [],
		}),
		emailAndPassword: { enabled: true },
		secret: "ryu-client-session-regression-secret-2026",
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
		body: {
			email: "agent@example.com",
			name: "Agent owner",
			password: "Agent-owner-password-2026!",
		},
	});
	if (signup.status !== 200) {
		throw new Error(`Sign-up failed with status ${signup.status}`);
	}
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";", 1).join(""))
		.join("; ");
	return { auth, browserHeaders: new Headers({ cookie }) };
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

function requireOk(response: Response, step: string): void {
	if (response.status !== 200) {
		throw new Error(`Device ${step} failed with status ${response.status}`);
	}
}

/** Claim the user code as the signed-in browser, then approve it. */
async function approveDeviceCode(
	{ auth, browserHeaders }: Fixture,
	userCode: string
): Promise<void> {
	const cookie = browserHeaders.get("cookie") ?? "";
	const claim = await auth.handler(
		new Request(
			`${BASE_URL}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
			{ headers: { cookie, origin: BASE_URL } }
		)
	);
	requireOk(claim, "claim");
	const approve = await auth.handler(
		postJson("/device/approve", { userCode }, { cookie })
	);
	requireOk(approve, "approve");
}

/** Run the device grant end to end and return the issued bearer token. */
async function deviceFlowToken(
	setup: Fixture,
	clientId: string,
	tokenHeaders: HeadersInit = {}
): Promise<string> {
	const start = await setup.auth.handler(
		postJson("/device/code", { client_id: clientId, scope: "openid" })
	);
	const { device_code: deviceCode, user_code: userCode } =
		(await start.json()) as { device_code: string; user_code: string };
	await approveDeviceCode(setup, userCode);
	const token = await setup.auth.handler(
		postJson(
			"/device/token",
			{
				client_id: clientId,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			},
			tokenHeaders
		)
	);
	requireOk(token, "token");
	const { access_token: accessToken } = (await token.json()) as {
		access_token: string;
	};
	return accessToken;
}

async function sessionFor(auth: Fixture["auth"], headers: Headers) {
	const result = await auth.api.getSession({ headers });
	if (!result) {
		throw new Error("Expected a session");
	}
	return result.session;
}

describe("ryu client session marker", () => {
	test("a device-flow session records the client its grant was issued to", async () => {
		const setup = await fixture();
		const token = await deviceFlowToken(setup, "ryu-cli");
		const session = await sessionFor(
			setup.auth,
			new Headers({ authorization: `Bearer ${token}` })
		);
		expect(sessionIssuedClientId(session)).toBe("ryu-cli");
		expect(sessionIssuedToRyuAgentClient(session)).toBe(true);
	});

	test("a browser sign-in session stays unmarked", async () => {
		const setup = await fixture();
		const session = await sessionFor(setup.auth, setup.browserHeaders);
		expect(sessionIssuedClientId(session)).toBeNull();
		expect(sessionIssuedToRyuAgentClient(session)).toBe(false);
	});

	test("a non-agent device client is recorded but is not a Ryu agent", async () => {
		const setup = await fixture();
		const token = await deviceFlowToken(setup, "ryu-extension");
		const session = await sessionFor(
			setup.auth,
			new Headers({ authorization: `Bearer ${token}` })
		);
		expect(sessionIssuedClientId(session)).toBe("ryu-extension");
		expect(sessionIssuedToRyuAgentClient(session)).toBe(false);
	});

	test("request headers cannot assert the client id", async () => {
		const setup = await fixture();
		const token = await deviceFlowToken(setup, "ryu-extension", {
			"x-client-id": "ryu-desktop",
			"x-ryu-client": "ryu-desktop",
		});
		const session = await sessionFor(
			setup.auth,
			new Headers({ authorization: `Bearer ${token}` })
		);
		expect(sessionIssuedClientId(session)).toBe("ryu-extension");
	});

	test("a token request naming a different client than the grant is refused", async () => {
		const setup = await fixture();
		const start = await setup.auth.handler(
			postJson("/device/code", { client_id: "ryu-extension" })
		);
		const { device_code: deviceCode, user_code: userCode } =
			(await start.json()) as { device_code: string; user_code: string };
		await approveDeviceCode(setup, userCode);
		const token = await setup.auth.handler(
			postJson("/device/token", {
				client_id: "ryu-desktop",
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			})
		);
		expect(token.status).toBe(400);
	});
});

describe("deviceGrantClientId", () => {
	test("only the device token endpoint yields a client id", () => {
		const body = { client_id: "ryu-desktop" };
		expect(deviceGrantClientId({ body, path: "/device/token" })).toBe(
			"ryu-desktop"
		);
		expect(deviceGrantClientId({ body, path: "/sign-in/email" })).toBeNull();
		expect(deviceGrantClientId({ body, path: "/device/session" })).toBeNull();
		expect(deviceGrantClientId(null)).toBeNull();
		expect(
			deviceGrantClientId({ body: { client_id: 7 }, path: "/device/token" })
		).toBeNull();
	});

	test("only Ryu agent clients count as agent sessions", () => {
		expect(sessionIssuedToRyuAgentClient({ issuedClientId: "ryu-mcp" })).toBe(
			true
		);
		expect(sessionIssuedToRyuAgentClient({ issuedClientId: "ryu-web" })).toBe(
			false
		);
		expect(sessionIssuedToRyuAgentClient({ issuedClientId: "" })).toBe(false);
		expect(sessionIssuedToRyuAgentClient(null)).toBe(false);
	});

	test("refusals tell an unstamped bearer session to sign in again", () => {
		const bearer = { bearer: true };
		const cookie = { bearer: false };
		expect(
			ryuAgentSessionRefusal({ issuedClientId: "ryu-desktop" }, bearer)
		).toBeNull();
		expect(
			ryuAgentSessionRefusal({ issuedClientId: "ryu-cli" }, cookie)
		).toBeNull();
		expect(ryuAgentSessionRefusal({}, bearer)).toBe("unstamped_bearer");
		expect(ryuAgentSessionRefusal({}, cookie)).toBe("not_agent_client");
		expect(
			ryuAgentSessionRefusal({ issuedClientId: "ryu-extension" }, bearer)
		).toBe("not_agent_client");
	});
});
