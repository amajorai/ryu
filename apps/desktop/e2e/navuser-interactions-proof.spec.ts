import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { parseProofJson } from "./fixture-json.ts";
import {
	DESKTOP_SECRET_RECORD_KEY,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	parseAuthVaultSlot,
} from "./harness/desktop-secret-slots.ts";

const PROOF_URL = "/navuser-interactions-proof.html";
const ORIGIN = "http://127.0.0.1:5431";
const FRONTEND = "http://localhost:3001";
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ApiCall {
	authorization: string | null;
	body: unknown;
	headers: Record<string, string>;
	method: string;
	path: string;
	status: number;
}

interface RouteFixture {
	calls: ApiCall[];
	externalRequests: string[];
	failNext: (method: string, path: string, count?: number) => void;
	releaseSession: () => void;
}

interface AccountVault {
	accounts: Array<{
		email: string;
		isAnonymous?: boolean;
		name: string;
		userId: string;
	}>;
	activeUserId: string | null;
	token: string | null;
}

function parseJson(raw: string | null) {
	if (!raw) {
		return null;
	}
	try {
		return parseProofJson(raw);
	} catch {
		return null;
	}
}

async function seedAuthVault(page: Page) {
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

async function installApiFixture(
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

function tokenProfile(token: string) {
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

async function openNavMenu(page: Page, name = "Ada Lovelace") {
	const trigger = page.getByRole("button", { name: new RegExp(`^${name}`) });
	await trigger.click();
	await expect(page.getByRole("menu").last()).toBeVisible();
	return trigger;
}

function userNavButton(page: Page, name: string) {
	return page.getByRole("button", { name: new RegExp(`^${name}`) });
}

async function openAccountSubmenu(page: Page, name = "Ada Lovelace") {
	await page.getByRole("menuitem", { name }).click();
	await expect(page.getByRole("menu").last()).toBeVisible();
}

async function externalUrls(page: Page): Promise<string[]> {
	return page.evaluate(() => window.__NAVUSER_PROOF__?.externalUrls ?? []);
}

/**
 * The vault sealed in the `auth-vault` slot the runtime keeps in sessionStorage
 * (an empty slot reads as signed out). The seeded plaintext vault migrates into
 * the slot on first load, so no plaintext copy may remain in localStorage.
 */
async function accountVault(page: Page): Promise<AccountVault> {
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

async function saveEvidence(page: Page, name: string) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, `${name}.png`),
	});
}

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
	await seedAuthVault(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ height: 1000, width: 1440 });
});

test("production account menu shows while signed in, and Escape restores trigger focus", async ({
	page,
}) => {
	const fixture = await installApiFixture(page, { holdSession: true });
	await page.goto(`${PROOF_URL}?inbox=on`);
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Ada Lovelace" })).toHaveCount(
		0
	);
	await fixture.releaseSession();
	const trigger = page.getByRole("button", { name: /^Ada Lovelace/u });
	await expect(trigger).toBeVisible();
	await trigger.click();
	const menu = page.getByRole("menu").last();
	await expect(
		menu.getByRole("menuitem", { name: "Online status: Online" })
	).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Plan Ryu Pro" })
	).toBeDisabled();
	await expect(
		menu.getByRole("menuitem", { name: "Settings", exact: true })
	).toBeVisible();
	await saveEvidence(page, "desktop-navuser-account-menu");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(fixture.externalRequests).toEqual([]);
});

