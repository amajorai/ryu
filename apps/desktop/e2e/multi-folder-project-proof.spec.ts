import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const PRIMARY_FOLDER = "/Users/jiawei/Documents/DescomicWeb";
const SECONDARY_FOLDER = "/Users/jiawei/Documents/DescomicApi";
const PROOF_SCREENSHOT = proofEvidencePath("multi-folder-project-settings.png");
const PROOF_LOG = proofEvidencePath("multi-folder-project-settings.log.json");

test.describe.configure({ mode: "serial", timeout: 120_000 });

test("promotes a secondary source folder and persists the primary order", async ({
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

	await page.goto("/multi-folder-project-proof.html", {
		waitUntil: "domcontentloaded",
	});
	const settings = page.getByRole("dialog").first();
	await expect(settings).toBeVisible();
	await expect(
		settings.getByRole("heading", { name: "Edit project" })
	).toBeVisible();
	await expect(
		settings.getByText("Source folders", { exact: true })
	).toBeVisible();
	await expect(
		settings.getByText(PRIMARY_FOLDER, { exact: true })
	).toBeVisible();
	await expect(
		settings.getByText(SECONDARY_FOLDER, { exact: true })
	).toBeVisible();
	await expect(settings.getByText("Primary", { exact: true })).toBeVisible();

	await expect(
		settings.getByRole("button", {
			name: `Make ${SECONDARY_FOLDER} primary`,
		})
	).toBeVisible();
	await settings
		.getByRole("button", { name: `Make ${SECONDARY_FOLDER} primary` })
		.click();
	const secondaryRow = settings
		.locator("[data-project-source-folder]")
		.filter({ hasText: SECONDARY_FOLDER });
	await expect(secondaryRow).toContainText("Primary");
	await expect(
		settings.getByRole("button", {
			name: `Make ${SECONDARY_FOLDER} primary`,
		})
	).toHaveCount(0);
	await expect(
		settings.locator("[data-project-source-folder]").first()
	).toContainText(SECONDARY_FOLDER);

	await settings.getByRole("button", { name: "Save", exact: true }).click();
	await expect(settings).toBeHidden();
	await page.getByRole("button", { name: "Edit project", exact: true }).click();
	await expect(settings).toBeVisible();
	const sourceRows = settings.locator("[data-project-source-folder]");
	await expect(sourceRows.nth(0)).toContainText(SECONDARY_FOLDER);
	await expect(sourceRows.nth(0)).toContainText("Primary");
	await expect(sourceRows.nth(1)).toContainText(PRIMARY_FOLDER);
	await expect(
		sourceRows
			.nth(1)
			.getByRole("button", { name: `Make ${PRIMARY_FOLDER} primary` })
	).toBeVisible();
	await expect(page.locator("[data-active-folder]")).toHaveAttribute(
		"data-active-folder",
		SECONDARY_FOLDER
	);

	await settings.getByRole("button", { name: "Add environment" }).click();
	await expect(
		settings.getByText(
			"Setup and cleanup shell hooks are unavailable for chat worktrees.",
			{
				exact: false,
			}
		)
	).toBeVisible();
	await expect(
		settings.getByText("Inherited by actions and the coding agent.", {
			exact: false,
		})
	).toBeVisible();
	await settings
		.getByText(
			"Setup and cleanup shell hooks are unavailable for chat worktrees.",
			{
				exact: false,
			}
		)
		.scrollIntoViewIfNeeded();

	await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
	await writeFile(
		PROOF_LOG,
		JSON.stringify({ consoleErrors, failedRequests }, null, 2)
	);

	expect(consoleErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});
