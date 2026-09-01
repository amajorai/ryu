import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const PROOF_DIR = path.resolve(
	process.env.RYU_PROOF_DIR ?? "test-results/private-package-share"
);
const PROOF_SCREENSHOT = `${PROOF_DIR}/private-package-share.png`;
const PROOF_LOG = `${PROOF_DIR}/private-package-share.log.json`;
const STORY_URL = process.env.RYU_PRIVATE_PACKAGE_STATIC
	? `file://${path.resolve("e2e/harness/dist-private-package-share-story/private-package-share-story.html")}`
	: "/private-package-share-story.html";

test("previews a private workflow, shows missing auth, and installs with setup still actionable", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));
	page.on("requestfailed", (request) => {
		failedRequests.push(
			`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`
		);
	});

	await page.setViewportSize({ height: 900, width: 1200 });
	await page.goto(STORY_URL);
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();

	await page.getByLabel("Package code").fill("7K4MX2QP9F6D");
	await page
		.getByRole("button", { name: "Preview package", exact: true })
		.click();
	await expect(
		dialog.getByText("Weekly revenue brief", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText("Verified", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Google Drive", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("Needs connection", { exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Connect", exact: true })
	).toBeVisible();
	await expect(
		dialog.getByText("1 required connection still needed", { exact: true })
	).toBeVisible();

	await dialog
		.getByRole("button", { name: "Install package", exact: true })
		.click();
	await expect(dialog.getByText("Finish setup", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("Needs connection", { exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Connect", exact: true })
	).toBeVisible();

	const installRequest = await page.evaluate(() =>
		window.__privatePackageRequests?.find((request) =>
			request.path.includes("/api/marketplace/packages/install")
		)
	);
	expect(installRequest?.body).toContain("signed-install-session-for-proof");

	await mkdir(PROOF_DIR, { recursive: true });
	await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
	await writeFile(
		PROOF_LOG,
		JSON.stringify({ consoleErrors, failedRequests, installRequest }, null, 2)
	);

	expect(consoleErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});
