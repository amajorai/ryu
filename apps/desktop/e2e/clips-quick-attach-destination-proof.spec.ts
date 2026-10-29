import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked proof images.
const proofDir = process.env.RYU_PROOF_OUTPUT_ROOT
	? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT)
	: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/clips-quick-attach-destination"
		);

test("selects and saves every Clips destination", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.setViewportSize({ width: 1440, height: 440 });
	await page.goto("/clips-quick-attach-destination-proof.html", {
		waitUntil: "domcontentloaded",
	});

	await expect(
		page.getByRole("heading", { name: "Clips quick attach" })
	).toBeVisible();
	const destination = page.getByRole("combobox", { name: "Clips destination" });
	await expect(destination).toContainText("Automatic");

	await destination.click();
	await expect(
		page.getByRole("option", {
			name: /Use the selected chat when a chat tab is active/,
		})
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: /Always use the selected chat/ })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: /Always start a new chat/ })
	).toBeVisible();
	await page
		.getByRole("option", { name: /Always use the selected chat/ })
		.click();
	await expect(destination).toContainText("Current chat");
	await expect(page.locator("body")).toHaveAttribute(
		"data-saved-destination",
		"current_chat"
	);

	await destination.click();
	await page.getByRole("option", { name: /Always start a new chat/ }).click();
	await expect(destination).toContainText("New chat");
	await expect(page.locator("body")).toHaveAttribute(
		"data-saved-destination",
		"new_chat"
	);

	await destination.click();
	await page
		.getByRole("option", {
			name: /Use the selected chat when a chat tab is active/,
		})
		.click();
	await expect(destination).toContainText("Automatic");
	await expect(page.locator("body")).toHaveAttribute(
		"data-saved-destination",
		"automatic"
	);

	await destination.click();
	await expect(
		page.getByRole("option", { name: /Always start a new chat/ })
	).toBeVisible();
	mkdirSync(proofDir, { recursive: true });
	await page.screenshot({
		clip: { height: 380, width: 1000, x: 250, y: 0 },
		path: path.join(
			proofDir,
			"clips-quick-attach-destination-dark-options.png"
		),
	});
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("option", { name: /Always start a new chat/ })
	).not.toBeVisible();
	await page.screenshot({
		clip: { height: 380, width: 1000, x: 250, y: 0 },
		path: path.join(proofDir, "clips-quick-attach-destination-dark.png"),
	});
	await page
		.locator("html")
		.evaluate((element) => element.classList.remove("dark"));
	await destination.click();
	await expect(
		page.getByRole("option", { name: /Always use the selected chat/ })
	).toBeVisible();
	await page.screenshot({
		clip: { height: 380, width: 1000, x: 250, y: 0 },
		path: path.join(
			proofDir,
			"clips-quick-attach-destination-light-options.png"
		),
	});
	await page.keyboard.press("Escape");

	await page.setViewportSize({ width: 390, height: 844 });
	await destination.click();
	await expect(
		page.getByRole("option", { name: /Always use the selected chat/ })
	).toBeVisible();
	const overflowsHorizontally = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth
	);
	expect(overflowsHorizontally).toBe(false);
	expect(pageErrors).toEqual([]);
});
