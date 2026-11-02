// Marketplace Store home proof. Plugins release channels and detail tabs.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR, IDS } from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	deferred,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { storeEffectsSchema } from "./marketplace-store-home-proof.contracts.ts";

registerStoreHomeEvidenceHooks();

test("Plugins install and switch the exact release channel only after confirmation; Manage keeps enable gated", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.pluginInstallFailures = 1;
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home Plugin");
	await expect
		.poll(
			() => callsFor(fixture, "GET", "/api/plugins/catalog/channels").length
		)
		.toBeGreaterThan(0);
	const installChannel = details.getByRole("combobox").first();
	await installChannel.click();
	await page.getByRole("option", { name: /Beta/ }).click();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	expect(fixture.appChannels[IDS.plugin]).toBe("beta");
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{ channel: "beta", id: IDS.plugin },
		{ channel: "beta", id: IDS.plugin },
	]);

	const updatePath = `/api/plugins/${encodeURIComponent(IDS.plugin)}/update`;
	const channelPicker = details.getByRole("combobox").first();
	await channelPicker.click();
	await page.getByRole("option", { name: /Stable/ }).click();
	const switchDialog = page.getByRole("alertdialog");
	await expect(switchDialog).toContainText("Follow the Stable channel?");
	await switchDialog.getByRole("button", { name: "Cancel" }).click();
	expect(callsFor(fixture, "POST", updatePath)).toHaveLength(0);
	expect(fixture.appChannels[IDS.plugin]).toBe("beta");

	await channelPicker.click();
	await page.getByRole("option", { name: /Stable/ }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Switch" })
		.click();
	await expect.poll(() => fixture.appChannels[IDS.plugin]).toBe(null);
	expect(
		callsFor(fixture, "POST", updatePath).map((call) => call.body)
	).toEqual([{}]);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-channel-readback.png"
		),
	});

	await details.getByRole("button", { name: "Close" }).click();
	const pluginCard = page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.locator("xpath=..");
	await pluginCard.getByRole("button", { name: "Manage" }).click();
	const manageMenu = page.getByRole("menu", { name: "Manage" });
	await expect(
		manageMenu.getByRole("menuitem", { name: "Enable" })
	).toBeVisible();
	await expect(
		manageMenu.getByRole("menuitem", { name: "Remove" })
	).toHaveCount(0);
	await expect(
		manageMenu.getByRole("menuitem", { name: "Settings" })
	).toBeVisible();
	await expect(
		manageMenu.getByRole("menuitem", { name: "Report" })
	).toBeVisible();
	await manageMenu.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.plugin]);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Report" }).click();
	const reportDialog = page.getByRole("dialog");
	await expect(reportDialog).toContainText("Report Fixture Home Plugin");
	await expect(
		reportDialog.getByRole("button", { name: "Submit report" })
	).toBeDisabled();
	await reportDialog.getByLabel("Reason").click();
	await page.getByRole("option", { name: "Something else" }).click();
	const reportDetails = reportDialog.getByLabel("Details (required)");
	await expect(reportDetails).toBeVisible();
	await expect(
		reportDialog.getByRole("button", { name: "Submit report" })
	).toBeDisabled();
	await reportDetails.fill("Fixture report draft");
	await reportDialog.getByRole("button", { name: "Cancel" }).click();
	const reportEffects = storeEffectsSchema.parse(
		JSON.parse(await page.getByTestId("marketplace-home-effects").innerText())
	);
	expect(reportEffects.submittedReports).toEqual([]);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Report" }).click();
	const reportDialogRetry = page.getByRole("dialog");
	await reportDialogRetry.getByLabel("Reason").click();
	await page.getByRole("option", { name: "Something else" }).click();
	await reportDialogRetry
		.getByLabel("Details (required)")
		.fill("Fixture report draft");
	await reportDialogRetry
		.getByRole("button", { name: "Submit report" })
		.click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.submittedReports;
		})
		.toEqual([
			{
				details: "Fixture report draft",
				homepage: "https://github.com/fixture/ryu-plugin",
				id: IDS.plugin,
				installSource: "marketplace",
				itemName: "Fixture Home Plugin",
				kind: "plugin",
				reason: "other",
				source: "mongo",
			},
		]);
	await expect(reportDialogRetry).toHaveCount(0);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	const enableRequestsBeforeManage = callsFor(
		fixture,
		"POST",
		`/api/plugins/${encodeURIComponent(IDS.plugin)}/enable`
	).length;
	await manageMenu.getByRole("menuitem", { name: "Enable" }).click();
	await expect(page.getByRole("dialog").first()).toContainText(
		"Fixture Home Plugin"
	);
	await expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.plugin)}/enable`
		)
	).toHaveLength(enableRequestsBeforeManage);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
});

test("Plugins detail tabs render safe docs, API, version snapshots, and confirmed exact historical install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home Plugin");
	const readmeTab = details.getByRole("tab", { name: "README" });
	await readmeTab.click();
	await expect(
		details.getByText("Local README content for the Store detail proof.", {
			exact: true,
		})
	).toBeVisible();
	const originalReadme = details.getByRole("link", {
		name: "Read the original",
	});
	await expect(originalReadme).toHaveAttribute(
		"href",
		"https://github.com/fixture/ryu-plugin#readme"
	);
	await expect(originalReadme).toHaveAttribute("target", "_blank");
	await expect(originalReadme).toHaveAttribute("rel", "noopener noreferrer");
	const repository = details.locator(
		'a[href="https://github.com/fixture/ryu-plugin"]'
	);
	await expect(repository).toHaveAttribute("target", "_blank");
	await expect(repository).toHaveAttribute("rel", "noopener noreferrer");

	await details.getByRole("tab", { name: "API" }).click();
	await expect(
		details.getByText("Open fixture", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("fixture:open", { exact: true })
	).toBeVisible();
	await details.getByRole("tab", { name: "Dependencies" }).click();
	await expect(
		details.getByRole("heading", { name: "Requires these plugins" })
	).toBeVisible();
	await expect(
		details.getByText("fixture/required-plugin", { exact: true })
	).toBeVisible();
	await expect(details.getByText("≥ 1.2.0", { exact: true })).toBeVisible();
	await details.getByRole("button", { name: /Health .* out of 100/ }).click();
	await expect(details.getByRole("tab", { name: "Health" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		details.getByRole("heading", { name: "Automated checks" })
	).toBeVisible();
	fixture.auditFailures = 1;
	const auditButton = details.getByTestId("catalog-scan-button");
	await auditButton.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(1);
	await expect(
		details.getByText("Agent audit failed: Fixture audit unavailable", {
			exact: true,
		})
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/scan")[0]?.body).toMatchObject(
		{
			description: "A signed fixture plugin for the Plugins tab.",
			execution: "agent",
			id: IDS.plugin,
			kind: "plugin",
			name: "Fixture Home Plugin",
			metadata: {
				repositoryUrl: "https://github.com/fixture/ryu-plugin",
				version: "1.0.0",
			},
		}
	);
	const auditGate = deferred();
	fixture.auditGate = auditGate;
	await auditButton.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(2);
	await expect(auditButton).toBeDisabled();
	await expect(
		details.getByText("The agent is reviewing the evidence…")
	).toBeVisible();
	auditGate.release();
	await expect(details.getByTestId("catalog-scan-result")).toContainText(
		"Local fixture audit result."
	);
	await details
		.getByRole("button", { name: "Open audit conversation" })
		.click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedAuditConversations;
		})
		.toEqual(["fixture-audit-conversation"]);
	await details.getByRole("button", { name: "Audit again" }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(3);
	await expect(details.getByTestId("catalog-scan-result")).toContainText(
		"Local fixture audit result."
	);

	const versionsTab = details.getByRole("tab", { name: "Versions" });
	if (await versionsTab.isVisible().catch(() => false)) {
		await versionsTab.click();
	} else {
		await details.getByRole("button", { name: /Show \d+ more tabs/ }).click();
		await page.getByRole("option", { name: /Reorder Versions/ }).click();
	}
	await expect(details.getByText("0.9.0", { exact: true })).toBeVisible();
	const releaseLink = details
		.getByRole("link", { name: "View release" })
		.last();
	await expect(releaseLink).toHaveAttribute(
		"href",
		"https://github.com/fixture/ryu-plugin/releases/tag/v0.9.0"
	);
	await expect(releaseLink).toHaveAttribute("target", "_blank");
	await expect(releaseLink).toHaveAttribute("rel", "noopener noreferrer");
	await details
		.getByRole("button", { name: "Show what shipped in this version" })
		.last()
		.click();
	await expect(details).toContainText("The historical fixture release.");
	await expect(details).toContainText("Licence: MIT");
	const snapshotRead = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/version-detail"
	).at(-1);
	expect(new URLSearchParams(snapshotRead?.search).get("repo")).toBe(
		"https://github.com/fixture/ryu-plugin"
	);
	expect(new URLSearchParams(snapshotRead?.search).get("tag")).toBe("0.9.0");

	const installOldVersion = details.getByRole("button", {
		name: "Install 0.9.0",
	});
	await installOldVersion.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Install 0.9.0?");
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install")
	).toHaveLength(0);
	await installOldVersion.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Install version" })
		.click();
	await expect(
		details.getByText("Installed 0.9.0", { exact: true })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([{ id: IDS.plugin, version: "0.9.0" }]);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-version-readback.png"
		),
	});
});
