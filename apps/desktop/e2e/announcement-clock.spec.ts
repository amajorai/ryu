import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("announcement status clock pauses hidden and catches up on return", async ({
	page,
}) => {
	const start = new Date("2026-09-12T00:00:00Z");
	let reads = 0;
	await page.route("**/api/announcements/admin", async (route) => {
		expect(route.request().method()).toBe("GET");
		reads++;
		await route.fulfill({
			json: {
				announcements: [
					{
						id: "scheduled",
						title: "Scheduled release",
						body: "A scheduled product update.",
						active: true,
						startsAt: new Date(start.getTime() + 60_000).toISOString(),
						endsAt: new Date(start.getTime() + 120_000).toISOString(),
						createdAt: start.toISOString(),
						updatedAt: start.toISOString(),
						createdBy: null,
						blobColors: [],
						color: null,
						icon: null,
						iconUrl: null,
						linkUrl: null,
						linkLabel: null,
						type: "card",
						visualCode: null,
						visualIcon: null,
						visualIconBackground: null,
						visualIconDither: null,
						visualIconUrl: null,
					},
				],
			},
		});
	});
	await page.clock.install({ time: start });
	await page.goto("/announcement-clock-proof.html");
	await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.clock.fastForward(90_000);
	await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await page.clock.fastForward(60_000);
	await expect(page.getByText("Expired", { exact: true })).toBeVisible();
	expect(reads).toBe(1);
	await page
		.getByText("Scheduled release", { exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: proofEvidencePath(
			"performance-sweep/announcement-clock-completed.png"
		),
		fullPage: false,
		animations: "disabled",
	});
});
