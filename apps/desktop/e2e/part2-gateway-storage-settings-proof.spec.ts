import { expect, test } from "@playwright/test";
import {
	addDestination,
	evidence,
	RestoreCaptureSchema,
	setFailure,
	snapshot,
} from "./gateway-storage-settings-proof.helpers.ts";

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
