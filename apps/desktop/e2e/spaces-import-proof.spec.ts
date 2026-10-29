import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";

const evidenceDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
	"docs/proof/test-coverage-sweep-20260924/evidence"
);

test.describe.configure({ timeout: 90_000 });

test("imports a CSV and preserves completed file and Composio history", async ({
	page,
}) => {
	await page.goto("/spaces-import-proof.html");
	await page.getByRole("tab", { name: "Import" }).click();

	await expect(
		page.getByRole("heading", { name: "Import", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Ingest a document" })
	).toBeHidden();
	await expect(page.getByText("File-based imports")).toBeVisible();
	await expect(page.getByText("Third-party imports")).toBeVisible();
	await expect(page.getByText("customer-research.csv")).toBeVisible();
	await expect(
		page.getByText("Open GitHub issues", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByLabel("Connected app")).toContainText("GitHub");
	await expect(page.getByLabel("Read action")).toContainText(
		"List repository issues"
	);
	await page.getByLabel("Read action").click();
	await expect(
		page.getByRole("option", { name: "List repository issues" })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "List and mark notifications" })
	).toHaveCount(0);
	await page.screenshot({
		path: "e2e/proof/spaces-import-readonly-actions-proof.png",
	});
	await page.getByRole("option", { name: "List repository issues" }).click();

	await page.getByLabel("Spreadsheets files").setInputFiles({
		name: "fresh-leads.csv",
		mimeType: "text/csv",
		buffer: Buffer.from("name,score\nAda,9\nLin,8\nSam,7\n"),
	});
	await expect(page.getByText("fresh-leads.csv")).toBeVisible({
		timeout: 10_000,
	});
	await expect(page.getByText("3 items")).toBeVisible();

	await page.getByRole("button", { name: "Open Fresh leads" }).click();
	await expect(page.getByTestId("opened-document")).toHaveText(
		"database:Fresh leads"
	);

	await page.getByLabel("Owner").fill("amajorai");
	await page.getByLabel("Repository").fill("ryu");
	await page.getByLabel("Title").fill("Ryu GitHub issues");
	await page.getByRole("button", { name: "Import from GitHub" }).click();
	await expect(
		page.getByText("Ryu GitHub issues", { exact: true }).first()
	).toBeVisible({ timeout: 10_000 });
	await expect(page.getByText("17 items")).toBeVisible();
	await page.getByRole("button", { name: "Open Ryu GitHub issues" }).click();
	await expect(page.getByTestId("opened-document")).toHaveText(
		"database:Ryu GitHub issues"
	);
	await page.getByRole("tabpanel", { name: "Import" }).evaluate((panel) => {
		panel.scrollTop = 0;
	});

	await page.screenshot({
		path: "e2e/proof/spaces-import-proof.png",
		fullPage: true,
	});
});

test("routes both Manage connections states to Connections", async ({
	page,
}) => {
	for (const scenario of ["unconfigured", "unconnected"]) {
		await page.goto(`/spaces-import-proof.html?scenario=${scenario}`);
		await page.getByRole("tab", { name: "Import" }).click();

		if (scenario === "unconfigured") {
			await expect(
				page.getByText("Configure Composio in Connections before importing.")
			).toBeVisible();
		} else {
			await expect(
				page.getByText(
					"Connect an app to make its import actions available here."
				)
			).toBeVisible();
		}

		await page.getByRole("button", { name: "Manage connections" }).click();
		await expect(page.getByTestId("opened-document")).toHaveText("Connections");
	}
});

test("selects a connected toolkit and action, serializes dynamic arguments, retries, imports both destinations, and refreshes history", async ({
	page,
}) => {
	await page.goto("/spaces-import-proof.html?scenario=interactions");
	await page.getByRole("tab", { name: "Import" }).click();

	await expect(
		page.getByText("/api/spaces/space_demo/imports failed: 503")
	).toBeVisible();
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(
		page.getByText("/api/spaces/space_demo/imports failed: 503")
	).toBeHidden();
	await expect(page.getByText("customer-research.csv")).toBeVisible();

	await page.getByLabel("Connected app").click();
	await page.getByRole("option", { name: "Slack", exact: true }).click();
	await expect(page.getByLabel("Read action")).toContainText(
		"Read channel history"
	);
	await page.getByLabel("Read action").click();
	await expect(
		page.getByRole("option", { name: "Read channel history", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Delete channel", exact: true })
	).toHaveCount(0);
	await page.getByRole("option", { name: "Read channel history" }).click();

	await page.getByLabel("Channel ID").fill("C_SUPPORT");
	await page.getByLabel("Message limit").fill("47");
	await page.getByLabel("Include replies").click();
	await page.getByRole("option", { name: "True", exact: true }).click();
	await page.getByLabel("Output style").click();
	await page.getByRole("option", { name: "compact", exact: true }).click();
	await page
		.getByLabel("Filters")
		.fill('{"after":"2026-09-01","labels":["support"]}');
	await page.getByLabel("Labels").fill('["incident","weekly"]');
	await page.getByLabel("Title").fill("  Quarterly channel report  ");
	await page.getByLabel("Destination").click();
	await page.getByRole("option", { name: "Database", exact: true }).click();

	const databasePayload = {
		action: "SLACK_LIST_CHANNEL_HISTORY",
		arguments: {
			channel_id: "C_SUPPORT",
			limit: 47,
			include_replies: true,
			format: "compact",
			filters: { after: "2026-09-01", labels: ["support"] },
			labels: ["incident", "weekly"],
		},
		destination_kind: "database",
		title: "Quarterly channel report",
		toolkit: "slack",
	};
	const firstSubmission = page.getByRole("button", {
		name: "Import from Slack",
		exact: true,
	});
	await firstSubmission.click();
	await expect(
		page.getByText("/api/spaces/space_demo/imports/composio failed: 503")
	).toBeVisible();
	await expect(page.getByLabel("Channel ID")).toHaveValue("C_SUPPORT");
	await expect(page.getByLabel("Message limit")).toHaveValue("47");
	await expect(page.getByLabel("Include replies")).toContainText("true");
	await expect(page.getByLabel("Output style")).toContainText("compact");
	await expect(page.getByLabel("Filters")).toHaveValue(
		'{"after":"2026-09-01","labels":["support"]}'
	);
	await expect(page.getByLabel("Labels")).toHaveValue('["incident","weekly"]');
	await expect(page.getByLabel("Title")).toHaveValue(
		"  Quarterly channel report  "
	);
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("Destination")).toContainText("Database");
	await page.getByLabel("Title").click();
	await expect(
		page.getByRole("option", { name: "Database", exact: true })
	).toHaveCount(0);
	await page.setViewportSize({ height: 1600, width: 1440 });
	await page.getByRole("tabpanel", { name: "Import" }).evaluate((panel) => {
		panel.scrollTop = 0;
	});
	await page.screenshot({
		path: path.join(evidenceDirectory, "desktop-space-imports-retry-error.png"),
		fullPage: true,
	});

	await firstSubmission.click();
	const completionRefreshes = page.getByTestId("import-completion-refreshes");
	const completionRefreshesBeforeImport = Number(
		await completionRefreshes.textContent()
	);
	const databaseRow = page
		.getByRole("listitem")
		.filter({ hasText: "Quarterly channel report" });
	await expect(databaseRow).toContainText("completed", { timeout: 10_000 });
	await expect(databaseRow).toContainText("47 items");
	await expect
		.poll(async () => Number(await completionRefreshes.textContent()))
		.toBeGreaterThan(completionRefreshesBeforeImport);
	await expect(
		databaseRow.getByRole("button", {
			name: "Open Quarterly channel report",
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: "Open Quarterly channel report" })
		.click();
	await expect(page.getByTestId("opened-document")).toHaveText(
		"database:Quarterly channel report"
	);

	await page.getByLabel("Title").fill("Release notes page");
	await page.getByLabel("Destination").click();
	await page.getByRole("option", { name: "Page", exact: true }).click();
	const completionRefreshesBeforePageImport = Number(
		await completionRefreshes.textContent()
	);
	await page.getByRole("button", { name: "Import from Slack" }).click();
	const pageRow = page
		.getByRole("listitem")
		.filter({ hasText: "Release notes page" });
	await expect(pageRow).toContainText("completed", { timeout: 10_000 });
	await expect(pageRow).toContainText("47 items");
	await expect
		.poll(async () => Number(await completionRefreshes.textContent()))
		.toBeGreaterThan(completionRefreshesBeforePageImport);
	await page.getByRole("button", { name: "Open Release notes page" }).click();
	await expect(page.getByTestId("opened-document")).toHaveText(
		"page:Release notes page"
	);

	const pagePayload = {
		...databasePayload,
		destination_kind: "page",
		title: "Release notes page",
	};
	const proofState = await page.evaluate(() => {
		const state =
			/* SAFETY: spaces-import-proof.tsx initializes its typed SpaceImportsCapturedState and publishes this same private holder with Object.assign before the test observes imported request history. The optional view preserves the native browser window. */ (
				window as Window & {
					__spaceImportsProofState?: {
						composioRequests: Array<{
							body: ProofJsonRecord;
							method: string;
							url: string;
						}>;
						historyReads: number;
						successfulComposioBodies: ProofJsonRecord[];
					};
				}
			).__spaceImportsProofState;
		return state;
	});
	expect(proofState?.composioRequests.map(({ body }) => body)).toEqual([
		databasePayload,
		databasePayload,
		pagePayload,
	]);
	expect(
		proofState?.composioRequests.map(({ method, url }) => ({
			method,
			path: new URL(url).pathname,
		}))
	).toEqual([
		{
			method: "POST",
			path: "/api/spaces/space_demo/imports/composio",
		},
		{
			method: "POST",
			path: "/api/spaces/space_demo/imports/composio",
		},
		{
			method: "POST",
			path: "/api/spaces/space_demo/imports/composio",
		},
	]);
	expect(proofState?.historyReads).toBeGreaterThanOrEqual(4);
	expect(proofState?.successfulComposioBodies).toEqual([
		databasePayload,
		pagePayload,
	]);
	await page.getByRole("tabpanel", { name: "Import" }).evaluate((panel) => {
		panel.scrollTop = 0;
	});
	await page.screenshot({
		path: path.join(
			evidenceDirectory,
			"desktop-space-imports-completed-readback.png"
		),
		fullPage: true,
	});
});
