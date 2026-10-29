// Real-browser proof for the compact node selector's status treatment.

import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 240_000 });

const STORY_URL = "/node-selector-status-story.html";

test("keeps the node icon neutral and anchors status at its bottom right", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(1000);

	const trigger = page.getByRole("button", { name: /Your computer/i });
	if ((await trigger.count()) === 0 && pageErrors.length > 0) {
		throw new Error(
			`Node selector story failed to mount: ${pageErrors.join(" | ")}`
		);
	}
	await expect(trigger).toBeVisible();

	const triggerIcon = trigger.locator('[data-slot="node-status-icon"]');
	const triggerDot = triggerIcon.locator('[data-slot="node-status-dot"]');
	await expect(triggerIcon).toHaveCount(1);
	await expect(triggerDot).toHaveCount(1);
	await expect(triggerDot).toHaveClass(/bg-success/);
	await expect(triggerDot).toHaveClass(/border-sidebar/);
	await expect(triggerIcon.locator("svg")).toHaveClass(
		/text-muted-foreground\/70/
	);
	await expect(triggerIcon.locator("svg")).not.toHaveClass(/text-success/);

	const iconBox = await triggerIcon.boundingBox();
	const dotBox = await triggerDot.boundingBox();
	expect(iconBox).not.toBeNull();
	expect(dotBox).not.toBeNull();
	if (iconBox && dotBox) {
		expect(dotBox.x).toBeGreaterThan(iconBox.x + iconBox.width / 2);
		expect(dotBox.y).toBeGreaterThan(iconBox.y + iconBox.height / 2);
	}

	await trigger.click();
	const activeRow = page.getByRole("menuitem", { name: /^Your computer/ });
	await expect(activeRow).toBeVisible();
	await expect(activeRow.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/
	);
	await expect(activeRow.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/border-accent/
	);
	const shadowRow = page.getByRole("menuitem", { name: /^Shadow/ });
	await expect(shadowRow).toBeVisible();
	await expect(shadowRow.locator('span[class*="size-1.5"]')).toHaveClass(
		/bg-success/
	);
	await expect(page.getByRole("menuitem", { name: /Island/i })).toHaveCount(0);
	await expect(page.getByText("Computers", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Cloud Computers", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Auto-select computer", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Always use your default computer", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("switch", {
			name: "Prefer a reachable remote computer, else use your computer",
		})
	).toBeVisible();
	await expect(page.getByRole("menu")).not.toContainText(/\bnodes?\b/i);
	expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
	const headings = page.getByRole("menu").locator("p");
	for (const heading of await headings.all()) {
		await expect(heading).not.toHaveCSS("text-transform", "uppercase");
	}
	await expect(
		page.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
	).not.toHaveCSS("text-transform", "uppercase");
	await activeRow.scrollIntoViewIfNeeded();

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("node-selector-status-proof.png"),
	});
	await page
		.getByRole("menuitem", { name: "Add computer", exact: true })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Add computer", exact: true })
	).toBeVisible();
});

test("shows Cloudflare Quick Tunnel as a public tunnel with a shareable URL", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(`${STORY_URL}?cloudflared`, {
		waitUntil: "domcontentloaded",
	});

	const trigger = page.getByRole("button", { name: /Your computer/i });
	await expect(trigger).toBeVisible();
	await trigger.click();

	// The expanded computer dialog: Toolkits is a page, VPN a page inside it.
	await page
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	// The dialog's title follows the page stack, so hold it by role alone.
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Toolkits/ }).click();
	await expect(
		dialog.getByRole("heading", { name: "Toolkits", exact: true })
	).toBeVisible();

	const tunnelLayer = dialog.getByRole("button", { name: /^VPN\b/ });
	await expect(tunnelLayer).toBeVisible();
	await expect(dialog.getByRole("button", { name: /^Tunnel\b/ })).toHaveCount(
		0
	);
	await tunnelLayer.click();
	await expect(
		dialog.getByRole("button", { name: "Back to Toolkits" })
	).toBeVisible();

	await expect(
		dialog
			.getByText("Cloudflare Quick Tunnel", { exact: true })
			.filter({ visible: true })
			.first()
	).toBeVisible();
	await expect(
		dialog.getByText("public · temporary · anyone with URL", { exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Copy public URL" })
	).toBeVisible();

	await expect(page.getByText("Installed", { exact: true })).not.toHaveCSS(
		"text-transform",
		"uppercase"
	);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("cloudflare-node-selector-proof.png"),
	});
	expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
});
