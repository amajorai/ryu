import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type {
	GatewayStorageProgress,
	GatewayStorageState,
} from "./harness/gateway-storage-settings-proof.mock.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidence = (name: string) =>
	path.resolve(
		process.env.RYU_PROOF_EVIDENCE_DIR ??
			path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence"
			),
		name
	);
const RestoreCaptureSchema = z.object({ backupId: z.string().optional() });
const IdempotencyCaptureSchema = z.object({ idempotencyKey: z.string() });

declare global {
	interface Window {
		__emitGatewayStorageProgress?: (payload: GatewayStorageProgress) => void;
		__GATEWAY_STORAGE_PROOF__?: GatewayStorageState;
	}
}

type ProofSnapshot = Pick<
	GatewayStorageState,
	| "apiCalls"
	| "fetchCalls"
	| "dataPath"
	| "destinations"
	| "dialogCalls"
	| "operations"
	| "policies"
	| "records"
	| "tauriCalls"
>;

async function snapshot(page: Page): Promise<ProofSnapshot> {
	return page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (!state) {
			throw new Error("Gateway Storage proof fixtures were not installed");
		}
		return {
			apiCalls: state.apiCalls,
			fetchCalls: state.fetchCalls,
			dataPath: state.dataPath,
			destinations: state.destinations,
			dialogCalls: state.dialogCalls,
			operations: state.operations,
			policies: state.policies,
			records: state.records,
			tauriCalls: state.tauriCalls,
		};
	});
}

async function setFailure(
	page: Page,
	key: string,
	message: string,
	remaining = 1,
	status = 500
): Promise<void> {
	await page.evaluate(
		({ failureKey, failureMessage, count, statusCode }) => {
			const state = window.__GATEWAY_STORAGE_PROOF__;
			if (!state) {
				throw new Error("Gateway Storage proof fixtures were not installed");
			}
			state.failures[failureKey] = {
				message: failureMessage,
				remaining: count,
				status: statusCode,
			};
		},
		{
			failureKey: key,
			failureMessage: message,
			count: remaining,
			statusCode: status,
		}
	);
}

async function addDestination(
	page: Page,
	name = "Nightly archive"
): Promise<void> {
	await page.getByRole("button", { name: "Add destination" }).click();
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toBeVisible();
	await page.getByLabel("Destination name").fill(name);
	await page.getByLabel("Provider").selectOption("aws");
	await page.getByLabel("Bucket").fill("ryu-proof-backups");
	await page.getByLabel("Object prefix").fill("proof/nightly");
	await page.getByLabel("Access key ID").fill("AKIA-PROOF");
	await page.getByLabel("Secret access key").fill("proof-secret-access-key");
	await page.getByLabel("Session token (optional)").fill("proof-session-token");
	await page
		.getByLabel("Apps allowed to use this destination")
		.fill("@ryu/canvas, com.example.notes");
	await page.getByRole("button", { name: "Generate key" }).click();
	await expect(page.getByRole("textbox", { name: "Recovery key" })).toHaveValue(
		"proof-recovery-key-32-characters"
	);
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();
	await page
		.getByRole("checkbox", { name: "Use path-style requests" })
		.uncheck();
	await page
		.getByRole("checkbox", {
			name: "Allow HTTP for a trusted private S3 server",
		})
		.check();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toHaveCount(0);
}

test("shows node-reported data folder details and upload limit", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await expect(
		page.getByText("/Users/proof/.ryu-canary", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("1.5 GB used · 8.0 GB free on this drive")
	).toBeVisible();
	await expect(
		page.getByText("/Users/proof/.ryu", { exact: true })
	).toBeVisible();
	await expect(page.getByText("25 MB", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/Reported by this node.*Chat attachments/s)
	).toBeVisible();
	await expect(page.getByText("No S3 destinations yet")).toBeVisible();

	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-storage-settings.png"),
	});
	const state = await snapshot(page);
	expect(state.fetchCalls).toContain("http://127.0.0.1:18980/api/data-path");
	expect(state.apiCalls.map((call) => call.path)).toContain("/api/data-path");
	expect(
		state.apiCalls.some(
			(call) => call.path === "/api/documents/parse/capability"
		)
	).toBe(true);
});

