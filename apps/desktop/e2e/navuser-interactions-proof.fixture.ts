import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { parseProofJson } from "./fixture-json.ts";
import {
	DESKTOP_SECRET_RECORD_KEY,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	parseAuthVaultSlot,
} from "./harness/desktop-secret-slots.ts";

export const PROOF_URL = "/navuser-interactions-proof.html";
export const ORIGIN = "http://127.0.0.1:5431";
export const FRONTEND = "http://localhost:3001";
export const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export interface ApiCall {
	authorization: string | null;
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
	status: number;
}

export interface RouteFixture {
	calls: ApiCall[];
	externalRequests: string[];
	failNext: (method: string, path: string, count?: number) => void;
	releaseSession: () => void;
}

export interface AccountVault {
	accounts: Array<{
		email: string;
		isAnonymous?: boolean;
		name: string;
		userId: string;
	}>;
	activeUserId: string | null;
	token: string | null;
}

export function parseJson(raw: string | null) {
	if (!raw) {
		return null;
	}
	try {
		return parseProofJson(raw);
	} catch {
		return null;
	}
}

export async function seedAuthVault(page: Page) {
	await page.addInitScript(() => {
		// The first load of each tab migrates this plaintext vault into that
		// tab's sealed slot (sessionStorage) and purges it, so the seed guard is
		// per tab too: a second tab seeds and migrates its own vault.
		if (sessionStorage.getItem("navuser-proof-seeded") === "true") {
			return;
		}
		const accounts = [
			{
				email: "ada@example.test",
				image: null,
				isAnonymous: false,
				name: "Ada Lovelace",
				token: "navuser-token-ada",
				userId: "navuser-user-ada",
			},
			{
				email: "grace@example.test",
				image: null,
				isAnonymous: false,
				name: "Grace Hopper",
				token: "navuser-token-grace",
				userId: "navuser-user-grace",
			},
		];
		localStorage.setItem("ryu_accounts", JSON.stringify(accounts));
		localStorage.setItem("ryu_active_user_id", "navuser-user-ada");
		localStorage.setItem("ryu_session_token", "navuser-token-ada");
		localStorage.setItem("ryu_oidc_user", "");
		sessionStorage.setItem("navuser-proof-seeded", "true");
	});
}

export async function installApiFixture(
	page: Page,
	options: { holdSession?: boolean } = {}
): Promise<RouteFixture> {
	const calls: ApiCall[] = [];
	const externalRequests: string[] = [];
	const failures = new Map<string, number>();
	let sessionGateOpen = !options.holdSession;
	let releaseSessionGate: () => void = () => undefined;
	const sessionGate = new Promise<void>((resolve) => {
		releaseSessionGate = resolve;
	});
	let sessionCallCount = 0;
	let devicePollCount = 0;

	const fixture: RouteFixture = {
		calls,
		externalRequests,
		failNext: (method, urlPath, count = 1) => {
			failures.set(`${method.toUpperCase()} ${urlPath}`, count);
		},
		releaseSession: () => {
			sessionGateOpen = true;
			releaseSessionGate();
		},
	};

	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.origin !== ORIGIN) {
			externalRequests.push(url.toString());
			await route.abort();
			return;
		}
		if (!url.pathname.startsWith("/api/")) {
			await route.continue();
			return;
		}

		const method = request.method().toUpperCase();
		const headers = request.headers();
		const body = parseJson(request.postData());
		const apiPath = url.pathname + url.search;
		const statusResponse = async <FixturePayload>(
			status: number,
			value: FixturePayload
		) => {
			calls.push({
				authorization: headers.authorization ?? null,
				body,
				headers,
				method,
				path: apiPath,
				status,
			});
			await route.fulfill({
				body: JSON.stringify(value),
				contentType: "application/json",
				status,
			});
		};

		const failureKey = `${method} ${url.pathname}`;
		const plannedFailures = failures.get(failureKey) ?? 0;
		if (plannedFailures > 0) {
			failures.set(failureKey, plannedFailures - 1);
			await statusResponse(503, { error: "fixture_temporarily_unavailable" });
			return;
		}

		if (url.pathname === "/api/auth/get-session" && method === "GET") {
			sessionCallCount += 1;
			if (!sessionGateOpen && sessionCallCount === 1) {
				await sessionGate;
			}
			const token = headers.authorization?.replace(/^Bearer\s+/u, "") ?? "";
			const profile = tokenProfile(token);
			await statusResponse(
				200,
				profile
					? {
							session: {
								createdAt: "2026-09-01T00:00:00.000Z",
								expiresAt: "2027-09-01T00:00:00.000Z",
								id: `session-${profile.id}`,
								updatedAt: "2026-09-01T00:00:00.000Z",
								userId: profile.id,
							},
							user: {
								createdAt: "2026-09-01T00:00:00.000Z",
								email: profile.email,
								emailVerified: true,
								id: profile.id,
								image: null,
								name: profile.name,
								updatedAt: "2026-09-01T00:00:00.000Z",
							},
						}
					: { session: null, user: null }
			);
			return;
		}
		if (url.pathname === "/api/auth/device/code" && method === "POST") {
			await statusResponse(200, {
				device_code: "navuser-device-code",
				expires_in: 90,
				interval: 5,
				user_code: "F1XT-URE",
				verification_uri: "https://www.ryuhq.com/device",
				verification_uri_complete:
					"https://www.ryuhq.com/device?user_code=F1XT-URE",
			});
			return;
		}
		if (url.pathname === "/api/auth/device/token" && method === "POST") {
			devicePollCount += 1;
			await statusResponse(
				200,
				devicePollCount === 1
					? { access_token: "navuser-device-token" }
					: { error: "authorization_pending" }
			);
			return;
		}
		if (url.pathname === "/api/step-up/status" && method === "GET") {
			// The billing scope's status as the API serves it: an open window.
			await statusResponse(200, {
				action: "complete this billing action",
				enrolmentRequired: false,
				methods: ["otp"],
				passwordAvailable: false,
				satisfied: true,
				scope: "billing",
				twoFactorEnabled: false,
				windowMs: 5 * 60_000,
			});
			return;
		}
		if (
			url.pathname === "/api/billing/subscription-status" &&
			method === "GET"
		) {
			await statusResponse(200, {
				lifetime: null,
				subscription: {
					currentPeriodEnd: "2026-12-31T00:00:00.000Z",
					id: "navuser-subscription-fixture",
					interval: "month",
					status: "active",
				},
			});
			return;
		}
		if (
			url.pathname === "/api/billing/checkout/lifetime" &&
			method === "POST"
		) {
			await statusResponse(200, {
				url: "https://checkout.fixture.test/lifetime?session=navuser",
			});
			return;
		}
		if (url.pathname === "/api/plugins/contributions" && method === "GET") {
			const inboxEnabled =
				new URL(page.url()).searchParams.get("inbox") !== "off";
			await statusResponse(200, {
				companions: inboxEnabled
					? [
							{
								approved_grants: [],
								has_ui: true,
								id: "app__approvals-companion",
								label: "Inbox",
								name: "Approvals",
								plugin_id: "com.ryu.approvals",
							},
						]
					: [],
				create_actions: [],
				sidebar_buttons: [],
			});
			return;
		}
		if (url.pathname === "/api/agents" && method === "GET") {
			await statusResponse(200, { agents: [] });
			return;
		}
		if (url.pathname === "/api/engines" && method === "GET") {
			await statusResponse(200, { engines: [] });
			return;
		}
		if (url.pathname === "/api/engine/active" && method === "GET") {
			await statusResponse(200, {
				active: null,
				available: [],
				running: false,
			});
			return;
		}
		if (url.pathname === "/api/teams" && method === "GET") {
			await statusResponse(200, { teams: [] });
			return;
		}
		if (url.pathname === "/api/health" && method === "GET") {
			await statusResponse(200, { status: "ok", version: "1.2.3" });
			return;
		}
		if (url.pathname === "/api/system/status" && method === "GET") {
			await statusResponse(200, {
				engine: { active: null, running: false },
				gateway: { reachable: true },
			});
			return;
		}
		if (url.pathname === "/api/preferences/agent-auto-routing") {
			await statusResponse(404, { error: "preference_not_found" });
			return;
		}
		await statusResponse(200, {});
	});

	return fixture;
}

