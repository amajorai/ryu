import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	agentsTab,
	EVIDENCE_DIR,
	globalSearch,
	installLocalFixture,
	runtimeCodexCard,
	STORY_URL,
	selectStoreSection,
} from "./marketplace-store-interactions.fixture.ts";

test.describe.configure({ timeout: 90_000 });

test("Store-wide search opens a matching realm and carries the query into it", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=bundles`);
	await globalSearch(page).fill("Codex");
	await expect(
		page.getByRole("button", { name: /Codex/ }).last()
	).toBeVisible();
	await page.getByRole("button", { name: /Codex/ }).last().click();
	await expect(agentsTab(page)).toHaveAttribute("aria-selected", "true");
	// The clicked result opens on its own detail inside the realm.
	const detail = page.getByRole("dialog", { name: "Codex" });
	await expect(detail).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(detail).toHaveCount(0);
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(globalSearch(page)).toHaveValue("");
	const agentSearch = page.getByRole("textbox", { name: "Search agents…" });
	await expect(agentSearch).toHaveValue("Codex");
	await expect(
		fixture.calls.some(
			(call) => call.path === "/api/agents/catalog" && call.method === "GET"
		)
	).toBe(true);
});

test("Install from code validates and normalizes before preview, and reopening resets the draft", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=agents`);
	await page.getByRole("button", { name: "More store actions" }).click();
	await page.getByRole("menuitem", { name: "Install from code" }).click();
	const dialog = page.getByRole("dialog", {
		name: "Install a private package",
	});
	await expect(dialog).toContainText("Private by default");
	const input = dialog.getByRole("textbox", { name: "Package code" });
	await input.fill("bad-code");
	await expect(
		dialog.getByRole("button", { name: "Preview package" })
	).toBeDisabled();
	await expect(
		fixture.calls.filter((call) => call.path.includes("share-codes/preview"))
	).toHaveLength(0);
	await input.fill("7k4m-x2qp-9f6d");
	await input.blur();
	await expect(input).toHaveValue("7K4M-X2QP-9F6D");
	await dialog.getByRole("button", { name: "Preview package" }).click();
	await expect(dialog).toContainText("Private Search Plugin");
	await expect(dialog).toContainText("mcp:fixture.search");
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/marketplace/share-codes/preview")
			.map((call) => call.body)
	).toEqual([{ code: "7K4MX2QP9F6D" }]);
	await dialog.getByRole("button", { name: "Use another code" }).click();
	await expect(
		dialog.getByRole("button", { name: "Preview package" })
	).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await page.getByRole("button", { name: "More store actions" }).click();
	await page.getByRole("menuitem", { name: "Install from code" }).click();
	await expect(
		page
			.getByRole("dialog", { name: "Install a private package" })
			.getByRole("textbox", { name: "Package code" })
	).toHaveValue("");
	expect(
		fixture.calls.filter(
			(call) =>
				call.method === "POST" && call.path.includes("share-codes/redeem")
		)
	).toHaveLength(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "More store actions" }).click();
	await page.getByRole("menuitem", { name: "Share package" }).click();
	const shareDialog = page.getByRole("dialog", {
		name: "Create a private package code",
	});
	await expect(shareDialog).toBeVisible();
	await expect(shareDialog).toContainText("time-limited code");
	await shareDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(shareDialog).toHaveCount(0);
	expect(
		fixture.calls
			.filter(
				(call) => call.method === "POST" && call.path.includes("share-codes")
			)
			.map((call) => call.path)
	).toEqual(["/api/marketplace/share-codes/preview"]);
});