test("standard account, More, Get Ryu apps, and Help actions open their exact web destinations", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	const directLinks = [
		["Profile", `${FRONTEND}/u/navuser-user-ada`],
		["Organizations", `${FRONTEND}/organizations`],
		["Invite a friend", `${FRONTEND}/referrals`],
		["Join Discord", `${FRONTEND}/discord`],
		["Account", `${FRONTEND}/settings`],
		["Personal access tokens", `${FRONTEND}/api-keys`],
	] as const;

	for (const [label, destination] of directLinks) {
		await openNavMenu(page);
		await page.getByRole("menuitem", { name: label, exact: true }).click();
		await expect.poll(() => externalUrls(page)).toContain(destination);
	}

	const moreLinks = [
		["Terms of Service", `${FRONTEND}/terms`],
		["Privacy", `${FRONTEND}/privacy`],
		["Data Processing Agreement", `${FRONTEND}/dpa`],
	] as const;
	for (const [label, destination] of moreLinks) {
		await openNavMenu(page);
		await page.getByRole("menuitem", { name: "More", exact: true }).click();
		await page.getByRole("menuitem", { name: label, exact: true }).click();
		await expect.poll(() => externalUrls(page)).toContain(destination);
	}

	// The native shell is the desktop app, so it only promotes the others. The
	// proof build names no mobile store listing, so Mobile stays out as well.
	const appLinks = [
		["Browser extension", `${FRONTEND}/download#extension`],
	] as const;
	for (const [label, destination] of appLinks) {
		await openNavMenu(page);
		await page
			.getByRole("menuitem", { name: "Get Ryu apps", exact: true })
			.click();
		const appLink = page.getByRole("menuitem", {
			name: new RegExp(`^${label}`, "u"),
		});
		// Wait for the submenu so the absence checks below are not vacuous.
		await expect(appLink).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: /^Desktop app/u })
		).toHaveCount(0);
		await expect(
			page.getByRole("menuitem", { name: /^Mobile app/u })
		).toHaveCount(0);
		await appLink.click();
		await expect.poll(() => externalUrls(page)).toContain(destination);
	}

	const helpLinks = [
		["Documentation", `${FRONTEND}/docs`],
		["Get support", "mailto:support@ryuhq.com"],
		[
			"Desktop navigation fixture",
			`${FRONTEND}/blog/fixture-desktop-navigation`,
		],
		["View all releases", `${FRONTEND}/changelog`],
	] as const;
	for (const [label, destination] of helpLinks) {
		await openNavMenu(page);
		await page.getByRole("menuitem", { name: "Help", exact: true }).hover();
		await expect(
			page.getByRole("menuitem", { name: /App Version/u })
		).toBeVisible();
		await page.getByRole("menuitem", { name: label }).click();
		await expect.poll(() => externalUrls(page)).toContain(destination);
	}

	await expect(externalUrls(page)).resolves.toEqual([
		...directLinks.map(([, destination]) => destination),
		...moreLinks.map(([, destination]) => destination),
		...appLinks.map(([, destination]) => destination),
		...helpLinks.map(([, destination]) => destination),
	]);
	await expect(fixture.externalRequests).toEqual([]);
});

test("Get Ryu apps never promotes the browser host the shared menu runs in", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	// [host surface, promoted in order, never shown]. No mobile store listing is
	// configured in the proof build, so no host promotes Mobile.
	const hosts = [
		["extension", ["Desktop app"], ["Browser extension", "Mobile app"]],
		["web", ["Desktop app", "Browser extension"], ["Mobile app"]],
		["telegram", ["Desktop app", "Browser extension"], ["Mobile app"]],
	] as const;
	for (const [surface, promoted, absent] of hosts) {
		await page.goto(`${PROOF_URL}?inbox=on&surface=${surface}`);
		await openNavMenu(page);
		await page
			.getByRole("menuitem", { name: "Get Ryu apps", exact: true })
			.click();
		for (const label of promoted) {
			await expect(
				page.getByRole("menuitem", { name: new RegExp(`^${label}`, "u") })
			).toBeVisible();
		}
		for (const label of absent) {
			await expect(
				page.getByRole("menuitem", { name: new RegExp(`^${label}`, "u") })
			).toHaveCount(0);
		}
		await page.getByRole("menuitem", { name: /^Desktop app/u }).click();
		await expect
			.poll(() => externalUrls(page))
			.toEqual([`${FRONTEND}/download#desktop`]);
	}
	await expect(fixture.externalRequests).toEqual([]);
});

