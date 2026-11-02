// Browser proof for the app-owned record pickers that now use the desktop
// sidebar contribution primitive instead of shipping their own primary rail.

import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const STORY_URL = "/app-sidebar-sections-proof.html";

test.describe("app-owned sidebar sections", () => {
	test("renders all migrated record pickers through the shared section", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		for (const title of [
			"Plans",
			"Monitors",
			"Policies",
			"Contexts",
			"Campaigns",
			"Inboxes",
			"Workflows",
		]) {
			await expect(page.getByText(title, { exact: true })).toBeVisible();
		}
		for (const item of [
			"Launch plan",
			"Production API",
			"Release policy",
			"Q3 contracts",
			"Search campaign",
			"Support",
			"Release workflow",
		]) {
			await expect(page.getByText(item, { exact: true })).toBeVisible();
		}
		await expect(page.locator("html")).toHaveAttribute(
			"data-section-reads",
			"7"
		);
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/sidebar-source-shared-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	});

	test("opens a migrated row through its declarative item target", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByRole("button", { name: /Release workflow/ }).click();
		await expect(page.locator("#opened")).toHaveText("/workflows/workflow-1");
	});

	test("passes a record id through the migrated research target context", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByRole("button", { name: /Search campaign/ }).click();
		await expect(page.locator("#opened")).toHaveText(
			"/plugin/app__research-companion"
		);
		await expect(page.locator("#opened-context")).toHaveText(
			'{"campaignId":"campaign-1"}'
		);
	});
});

test("staggered app feed readers retain one polling cadence", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?polling`);
	await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();
	await page.waitForTimeout(450);
	await page
		.getByRole("button", { name: "Mount shared reader", exact: true })
		.click();
	await page.waitForTimeout(2500);
	const times = await page
		.locator("html")
		.getAttribute("data-source-read-times");
	const readings: number[] = JSON.parse(times ?? "[]");
	expect(readings.length).toBeGreaterThanOrEqual(3);
	const intervals = readings
		.slice(1)
		.map((value, index) => value - readings[index]);
	for (const interval of intervals) {
		expect(interval).toBeGreaterThanOrEqual(950);
	}
	await expect(page.getByRole("button", { name: /Launch plan/ })).toBeVisible();
	await page.screenshot({
		path: proofEvidencePath(
			"performance-sweep/sidebar-source-cadence-completed.png"
		),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		proofEvidencePath("performance-sweep/sidebar-source-cadence.json"),
		`${JSON.stringify(
			{
				readings,
				intervals,
				scope:
					"Real DynamicSidebarSection plus shared source hook; controlled fetch responses; second reader mounted after 450ms",
			},
			null,
			2
		)}\n`
	);
	await test.info().attach("source-poll-intervals", {
		body: JSON.stringify({ readings, intervals }),
		contentType: "application/json",
	});
});