test("retries data-folder loading and falls back to the documented upload default", async ({
	page,
}) => {
	await page.goto(
		"/gateway-storage-settings-proof.html?failDataPath&failParseCapability"
	);
	await expect(
		page.getByText("We couldn't load your data folder details.")
	).toBeVisible();
	await expect(
		page.getByText("This node did not report its limit")
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByText("/Users/proof/.ryu-canary", { exact: true })
	).toBeVisible();
	await expect(page.getByText("32 MB", { exact: true })).toBeVisible();
	await expect(
		page.getByText("/Users/proof/.ryu", { exact: true })
	).toBeVisible();
});

test("validates a selected data folder, cancels it, then copies with progress", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await expect(
		page.getByRole("button", { name: "Choose folder…" })
	).toBeVisible();
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push(null);
	});
	await page.getByRole("button", { name: "Choose folder…" }).click();
	await expect(
		page.getByRole("button", { name: "Choose folder…" })
	).toBeVisible();
	expect(
		(await snapshot(page)).apiCalls.filter(
			(call) => call.path === "/api/data-path/validate"
		)
	).toHaveLength(0);
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push("/Volumes/Ryu Data");
	});
	await page.getByRole("button", { name: "Choose folder…" }).click();
	await expect(
		page.getByText("/Volumes/Ryu Data", { exact: true })
	).toBeVisible();
	await expect(page.getByText(/1.5 GB to copy/)).toBeVisible();
	let state = await snapshot(page);
	const validation = state.apiCalls.find(
		(call) => call.path === "/api/data-path/validate"
	);
	expect(validation?.method).toBe("POST");
	expect(validation?.body).toEqual({ path: "/Volumes/Ryu Data" });

	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Choose folder…" })
	).toBeVisible();
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push("/Volumes/Ryu Data");
	});
	await page.getByRole("button", { name: "Choose folder…" }).click();
	await page.getByRole("button", { name: "Copy data & restart" }).click();
	await expect(page.getByText("Copying… 0%")).toBeVisible();
	await page.evaluate(() => {
		window.__emitGatewayStorageProgress?.({
			phase: "copy",
			copied_bytes: 768 * 1024 ** 2,
			total_bytes: 1.5 * 1024 ** 3,
		});
	});
	await expect(page.getByText("Copying… 50%")).toBeVisible();
	state = await snapshot(page);
	const migrate = state.tauriCalls.find(
		(call) => call.command === "migrate_data_folder"
	);
	expect(migrate?.args).toEqual({ to: "/Volumes/Ryu Data", moveSource: false });
});

test("blocks an invalid data-folder target and switches to a fresh folder when asked", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (state) {
			state.validationResult = {
				error: "The selected folder is inside the current data folder",
				ok: false,
				source_size_bytes: 1.5 * 1024 ** 3,
				target_free_bytes: 8 * 1024 ** 3,
			};
			state.dialogs.open.push("/Users/proof/.ryu-canary/cache");
		}
	});
	await page.getByRole("button", { name: "Choose folder…" }).click();
	await expect(
		page.getByText("The selected folder is inside the current data folder")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Copy data & restart" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Start fresh here" })
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();

	await setFailure(
		page,
		"POST /api/data-path/switch",
		"Node refused the folder switch"
	);
	await page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (state) {
			state.validationResult.ok = true;
			state.validationResult.error = undefined;
			state.dialogs.open.push("/Volumes/Empty Ryu");
		}
	});
	await page.getByRole("button", { name: "Choose folder…" }).click();
	await page.getByRole("button", { name: "Start fresh here" }).click();
	await expect(page.getByText("Could not switch folder")).toBeVisible();
	await page.getByRole("button", { name: "Start fresh here" }).click();
	await expect
		.poll(async () =>
			(await snapshot(page)).tauriCalls.some(
				(call) => call.command === "relaunch"
			)
		)
		.toBe(true);
	const state = await snapshot(page);
	expect(
		state.apiCalls.filter((call) => call.path === "/api/data-path/switch")
	).toHaveLength(2);
	expect(
		state.apiCalls.find((call) => call.path === "/api/data-path/switch")?.body
	).toEqual({ path: "/Volumes/Empty Ryu" });
	expect(state.tauriCalls).toContainEqual({ command: "relaunch" });
});

