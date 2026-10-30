import { expect, test } from "@playwright/test";
import {
	externalUrls,
	FRONTEND,
	installApiFixture,
	ORIGIN,
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
		menu.getByRole("menuitem", { name: "Settings", exact: true })
	).toBeVisible();
	// The plan row sits in the Organization (or Plan) submenu, whose trigger
	// carries the plan name.
	await menu
		.getByRole("menuitem", { name: /^(Organization|Plan)\b/u })
		.first()
		.click();
	await expect(
		page.getByRole("menuitem", { name: /plan Ryu Pro$/iu })
	).toBeDisabled();
	await page.keyboard.press("Escape");
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
	// Each web link sits in the submenu it belongs to: the account switcher
	// (profile, web account, tokens), Organization, or More (community).
	const directLinks = [
		["Profile", `${FRONTEND}/u/navuser-user-ada`, "account"],
		["Organizations", `${FRONTEND}/organizations`, "organization"],
		["Invite a friend", `${FRONTEND}/referrals`, "more"],
		["Join Discord", `${FRONTEND}/discord`, "more"],
		["Account", `${FRONTEND}/settings`, "account"],
		["Personal access tokens", `${FRONTEND}/api-keys`, "account"],
	] as const;

	for (const [label, destination, submenu] of directLinks) {
		await openNavMenu(page);
		if (submenu === "account") {
			await page
				.locator('[data-slot="dropdown-menu-sub-trigger"]')
				.first()
				.click();
		} else if (submenu === "organization") {
			await page
				.getByRole("menuitem", { name: /^Organization/u })
				.first()
				.click();
		} else {
			await page.getByRole("menuitem", { name: "More", exact: true }).click();
		}
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
