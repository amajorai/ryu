import { writeFileSync } from "node:fs";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { installConsoleAccessAppFixture } from "./console-access-app-proof.fixture.ts";
import {
	DESKTOP_SECRET_RECORD_KEY,
	LEGACY_VAULT_LOCAL_STORAGE_KEYS,
	parseAuthVaultSlot,
} from "./harness/desktop-secret-slots.ts";

test.describe.configure({ timeout: 120_000 });
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
interface Snapshot {
	consoleAccess: boolean;
	defaultNode: string;
	node: { name: string; managed?: boolean; orgId?: string | null };
	organizationQuery?: { status: string; fetchStatus: string };
	requestedMode: string;
}
declare global {
	interface Window {
		consoleAccessProof: { snapshot: () => Snapshot };
	}
}

function snapshot(page: Page): Promise<Snapshot> {
	return page.evaluate(() =>
		(
			window as unknown as { consoleAccessProof: { snapshot: () => Snapshot } }
		).consoleAccessProof.snapshot()
	);
}
/** The vault sealed in the `auth-vault` slot the native fixture keeps. */
async function sealedVault(page: Page) {
	const vault = parseAuthVaultSlot(
		await page.evaluate(
			(key) => sessionStorage.getItem(key),
			DESKTOP_SECRET_RECORD_KEY
		)
	);
	if (!vault) {
		throw new Error("The auth-vault slot is empty");
	}
	return vault;
}
async function expectNoPlaintextVault(page: Page) {
	expect(
		await page.evaluate(
			(keys) => keys.map((key) => localStorage.getItem(key)),
			[...LEGACY_VAULT_LOCAL_STORAGE_KEYS]
		)
	).toEqual([null, null, null]);
}
async function switchMenu(page: Page) {
	await page.getByTestId("product-mode-trigger").click();
}
async function expectHiddenConsole(page: Page) {
	await switchMenu(page);
	await expect(page.getByRole("menuitemradio", { name: /^Agent/ })).toHaveCount(
		0
	);
	await page.keyboard.press("Escape");
}
async function saveProof(
	page: Page,
	label: string,
	fixture: Awaited<ReturnType<typeof installConsoleAccessAppFixture>>,
	testInfo: TestInfo
) {
	let headerGeometry: unknown;
	// Proof ends on settled product state, including the actual Bot health badge.
	if (await page.getByTestId("bot-connection-status").count()) {
		await expect(page.getByTestId("bot-connection-status")).toHaveAttribute(
			"aria-label",
			"Ryu Cloud managed workspace: Connected"
		);
	}
	await expect(page.getByTestId("reconnect-retry-status")).toHaveCount(0, {
		timeout: 15_000,
	});
	// The shared connection toast has its own lifecycle (Desktop clears restored
	// after three seconds); it is independent of Sileo and reconnect-retry banners.
	await expect(page.getByTestId("connection-status-toast")).toBeHidden({
		timeout: 15_000,
	});
	await expect(
		page.getByText("Connection restored", { exact: true })
	).toBeHidden({ timeout: 15_000 });
	await expect(
		page.getByText(/Can’t reach .+\. Reconnecting automatically…/)
	).toBeHidden({ timeout: 15_000 });
	await expect(page.locator("[data-sileo-toast]")).toHaveCount(0, {
		timeout: 15_000,
	});
	if (await page.getByTestId("bot-chat-header").count()) {
		await expect(page.getByTestId("bot-chat-header-avatar")).toBeVisible();
		// TitleBar's actual drag-region root renders ProgressiveBlur as its first
		// direct child. Its box includes the fade below the titlebar controls.
		headerGeometry = await page
			.getByTestId("bot-chat-header-avatar")
			.evaluate((avatar) => {
				const titlebar = document.querySelector(
					"[data-tab-appearance][data-tauri-drag-region]"
				);
				const blur = titlebar?.firstElementChild;
				if (!(titlebar instanceof HTMLElement && blur instanceof HTMLElement)) {
					throw new Error("Actual titlebar blur region is missing");
				}
				const avatarBox = avatar.getBoundingClientRect();
				const blurBox = blur.getBoundingClientRect();
				const avatarStyle = getComputedStyle(avatar);
				return {
					avatarTop: avatarBox.top,
					avatarBottom: avatarBox.bottom,
					avatarHeight: avatarBox.height,
					titlebarFadeBottom: blurBox.bottom,
					avatarVisibility: avatarStyle.visibility,
					avatarOpacity: avatarStyle.opacity,
					clearsTitlebarFade: avatarBox.top >= blurBox.bottom - 1,
				};
			});
		expect(headerGeometry).toMatchObject({
			clearsTitlebarFade: true,
			avatarVisibility: "visible",
			avatarOpacity: "1",
		});
	}
	await page.screenshot({
		path: testInfo.outputPath(`${label}.png`),
		fullPage: true,
		animations: "disabled",
	});
	writeFileSync(
		testInfo.outputPath(`${label}.json`),
		JSON.stringify(
			{
				state: await snapshot(page),
				headerGeometry,
				transport: fixture.snapshot(),
			},
			null,
			2
		)
	);
	expect(
		fixture.snapshot().fallbackPaths,
		"All mounted API callers need finite source-backed contracts"
	).toEqual([]);
	expect(
		pageErrors.get(page) ?? [],
		"The actual App must mount without runtime errors"
	).toEqual([]);
}