test("resets a custom data folder and reports reset failures", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await setFailure(page, "POST /api/data-path/reset", "Node refused the reset");
	await page.getByRole("button", { name: "Reset to default" }).click();
	await expect(page.getByText("Could not reset folder")).toBeVisible();
	let state = await snapshot(page);
	expect(
		state.apiCalls.some((call) => call.path === "/api/data-path/reset")
	).toBe(true);
	expect(state.tauriCalls.some((call) => call.command === "relaunch")).toBe(
		false
	);

	await page.getByRole("button", { name: "Reset to default" }).click();
	await expect
		.poll(async () =>
			(await snapshot(page)).tauriCalls.some(
				(call) => call.command === "relaunch"
			)
		)
		.toBe(true);
	state = await snapshot(page);
	expect(
		state.apiCalls.filter((call) => call.path === "/api/data-path/reset")
	).toHaveLength(2);
});

test("copies into each profile only after confirmation and displays copy failures", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	for (const [index, profile] of [
		"dev",
		"canary",
		"nightly",
		"beta",
	].entries()) {
		await page
			.getByRole("button", { name: "Copy", exact: true })
			.nth(index)
			.click();
		await expect(
			page.getByRole("heading", {
				name: `Copy this profile's data to ${profile}?`,
			})
		).toBeVisible();
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(
			page.getByRole("heading", {
				name: `Copy this profile's data to ${profile}?`,
			})
		).toHaveCount(0);
	}
	let state = await snapshot(page);
	expect(
		state.tauriCalls.filter(
			(call) => call.command === "copy_data_folder_to_profile"
		)
	).toHaveLength(0);

	await page.getByRole("button", { name: "Copy", exact: true }).first().click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Copy", exact: true })
		.click();
	await expect(page.getByText("Copied to the dev profile")).toBeVisible();
	state = await snapshot(page);
	expect(state.tauriCalls.at(-1)).toEqual({
		command: "copy_data_folder_to_profile",
		args: { toProfile: "dev" },
	});

	await setFailure(
		page,
		"tauri:copy_data_folder_to_profile",
		"Target profile already has data"
	);
	await page.getByRole("button", { name: "Copy", exact: true }).nth(3).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Copy", exact: true })
		.click();
	await expect(page.getByText("Could not copy to that profile")).toBeVisible();
	await expect(page.getByText("Target profile already has data")).toBeVisible();
});

const EXPORT_PASSPHRASE = "correct horse battery";

/** Export… asks for the backup passphrase twice before the save dialog. */
async function startEncryptedExport(page: Page) {
	await page.getByRole("button", { name: "Export…" }).click();
	await page.getByLabel("Backup passphrase").fill(EXPORT_PASSPHRASE);
	await page.getByLabel("Confirm passphrase").fill(EXPORT_PASSPHRASE);
	await page.getByRole("button", { name: "Choose location…" }).click();
}

