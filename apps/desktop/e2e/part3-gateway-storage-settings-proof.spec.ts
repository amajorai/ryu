import { expect, test } from "@playwright/test";
import {
	addDestination,
	evidence,
	IdempotencyCaptureSchema,
	setFailure,
	snapshot,
} from "./gateway-storage-settings-proof.helpers.ts";

test("keeps the selected Space scope and retries failed backup and restore operations", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await addDestination(page);
	const scope = page.getByLabel("Back up");
	await scope.selectOption("space-proof");
	await expect(scope).toHaveValue("space-proof");
	await setFailure(
		page,
		"POST /api/backups/runs",
		"Snapshot could not be created"
	);
	await page.getByRole("button", { name: "Back up now" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Snapshot could not be created"
	);
	await expect(scope).toHaveValue("space-proof");
	let state = await snapshot(page);
	expect(state.operations).toHaveLength(0);
	let runCalls = state.apiCalls.filter(
		(call) => call.method === "POST" && call.path === "/api/backups/runs"
	);
	expect(runCalls).toHaveLength(1);
	expect(runCalls[0]?.body).toMatchObject({
		destinationId: "destination-proof",
		scope: { kind: "space", spaceId: "space-proof" },
	});

	await page.getByRole("button", { name: "Back up now" }).click();
	await expect(page.getByText("Backup completed.")).toBeVisible();
	state = await snapshot(page);
	runCalls = state.apiCalls.filter(
		(call) => call.method === "POST" && call.path === "/api/backups/runs"
	);
	expect(runCalls).toHaveLength(2);
	expect(runCalls[1]?.body).toMatchObject({
		destinationId: "destination-proof",
		scope: { kind: "space", spaceId: "space-proof" },
	});
	const runBodies = runCalls.map((call) =>
		IdempotencyCaptureSchema.safeParse(call.body)
	);
	expect(runBodies.every((body) => body.success)).toBe(true);
	const runKeys = runBodies.map((body) => body.data?.idempotencyKey);
	expect(new Set(runKeys).size).toBe(2);

	await page.evaluate(() => {
		const current = window.__GATEWAY_STORAGE_PROOF__;
		if (!current) {
			throw new Error("Gateway Storage proof fixtures were not installed");
		}
		current.records = [
			{
				bytes: 4096,
				createdAt: "2026-09-25T01:00:00.000Z",
				id: "retry-space-record",
				objectKey: "space-retry.zip",
				scope: { kind: "space", spaceId: "space-proof" },
				sha256: "space-retry-hash",
				version: 1,
			},
		];
	});
	await page.getByRole("button", { name: "Browse backups" }).click();
	const backupRow = page
		.getByText(/Space ·/)
		.first()
		.locator("xpath=../..");
	await expect(
		backupRow.getByRole("button", { name: "Restore" })
	).toBeEnabled();
	await backupRow.getByRole("button", { name: "Restore" }).click();
	const restoreDialog = page.getByRole("dialog", { name: "Restore Space" });
	await expect(restoreDialog).toBeVisible();
	await expect(restoreDialog).toContainText("Your original Space stays intact");
	await setFailure(page, "POST /api/backups/restore", "Restore staging failed");
	await restoreDialog.getByRole("button", { name: "Restore backup" }).click();
	await expect(page.getByRole("alert")).toHaveText("Restore staging failed");
	await expect(restoreDialog).toHaveCount(0);
	await expect(
		backupRow.getByRole("button", { name: "Restore" })
	).toBeEnabled();
	state = await snapshot(page);
	let restoreCalls = state.apiCalls.filter(
		(call) => call.method === "POST" && call.path === "/api/backups/restore"
	);
	expect(restoreCalls).toHaveLength(1);
	expect(restoreCalls[0]?.body).toMatchObject({
		backupId: "retry-space-record",
		destinationId: "destination-proof",
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("gateway-backup-restore-error.png"),
	});

	await backupRow.getByRole("button", { name: "Restore" }).click();
	await page
		.getByRole("dialog", { name: "Restore Space" })
		.getByRole("button", { name: "Restore backup" })
		.click();
	await expect(page.getByText("Restore completed.")).toBeVisible();
	state = await snapshot(page);
	restoreCalls = state.apiCalls.filter(
		(call) => call.method === "POST" && call.path === "/api/backups/restore"
	);
	expect(restoreCalls).toHaveLength(2);
	expect(restoreCalls[1]?.body).toMatchObject({
		backupId: "retry-space-record",
		destinationId: "destination-proof",
	});
	const restoreBodies = restoreCalls.map((call) =>
		IdempotencyCaptureSchema.safeParse(call.body)
	);
	expect(restoreBodies.every((body) => body.success)).toBe(true);
	const restoreKeys = restoreBodies.map((body) => body.data?.idempotencyKey);
	expect(new Set(restoreKeys).size).toBe(2);
	await expect(
		page.getByText("Restore · Space", { exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("gateway-backup-space-retry.png"),
	});
});

test("locks BackupSettings to its Space prop and sends that scope on backup", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html?spaceBackup");
	await expect(
		page.getByRole("heading", { name: "Space backup settings" })
	).toBeVisible();
	await addDestination(page);
	const scope = page.getByLabel("Back up");
	await expect(scope).toHaveValue("space-proof");
	await expect(scope).toBeDisabled();
	await expect(scope).toContainText("Research Space");

	await page.getByRole("button", { name: "Back up now" }).click();
	await expect(page.getByText("Backup completed.")).toBeVisible();
	const backupRequest = (await snapshot(page)).apiCalls.find(
		(call) => call.method === "POST" && call.path === "/api/backups/runs"
	);
	expect(backupRequest?.body).toMatchObject({
		destinationId: "destination-proof",
		scope: { kind: "space", spaceId: "space-proof" },
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("gateway-backup-space-scope.png"),
	});
});

