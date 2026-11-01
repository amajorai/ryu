import { expect, test } from "@playwright/test";

test("shows the explicit Git-backed Memory source controls", async ({
	page,
}) => {
	await page.goto("/memory-git-source-proof.html");
	await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
	// Since fe340dc797 (P9) the Git-backed memory panel opens in a dialog from
	// the header's overflow menu ("Git source…") instead of sitting on the page.
	await page.getByRole("button", { name: "More memory actions" }).click();
	await page.getByRole("menuitem", { name: "Git source…" }).click();
	const panel = page.getByRole("dialog", { name: "Git-backed memory" });
	await expect(panel).toBeVisible();
	await expect(
		panel.getByText("Git-backed memory", { exact: true }).first()
	).toBeVisible();
	await expect(panel.getByText("/Users/demo/memory-repo")).toBeVisible();
	await expect(panel.getByText("main · 2 changed files")).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "Export Markdown" })
	).toBeVisible();
	await expect(
		panel.getByRole("button", { name: "Import changes" })
	).toBeVisible();
	await expect(panel.getByRole("button", { name: "Commit" })).toBeVisible();
	await page.screenshot({
		path: "e2e/proof/memory-git-source-proof.png",
		fullPage: true,
	});
});