test("exports a zip with save-dialog cancel, success, and visible error handling", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.save.push(null);
	});
	await startEncryptedExport(page);
	await expect
		.poll(async () => (await snapshot(page)).dialogCalls.length)
		.toBe(1);
	let state = await snapshot(page);
	expect(state.dialogCalls[0]).toEqual({
		kind: "save",
		options: {
			defaultPath: "ryu-data-backup.zip",
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		},
		picked: null,
	});
	expect(
		state.apiCalls.some((call) => call.path === "/api/data-path/export")
	).toBe(false);

	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.save.push("/tmp/ryu-backup.zip");
	});
	await startEncryptedExport(page);
	await expect(page.getByText("Backup created")).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.find((call) => call.path === "/api/data-path/export")?.body
	).toEqual({ out: "/tmp/ryu-backup.zip", passphrase: EXPORT_PASSPHRASE });

	await setFailure(page, "POST /api/data-path/export", "Disk is full");
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.save.push("/tmp/ryu-backup.zip");
	});
	await startEncryptedExport(page);
	await expect(page.getByText("Backup failed")).toBeVisible();
	await page.getByText("Backup failed").hover();
	await expect(
		page.getByText("/api/data-path/export failed: 500")
	).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.filter((call) => call.path === "/api/data-path/export")
	).toHaveLength(2);
});

test("restores a zip only after explicit confirmation and passes the native command the chosen archive", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push(null);
	});
	await page.getByRole("button", { name: "Restore…" }).click();
	await expect(
		page.getByRole("heading", { name: "Restore from this backup?" })
	).toHaveCount(0);
	let state = await snapshot(page);
	expect(state.dialogCalls[0]).toEqual({
		kind: "open",
		options: {
			multiple: false,
			filters: [{ name: "Zip archive", extensions: ["zip"] }],
		},
		picked: null,
	});

	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push(
			"/tmp/backup from old laptop.zip"
		);
	});
	await page.getByRole("button", { name: "Restore…" }).click();
	await expect(
		page.getByRole("heading", { name: "Restore from this backup?" })
	).toBeVisible();
	await expect(page.getByText("/tmp/backup from old laptop.zip")).toBeVisible();
	await expect(
		page.getByText(/encryption key is stored in this machine's keychain/)
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	state = await snapshot(page);
	expect(
		state.tauriCalls.some((call) => call.command === "import_data_folder")
	).toBe(false);

	await setFailure(page, "tauri:import_data_folder", "Archive is corrupt");
	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push("/tmp/broken.zip");
	});
	await page.getByRole("button", { name: "Restore…" }).click();
	await page.getByRole("button", { name: "Restore & restart" }).click();
	await expect(page.getByText("Restore failed")).toBeVisible();
	await expect(page.getByText("Archive is corrupt")).toBeVisible();
	state = await snapshot(page);
	expect(state.tauriCalls.at(-1)).toEqual({
		command: "import_data_folder",
		args: { archive: "/tmp/broken.zip" },
	});

	await page.evaluate(() => {
		window.__GATEWAY_STORAGE_PROOF__?.dialogs.open.push(
			"/tmp/backup from old laptop.zip"
		);
	});
	await page.getByRole("button", { name: "Restore…" }).click();
	await page.getByRole("button", { name: "Restore & restart" }).click();
	await expect(page.getByText("Restoring…")).toBeVisible();
});