for (const initial of ["member", "error"] as const) {
	test(`actual App gate keeps stale saved Console in Bot for ${initial}, then exposes the owner switch after fresh server read`, async ({
		page,
	}, testInfo) => {
		const fixture = await installConsoleAccessAppFixture(page);
		fixture.setFailure(initial === "error");
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto("/console-access-app-proof.html");
		await expect
			.poll(async () => (await snapshot(page)).node.managed)
			.toBe(true);
		await expect
			.poll(async () => (await snapshot(page)).organizationQuery?.status)
			.toBe(initial === "error" ? "error" : "success");
		await expect(
			page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
		).toBeVisible();
		expect((await snapshot(page)).requestedMode).toBe("console");
		await expectHiddenConsole(page);
		fixture.setFailure(false);
		fixture.setRole("owner");
		await page.reload();
		await expect
			.poll(async () => (await snapshot(page)).consoleAccess)
			.toBe(true);
		await switchMenu(page);
		await expect(
			page.getByRole("menuitemradio", { name: /^Agent/ })
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(
			page
				.getByTestId("product-mode-lockup")
				.getByText("Agent", { exact: true })
		).toBeVisible();
		await saveProof(
			page,
			`console-${initial}-owner-completed`,
			fixture,
			testInfo
		);
		expect(
			fixture
				.snapshot()
				.calls.filter((call) => call.path === "/api/control-plane/orgs")
				.every((call) => call.authorization === "Bearer console-owner-token")
		).toBe(true);
		expect(errors).toEqual([]);
	});
}

test("actual AppSidebar hides Console while organization response is pending and shows it only after owner readback", async ({
	page,
}, testInfo) => {
	const fixture = await installConsoleAccessAppFixture(page);
	fixture.setRole("owner");
	fixture.hold();
	await page.goto("/console-access-app-proof.html");
	await expect.poll(async () => (await snapshot(page)).node.managed).toBe(true);
	await expect
		.poll(async () => (await snapshot(page)).organizationQuery?.fetchStatus)
		.toBe("fetching");
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();
	await expectHiddenConsole(page);
	fixture.release();
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(true);
	await switchMenu(page);
	await expect(
		page.getByRole("menuitemradio", { name: /^Agent/ })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await saveProof(page, "console-loading-owner-completed", fixture, testInfo);
});

test("actual node selector replaces owner node with member node without granting its cached owner organization", async ({
	page,
}, testInfo) => {
	const fixture = await installConsoleAccessAppFixture(page);
	fixture.setRole("owner");
	await page.goto("/console-access-app-proof.html");
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(true);
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Agent", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Managed A", exact: true }).click();
	await page.getByRole("menuitem", { name: /^Managed B/ }).click();
	await expect
		.poll(async () => (await snapshot(page)).node.orgId)
		.toBe("org-b");
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(false);
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();
	await expectHiddenConsole(page);
	expect(
		await page.evaluate(() => localStorage.getItem("console-default-node"))
	).toBe("Managed B");
	expect(
		await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem("console-native-calls") ?? "[]").filter(
				(call: { command: string }) => call.command === "set_default_node"
			)
		)
	).toContainEqual({
		command: "set_default_node",
		args: { name: "Managed B" },
	});
	await saveProof(
		page,
		"console-node-replacement-member-completed",
		fixture,
		testInfo
	);
	// BotConnectionBadge is intentionally read-only: NodeSelector belongs to Console.
	// This product proof ends at the real A→B native selection/persistence transition.
	// Held node-confirmation supersession is covered by the mounted real node-store
	// contract; the separate actual account-menu case below proves held auth response
	// supersession through a UI action available while Bot is mounted.
});

