// Marketplace Store home proof. Apps and Plugins catalogs, sources, manifest installs and consent.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
	EVIDENCE_DIR,
	IDS,
	STORY_URL,
} from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";

registerStoreHomeEvidenceHooks();

test("Apps and Plugins isolate their catalogs, retry browse, search, and persist unstable releases", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "apps");
	fixture.appCatalogFailures = 1;
	await page.reload();
	await expect(page.getByText(/Couldn't load apps/)).toBeVisible();
	const retryButton = page.getByRole("button", { name: "Try again" });
	await retryButton.click();
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toHaveCount(0);
	const firstPartyReads = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).filter((call) => !new URLSearchParams(call.search).has("origin"));
	expect(firstPartyReads.slice(-2).map((call) => call.search)).toEqual([
		"?limit=40&source=all",
		"?limit=40&source=all",
	]);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search apps…");
	await search.fill("native");
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toHaveCount(0);
	await expect
		.poll(() => {
			const read = callsFor(fixture, "GET", "/api/plugins/catalog/browse").find(
				(call) => new URLSearchParams(call.search).get("query") === "native"
			);
			return read?.search;
		})
		.toBe("?query=native&limit=40&source=all");
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByPlaceholder("Search apps…")).toHaveValue("");
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Show more" }).click();
	await expect(
		page.getByText("Fixture Extra App 8", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Open Productivity" }).click();
	await expect(
		page.getByRole("heading", { name: "Productivity", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Back to categories" }).click();
	await expect(
		page.getByRole("button", { name: "Open Productivity" })
	).toBeVisible();

	fixture.appCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=plugins`);
	await expect(page.getByText(/Couldn't load plugins/)).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toBeVisible();
	const pluginReads = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).filter((call) => {
		const params = new URLSearchParams(call.search);
		return !(
			params.has("origin") ||
			params.has("cursor") ||
			params.has("query")
		);
	});
	expect(pluginReads.slice(-2).map((call) => call.search)).toEqual([
		"?limit=40&source=all",
		"?limit=40&source=all",
	]);
	await expect(page.getByText("Fixture Home App", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Filters" }).click();
	const browseReadsBeforeTag = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).length;
	const tagSelect = page
		.getByText("Tag", { exact: true })
		.locator("..")
		.getByRole("combobox");
	await tagSelect.click();
	await page.getByRole("option", { name: "developer", exact: true }).click();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toHaveCount(0);
	expect(callsFor(fixture, "GET", "/api/plugins/catalog/browse")).toHaveLength(
		browseReadsBeforeTag
	);
	await tagSelect.click();
	await page.getByRole("option", { name: "All tags", exact: true }).click();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toBeVisible();
	const showUnstable = page.getByRole("checkbox", {
		name: "Show unstable releases",
	});
	await showUnstable.check();
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugins-unstable.png"),
	});
});

test("Plugins infinite scroll follows the exact next cursor after reaching the sentinel", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 620 });
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByPlaceholder("Search plugins…").fill("paging-fixture");
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 1", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 24", exact: true })
	).toBeVisible();
	const firstPage = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).find(
		(call) =>
			new URLSearchParams(call.search).get("query") === "paging-fixture" &&
			!new URLSearchParams(call.search).has("cursor") &&
			!new URLSearchParams(call.search).has("origin")
	);
	expect(firstPage?.search).toBe("?query=paging-fixture&limit=40&source=all");
	await page
		.getByRole("button", { name: "Pagination Plugin 24", exact: true })
		.scrollIntoViewIfNeeded();
	await expect
		.poll(() => {
			const pageTwo = callsFor(
				fixture,
				"GET",
				"/api/plugins/catalog/browse"
			).find(
				(call) =>
					new URLSearchParams(call.search).get("cursor") === "fixture-next-page"
			);
			return pageTwo?.search;
		})
		.toBe("?query=paging-fixture&limit=40&cursor=fixture-next-page&source=all");
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 25", exact: true })
	).toBeVisible();
});

test("Plugins source management and manifest URL install validate, retry, and read back local state", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.pluginSourceAddFailures = 1;
	fixture.appUrlInstallFailures = 1;
	await page.getByRole("button", { name: "Filters" }).click();
	const addMarketplaceButton = page
		.getByRole("button", {
			name: "Add marketplace",
			exact: true,
		})
		.first();
	await addMarketplaceButton.hover();
	const marketplaceTooltip = page.getByText("Add a Claude plugin marketplace", {
		exact: true,
	});
	await expect(marketplaceTooltip).toBeVisible();
	await expect(marketplaceTooltip).toHaveCSS("pointer-events", "none");
	await expect(marketplaceTooltip.locator("xpath=..")).toHaveCSS(
		"pointer-events",
		"none"
	);
	const catalogSource = page
		.getByText("Catalog source", { exact: true })
		.locator("..");
	const catalogSourcePicker = catalogSource.getByRole("combobox");
	await catalogSourcePicker.click();
	await page.getByRole("option", { name: "Fixture Plugin Source" }).click();
	await expect(catalogSourcePicker).toContainText("Fixture Plugin Source");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/plugins/catalog/browse").some(
				(call) =>
					new URLSearchParams(call.search).get("source") ===
					"fixture-plugin-source"
			)
		)
		.toBe(true);
	expect(
		callsFor(fixture, "GET", "/api/plugins/catalog/browse").at(-1)?.search
	).toBe("?limit=40&source=fixture-plugin-source");

	await page.getByRole("button", { name: "Add marketplace" }).first().click();
	const repoField = page.getByLabel("Repo, git URL, or local path");
	const nameField = page.getByLabel("Display name (optional)");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(
		page.getByText("Enter a repo, git URL, or local path")
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/sources")).toHaveLength(0);
	await repoField.fill("  owner/fixture-marketplace  ");
	await nameField.fill("  Fixture Team  ");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(page.getByText("Fixture source add failed")).toBeVisible();
	await expect(repoField).toHaveValue("  owner/fixture-marketplace  ");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(repoField).toHaveCount(0);
	await page.getByRole("button", { name: "Add marketplace" }).click();
	await expect(repoField).toHaveValue("");
	await repoField.press("Escape");
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources").map((call) => call.body)
	).toEqual([
		{
			base_url: "owner/fixture-marketplace",
			display_name: "Fixture Team",
			id: "mp-fixture-team",
			kind: "plugin",
		},
		{
			base_url: "owner/fixture-marketplace",
			display_name: "Fixture Team",
			id: "mp-fixture-team",
			kind: "plugin",
		},
	]);
	expect(fixture.pluginSources.at(-1)).toEqual({
		base_url: "owner/fixture-marketplace",
		builtin: false,
		display_name: "Fixture Team",
		id: "mp-fixture-team",
	});
	await catalogSourcePicker.click();
	await expect(
		page.getByRole("option", { name: "Fixture Team" })
	).toBeVisible();
	await page.getByRole("option", { name: "Fixture Team" }).click();
	await expect(catalogSourcePicker).toContainText("Fixture Team");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/plugins/catalog/browse").some(
				(call) =>
					new URLSearchParams(call.search).get("source") === "mp-fixture-team"
			)
		)
		.toBe(true);

	const urlField = page.getByPlaceholder("https://…/manifest.json");
	await urlField.fill(
		"  https://github.com/fixture/url-plugin/manifest.json  "
	);
	await page.getByRole("button", { name: "Add from URL" }).click();
	await expect(urlField).toHaveValue(
		"  https://github.com/fixture/url-plugin/manifest.json  "
	);
	await expect(
		page.getByText("Gateway unreachable (fail-closed): gateway unreachable", {
			exact: true,
		})
	).toBeVisible();
	await urlField.press("Enter");
	await expect(urlField).toHaveValue("");
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").map((call) => call.body)
	).toEqual([
		{ url: "https://github.com/fixture/url-plugin/manifest.json" },
		{ url: "https://github.com/fixture/url-plugin/manifest.json" },
	]);
	expect(fixture.appsInstalled.has(IDS.urlPlugin)).toBe(true);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/plugins").length)
		.toBeGreaterThan(0);
	await page.reload();
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Get", exact: true })
	).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugin-url-installed.png"),
	});
});

test("Apps install retries, consent gates enable, and enable/disable state reads back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "apps");
	fixture.appInstallFailures = 1;
	const appCard = page
		.getByRole("button", { name: "Fixture Home App" })
		.locator("xpath=..");
	await appCard.getByRole("button", { name: "Get", exact: true }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home App");
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.app)).toBe(true);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/install`
		)
	).toHaveLength(2);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/plugins").length)
		.toBeGreaterThan(1);

	const enable = details.getByRole("button", { name: "Enable", exact: true });
	await enable.click();
	const consent = page.getByRole("alertdialog");
	await expect(consent).toContainText("Enable Fixture Home App?");
	await expect(consent).toContainText("Access the internet");
	await expect(consent).toContainText("Make network requests");
	await consent.getByRole("button", { name: "Cancel" }).click();
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/enable`
		)
	).toHaveLength(0);

	await details.getByRole("button", { name: "Enable", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Allow" })
		.click();
	await expect(
		details.getByRole("button", { name: "Disable", exact: true })
	).toBeVisible();
	expect(fixture.appEnabled.has(IDS.app)).toBe(true);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/enable`
		).map((call) => call.body)
	).toEqual([null]);

	await details.getByRole("button", { name: "Disable", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appEnabled.has(IDS.app)).toBe(false);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/disable`
		).map((call) => call.body)
	).toEqual([null]);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-app-disabled-readback.png"),
	});
});
