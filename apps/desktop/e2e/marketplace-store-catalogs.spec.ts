import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	accountState,
	EVIDENCE_DIR,
	installFixture,
	STORY_URL,
} from "./marketplace-store-catalogs.helpers.ts";

test.describe.configure({ timeout: 60_000 });

test("Integrations retries its list read, searches the returned page, and hands an exact brand query to MCP", async ({
	page,
}, _testInfo) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?section=integrations`);
	const integrationsTab = page.getByRole("tab", { name: "Integrations" });
	await expect(integrationsTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Couldn't load integrations", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("button", { name: /Notion/ })).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls
				.filter(
					(call) => call.path === "/api/integrations" && call.method === "GET"
				)
				.map((call) => call.search)
		)
		.toEqual(["?limit=60", "?limit=60"]);

	const search = page.getByPlaceholder(
		"Search integrations (Notion, Slack, GitHub…)"
	);
	await search.fill("Slack");
	const slackCard = page.getByRole("button", { name: /Slack/ });
	await expect(slackCard).toBeVisible();
	await expect(page.getByRole("button", { name: /Notion/ })).toHaveCount(0);
	await slackCard.click();
	const detailHeading = page.getByRole("heading", { name: "Slack" }).last();
	await expect(detailHeading).toBeVisible();
	await expect(
		page.getByText("Slack detail read back from the fixture directory.", {
			exact: true,
		})
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.method === "GET" && call.path === "/api/integrations/slack"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/integrations" &&
					call.search === "?q=Slack&limit=60"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some((call) => call.path === "/api/agents/catalog")
		)
		.toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-integrations-detail.png"),
	});

	await page.getByRole("button", { name: "Find in MCP catalog" }).click();
	const mcpTab = page.getByRole("tab", { name: "MCP" });
	await expect(mcpTab).toHaveAttribute("aria-selected", "true");
	await expect(page.getByPlaceholder("Search MCP servers…")).toHaveValue(
		"Slack"
	);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/mcp/catalog" &&
					new URLSearchParams(call.search).get("query") === "Slack"
			)
		)
		.toBe(true);
});

test("Connections searches a configured toolkit catalog and reads back its tools and triggers", async ({
	page,
}, _testInfo) => {
	const fixture = await installFixture(page);
	await page.goto(`${STORY_URL}?section=connections`);
	await expect(page.getByRole("tab", { name: "Connections" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByText("Managed integrations", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Access: Read only", { exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/connections" && call.method === "GET"
			)
		)
		.toBe(true);

	const search = page.getByPlaceholder(
		"Search integrations (Gmail, Slack, GitHub…)"
	);
	await search.fill("not-a-fixture-toolkit");
	await expect(page.getByText(/No integrations match/)).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByText("Slack", { exact: true }).first()).toBeVisible();
	await page.getByRole("button", { name: "View tools" }).click();
	await expect(page.getByText("Send message", { exact: true })).toBeVisible();
	await expect(
		page.getByText("New message event", { exact: true })
	).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/actions" &&
					new URLSearchParams(call.search).get("toolkit") === "slack"
			)
		)
		.toBe(true);
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/composio/triggers" &&
					new URLSearchParams(call.search).get("toolkit") === "slack"
			)
		)
		.toBe(true);
	await page.getByRole("button", { name: "Hide tools" }).click();
	await expect(page.getByText("Send message", { exact: true })).toHaveCount(0);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-connections-catalog.png"),
	});
});

test("My licenses refresh reads back the owned item and shows its purchase facts", async ({
	page,
}, _testInfo) => {
	await page.goto(`${STORY_URL}?section=licenses`);
	await expect(page.getByRole("tab", { name: "My licenses" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByText("No purchases yet", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(
		page.getByText("Paid Fixture Skill", { exact: true })
	).toBeVisible();
	await expect(page.getByText("$12.00", { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).licenseRefreshes)
		.toBe(1);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-license-readback.png"),
	});
});

test("Sell retries hosted onboarding, refreshes payout state, and resolves seller reports", async ({
	page,
}, _testInfo) => {
	await page.goto(`${STORY_URL}?section=sell`);
	await expect(page.getByRole("tab", { name: "Sell" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(page.getByText("In progress", { exact: true })).toBeVisible();
	const refreshButtons = page.getByRole("button", { name: "Refresh" });
	await expect(refreshButtons).toHaveCount(2);
	await refreshButtons.first().click();
	await expect(page.getByText("Active", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Payouts enabled", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Manage seller account" })
	).toBeVisible();
	await expect(
		page.getByText("Identity verified via Stripe Connect", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).sellerRefreshes)
		.toBe(1);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-seller-status.png"),
	});

	const setup = page.getByRole("button", { name: "Manage seller account" });
	await setup.click();
	await expect(
		page.getByText("Fixture seller onboarding temporarily unavailable", {
			exact: true,
		})
	).toBeVisible();
	await setup.click();
	await expect
		.poll(async () => (await accountState(page)).externalUrls)
		.toEqual(["https://checkout.example.test/connect/acct-fixture"]);
	await expect
		.poll(async () => (await accountState(page)).onboardAttempts)
		.toBe(2);

	await expect(
		page.getByText("Reports on your listings", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Install fails after retrying the local fixture.", {
			exact: true,
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Resolve", exact: true }).click();
	await expect(
		page.getByText("No open reports.", { exact: true })
	).toBeVisible();
	await expect
		.poll(async () => (await accountState(page)).reportActions)
		.toEqual([{ id: "report-fixture", status: "resolved" }]);
});

test("Marketplaces retries source reads and reads back selection, order, add, and removal", async ({
	page,
}) => {
	const fixture = await installFixture(page);
	fixture.sourceListFailures = 1;
	await page.goto(`${STORY_URL}?section=marketplaces`);
	await expect(
		page.getByRole("heading", { name: "Could not load marketplaces" })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	const marketplacesTab = page.getByRole("tab", { name: "Marketplaces" });
	await expect(marketplacesTab).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByText("Community fixture source", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Ryu-hosted plugin", { exact: true })
	).toBeVisible();
	const pluginSources = page
		.locator("section")
		.filter({ has: page.getByRole("heading", { name: "Apps and plugins" }) });
	const communitySource = pluginSources
		.getByText("Community fixture source", { exact: true })
		.locator("xpath=../../..");
	await communitySource.getByRole("button", { name: "Use source" }).click();
	await expect(
		communitySource.getByRole("button", { name: "Selected" })
	).toBeDisabled();
	expect(fixture.catalogSources.plugin?.active).toBe("community-plugin-source");
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources/select" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([{ id: "community-plugin-source", kind: "plugin" }]);

	await pluginSources
		.getByRole("button", { name: "Move Community fixture source up" })
		.click();
	expect(fixture.catalogSources.plugin?.sources[0]?.id).toBe(
		"community-plugin-source"
	);
	await expect(
		pluginSources.getByRole("button", {
			name: "Move Community fixture source up",
		})
	).toBeDisabled();
	await pluginSources
		.getByRole("button", { name: "Move Community fixture source down" })
		.click();
	expect(fixture.catalogSources.plugin?.sources[1]?.id).toBe(
		"community-plugin-source"
	);
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources/reorder" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([
		{ direction: "up", id: "community-plugin-source", kind: "plugin" },
		{ direction: "down", id: "community-plugin-source", kind: "plugin" },
	]);

	await page.getByRole("button", { name: "Add marketplace" }).click();
	const dialog = page.getByRole("dialog", { name: "Add a marketplace" });
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toContainText(
		"Name, id, and repository or URL are required."
	);
	await dialog
		.getByRole("textbox", { name: "Name" })
		.fill("Private fixture marketplace");
	await dialog
		.getByRole("textbox", { name: "Id" })
		.fill("fixture/private-catalog");
	await dialog
		.getByRole("textbox", { name: "Repository or manifest URL" })
		.fill("https://github.com/fixture/private-catalog");
	await dialog.getByRole("button", { name: "Apps and plugins" }).click();
	await dialog.getByRole("button", { name: "Skills" }).click();
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toContainText("Choose at least one catalog section.");
	await dialog.getByRole("button", { name: "Apps and plugins" }).click();
	await dialog.getByRole("button", { name: "Skills" }).click();
	await dialog
		.getByRole("textbox", { name: "Auth environment variable (optional)" })
		.fill("GITHUB_TOKEN");
	const authReference = `${String.fromCharCode(36)}{GITHUB_TOKEN}`;
	await dialog.getByRole("button", { name: "Add marketplace" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(2);
	await expect(page.getByText("Auth configured", { exact: true })).toHaveCount(
		2
	);
	const addRequests = fixture.calls.filter(
		(call) => call.path === "/api/catalog/sources" && call.method === "POST"
	);
	expect(addRequests.map((call) => call.body)).toEqual([
		{
			auth: { bearer: authReference },
			base_url: "https://github.com/fixture/private-catalog",
			display_name: "Private fixture marketplace",
			id: "fixture/private-catalog",
			kind: "plugin",
		},
		{
			auth: { bearer: authReference },
			base_url: "https://github.com/fixture/private-catalog",
			display_name: "Private fixture marketplace",
			id: "fixture/private-catalog",
			kind: "skill",
		},
	]);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-sources-auth-reference-readback.png"
		),
	});

	await pluginSources
		.getByRole("button", { name: "Remove Private fixture marketplace" })
		.click();
	await expect(
		pluginSources.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByText("Private fixture marketplace", { exact: true })
	).toHaveCount(1);
	expect(
		fixture.calls
			.filter(
				(call) =>
					call.path === "/api/catalog/sources" && call.method === "DELETE"
			)
			.map((call) => call.body)
	).toEqual([{ id: "fixture/private-catalog", kind: "plugin" }]);
});