test("availability and Settings entries open the real General settings dialog", async ({
	page,
}) => {
	await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: "Online status: Online", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Away", exact: true })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Away", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:user-availability"))
		)
		.toContain('"manualStatus":"away"');

	await openNavMenu(page);
	await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
	// Once the modal closes, the footer's Inbox and Downloads trays (mounted as
	// inert dialogs) are exposed again, so follow the Settings dialog by its page.
	const settingsDialog = dialog.filter({
		has: page.getByRole("heading", { name: "General" }),
	});
	await expect(settingsDialog).toBeVisible();
	await expect(page.getByTestId("settings-state")).toHaveText(
		JSON.stringify({ open: true, section: "general" })
	);
	await saveEvidence(page, "desktop-navuser-settings-open");
	await page.keyboard.press("Escape");
	await expect(settingsDialog).toBeHidden();
	await expect(page.getByTestId("settings-state")).toHaveText(
		JSON.stringify({ open: false, section: "general" })
	);
});

test("keyboard focus preloads the Settings dialog before it is opened", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	const moduleRequests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("SettingsDialog.tsx")) {
			moduleRequests.push(request.url());
		}
	});
	await userNavButton(page, "Ada Lovelace").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menu").last()).toBeVisible();
	const settingsItem = page.getByRole("menuitem", {
		name: "Settings",
		exact: true,
	});
	await settingsItem.focus();
	await expect.poll(() => moduleRequests.length).toBeGreaterThan(0);
	// SAFETY: the awaited poll observed this nonempty local string array. Its sole
	// writer appends native Request.url() strings, so its first entry remains a string.
	expect(new URL(moduleRequests[0] as string).origin).toBe(ORIGIN);
	await settingsItem.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
	await expect(fixture.externalRequests).toEqual([]);
});

test("account switching reloads the new active vault and row sign-out can cancel then remove an inactive account", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	await openAccountSubmenu(page);
	const graceRow = page.getByRole("menuitem", { name: /Grace Hopper/u });
	await expect(graceRow).toBeVisible();
	const switched = page.waitForEvent("load");
	await graceRow.click();
	await switched;
	await expect(userNavButton(page, "Grace Hopper")).toBeVisible();
	expect(await accountVault(page)).toMatchObject({
		activeUserId: "navuser-user-grace",
		token: "navuser-token-grace",
	});

	await openNavMenu(page, "Grace Hopper");
	await openAccountSubmenu(page, "Grace Hopper");
	const adaRow = page.getByRole("menuitem", { name: /Ada Lovelace/u });
	await adaRow.hover();
	await adaRow.getByRole("button", { name: "Sign out Ada Lovelace" }).click();
	const dialog = page.getByRole("alertdialog", {
		name: "Log out of this account?",
	});
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("ada@example.test")).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveAttribute("data-closed", "");
	expect((await accountVault(page)).accounts).toHaveLength(2);

	await page.keyboard.press("Escape");
	await openNavMenu(page, "Grace Hopper");
	await openAccountSubmenu(page, "Grace Hopper");
	const adaRowAgain = page.getByRole("menuitem", { name: /Ada Lovelace/u });
	await expect(adaRowAgain).toBeVisible();
	await adaRowAgain.hover();
	await adaRowAgain
		.getByRole("button", { name: "Sign out Ada Lovelace" })
		.click();
	const confirmation = page.getByRole("alertdialog", {
		name: "Log out of this account?",
	});
	await confirmation
		.getByRole("button", { name: "Log out", exact: true })
		.click();
	await expect(confirmation).toHaveAttribute("data-closed", "");
	await expect(
		page.getByRole("menuitem", { name: /Ada Lovelace/u })
	).toHaveCount(0);
	const vault = await accountVault(page);
	expect(vault.activeUserId).toBe("navuser-user-grace");
	expect(vault.token).toBe("navuser-token-grace");
	expect(vault.accounts.map((account) => account.userId)).toEqual([
		"navuser-user-grace",
	]);
	expect(
		fixture.calls.filter((call) => call.path === "/api/auth/sign-out")
	).toEqual([]);
	await expect(fixture.externalRequests).toEqual([]);
});

