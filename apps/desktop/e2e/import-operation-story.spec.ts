// Real-browser spec for `e2e/harness/import-operation-story.{html,tsx}`, the
// "Import agent setup" dialog on the node's operations service.
//
// What it proves, with the real dialog, store, hook and live-activity adapter
// against a stand-in node:
//   * the dialog starts the import with `async` and an idempotency key;
//   * the dialog can be closed while the import runs, the Live list keeps
//     showing it, and the dialog opened again shows the same import and then
//     its results;
//   * an import that continued after a node restart is marked as resumed;
//   * an interrupted import says so and Retry finishes it;
//   * failed items are listed, and Stop keeps what was imported;
//   * another user's running import on the same node gets no Live card and
//     is not taken over by the dialog, which offers a fresh import.
//
// It does not prove anything about Core. The stand-in node is part of the
// story file.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const STORY_URL = "/import-operation-story.html";
const LONG = { timeout: 60_000 };
const PROGRESS = /^\d+ of 12 items$/;
const PROGRESS_STARTED = /^[1-9]\d* of 12 items$/;
const PROGRESS_IN_CARD = /\d+ of 12 items/;
const KEY_SENT = /"idempotencyKey":"import-/;
const STOPPED_TOTALS = /^Imported \d+, skipped 0, failed 0$/;

function shot(name: string): string {
	return proofEvidencePath("durable-operations", name);
}

async function startImport(page: Page, scenario: string): Promise<void> {
	await page.goto(`${STORY_URL}?scenario=${scenario}`);
	await page.getByRole("button", { name: "Claude Code", exact: true }).click();
	await page.getByRole("button", { name: "Select all", exact: true }).click();
	await page.getByRole("button", { name: "Import 12", exact: true }).click();
}

test.beforeAll(async () => {
	await mkdir(path.dirname(shot("x.png")), { recursive: true });
});

test.describe("import agent setup as an operation", () => {
	test("keeps running while the dialog is closed and shows its results after", async ({
		page,
	}) => {
		await startImport(page, "plain");
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Importing…")).toBeVisible();
		await expect(dialog.getByText(PROGRESS)).toBeVisible();
		await expect(
			dialog.getByText("You can close this window.", { exact: false })
		).toBeVisible();
		await page.screenshot({ path: shot("01-import-running.png") });

		const starts = await page.evaluate(() => window.importStory.starts);
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({ async: true });
		expect(JSON.stringify(starts[0])).toMatch(KEY_SENT);

		// Close the dialog. The import is not the dialog's.
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		const card = page.getByTestId("live-card");
		await expect(card).toContainText("Importing .claude");
		await expect(card).toContainText(PROGRESS_IN_CARD);
		await page.screenshot({ path: shot("02-dialog-closed-live-list.png") });

		// Open it again while the import still runs: the same import, further on.
		await page.getByTestId("open-import").click();
		await expect(dialog.getByText("Importing…")).toBeVisible();
		await expect(dialog.getByText(PROGRESS)).toBeVisible();
		await page.screenshot({ path: shot("03-dialog-reopened-running.png") });

		await expect(
			dialog.getByText("Imported 12, skipped 0, failed 0")
		).toBeVisible(LONG);
		await expect(page.getByTestId("live-empty")).toBeVisible();
		await page.screenshot({ path: shot("04-import-finished.png") });

		// Back to the folder picker.
		await dialog
			.getByRole("button", { name: "Import another folder", exact: true })
			.click();
		await expect(
			dialog.getByText("Imported 12, skipped 0, failed 0")
		).toHaveCount(0);
		expect(await page.evaluate(() => window.importStory.starts.length)).toBe(1);
	});

	test("marks an import that continued after a node restart", async ({
		page,
	}) => {
		await startImport(page, "resumed");
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Resumed after restart")).toBeVisible(LONG);
		await expect(page.getByTestId("live-card")).toContainText(
			"Resumed after restart"
		);
		await page.screenshot({ path: shot("05-resumed-after-restart.png") });
		await expect(
			dialog.getByText("Imported 12, skipped 0, failed 0")
		).toBeVisible(LONG);
	});

	test("says when an import was interrupted and finishes it on Retry", async ({
		page,
	}) => {
		await startImport(page, "interrupted");
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByText(
				"The node restarted during this import. Items already imported are kept."
			)
		).toBeVisible(LONG);
		await expect(
			dialog.getByText("Imported 4, skipped 0, failed 0")
		).toBeVisible();
		await page.screenshot({ path: shot("06-interrupted.png") });
		await dialog.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(
			dialog.getByText("Imported 12, skipped 0, failed 0")
		).toBeVisible(LONG);
	});

	test("lists the items that failed", async ({ page }) => {
		await startImport(page, "failing");
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByText("Imported 10, skipped 0, failed 2")
		).toBeVisible(LONG);
		await expect(
			dialog.getByText("Skill 3: The file is not a readable skill.")
		).toBeVisible();
		await expect(
			dialog.getByText("Skill 8: The file is not a readable skill.")
		).toBeVisible();
		await page.screenshot({ path: shot("07-failed-items.png") });
	});

	test("stops between items and keeps what was imported", async ({ page }) => {
		await startImport(page, "plain");
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText(PROGRESS_STARTED)).toBeVisible(LONG);
		await dialog.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(
			dialog.getByText(
				"The import was stopped. Items already imported are kept."
			)
		).toBeVisible(LONG);
		await expect(dialog.getByText(STOPPED_TOTALS)).toBeVisible();
		await page.screenshot({ path: shot("08-stopped.png") });
	});

	test("leaves another user's import alone: no card, and the dialog offers a fresh import", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?scenario=theirs`);
		// The app-wide feed has put the other user's running import into the
		// client's mirror, on the node the dialog talks to.
		await expect
			.poll(() => page.evaluate(() => window.importStory.mirrored()), LONG)
			.toContain("op_theirs");
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByRole("button", { name: "Claude Code", exact: true })
		).toBeVisible();
		await expect(dialog.getByText("Importing…")).toHaveCount(0);
		await expect(page.getByTestId("live-empty")).toBeVisible();
		await page.screenshot({ path: shot("09-other-users-import.png") });

		// A fresh import of the user's own runs next to it, with its own card.
		await dialog
			.getByRole("button", { name: "Claude Code", exact: true })
			.click();
		await dialog
			.getByRole("button", { name: "Select all", exact: true })
			.click();
		await dialog
			.getByRole("button", { name: "Import 12", exact: true })
			.click();
		await expect(dialog.getByText("Importing…")).toBeVisible();
		const card = page.getByTestId("live-card");
		await expect(card).toHaveCount(1);
		await expect(card).toContainText("Importing .claude");
		await expect(
			dialog.getByText("Imported 12, skipped 0, failed 0")
		).toBeVisible(LONG);
		// Nothing was read, stopped or retried on the other user's import.
		expect(await page.evaluate(() => window.importStory.theirs)).toEqual([]);
		await expect(page.getByText("member-project")).toHaveCount(0);
	});
});
