// Marketplace Store home proof. Skills and MCP catalog lists, search, sources and packs.

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
	confirmSkillSetChange,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

registerStoreHomeEvidenceHooks();

test("Skills catalog list failure retries the exact read and restores results", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	await expect(page.getByText("Couldn't load skills")).toBeVisible();
	const initialReadCount = callsFor(
		fixture,
		"GET",
		"/api/skills/catalog"
	).length;
	expect(initialReadCount).toBeGreaterThan(0);
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	const reads = callsFor(fixture, "GET", "/api/skills/catalog");
	expect(reads.length).toBeGreaterThan(initialReadCount);
	for (const read of reads) {
		const query = new URLSearchParams(read.search);
		expect(query.get("limit")).toBe("120");
		expect(query.get("source")).toBe("all");
	}
});

test("MCP catalog list failure offers a retry and restores catalog cards", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.mcpCatalogFailures = 2;
	await page.goto(`${STORY_URL}?section=mcp`);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/mcp/catalog").length)
		.toBe(2);
	for (const read of callsFor(fixture, "GET", "/api/mcp/catalog")) {
		expect(new URLSearchParams(read.search).get("limit")).toBe("40");
	}
	await expect(page.getByText(/Couldn't load MCP servers/)).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	const reads = callsFor(fixture, "GET", "/api/mcp/catalog");
	expect(reads).toHaveLength(3);
	expect(new URLSearchParams(reads.at(-1)?.search).get("limit")).toBe("40");
});

test("Skills search, sort, friendly names, and Installed filters preserve their state", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "skills");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search skills…");
	await search.fill("alpha");
	const alpha = page.getByRole("button", { name: /Alpha Assistant/i });
	await expect(alpha).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toHaveCount(0);
	const queryRead = callsFor(fixture, "GET", "/api/skills/catalog").at(-1);
	expect(new URLSearchParams(queryRead?.search).get("query")).toBe("alpha");
	expect(new URLSearchParams(queryRead?.search).get("limit")).toBe("120");

	await page.getByLabel("Clear search").click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Filters" }).click();
	const sort = page.getByRole("combobox").first();
	await expect(sort).toBeVisible();
	await sort.click();
	const nameSort = page.getByRole("option", {
		exact: true,
		name: "Name (A–Z)",
	});
	await expect(nameSort).toBeVisible();
	await nameSort.click();
	await expect(sort).toContainText("Name (A–Z)");
	const homeSkill = page.getByRole("button", { name: /Home Skill Fixture/ });
	const installedSkill = page.getByRole("button", { name: /Installed Skill/ });
	const homeBounds = await homeSkill.boundingBox();
	const installedBounds = await installedSkill.boundingBox();
	expect(homeBounds?.y).toBeLessThan(
		installedBounds?.y ?? Number.POSITIVE_INFINITY
	);

	const friendly = page.getByRole("switch", { name: "Friendly names" });
	await expect(friendly).toHaveAttribute("aria-checked", "true");
	await friendly.click();
	await expect(friendly).toHaveAttribute("aria-checked", "false");
	await expect(
		page.getByRole("button", { name: /alpha assistant/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByPlaceholder("Search skills…").fill("no-such-skill-fixture");
	await expect(page.getByText("No skills found")).toBeVisible();
	await page.getByRole("button", { name: "Clear filters" }).click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Filters" }).click();
	const addedOnly = page.getByRole("switch", { name: "Added only" });
	await expect(addedOnly).toBeVisible();
	await addedOnly.click();
	await expect(
		page.getByRole("button", { name: /Installed Skill/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toHaveCount(0);
	const installedRead = callsFor(fixture, "GET", "/api/skills/catalog").at(-1);
	expect(new URLSearchParams(installedRead?.search).get("installed_only")).toBe(
		"true"
	);
	const globalInstalled = page
		.getByRole("button", {
			name: "Installed",
			exact: true,
		})
		.first();
	await expect(globalInstalled).toHaveAttribute("aria-pressed", "false");
	await globalInstalled.click();
	await expect(globalInstalled).toHaveAttribute("aria-pressed", "true");
	await expect(addedOnly).toHaveAttribute("aria-checked", "true");
	await page.reload();
	await page.getByRole("button", { name: "Filters" }).click();
	await expect(
		page.getByRole("switch", { name: "Friendly names" })
	).toHaveAttribute("aria-checked", "false");
});

test("Skills marketplace form validates, retries, reorders, and removes exact sources", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "skills");
	fixture.skillSourceAddFailures = 1;
	await page.getByRole("button", { name: "Filters" }).click();
	const newSkillNavigation = page.evaluate(
		() =>
			new Promise<string>((resolveNavigation) => {
				window.addEventListener(
					"marketplace-store:tab",
					(event) => {
						const decode = window.__marketplaceHomeDecodeStringEvent;
						if (!decode) {
							throw new Error(
								"Marketplace Home event decoder is not installed"
							);
						}
						resolveNavigation(decode(event));
					},
					{ once: true }
				);
			})
	);
	await page.getByRole("button", { name: "New skill" }).click();
	expect(await newSkillNavigation).toBe("/skills/new");
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByText("Enter a repo, git URL, or local path")
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/sources")).toHaveLength(0);
	await page
		.getByLabel("Repo, git URL, or local path")
		.fill("owner/my-marketplace");
	await page.getByLabel("Display name (optional)").fill("My Marketplace");
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByText("/api/catalog/sources failed: 503")
	).toBeVisible();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByRole("button", { name: "Add marketplace", exact: true }).first()
	).toBeVisible();
	const additions = callsFor(fixture, "POST", "/api/catalog/sources");
	expect(additions.map((call) => call.body)).toEqual([
		{
			base_url: "owner/my-marketplace",
			display_name: "My Marketplace",
			id: "mp-my-marketplace",
			kind: "skill",
		},
		{
			base_url: "owner/my-marketplace",
			display_name: "My Marketplace",
			id: "mp-my-marketplace",
			kind: "skill",
		},
	]);
	expect(fixture.skillSources.map((source) => source.id)).toContain(
		"mp-my-marketplace"
	);

	await page.reload();
	await page.getByRole("button", { name: "Filters" }).click();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.first()
		.click();
	await expect(page.getByText("My Marketplace", { exact: true })).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-skills-sources.png"),
	});
	await page.getByRole("button", { name: "Move My Marketplace up" }).click();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/reorder").at(-1)?.body
	).toEqual({
		direction: "up",
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await page.getByRole("button", { name: "Move My Marketplace down" }).click();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/reorder").at(-1)?.body
	).toEqual({
		direction: "down",
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await page.getByRole("button", { name: "Delete My Marketplace" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/catalog/sources").at(-1)?.body
	).toEqual({
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await expect(page.getByText("My Marketplace", { exact: true })).toHaveCount(
		0
	);
	expect(
		fixture.skillSources.some((source) => source.id === "mp-my-marketplace")
	).toBe(false);
});

test("Skills packs support keyboard navigation, open/back, and retryable install readback", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillPackInstallFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	const productivityPack = page.getByRole("button", {
		name: "Open the Fixture Productivity Pack pack (2 skills)",
	});
	const researchPack = page.getByRole("button", {
		name: "Open the Fixture Research Pack pack (1 skills)",
	});
	await productivityPack.focus();
	await productivityPack.press("ArrowRight");
	await expect(researchPack).toBeFocused();
	await researchPack.press("ArrowLeft");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("ArrowDown");
	await expect(researchPack).toBeFocused();
	await researchPack.press("ArrowUp");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("End");
	await expect(researchPack).toBeFocused();
	await researchPack.press("Home");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("Enter");
	await expect(
		page.getByRole("button", { name: "Back to packs" })
	).toBeVisible();
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills/packs/detail").length)
		.toBe(1);
	expect(
		new URLSearchParams(
			callsFor(fixture, "GET", "/api/skills/packs/detail").at(-1)?.search
		).get("id")
	).toBe("fixture/productivity-pack");
	await page.getByRole("button", { name: "Back to packs" }).click();
	const installPack = page.getByRole("button", {
		name: "Install the Fixture Productivity Pack pack",
	});
	await installPack.click();
	await confirmSkillSetChange(page, fixture, "/api/skills/packs/install");
	await expect(installPack).toBeVisible();
	await installPack.click();
	await confirmSkillSetChange(page, fixture, "/api/skills/packs/install");
	await productivityPack.click();
	await expect(
		page.getByRole("button", { name: "alpha assistant is installed" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/skills/packs/install").map(
			(call) => call.body
		)
	).toEqual([
		{ id: "fixture/productivity-pack" },
		{ id: "fixture/productivity-pack" },
	]);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills").length)
		.toBeGreaterThan(0);
	expect(fixture.skillInstalled.has(IDS.skillAlpha)).toBe(true);
	expect(fixture.skillInstalled.has(IDS.skillCustom)).toBe(true);
});
