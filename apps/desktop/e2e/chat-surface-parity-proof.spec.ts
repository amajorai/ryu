// Real-browser proof for shared behavior across the desktop, floating, island,
// and side-chat surfaces.

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const SURFACE_IDS = ["desktop", "floating", "island", "side"];

async function openStory(page: Page) {
	await page.goto("/chat-surface-parity-story.html");
	await expect(page.getByTestId("surface-state")).toBeVisible();
	await expect(page.locator("[data-surface]")).toHaveCount(SURFACE_IDS.length);
	await expect(
		page.locator('[data-slot="message-navigation-collapsed-rail"]')
	).toHaveCount(SURFACE_IDS.length);
}

test("keeps the shared rail, tool UI, mention, and composer directory on every surface", async ({
	page,
}) => {
	await openStory(page);

	for (const surfaceId of SURFACE_IDS) {
		const surface = page.locator(`[data-surface="${surfaceId}"]`);
		await expect(
			surface.locator('[data-slot="message-navigation-collapsed-rail"]')
		).toHaveCount(1);
		await expect(surface.locator('[data-mention-token="agent"]')).toBeVisible();
		await expect(surface.locator('[data-slot="agent-ui"]')).toHaveCount(2);
		await expect(surface.getByText("Shared JSON UI")).toBeVisible();
		await expect(surface.getByText("A2UI shared preview")).toBeVisible();
		await expect(
			surface.getByText("Mapped into Ryu's native catalog")
		).toBeVisible();
		await expect(surface.locator("textarea")).toHaveCount(1);
	}
});

test("uses the same searchable + directory behavior in compact and full surfaces", async ({
	page,
}) => {
	await openStory(page);

	for (const surfaceId of SURFACE_IDS) {
		const surface = page.locator(`[data-surface="${surfaceId}"]`);
		await surface.getByRole("button", { name: "Add" }).click();
		const menu = page.getByRole("listbox").last();
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("option", { name: "Ryu" })).toBeVisible();
		await menu.getByRole("option", { name: "Ryu" }).click();
		await expect(surface.locator("textarea")).toHaveValue(
			"@Ryu review this shared surface @Ryu "
		);
	}
});

test("captures the completed cross-surface proof", async ({
	page,
}, testInfo) => {
	await openStory(page);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-surface-parity-proof.png"),
	});
});
