import path from "node:path";
import { expect, test } from "@playwright/test";

const PROOF_ROOT = path.resolve(import.meta.dirname, "../test-results");

test.describe("per-tab Library and Marketplace view modes", () => {
	test("keeps Showcase as the default and remembers Grid/List per tab", async ({
		page,
	}) => {
		await page.goto("/view-mode-proof.html");
		await page.evaluate(() => localStorage.clear());
		await page.reload();

		const libraryPanel = page.getByTestId("library-panel");
		const storePanel = page.getByTestId("store-panel");
		const libraryControl = page.getByTestId("library-view-control");
		const storeControl = page.getByTestId("store-view-control");
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "showcase");
		await expect(
			storeControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "showcase");
		await expect(page.getByTestId("library-showcase")).toBeVisible();
		await expect(page.getByTestId("store-panel")).toContainText("Atlas");
		await page.screenshot({
			path: path.join(PROOF_ROOT, "view-mode-showcase-proof.png"),
			fullPage: true,
		});

		await libraryControl.getByRole("button", { name: "Grid view" }).click();
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");
		await expect(page.getByTestId("library-showcase")).toHaveCount(0);

		await libraryPanel.getByTestId("tab-spaces").click();
		await expect(libraryPanel.getByTestId("tab-spaces")).toHaveAttribute(
			"aria-selected",
			"true"
		);
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "showcase");
		await expect(page.getByTestId("library-showcase")).toBeVisible();
		await libraryControl.getByRole("button", { name: "List view" }).click();
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "list");
		await expect(page.getByTestId("library-showcase")).toHaveCount(0);
		await page.screenshot({
			path: path.join(PROOF_ROOT, "view-mode-list-spaces-proof.png"),
			fullPage: true,
		});
		await libraryPanel.getByTestId("tab-agents").click();
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");

		await storeControl.getByRole("button", { name: "Grid view" }).click();
		await expect(
			storeControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");
		await expect(page.getByTestId("store-panel")).toContainText("Atlas");
		await storePanel.getByTestId("tab-skills").click();
		await expect(
			storeControl.getByRole("button", { name: "Showcase view" })
		).toHaveCount(0);
		await storePanel.getByTestId("tab-agents").click();
		await expect(
			storeControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");

		await page.reload();
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");
		await expect(
			storeControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "grid");
		await libraryPanel.getByTestId("tab-spaces").click();
		await expect(libraryPanel.getByTestId("tab-spaces")).toHaveAttribute(
			"aria-selected",
			"true"
		);
		await expect(
			libraryControl.locator('[data-slot="view-toggle"]')
		).toHaveAttribute("data-view-mode", "list");
		await page.screenshot({
			path: path.join(PROOF_ROOT, "view-mode-grid-list-proof.png"),
			fullPage: true,
		});
	});
});