test("private package connection review cancels without writing and forwards the chosen access ceiling", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, {
		includeConnectionRequirement: true,
	});
	await page.goto(`${STORY_URL}?section=agents`);
	await page.getByRole("button", { name: "More store actions" }).click();
	await page.getByRole("menuitem", { name: "Install from code" }).click();
	const packageDialog = page.getByRole("dialog", {
		name: "Install a private package",
	});
	await packageDialog
		.getByRole("textbox", { name: "Package code" })
		.fill("7K4M-X2QP-9F6D");
	await packageDialog.getByRole("button", { name: "Preview package" }).click();
	await expect(packageDialog).toContainText("Fixture Slack account");
	await expect(packageDialog).toContainText("Needs connection");

	await packageDialog.getByRole("button", { name: "Connect" }).click();
	const permissionDialog = page.getByTestId("connection-permission-dialog");
	await expect(permissionDialog).toContainText(
		"Review access before connecting Fixture Slack account"
	);
	await permissionDialog
		.getByRole("radio", { name: "Full access, including delete" })
		.check();
	await permissionDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(permissionDialog).toHaveCount(0);
	expect(
		fixture.calls.filter(
			(call) => call.path === "/api/composio/connections/initiate"
		)
	).toHaveLength(0);
	await expect(packageDialog).toContainText("Needs connection");

	await packageDialog.getByRole("button", { name: "Connect" }).click();
	await permissionDialog.getByRole("radio", { name: "Write access" }).check();
	await permissionDialog
		.getByRole("button", { name: "Continue to connect" })
		.click();
	await expect(permissionDialog).toHaveCount(0);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/composio/connections/initiate")
			.map((call) => call.body)
	).toEqual([{ access_level: "write", toolkit: "slack" }]);
	await expect(packageDialog).toContainText(
		"Everything required is connected."
	);
	await expect(
		packageDialog.getByText("Connected", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("harness-effects")).toContainText(
		"https://composio.example.test/oauth/fixture"
	);
});

test("Themes tab renders theme listings from its exact catalog", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(`${STORY_URL}?section=themes`);
	const themesTab = page.getByRole("tab", { name: "Themes" });
	await expect(themesTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Fixture Minimal Theme", { exact: true })
	).toBeVisible();
	expect(
		fixture.calls.some(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/marketplace/catalog" &&
				call.search === "?kind=theme"
		)
	).toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-themes-body.png"),
	});
});

test("enabled app-contributed Store tab renders its catalog and detail body", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message)
	);
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});
	await page.goto(
		`${STORY_URL}?fixtureStoreTab=1&section=plugin%3Acom.ryu.marketplace-fixture%3Afixture-library`
	);
	if (pageErrors.length > 0) {
		throw new Error(pageErrors.join("\n"));
	}
	expect(
		await page.evaluate(() => window.__marketplaceStoreTabFixture ?? null)
	).toEqual({
		enabled: true,
		value:
			"?fixtureStoreTab=1&section=plugin%3Acom.ryu.marketplace-fixture%3Afixture-library",
	});
	const tabLabels = await page.locator('[role="tab"]').allTextContents();
	expect(tabLabels).toContain("Fixture catalog");
	const fixtureTab = page.getByRole("tab", { name: "Fixture catalog" });
	await expect(fixtureTab).toHaveAttribute("aria-selected", "true");
	const listing = page.getByRole("button", {
		name: /Fixture catalog listing/,
	});
	await expect(listing).toBeVisible();
	expect(
		fixture.calls.some(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/fixture/marketplace-store/catalog"
		)
	).toBe(true);
	await listing.click();
	await expect(
		page.getByRole("heading", { name: "Fixture catalog listing" }).last()
	).toBeVisible();
	await expect(
		page
			.getByText("A row supplied by an enabled local Store-tab contribution.", {
				exact: true,
			})
			.last()
	).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-contributed-tab-detail.png"),
	});
});

test("Settings on an installed plugin-backed agent opens that exact settings target", async ({
	page,
}) => {
	await installLocalFixture(page, { pluginSettingsAgent: true });
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(page.getByRole("button", { name: /Pocket TTS/ })).toBeVisible();
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	const settingsItem = page.getByRole("menuitem", {
		name: "Settings",
		exact: true,
	});
	await expect(settingsItem).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.getByRole("menu").screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-agent-settings-menu.png"),
	});
	await settingsItem.click();
	await expect(page.getByTestId("harness-effects")).toContainText(
		'"settingsOpened":["pocket-tts"]'
	);
});