test("actual account menu switch supersedes a held owner response and reloads the member session gate", async ({
	page,
}, testInfo) => {
	const fixture = await installConsoleAccessAppFixture(page);
	fixture.setRole("owner");
	fixture.hold();
	await page.goto("/console-access-app-proof.html");
	await expect.poll(async () => (await snapshot(page)).node.managed).toBe(true);
	await expect
		.poll(async () => (await snapshot(page)).organizationQuery?.fetchStatus)
		.toBe("fetching");
	// Avatar alt text contributes to the accessible name; scope by visible account copy.
	await page
		.getByRole("button")
		.filter({ has: page.getByText("Owner One", { exact: true }) })
		.click();
	await page
		.getByRole("menuitem")
		.filter({ has: page.getByText("Owner One", { exact: true }) })
		.first()
		.hover();
	await Promise.all([
		page.waitForEvent("load"),
		page.getByRole("menuitem", { name: /Member Two/ }).click(),
	]);
	fixture.release();
	await expect
		.poll(async () => (await snapshot(page)).organizationQuery?.status)
		.toBe("success");
	expect((await sealedVault(page)).activeToken).toBe("console-member-token");
	await expectNoPlaintextVault(page);
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(false);
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();
	await expectHiddenConsole(page);
	expect(
		fixture
			.snapshot()
			.calls.some(
				(call) =>
					call.path === "/api/control-plane/orgs" &&
					call.authorization === "Bearer console-member-token"
			)
	).toBe(true);
	await saveProof(
		page,
		"console-account-supersession-member-completed",
		fixture,
		testInfo
	);
});

test("actual account sign-out confirmation removes owner identity and reloads the remaining member gate", async ({
	page,
}, testInfo) => {
	const fixture = await installConsoleAccessAppFixture(page);
	fixture.setRole("owner");
	await page.goto("/console-access-app-proof.html");
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(true);
	await page
		.getByRole("button")
		.filter({ has: page.getByText("Owner One", { exact: true }) })
		.click();
	await page
		.getByRole("menuitem")
		.filter({ has: page.getByText("Owner One", { exact: true }) })
		.first()
		.hover();
	await page
		.getByRole("button", { name: "Sign out Owner One", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toContainText(
		"Log out of this account?"
	);
	await Promise.all([
		page.waitForEvent("load"),
		page.getByRole("button", { name: "Log out", exact: true }).click(),
	]);
	await expect
		.poll(async () => (await snapshot(page)).organizationQuery?.status)
		.toBe("success");
	await expect
		.poll(async () => (await snapshot(page)).consoleAccess)
		.toBe(false);
	const vault = await sealedVault(page);
	expect(vault.accounts.map((account) => account.userId)).toEqual([
		"member-two",
	]);
	expect(vault.activeToken).toBe("console-member-token");
	await expectNoPlaintextVault(page);
	await expectHiddenConsole(page);
	await saveProof(
		page,
		"console-owner-signout-member-completed",
		fixture,
		testInfo
	);
});
