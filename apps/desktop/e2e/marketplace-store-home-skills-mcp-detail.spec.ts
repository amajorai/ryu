// Marketplace Store home proof. Skills and MCP detail install, activation and context actions.

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
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

registerStoreHomeEvidenceHooks();

test("Skills detail Add retries, activates from persisted state, edits, and closes", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillInstallFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	const alphaCard = page.getByRole("button", { name: /alpha assistant/i });
	await alphaCard.click();
	await expect
		.poll(() => {
			const detail = callsFor(fixture, "GET", "/api/skills/catalog/detail").at(
				-1
			);
			return new URLSearchParams(detail?.search).get("id");
		})
		.toBe(IDS.skillAlpha);
	const repositoryLink = page.getByRole("link", { name: "GitHub" });
	await expect(repositoryLink).toHaveAttribute(
		"href",
		"https://fixture.invalid/skills"
	);
	await expect(repositoryLink).toHaveAttribute("target", "_blank");
	await expect(repositoryLink).toHaveAttribute("rel", "noopener noreferrer");
	await page
		.getByRole("button", { name: "More by Fixture Skills Registry" })
		.click();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Filters" }).click();
	await expect(page.getByText("Org: Fixture Skills Registry")).toBeVisible();
	await page
		.getByRole("button", {
			name: "Remove filter Org: Fixture Skills Registry",
		})
		.click();
	await expect(page.getByText("Org: Fixture Skills Registry")).toHaveCount(0);
	await page.getByRole("button", { name: /alpha assistant/i }).click();
	await page
		.getByRole("button", { name: "references/DETAIL.md", exact: true })
		.click();
	await expect(
		page.getByText("Reference content for selection proof.")
	).toBeVisible();
	const installedReadsBeforeInstall = callsFor(
		fixture,
		"GET",
		"/api/skills"
	).length;
	const addSkill = page.getByRole("button", { name: "Add skill" });
	await addSkill.click();
	await confirmSkillSetChange(page, fixture, "/api/skills/catalog/install");
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(1);
	await addSkill.click();
	await confirmSkillSetChange(page, fixture, "/api/skills/catalog/install");
	await expect(page.getByText("Added", { exact: true }).first()).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{
			id: IDS.skillAlpha,
			promptForTargets: true,
			source: "fixture-skill-registry",
		},
		{
			id: IDS.skillAlpha,
			promptForTargets: true,
			source: "fixture-skill-registry",
		},
	]);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills").length)
		.toBeGreaterThan(installedReadsBeforeInstall);
	expect(fixture.skillInstalled.has(IDS.skillAlpha)).toBe(true);

	const enableSkill = page.getByRole("switch", { name: "Disabled" });
	await enableSkill.click();
	await confirmSkillSetChange(page, fixture, "/api/skills/activate");
	await expect(page.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	expect(
		callsFor(fixture, "POST", "/api/skills/activate").at(-1)?.body
	).toEqual({
		active: true,
		id: IDS.skillAlpha,
	});
	expect(fixture.skillActiveById[IDS.skillAlpha]).toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-skills-enabled.png"),
	});
	const useWithAgents = page.getByRole("button", { name: "Use with agents" });
	await useWithAgents.click();
	const targetDialog = page.getByRole("dialog", {
		name: "Use this skill with local agents",
	});
	await expect(targetDialog).toBeVisible();
	await page.getByRole("checkbox", { name: "Fixture Code Agent" }).click();
	await page.getByRole("button", { name: "Show all supported agents" }).click();
	const targetSearch = page.getByRole("searchbox", {
		name: "Search supported agents",
	});
	await targetSearch.fill("unavailable");
	await expect(
		page.getByRole("checkbox", { name: "Unavailable Fixture Agent" })
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveCount(0);
	await targetSearch.fill("");
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveAttribute("aria-checked", "true");
	const rememberTargets = page.getByRole("checkbox", {
		name: "Remember for future skill installs",
	});
	await rememberTargets.click();
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await expect(targetDialog).toHaveCount(0);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/skills/${encodeURIComponent(IDS.skillAlpha)}/distribute`
		).at(-1)?.body
	).toEqual({ rememberTargetIds: true, targetIds: ["fixture-code-agent"] });
	expect(fixture.skillTargetPreferences).toEqual({
		configured: true,
		targetIds: ["fixture-code-agent"],
		version: 1,
	});
	await useWithAgents.click();
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("checkbox", { name: "Remember for future skill installs" })
	).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/skills/${encodeURIComponent(IDS.skillAlpha)}/distribute`
		)
	).toHaveLength(1);

	const editNavigation = page.evaluate(
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
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	expect(await editNavigation).toBe(`/skills/${IDS.skillAlpha}/edit`);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
	await page.getByRole("button", { name: /Get — 22 downloads/ }).click();
	await confirmSkillSetChange(page, fixture, "/api/skills/catalog/install");
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(3);
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.skill,
		promptForTargets: true,
		source: "fixture-skill-registry",
	});
	expect(fixture.skillInstalled.has(IDS.skill)).toBe(true);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	const customSkillCard = page
		.locator("div.group.relative")
		.filter({ hasText: "custom helper" });
	const customSkillLike = customSkillCard.getByTestId("item-like-button");
	await customSkillLike.click();
	await expect(
		customSkillCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: IDS.skillCustom,
	});
	await customSkillCard.getByRole("button", { name: "Unlike (3)" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: IDS.skillCustom,
	});
	await customSkillCard.locator("button").first().click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await confirmSkillSetChange(page, fixture, "/api/skills/catalog/install");
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(4);
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.skillCustom,
		promptForTargets: true,
		source: "fixture-custom-skills",
	});
	expect(fixture.skillInstalled.has(IDS.skillCustom)).toBe(true);
});

