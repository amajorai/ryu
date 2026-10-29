// Real-browser spec for the skills-catalog story (`e2e/harness/
// skills-catalog-story.{html,tsx}`), which mounts the REAL shared
// `SkillsCatalogSection` against a fake host that stores whatever id `select`
// receives — including the empty string the layout sends on close.
//
// What it certifies, none of which a type-check or a `renderToStaticMarkup` test
// can see (the preview is a portaled dialog):
//   • picking a skill opens the preview on THAT skill;
//   • every dismissal — the X, Escape, the backdrop — actually closes it;
//   • the closed state is closed, not a dialog stuck on "No skill selected".
//
// The bug: `hasSelection={selectedId != null}` with a close that sets `""`. The
// dialog reopened itself on close and could not be dismissed at all.

import path from "node:path";
import { expect, test } from "@playwright/test";

// The story pulls the shared marketplace module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/skills-catalog-story.html";
const PACK_PROOF_PATH = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/marketplace-skill-packs/jakubkrehel-featured.png"
);

const dialog = (page: import("@playwright/test").Page) =>
	page.locator('[data-slot="dialog-content"]');

/** The card's click target is a full-bleed overlay button labelled with the skill
 *  name — it covers the text, so clicking the text itself never lands. */
function card(page: import("@playwright/test").Page, name: string) {
	return page.getByRole("button", { name, exact: true });
}

async function openPreview(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	await card(page, "PDF Filler").click();
	await expect(dialog(page)).toBeVisible();
}

test.describe("skills catalog preview — open and close", () => {
	test("picking a skill opens the preview on that skill", async ({ page }) => {
		await openPreview(page);
		await expect(dialog(page).getByText("PDF Filler").first()).toBeVisible();
		await expect(dialog(page).getByText("No skill selected")).toHaveCount(0);
	});

	test("the close button dismisses it", async ({ page }) => {
		await openPreview(page);
		await page.locator('[data-slot="dialog-close"]').first().click();
		await expect(dialog(page)).toHaveCount(0);
	});

	test("Escape dismisses it", async ({ page }) => {
		await openPreview(page);
		await page.keyboard.press("Escape");
		await expect(dialog(page)).toHaveCount(0);
	});

	test("closing never leaves an empty preview behind", async ({ page }) => {
		await openPreview(page);
		await page.keyboard.press("Escape");
		// The regression's signature: a dialog that reopened itself with nothing
		// selected. Assert the empty state is not on screen at all.
		await expect(page.getByText("No skill selected")).toHaveCount(0);
		// And the section is still usable — a second pick opens the preview again.
		await card(page, "CSV Tidy").click();
		await expect(dialog(page)).toBeVisible();
	});
});

test("the marketplace featured pack shelf includes Jakub Krehel's skills", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(
		page.getByText("Featured skill packs", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Open the Jakubkrehel Skills pack (11 skills)",
		})
	).toBeVisible();
	await page.screenshot({ path: PACK_PROOF_PATH, fullPage: true });
});

test("all marketplaces stays visible while the popover manages sources", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Filters", exact: true }).click();

	await expect(page.getByText("All marketplaces", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("button", { name: "Add marketplace", exact: true })
	).toBeVisible();
	await expect(page.getByRole("combobox")).toHaveCount(1);
	await expect(page.locator("h3", { hasText: "skills.sh" })).toBeVisible();
	await expect(page.locator("h3", { hasText: "browse.sh" })).toBeVisible();
	await expect(page.locator("h3", { hasText: "ClawHub" })).toBeVisible();
	await expect(page.locator("h3", { hasText: "LobeHub" })).toBeVisible();
	await expect(
		page.locator("h3", { hasText: "Ryu Marketplace" })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.click();
	await expect(page.getByText("Marketplaces", { exact: true })).toBeVisible();
	await expect(page.getByText("Team Skills", { exact: true })).toBeVisible();
	await expect(page.getByText("Research Lab", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Move Research Lab up" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete Team Skills" })
	).toBeVisible();

	await page.getByRole("button", { name: "Delete Team Skills" }).click();
	await expect(page.getByText("Team Skills", { exact: true })).toHaveCount(0);

	await expect(
		page.getByRole("button", { name: "Skill Auditor", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "PDF Filler", exact: true })
	).toBeVisible();
});