test("handles empty and failed backup browsing and removes a destination only after confirmation", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await addDestination(page);
	await page.getByRole("button", { name: "Browse backups" }).click();
	await expect(
		page.getByText("No backups found for this selection.")
	).toBeVisible();
	await setFailure(
		page,
		"GET /api/backups/destinations/destination-proof/backups",
		"Could not list bucket objects"
	);
	await page.getByRole("button", { name: "Browse backups" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Could not list bucket objects"
	);
	await page.getByRole("button", { name: "Browse backups" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(
		page.getByText("No backups found for this selection.")
	).toBeVisible();
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Remove destination" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	let state = await snapshot(page);
	expect(
		state.apiCalls.some(
			(call) =>
				call.method === "DELETE" &&
				call.path.startsWith("/api/backups/destinations/")
		)
	).toBe(false);

	await page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (!state) {
			throw new Error("Gateway Storage proof fixtures were not installed");
		}
		state.records = [
			{
				bytes: 2048,
				createdAt: "2026-09-25T02:00:00.000Z",
				id: "kept-backup-record",
				objectKey: "kept-backup.zip",
				scope: { kind: "node" },
				sha256: "abc",
				version: 1,
			},
		];
	});
	await setFailure(
		page,
		"DELETE /api/backups/destinations/destination-proof",
		"Permission denied: nodes.manage is required",
		1,
		403
	);
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Remove destination" })
		.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Permission denied: nodes.manage is required"
	);
	await expect(
		page.getByText("Nightly archive", { exact: true }).first()
	).toBeVisible();
	state = await snapshot(page);
	expect(state.destinations).toHaveLength(1);
	expect(state.records).toHaveLength(1);

	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Remove destination" })
		.click();
	await expect(page.getByText("No S3 destinations yet")).toBeVisible();
	await expect(
		page.getByText("Destination removed. S3 backups were kept.")
	).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.some(
			(call) =>
				call.method === "DELETE" &&
				call.path === "/api/backups/destinations/destination-proof"
		)
	).toBe(true);
	expect(
		state.apiCalls.filter(
			(call) =>
				call.method === "DELETE" &&
				call.path === "/api/backups/destinations/destination-proof"
		)
	).toHaveLength(2);
	expect(state.records).toHaveLength(1);
});

test("retries the S3 overview after a service failure", async ({ page }) => {
	await page.goto("/gateway-storage-settings-proof.html?failBackupOverview");
	await expect(page.getByRole("alert")).toHaveText(
		"Backup service unavailable"
	);
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByText("No S3 destinations yet")).toBeVisible();
});
