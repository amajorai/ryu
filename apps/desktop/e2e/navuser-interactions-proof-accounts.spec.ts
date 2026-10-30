import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	accountVault,
	EVIDENCE_DIR,
	externalUrls,
	FRONTEND,
	installApiFixture,
	openAccountSubmenu,
	openNavMenu,
	PROOF_URL,
	saveEvidence,
	seedAuthVault,
	userNavButton,
} from "./navuser-interactions-proof.fixture.ts";

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
	await seedAuthVault(page);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.setViewportSize({ height: 1000, width: 1440 });
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
	// Plan and usage live in the Organization submenu.
	await page
		.getByRole("menuitem", { name: /^Organization/u })
		.first()
		.click();
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
	await page.keyboard.press("Escape");

	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: "Upgrade to Max", exact: true })
		.click();
	await expect.poll(() => externalUrls(page)).toContain(`${FRONTEND}/pricing`);

	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: /^Organization/u })
		.first()
		.click();
	await page
		.getByRole("menuitem", { name: "Get Lifetime Access", exact: true })
		.click();
	await expect(
		page.getByText("Failed to start checkout", { exact: true })
	).toBeVisible();
	await openNavMenu(page);
	await page
		.getByRole("menuitem", { name: /^Organization/u })
		.first()
		.click();
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

test("right-click hide actions remove only their owned footer controls; Inbox follows the enabled-app alias; idle downloads stay out of the footer", async ({
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

	// With nothing downloading, the footer has no downloads tray: Downloads is a
	// row in the account menu instead.
	await expect(
		page.getByRole("button", { name: "Downloads", exact: true })
	).toHaveCount(0);
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
	).toHaveCount(0);
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
		page.getByRole("menuitem", { name: "Download Ryu Build", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: /^Organization/u })
		.first()
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Organizations", exact: true })
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