test("signing out the active account selects the remaining account and reloads", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	await openAccountSubmenu(page);
	// Ada is active, so the submenu trigger also carries her name; pick her
	// account row by its sign-out control.
	const adaRow = page.getByRole("menuitem").filter({
		has: page.getByRole("button", { name: "Sign out Ada Lovelace" }),
	});
	await adaRow.hover();
	await adaRow.getByRole("button", { name: "Sign out Ada Lovelace" }).click();
	const dialog = page.getByRole("alertdialog", {
		name: "Log out of this account?",
	});
	const reloaded = page.waitForEvent("load");
	await dialog.getByRole("button", { name: "Log out", exact: true }).click();
	await reloaded;
	await expect(userNavButton(page, "Grace Hopper")).toBeVisible();
	const vault = await accountVault(page);
	expect(vault.activeUserId).toBe("navuser-user-grace");
	expect(vault.token).toBe("navuser-token-grace");
	expect(vault.accounts.map((account) => account.userId)).toEqual([
		"navuser-user-grace",
	]);
	expect(fixture.externalRequests).toEqual([]);
});

test("Add account reports a failed request, retries device auth, and persists the verified local fixture account", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	fixture.failNext("POST", "/api/auth/device/code");
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	await openAccountSubmenu(page);
	await page
		.getByRole("menuitem", { name: "Add account", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't add account", { exact: true })
	).toBeVisible();
	await openNavMenu(page);
	await openAccountSubmenu(page);
	const added = page.waitForEvent("load");
	await page
		.getByRole("menuitem", { name: "Add account", exact: true })
		.click();
	await expect(
		page.getByText("Finish signing in", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Approve in your browser to add the account.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("textbox", { name: "Device sign-in code" })
	).toHaveValue("F1XTURE");
	await expect
		.poll(() => externalUrls(page))
		.toContain("http://localhost:3001/device?user_code=F1XT-URE");
	await added;
	await expect(userNavButton(page, "Katherine Johnson")).toBeVisible({
		timeout: 15_000,
	});

	const deviceCodeCalls = fixture.calls.filter(
		(call) => call.path === "/api/auth/device/code" && call.method === "POST"
	);
	expect(deviceCodeCalls).toHaveLength(2);
	expect(deviceCodeCalls.map((call) => call.status)).toEqual([503, 200]);
	expect(deviceCodeCalls[1]?.body).toEqual({
		client_id: "ryu-desktop",
		scope: "openid profile email",
	});
	const deviceToken = fixture.calls.find(
		(call) => call.path === "/api/auth/device/token" && call.method === "POST"
	);
	expect(deviceToken?.body).toEqual({
		client_id: "ryu-desktop",
		device_code: "navuser-device-code",
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
	});
	const vault = await accountVault(page);
	expect(vault.activeUserId).toBe("navuser-user-katherine");
	expect(vault.token).toBe("navuser-device-token");
	expect(vault.accounts.map((account) => account.userId)).toEqual([
		"navuser-user-ada",
		"navuser-user-grace",
		"navuser-user-katherine",
	]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-navuser-account-added.png"),
	});
	await expect(fixture.externalRequests).toEqual([]);
});

test("usage shows subscription balance and reset date; pricing and lifetime checkout preserve retry and exact auth payload", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	fixture.failNext("POST", "/api/billing/checkout/lifetime");
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	const plan = page.getByRole("menuitem", {
		name: /Organization plan Ryu Pro/u,
	});
	await expect(plan).toBeDisabled();
	await page
		.getByRole("menuitem", { name: "Usage remaining", exact: true })
		.click();
	const usage = page.getByRole("menu").last();
	await expect(usage.getByText("$12.345", { exact: true })).toBeVisible();
	await expect(usage.getByText("Dec 31, 2026", { exact: true })).toBeVisible();
	await saveEvidence(page, "desktop-navuser-usage-submenu");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: "Upgrade to Max", exact: true })
		.click();
	await expect.poll(() => externalUrls(page)).toContain(`${FRONTEND}/pricing`);

	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: "Get Lifetime Access", exact: true })
		.click();
	await expect(
		page.getByText("Failed to start checkout", { exact: true })
	).toBeVisible();
	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: "Get Lifetime Access", exact: true })
		.click();
	await expect
		.poll(() => externalUrls(page))
		.toContain("https://checkout.fixture.test/lifetime?session=navuser");

	const stepUp = fixture.calls.filter(
		(call) => call.path === "/api/step-up/status?scope=billing"
	);
	expect(stepUp).toHaveLength(3);
	for (const call of stepUp) {
		expect(call.authorization).toBe("Bearer navuser-token-ada");
	}
	const checkouts = fixture.calls.filter(
		(call) =>
			call.path === "/api/billing/checkout/lifetime" && call.method === "POST"
	);
	expect(checkouts).toHaveLength(2);
	expect(checkouts[0]?.status).toBe(503);
	expect(checkouts[1]?.status).toBe(200);
	for (const call of checkouts) {
		expect(call.authorization).toBe("Bearer navuser-token-ada");
		expect(call.body).toEqual({});
		expect(call.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/iu);
	}
	await expect(fixture.externalRequests).toEqual([]);
});

