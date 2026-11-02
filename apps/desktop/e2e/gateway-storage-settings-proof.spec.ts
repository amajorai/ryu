import { expect, test } from "@playwright/test";
import {
	EXPORT_PASSPHRASE,
	evidence,
	setFailure,
	snapshot,
	startEncryptedExport,
} from "./gateway-storage-settings-proof.helpers.ts";

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