test("adds an S3 destination, covers provider presets, recovery-key download, validation, and saved options", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await expect(page.getByText("No S3 destinations yet")).toBeVisible();
	await page.getByRole("button", { name: "Add destination" }).click();
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toBeVisible();
	await page.getByLabel("Provider").selectOption("r2");
	await expect(page.getByLabel("S3 endpoint")).toHaveValue(
		"https://ACCOUNT_ID.r2.cloudflarestorage.com"
	);
	await expect(page.getByLabel("Region")).toHaveValue("auto");
	await page.getByLabel("Provider").selectOption("aws");
	await expect(page.getByLabel("S3 endpoint")).toHaveValue(
		"https://s3.us-east-1.amazonaws.com"
	);
	await expect(page.getByLabel("Region")).toHaveValue("us-east-1");
	await page.getByLabel("Provider").selectOption("custom");
	await page.getByLabel("Destination name").fill("Nightly archive");
	await page.getByLabel("Bucket").fill("ryu-proof-backups");
	await page.getByLabel("Object prefix").fill("proof/nightly");
	await page.getByLabel("Access key ID").fill("AKIA-PROOF");
	await page.getByLabel("Secret access key").fill("proof-secret-access-key");
	await page.getByLabel("Session token (optional)").fill("proof-session-token");
	await page
		.getByLabel("Apps allowed to use this destination")
		.fill("@ryu/canvas, com.example.notes");
	await page.getByRole("button", { name: "Generate key" }).click();
	await expect(page.getByRole("textbox", { name: "Recovery key" })).toHaveValue(
		"proof-recovery-key-32-characters"
	);
	await expect(
		page.getByRole("button", { name: "Validate & save" })
	).toBeDisabled();
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery key" }).click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe("ryu-backup-recovery-key.txt");
	const downloadStream = await download.createReadStream();
	if (!downloadStream) {
		throw new Error("The recovery-key download stream was unavailable");
	}
	let downloadedKey = "";
	for await (const chunk of downloadStream) {
		downloadedKey += chunk.toString("utf8");
	}
	expect(downloadedKey).toBe("proof-recovery-key-32-characters");
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();
	await page
		.getByRole("checkbox", { name: "Use path-style requests" })
		.uncheck();
	await page
		.getByRole("checkbox", {
			name: "Allow HTTP for a trusted private S3 server",
		})
		.check();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(
		page.getByText("Nightly archive", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("2 approved apps")).toBeVisible();
	const state = await snapshot(page);
	const saved = state.apiCalls.find(
		(call) =>
			call.path === "/api/backups/destinations" && call.method === "POST"
	);
	expect(saved?.body).toMatchObject({
		allowHttp: true,
		allowedApps: ["@ryu/canvas", "com.example.notes"],
		bucket: "ryu-proof-backups",
		endpoint: "https://s3.us-east-1.amazonaws.com",
		name: "Nightly archive",
		pathStyle: false,
		prefix: "proof/nightly",
		region: "us-east-1",
		recoveryKey: "proof-recovery-key-32-characters",
	});
});

test("validates required S3 fields, recovers a failed save, and edits saved settings", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.getByRole("button", { name: "Add destination" }).click();
	await page.getByRole("button", { name: "Generate key" }).click();
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(page.locator(":invalid")).toHaveCount(6);
	let state = await snapshot(page);
	expect(
		state.apiCalls.some(
			(call) =>
				call.path === "/api/backups/destinations" && call.method === "POST"
		)
	).toBe(false);

	await page.getByLabel("Destination name").fill("Nightly archive");
	await page.getByLabel("S3 endpoint").fill("https://storage.example.test");
	await page.getByLabel("Bucket").fill("ryu-proof-backups");
	await page.getByLabel("Region").fill("auto");
	await page.getByLabel("Object prefix").fill("ryu/proof");
	await page.getByLabel("Access key ID").fill("AKIA-PROOF");
	await page.getByLabel("Secret access key").fill("proof-secret-access-key");
	await page
		.getByRole("textbox", { name: "Recovery key" })
		.fill("proof-recovery-key-32-characters");
	await setFailure(
		page,
		"POST /api/backups/destinations",
		"Endpoint validation failed"
	);
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Endpoint validation failed"
	);
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toBeVisible();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(
		page.getByText("Nightly archive", { exact: true }).first()
	).toBeVisible();

	await page.getByRole("button", { name: "Edit" }).click();
	await expect(
		page.getByRole("heading", { name: "Edit S3 destination" })
	).toBeVisible();
	await expect(page.getByLabel("Destination name")).toHaveValue(
		"Nightly archive"
	);
	await expect(page.getByLabel("S3 endpoint")).toBeDisabled();
	await expect(page.getByLabel("Bucket")).toBeDisabled();
	await expect(page.getByLabel("Object prefix")).toBeDisabled();
	await expect(page.getByLabel("Access key ID")).toHaveValue("");
	await expect(page.getByRole("textbox", { name: "Recovery key" })).toHaveValue(
		""
	);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Edit S3 destination" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Edit" }).click();
	await page.getByLabel("Destination name").fill("Production archive");
	await page.getByLabel("Region").fill("us-west-2");
	await page
		.getByLabel("Session token (optional)")
		.fill("rotated-session-token");
	await page
		.getByLabel("Apps allowed to use this destination")
		.fill("@ryu/canvas, com.example.changed");
	await page.getByRole("checkbox", { name: "Use path-style requests" }).check();
	await page
		.getByRole("checkbox", {
			name: "Allow HTTP for a trusted private S3 server",
		})
		.uncheck();
	await page.getByLabel("Access key ID").fill("AKIA-ROTATED");
	await page.getByLabel("Secret access key").fill("rotated-secret");
	await page
		.getByRole("textbox", { name: "Recovery key" })
		.fill("proof-recovery-key-32-characters");
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();
	await page.getByRole("button", { name: "Validate & save" }).click();
	await expect(
		page.getByText("Production archive", { exact: true }).first()
	).toBeVisible();
	state = await snapshot(page);
	const edits = state.apiCalls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/backups/destinations/destination-proof"
	);
	expect(edits.at(-1)?.body).toMatchObject({
		accessKeyId: "AKIA-ROTATED",
		allowHttp: false,
		allowedApps: ["@ryu/canvas", "com.example.changed"],
		name: "Production archive",
		pathStyle: true,
		region: "us-west-2",
		secretAccessKey: "rotated-secret",
		sessionToken: "rotated-session-token",
	});
});