export function tokenProfile(token: string) {
	if (token === "navuser-token-ada") {
		return {
			email: "ada@example.test",
			id: "navuser-user-ada",
			name: "Ada Lovelace",
		};
	}
	if (token === "navuser-token-grace") {
		return {
			email: "grace@example.test",
			id: "navuser-user-grace",
			name: "Grace Hopper",
		};
	}
	if (token === "navuser-device-token") {
		return {
			email: "katherine@example.test",
			id: "navuser-user-katherine",
			name: "Katherine Johnson",
		};
	}
	return null;
}

export async function openNavMenu(page: Page, name = "Ada Lovelace") {
	const trigger = page.getByRole("button", { name: new RegExp(`^${name}`) });
	await trigger.click();
	await expect(page.getByRole("menu").last()).toBeVisible();
	return trigger;
}

export function userNavButton(page: Page, name: string) {
	return page.getByRole("button", { name: new RegExp(`^${name}`) });
}

export async function openAccountSubmenu(page: Page, name = "Ada Lovelace") {
	await page.getByRole("menuitem", { name }).click();
	await expect(page.getByRole("menu").last()).toBeVisible();
}

export async function externalUrls(page: Page): Promise<string[]> {
	return page.evaluate(() => window.__NAVUSER_PROOF__?.externalUrls ?? []);
}

/**
 * The vault sealed in the `auth-vault` slot the runtime keeps in sessionStorage
 * (an empty slot reads as signed out). The seeded plaintext vault migrates into
 * the slot on first load, so no plaintext copy may remain in localStorage.
 */
export async function accountVault(page: Page): Promise<AccountVault> {
	const { legacy, record } = await page.evaluate(
		({ keys, recordKey }) => ({
			legacy: keys.map((key) => localStorage.getItem(key)),
			record: sessionStorage.getItem(recordKey),
		}),
		{
			keys: [...LEGACY_VAULT_LOCAL_STORAGE_KEYS],
			recordKey: DESKTOP_SECRET_RECORD_KEY,
		}
	);
	expect(legacy).toEqual([null, null, null]);
	const sealed = parseAuthVaultSlot(record);
	return z
		.object({
			accounts: z.array(
				z.object({
					email: z.string(),
					name: z.string(),
					userId: z.string(),
					isAnonymous: z.boolean().optional(),
				})
			),
			activeUserId: z.string().nullable(),
			token: z.string().nullable(),
		})
		.parse({
			accounts: sealed?.accounts ?? [],
			activeUserId: sealed?.activeUserId ?? null,
			token: sealed?.activeToken ?? null,
		});
}

export async function saveEvidence(page: Page, name: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, `${name}.png`),
	});
}
