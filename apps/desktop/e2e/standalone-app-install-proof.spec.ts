import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const proof = proofEvidencePath("standalone-app-install");

test("right-click installs and removes only the standalone launch surface", async ({
	page,
}) => {
	test.setTimeout(120_000);
	mkdirSync(proof, { recursive: true });
	await page.setViewportSize({ width: 1280, height: 960 });
	await page.goto("/app-launchpad-story.html");
	const browserTile = page.getByRole("button", { name: "Browser" }).first();
	await expect(browserTile).toBeVisible();

	await browserTile.click({ button: "right" });
	await expect(page.getByText("Install as standalone app")).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "install-menu.png"),
		fullPage: false,
	});
	await page.getByText("Install as standalone app").click();
	await expect(page.getByTestId("standalone-status")).toHaveText(
		"Installed standalone: Browser"
	);

	await browserTile.click({ button: "right" });
	await expect(page.getByText("Open standalone app")).toBeVisible();
	await expect(page.getByText("Remove standalone app")).toBeVisible();
	await page.screenshot({
		path: path.join(proof, "installed-menu.png"),
		fullPage: false,
	});
	await page.getByText("Remove standalone app").click();
	await expect(page.getByTestId("standalone-status")).toHaveText(
		"Removed standalone: Browser; app data stays in Ryu"
	);
});
