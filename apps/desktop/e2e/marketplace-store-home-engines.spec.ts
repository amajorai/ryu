// Marketplace Store home proof. Engines list, installed engine menus, update and remove.

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
	deferred,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

registerStoreHomeEvidenceHooks();

test("Engine Try again reloads text, image, speech, and sandbox catalogs after a full list failure", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.engineCatalogFailures = 2;
	fixture.sandboxListFailures = 1;
	await page.goto(`${STORY_URL}?section=engines`);
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await expect(page.getByText("Could not load engines")).toBeVisible();
	await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
	expect(callsFor(fixture, "GET", "/api/catalog")).toHaveLength(2);
	expect(callsFor(fixture, "GET", "/api/sandbox/backend")).toHaveLength(1);

	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("heading", { name: "Text and Embedding" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Image" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Speech" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
	await expect(page.getByRole("button", { name: "llama.cpp" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Docker Fixture" })
	).toBeVisible();
	expect(callsFor(fixture, "GET", "/api/catalog")).toHaveLength(4);
	expect(callsFor(fixture, "GET", "/api/sandbox/backend")).toHaveLength(2);
});

test("Engines list groups and searches local runtime fixtures, and sandbox docs links stay safe", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await expect(
		page.getByRole("heading", { name: "Text and Embedding" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Image" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Speech" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "VLLM Unsupported Fixture" })
	).toBeVisible();
	const dockerCard = page
		.getByRole("button", { name: "Docker Fixture" })
		.locator("xpath=..");
	const dockerGuide = dockerCard.getByRole("link", { name: "How to install" });
	await expect(dockerGuide).toHaveAttribute(
		"href",
		"https://docs.docker.com/get-started/get-docker/"
	);
	await expect(dockerGuide).toHaveAttribute("target", "_blank");
	await expect(dockerGuide).toHaveAttribute("rel", "noopener noreferrer");

	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search engines…");
	await search.fill("pocket");
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Ollama Fixture" })
	).toHaveCount(0);
	await search.fill("no-such-engine");
	await expect(page.getByText("No engines found")).toBeVisible();
	const clearActions = page.getByRole("button", { name: "Clear search" });
	await expect(clearActions).toHaveCount(2);
	await clearActions.last().click();
	await expect(search).toHaveValue("");
	await expect(
		page.getByRole("button", { name: "Ollama Fixture" })
	).toBeVisible();
	await search.press("Escape");
	await expect(search).toHaveAttribute("aria-hidden", "true");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(search).toHaveAttribute("aria-hidden", "false");
	await search.fill("no-such-engine");
	await expect(page.getByText("No engines found")).toBeVisible();
	await page.getByLabel("Clear search").click();
	await expect(search).toHaveValue("");
	await expect(search).toHaveAttribute("aria-hidden", "true");
	await expect(page.getByText("No engines found")).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engines-catalog.png"),
	});
	expect(callsFor(fixture, "GET", "/api/catalog").length).toBeGreaterThan(0);
});

test("Installed engine card menus activate and remove the exact local engine", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.engineNew}:install`] = 1;
	const koboldCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await koboldCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		koboldCard.getByText("Fixture install failed", { exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await expect(
		koboldCard.getByRole("button", { name: "Installed" })
	).toBeVisible();
	await page.reload();

	const installedKoboldCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await installedKoboldCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Set as active" }).click();
	await expect.poll(() => fixture.engineActive).toBe(IDS.engineNew);

	await page
		.getByRole("button", { name: "Ollama Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Set as active" }).click();
	await expect.poll(() => fixture.engineActive).toBe(IDS.engineUpdate);

	await page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect
		.poll(() => fixture.engineInstalled.has(IDS.engineNew))
		.toBe(false);
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Get" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }, { name: IDS.engineUpdate }]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([
		{ search: "", body: null },
		{ search: "", body: null },
	]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/uninstall`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Get" })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-card-actions.png"),
	});
});

test("Engine update and Remove retry exact sidecar requests and read installed state back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.engineUpdate}:install`] = 1;
	await page.getByRole("button", { name: "Ollama Fixture" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Ollama Fixture");
	const update = details.getByRole("button", { name: "Update" });
	await update.click();
	await expect(details.getByText("Fixture install failed")).toBeVisible();
	await update.click();
	await expect(details.getByRole("button", { name: "Update" })).toHaveCount(0);
	expect(fixture.engineInstalledVersions[IDS.engineUpdate]).toBe("0.3.0");
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/install`).map(
			(call) => call.search
		)
	).toEqual(["?force=true", "?force=true"]);

	fixture.engineActionFailures[`${IDS.engineUpdate}:uninstall`] = 1;
	const remove = details.getByRole("button", { name: "Remove" });
	await remove.click();
	await expect(details.getByText("Fixture uninstall failed")).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineUpdate)).toBe(true);
	const removeGate = deferred();
	fixture.engineActionGates[`${IDS.engineUpdate}:uninstall`] = removeGate;
	await remove.click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/uninstall`)
					.length
		)
		.toBe(2);
	await expect(remove).toBeDisabled();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	removeGate.release();
	await expect(
		details.getByRole("button", { name: "Add", exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineUpdate)).toBe(false);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/uninstall`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
});