test("retries recovery-key generation and a node-admin destination denial without losing the draft", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.getByRole("button", { name: "Add destination" }).click();
	await page.getByLabel("Destination name").fill("Node-admin archive");
	await page.getByLabel("Provider").selectOption("aws");
	await page.getByLabel("Bucket").fill("node-admin-proof");
	await page.getByLabel("Access key ID").fill("AKIA-LOCAL-FIXTURE");
	await page.getByLabel("Secret access key").fill("local-fixture-secret");
	const recoveryKey = page.getByRole("textbox", { name: "Recovery key" });
	const save = page.getByRole("button", { name: "Validate & save" });
	const generate = page.getByRole("button", { name: "Generate key" });

	await setFailure(
		page,
		"POST /api/backups/recovery-key",
		"Recovery-key service is unavailable"
	);
	await generate.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Recovery-key service is unavailable"
	);
	await expect(recoveryKey).toHaveValue("");
	await expect(save).toBeDisabled();
	await generate.click();
	await expect(recoveryKey).toHaveValue("proof-recovery-key-32-characters");
	await page
		.getByRole("checkbox", { name: "I have saved my recovery key" })
		.check();

	await setFailure(
		page,
		"POST /api/backups/destinations",
		"Permission denied: nodes.manage is required",
		1,
		403
	);
	await save.click();
	await expect(page.getByRole("alert")).toHaveText(
		"Permission denied: nodes.manage is required"
	);
	await expect(
		page.getByRole("heading", { name: "Add S3 destination" })
	).toBeVisible();
	await expect(page.getByLabel("Destination name")).toHaveValue(
		"Node-admin archive"
	);
	await expect(page.getByLabel("Bucket")).toHaveValue("node-admin-proof");
	await expect(recoveryKey).toHaveValue("proof-recovery-key-32-characters");
	await expect(
		page.getByRole("checkbox", { name: "I have saved my recovery key" })
	).toBeChecked();
	let state = await snapshot(page);
	expect(state.destinations).toHaveLength(0);
	expect(
		state.apiCalls.filter(
			(call) =>
				call.method === "POST" && call.path === "/api/backups/recovery-key"
		)
	).toHaveLength(2);
	expect(
		state.apiCalls.filter(
			(call) =>
				call.method === "POST" && call.path === "/api/backups/destinations"
		)
	).toHaveLength(1);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("gateway-backup-destination-permission-error.png"),
	});

	await save.click();
	await expect(
		page.getByText("Node-admin archive", { exact: true }).first()
	).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.filter(
			(call) =>
				call.method === "POST" && call.path === "/api/backups/destinations"
		)
	).toHaveLength(2);
	expect(state.destinations).toHaveLength(1);
});

