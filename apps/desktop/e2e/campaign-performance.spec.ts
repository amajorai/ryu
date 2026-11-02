import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("campaign refreshes do not overlap, pause hidden, and stop after three failures", async ({
	page,
}) => {
	let calls = 0;
	let cancelled = 0;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/campaigns/active")) {
			cancelled++;
		}
	});
	await page.route("**/api/campaigns/active?**", async (route) => {
		const index = ++calls;
		if (index === 1) {
			await pending;
		}
		if (index >= 3) {
			return route.fulfill({ status: 503, json: {} });
		}
		return route.fulfill({
			json: {
				campaign: {
					slug: "preview",
					label: "Campaign preview",
					description: "Example campaign offer.",
					grantMicroUsd: 50_000_000,
					poolLabel: "Ryu Frontier",
					seatLimit: 100,
					claimedCount: 20,
					seatsRemaining: 80,
				},
			},
		});
	});
	await page.clock.install();
	try {
		await page.goto("/campaign-performance-proof.html");
		await expect(
			page.getByText("90 spots left.", { exact: true })
		).toBeVisible();
		expect(calls).toBe(0);
		await page.clock.fastForward(45_100);
		await expect.poll(() => calls).toBe(1);
		await page.clock.fastForward(90_000);
		expect(calls).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => cancelled).toBe(1);
		await page.clock.fastForward(180_000);
		expect(calls).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "visible",
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect(
			page.getByText("80 spots left.", { exact: true })
		).toBeVisible();
		expect(calls).toBe(2);
		for (let i = 0; i < 3; i++) {
			await page.clock.fastForward(45_100);
			await expect.poll(() => calls).toBe(3 + i);
			await page.waitForTimeout(30);
		}
		await page.clock.fastForward(180_000);
		expect(calls).toBe(5);
		await expect(
			page.getByText("80 spots left.", { exact: true })
		).toBeVisible();
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/campaign-polling-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