test("MCP catalog source, search, detail, and context install retry read back", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.mcpInstallFailures = 2;
	await page.goto(`${STORY_URL}?section=mcp`);
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	await page.getByRole("button", { name: "Source", exact: true }).click();
	await page.getByRole("combobox").first().click();
	await page.getByRole("option", { name: "Alternate MCP Registry" }).click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/select").at(-1)?.body
	).toEqual({
		id: "fixture-mcp-alt",
		kind: "mcp",
	});
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toHaveCount(0);
	const alternateCard = page
		.getByRole("button", { name: "Alternate MCP Fixture" })
		.locator("xpath=..");
	await alternateCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		alternateCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: `mcp:${IDS.mcpAlternate}`,
	});
	await alternateCard.getByRole("button", { name: "Unlike (3)" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: `mcp:${IDS.mcpAlternate}`,
	});

	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search MCP servers…");
	await search.fill("alternate");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/mcp/catalog").some(
				(call) => new URLSearchParams(call.search).get("query") === "alternate"
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	const searchRead = callsFor(fixture, "GET", "/api/mcp/catalog").at(-1);
	expect(new URLSearchParams(searchRead?.search).get("query")).toBe(
		"alternate"
	);
	await page.getByLabel("Clear search").click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await search.fill("no-such-mcp-fixture");
	await expect(page.getByText("No MCP servers found")).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();

	const server = page.getByRole("button", { name: "Alternate MCP Fixture" });
	await server.click();
	await expect
		.poll(() => {
			const detail = callsFor(fixture, "GET", "/api/mcp/catalog/detail").at(-1);
			return new URLSearchParams(detail?.search).get("id");
		})
		.toBe(IDS.mcpAlternate);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Alternate MCP Fixture" }).click({
		button: "right",
	});
	await page.getByRole("menuitem", { name: "Get" }).click();
	const serverReadCountBeforeInstall = callsFor(
		fixture,
		"GET",
		"/api/mcp/servers"
	).length;
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/mcp/catalog/install").length)
		.toBe(1);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/mcp/catalog/install").length)
		.toBe(2);
	const detailAdd = page.getByRole("button", { name: "Add server" });
	await expect(detailAdd).toBeVisible();
	await detailAdd.click();
	await expect(page.getByText("Added", { exact: true }).first()).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	expect(
		callsFor(fixture, "POST", "/api/mcp/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{ force: false, id: IDS.mcpAlternate },
		{ force: false, id: IDS.mcpAlternate },
		{ force: false, id: IDS.mcpAlternate },
	]);
	expect(fixture.mcpInstalled.has(IDS.mcpAlternate)).toBe(true);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/mcp/servers").length)
		.toBeGreaterThan(serverReadCountBeforeInstall);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-mcp-installed.png"),
	});
});