test("tests the S3 connection and surfaces a failure that can be retried", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await page.getByRole("button", { name: "Add destination" }).click();
	await page.getByLabel("Destination name").fill("Unsaved destination");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByText("No S3 destinations yet")).toBeVisible();
	expect(
		(await snapshot(page)).apiCalls.some(
			(call) => call.path === "/api/backups/destinations"
		)
	).toBe(false);
	await addDestination(page);
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-storage-s3-settings.png"),
	});
	await setFailure(
		page,
		"POST /api/backups/destinations/destination-proof/test",
		"Bucket access denied"
	);
	await page.getByRole("button", { name: "Test" }).click();
	await expect(page.getByRole("alert")).toHaveText("Bucket access denied");
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Test" }).click();
	await expect(
		page.getByText("Connection verified: read, write, list and delete passed.")
	).toBeVisible();
});

test("backs up a selected scope, saves and toggles its schedule, and browses backups", async ({
	page,
}) => {
	await page.goto("/gateway-storage-settings-proof.html");
	await addDestination(page);
	await addDestination(page, "Cold archive");
	await page
		.getByRole("combobox", { name: "Destination" })
		.selectOption("destination-proof-2");
	await expect(page.getByRole("combobox", { name: "Destination" })).toHaveValue(
		"destination-proof-2"
	);
	await page.getByLabel("Schedule (UTC)").fill("15 3 * * 1");
	await page.getByLabel("Backups to keep").fill("12");
	await page.getByRole("button", { name: "Back up now" }).click();
	await expect(page.getByText("Backup completed.")).toBeVisible();
	let state = await snapshot(page);
	expect(
		state.apiCalls.find((call) => call.path === "/api/backups/runs")?.body
	).toMatchObject({
		destinationId: "destination-proof-2",
		scope: { kind: "node" },
	});

	await page
		.getByRole("combobox", { name: "Destination" })
		.selectOption("destination-proof");
	await expect(page.getByRole("combobox", { name: "Destination" })).toHaveValue(
		"destination-proof"
	);
	await page.getByLabel("Back up").selectOption("space-proof");
	await expect(page.getByLabel("Backups to keep")).toHaveAttribute("min", "1");
	await expect(page.getByLabel("Backups to keep")).toHaveAttribute(
		"max",
		"500"
	);
	await page.getByLabel("Schedule (UTC)").fill("not a cron");
	await page.getByLabel("Backups to keep").fill("0");
	await setFailure(
		page,
		"POST /api/backups/policies",
		"The schedule or retention count is invalid"
	);
	await page.getByRole("button", { name: "Enable schedule" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"The schedule or retention count is invalid"
	);
	state = await snapshot(page);
	expect(
		state.apiCalls
			.filter(
				(call) =>
					call.path === "/api/backups/policies" && call.method === "POST"
			)
			.at(-1)?.body
	).toMatchObject({
		retentionCount: 0,
		schedule: "not a cron",
	});
	await page.getByLabel("Schedule (UTC)").fill("15 3 * * 1");
	await page.getByLabel("Backups to keep").fill("12");
	await page.getByRole("button", { name: "Enable schedule" }).click();
	await expect(
		page.getByText("Schedule enabled · 15 3 * * 1 UTC · keeps 12")
	).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls
			.filter(
				(call) =>
					call.path === "/api/backups/policies" && call.method === "POST"
			)
			.at(-1)?.body
	).toMatchObject({
		destinationId: "destination-proof",
		enabled: true,
		retentionCount: 12,
		schedule: "15 3 * * 1",
		scope: { kind: "space", spaceId: "space-proof" },
	});
	await page.getByLabel("Schedule (UTC)").fill("30 4 * * 2");
	await page.getByLabel("Backups to keep").fill("30");
	await page.getByRole("button", { name: "Save schedule" }).click();
	await expect(
		page.getByText("Schedule enabled · 30 4 * * 2 UTC · keeps 30")
	).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls
			.filter(
				(call) =>
					call.path === "/api/backups/policies" && call.method === "POST"
			)
			.at(-1)?.body
	).toMatchObject({
		destinationId: "destination-proof",
		enabled: true,
		retentionCount: 30,
		schedule: "30 4 * * 2",
		scope: { kind: "space", spaceId: "space-proof" },
	});
	await page.getByRole("button", { name: "Pause schedule" }).click();
	await expect(
		page.getByRole("button", { name: "Resume schedule" })
	).toBeVisible();
	await page.getByRole("button", { name: "Resume schedule" }).click();
	await expect(
		page.getByRole("button", { name: "Pause schedule" })
	).toBeVisible();
	await page.getByLabel("Back up").selectOption("node");

	await page.evaluate(() => {
		const state = window.__GATEWAY_STORAGE_PROOF__;
		if (state) {
			state.records = [
				{
					bytes: 2048,
					createdAt: "2026-09-25T02:00:00.000Z",
					id: "node-record",
					objectKey: "node.zip",
					scope: { kind: "node" },
					sha256: "abc",
					version: 1,
				},
				{
					bytes: 4096,
					createdAt: "2026-09-25T01:00:00.000Z",
					id: "space-record",
					objectKey: "space.zip",
					scope: { kind: "space", spaceId: "space-proof" },
					sha256: "def",
					version: 1,
				},
				{
					bytes: 8192,
					createdAt: "2026-09-25T00:00:00.000Z",
					id: "app-record",
					objectKey: "app.zip",
					scope: {
						appId: "com.example.notes",
						kind: "app",
						namespace: "com.example.notes",
						tenant: "tenant",
					},
					sha256: "ghi",
					version: 1,
				},
			];
		}
	});
	await page.getByRole("button", { name: "Browse backups" }).click();
	await expect(page.getByText("Backups in S3")).toBeVisible();
	await expect(page.getByText(/Entire node ·/)).toBeVisible();
	await expect(page.getByText(/Encrypted/).first()).toBeVisible();
	const appBackupRow = page
		.getByText(/App · com\.example\.notes/)
		.locator("xpath=../..");
	await expect(
		appBackupRow.getByRole("button", { name: "Restore" })
	).toBeDisabled();

	const nodeBackupRow = page
		.getByText(/Entire node ·/)
		.first()
		.locator("xpath=../..");
	await nodeBackupRow.getByRole("button", { name: "Restore" }).click();
	await expect(
		page.getByRole("heading", { name: "Prepare node recovery" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	state = await snapshot(page);
	expect(
		state.apiCalls.some((call) => call.path === "/api/backups/restore")
	).toBe(false);
	await nodeBackupRow.getByRole("button", { name: "Restore" }).click();
	await page.getByRole("button", { name: "Restore backup" }).click();
	await expect(page.getByText("Restore completed.")).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.find((call) => call.path === "/api/backups/restore")?.body
	).toMatchObject({
		backupId: "node-record",
		destinationId: "destination-proof",
	});

	const spaceBackupRow = page
		.getByText(/Space ·/)
		.first()
		.locator("xpath=../..");
	await spaceBackupRow.getByRole("button", { name: "Restore" }).click();
	await expect(
		page.getByRole("heading", { name: "Restore Space" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await spaceBackupRow.getByRole("button", { name: "Restore" }).click();
	await page.getByRole("button", { name: "Restore backup" }).click();
	await expect(page.getByText("Restore completed.")).toBeVisible();
	state = await snapshot(page);
	expect(
		state.apiCalls.find(
			(call) =>
				call.path === "/api/backups/restore" &&
				RestoreCaptureSchema.safeParse(call.body).data?.backupId ===
					"space-record"
		)?.body
	).toMatchObject({
		backupId: "space-record",
		destinationId: "destination-proof",
	});
});

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