test("runtime catalog retry, add/remove writes, installed filter, and view preference persist", async ({
	page,
}, testInfo) => {
	const fixture = await installLocalFixture(page);
	fixture.agentCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=agents`);
	await expect(
		page.getByText("Couldn't load agents", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(
		page.getByText("Needs manual install", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Unavailable on this platform" })
	).toBeVisible();
	await expect(
		page.getByRole("img", { name: "Built in" }).first()
	).toBeVisible();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"showcase"
	);

	await page.getByRole("button", { name: "Showcase view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"showcase"
	);
	await page.getByRole("button", { name: "Grid view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await expect(runtimeCodexCard(page)).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("store-agents-grid-with-runtime-states.png"),
	});
	await page.getByRole("button", { name: "List view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"list"
	);
	await page.getByRole("button", { name: "Grid view" }).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await expect(runtimeCodexCard(page)).toHaveCount(0);
	await expect(page.getByText("Agent Templates", { exact: true })).toHaveCount(
		0
	);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(runtimeCodexCard(page)).toBeVisible();
	await expect(
		page.getByText("Agent Templates", { exact: true })
	).toBeVisible();

	await runtimeCodexCard(page).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Couldn't add agent", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Codex runtime install is temporarily unavailable")
	).toBeVisible();
	await runtimeCodexCard(page).click();
	const detail = page.getByRole("dialog", { name: "Codex" });
	await expect(detail).toBeVisible();
	await expect(
		detail.getByText("Codex runtime install is temporarily unavailable")
	).toBeVisible();
	await expect(detail.getByRole("button", { name: "Add" })).toBeEnabled();
	await detail.getByRole("button", { name: "Add" }).click();
	await expect(detail.getByRole("button", { name: "Remove" })).toBeVisible();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(true);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/catalog/install"
				).length
		)
		.toBe(2);
	const agentWrites = fixture.calls.filter(
		(call) => call.path === "/api/agents/catalog/install"
	);
	expect(agentWrites.map((call) => call.body)).toEqual([
		{ id: "acp:codex" },
		{ id: "acp:codex" },
	]);

	await detail.getByRole("button", { name: "Remove" }).click();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(false);
	await page.keyboard.press("Escape");
	await expect(detail).toHaveCount(0);
	await page.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/agents/catalog/install"
				).length
		)
		.toBe(3);
	await expect(
		page.getByRole("button", { name: "Manage", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(
		fixture.agents.find((agent) => agent.id === "acp:codex")?.added
	).toBe(false);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/agents/catalog/uninstall")
			.map((call) => call.body)
	).toEqual([{ id: "acp:codex" }, { id: "acp:codex" }]);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await selectStoreSection(page, "Bundles");
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await agentsTab(page).click();
	await expect(
		page.getByRole("button", { name: "Installed", exact: true }).first()
	).toHaveAttribute("aria-pressed", "true");
	await expect(runtimeCodexCard(page)).toHaveCount(0);
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await runtimeCodexCard(page).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Codex" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Codex" })).toHaveCount(0);
	await runtimeCodexCard(page).focus();
	await page.keyboard.press("Space");
	await expect(page.getByRole("dialog", { name: "Codex" })).toBeVisible();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(page.getByRole("dialog", { name: "Codex" })).toHaveCount(0);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const localSearch = page.getByRole("textbox", { name: "Search agents…" });
	await localSearch.fill("no-such-agent-in-this-fixture");
	await expect(
		page.getByText("No agents found", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(runtimeCodexCard(page)).toBeVisible();

	await selectStoreSection(page, "Bundles");
	await expect(
		page.getByText("Agent Setup Bundle", { exact: true })
	).toBeVisible();
	await agentsTab(page).click();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await page.reload();
	await expect(page.locator('[data-slot="view-toggle"]')).toHaveAttribute(
		"data-view-mode",
		"grid"
	);
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:store-view-mode"))
	).resolves.toBe(JSON.stringify({ agents: "grid" }));
});