test("right-click hide actions remove only their owned footer controls; Inbox follows the enabled-app alias", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	const account = userNavButton(page, "Ada Lovelace");
	await account.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Hide account", exact: true })
		.click();
	await expect(account).toHaveCount(0);
	await expect(page.getByTestId("hidden-chrome")).toHaveText('["user"]');

	const notifications = page.getByRole("button", {
		name: "Inbox",
		exact: true,
	});
	await expect(notifications).toBeVisible();
	await notifications.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Hide inbox", exact: true }).click();
	await expect(notifications).toHaveCount(0);
	await expect(page.getByTestId("hidden-chrome")).toHaveText(
		'["user","inbox"]'
	);

	const downloads = page.getByRole("button", {
		name: "Downloads",
		exact: true,
	});
	await expect(downloads).toBeVisible();
	await downloads.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Hide downloads", exact: true })
		.click();
	await expect(downloads).toHaveCount(0);
	await expect(page.getByTestId("hidden-chrome")).toHaveText(
		'["user","inbox","downloads"]'
	);
	await expect(fixture.externalRequests).toEqual([]);

	const noInboxPage = await page.context().newPage();
	await seedAuthVault(noInboxPage);
	await installApiFixture(noInboxPage);
	await noInboxPage.goto(`${PROOF_URL}?inbox=off`);
	await expect(noInboxPage.getByRole("button", { name: "Inbox" })).toHaveCount(
		0
	);
	await expect(
		noInboxPage.getByRole("button", { name: "Downloads", exact: true })
	).toBeVisible();
});

test("Bot product keeps account links but omits desktop Settings, creation, Inbox, and downloads", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?product=bot&inbox=on`);
	await openNavMenu(page);
	await expect(
		page.getByRole("menuitem", { name: "Account", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Organizations", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Download Ryu Build", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Settings", exact: true })
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Create new" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Inbox" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Downloads" })).toHaveCount(0);
	await expect(fixture.externalRequests).toEqual([]);
});

test("Log out of all accounts clears the local vault and issues only local auth requests", async ({
	page,
}) => {
	const fixture = await installApiFixture(page);
	await page.goto(`${PROOF_URL}?inbox=on`);
	await openNavMenu(page);
	await openAccountSubmenu(page);
	const reloaded = page.waitForEvent("load");
	await page
		.getByRole("menuitem", { name: "Log out of all accounts", exact: true })
		.click();
	await reloaded;
	await expect
		.poll(() => accountVault(page))
		.toMatchObject({
			accounts: [],
			activeUserId: null,
			token: null,
		});
	await expect(userNavButton(page, "Ada Lovelace")).toHaveCount(0);
	const authSignOut = fixture.calls.find(
		(call) => call.path === "/api/auth/sign-out" && call.method === "POST"
	);
	expect(authSignOut).toBeDefined();
	const coreLogout = fixture.calls.find(
		(call) => call.path === "/api/auth/logout" && call.method === "POST"
	);
	expect(coreLogout?.body).toEqual({ all: true });
	await expect(fixture.externalRequests).toEqual([]);
});
