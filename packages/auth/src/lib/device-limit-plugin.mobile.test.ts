/**
 * A mobile or CLI sign-in routed through a Core node counts as mobile or CLI.
 *
 * The Ryu mobile app has no device flow of its own: its Core node runs the
 * `ryu-desktop` grant (no Origin, no declared scope), and the app opens the
 * approval link with `surface=mobile`. The approving owner's `/device/approve`
 * request carries that declaration; these tests run the whole grant through
 * real Better Auth and assert where the session lands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { registerDeviceLimitPolicyResolver } from "./device-limit-policy.ts";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_LIMIT_REACHED_CODE,
	type DeviceSurface,
} from "./device-limits.ts";
import { ryuClientSessionPlugin } from "./ryu-client-session.ts";

const BASE_URL = "http://localhost:3000";
const CORE_SCOPE = "openid profile email";

type Row = Record<string, unknown>;

afterEach(() => {
	registerDeviceLimitPolicyResolver(null);
});

function enforce(limits: Partial<Record<DeviceSurface, number>>): void {
	registerDeviceLimitPolicyResolver(async () => ({
		enforced: true,
		limits: { ...DEVICE_LIMIT_DEFAULTS, ...limits },
	}));
}

function post(path: string, body: unknown, headers: Record<string, string>) {
	return new Request(`${BASE_URL}/api/auth${path}`, {
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json", ...headers },
		method: "POST",
	});
}

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
		// Generated per run: no credential-shaped literal lives in the source.
		secret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
		plugins: [
			bearer(),
			deviceAuthorization({
				verificationUri: `${BASE_URL}/device`,
				validateClient: (clientId) =>
					["ryu-desktop", "ryu-extension"].includes(clientId),
			}),
			ryuClientSessionPlugin(),
		],
	});
	const signup = await auth.api.signUpEmail({
		asResponse: true,
		body: {
			email: "mobile@example.com",
			name: "Mobile owner",
			password: `Aa1!${crypto.randomUUID()}`,
		},
	});
	const cookie = signup.headers
		.getSetCookie()
		.map((value) => value.split(";", 1).join(""))
		.join("; ");
	const browser = { cookie, origin: BASE_URL };

	/** Start, claim, and approve a grant; returns the approve response. */
	async function approveGrant(
		clientId: string,
		scope: string,
		approveBody: Record<string, unknown>
	) {
		const start = await auth.handler(
			post("/device/code", { client_id: clientId, scope }, {})
		);
		const grant = (await start.json()) as {
			device_code: string;
			user_code: string;
		};
		await auth.handler(
			new Request(`${BASE_URL}/api/auth/device?user_code=${grant.user_code}`, {
				headers: browser,
			})
		);
		const approved = await auth.handler(
			post(
				"/device/approve",
				{ userCode: grant.user_code, ...approveBody },
				browser
			)
		);
		return { approved, grant };
	}

	/** Redeem as a Core runtime would: no Origin header. */
	function redeem(clientId: string, deviceCode: string) {
		return auth.handler(
			post(
				"/device/token",
				{
					client_id: clientId,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				},
				{}
			)
		);
	}

	function newestSurface(): unknown {
		return db.session?.at(-1)?.surface;
	}

	return { approveGrant, db, newestSurface, redeem };
}

describe("mobile sign-ins through a Core node", () => {
	test("an approval declaring mobile stamps the Core session as mobile", async () => {
		const setup = await fixture();
		const { approved, grant } = await setup.approveGrant(
			"ryu-desktop",
			CORE_SCOPE,
			{ surface: "mobile" }
		);
		expect(approved.status).toBe(200);
		expect(setup.db.deviceCode?.[0]?.scope).toBe(
			`${CORE_SCOPE} ryu:surface:mobile`
		);
		expect((await setup.redeem("ryu-desktop", grant.device_code)).status).toBe(
			200
		);
		expect(setup.newestSurface()).toBe("mobile");
	});

	test("without the declaration the Core session stays self-hosted", async () => {
		const setup = await fixture();
		const { grant } = await setup.approveGrant("ryu-desktop", CORE_SCOPE, {});
		await setup.redeem("ryu-desktop", grant.device_code);
		expect(setup.newestSurface()).toBe("self_hosted");
	});

	test("a grant that already declares Desktop is not relabelled", async () => {
		const setup = await fixture();
		const { grant } = await setup.approveGrant(
			"ryu-desktop",
			"openid ryu:surface:desktop",
			{ surface: "mobile" }
		);
		expect(setup.db.deviceCode?.[0]?.scope).toBe("openid ryu:surface:desktop");
		await setup.redeem("ryu-desktop", grant.device_code);
		expect(setup.newestSurface()).toBe("desktop");
	});

	test("only mobile or CLI can be declared, and only for a Core grant", async () => {
		const setup = await fixture();
		const web = await setup.approveGrant("ryu-desktop", CORE_SCOPE, {
			surface: "web",
		});
		await setup.redeem("ryu-desktop", web.grant.device_code);
		expect(setup.newestSurface()).toBe("self_hosted");

		const extension = await setup.approveGrant("ryu-extension", "openid", {
			surface: "mobile",
		});
		await setup.redeem("ryu-extension", extension.grant.device_code);
		expect(setup.newestSurface()).toBe("extension");
	});

	test("a full mobile cap refuses the approval without recording it", async () => {
		const setup = await fixture();
		const first = await setup.approveGrant("ryu-desktop", CORE_SCOPE, {
			surface: "mobile",
		});
		await setup.redeem("ryu-desktop", first.grant.device_code);
		enforce({ mobile: 1 });

		const second = await setup.approveGrant("ryu-desktop", CORE_SCOPE, {
			surface: "mobile",
		});
		expect(second.approved.status).toBe(403);
		expect(await second.approved.json()).toMatchObject({
			code: DEVICE_LIMIT_REACHED_CODE,
			limit: 1,
			surface: "mobile",
		});
		expect(setup.db.deviceCode?.at(-1)).toMatchObject({
			scope: CORE_SCOPE,
			status: "pending",
		});
	});
});

describe("CLI sign-ins through a Core node", () => {
	test("an approval declaring CLI stamps the Core session as CLI", async () => {
		const setup = await fixture();
		const { approved, grant } = await setup.approveGrant(
			"ryu-desktop",
			CORE_SCOPE,
			{ surface: "cli" }
		);
		expect(approved.status).toBe(200);
		expect(setup.db.deviceCode?.[0]?.scope).toBe(
			`${CORE_SCOPE} ryu:surface:cli`
		);
		expect((await setup.redeem("ryu-desktop", grant.device_code)).status).toBe(
			200
		);
		expect(setup.newestSurface()).toBe("cli");
	});

	test("a full CLI cap refuses the approval against the CLI cap", async () => {
		const setup = await fixture();
		enforce({ cli: 0 });
		const { approved } = await setup.approveGrant("ryu-desktop", CORE_SCOPE, {
			surface: "cli",
		});
		expect(approved.status).toBe(403);
		expect(await approved.json()).toMatchObject({
			code: DEVICE_LIMIT_REACHED_CODE,
			limit: 0,
			surface: "cli",
		});
		expect(setup.db.deviceCode?.[0]?.scope).toBe(CORE_SCOPE);
	});
});
