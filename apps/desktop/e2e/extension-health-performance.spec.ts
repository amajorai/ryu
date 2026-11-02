import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("extension health probes pause hidden and cancel on node change or unmount", async ({
	page,
}) => {
	const reads: string[] = [];
	const cancelled: string[] = [];
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/api/health")) {
			cancelled.push(new URL(request.url()).pathname);
		}
	});
	await page.route("**/api/health", async (route) => {
		reads.push(new URL(route.request().url()).pathname);
		await pending;
		await route.fulfill({ json: { ok: true } });
	});
	await page.clock.install();
	try {
		await page.goto("/extension-health-performance-proof.html");
		await expect.poll(() => reads.length).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				value: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => cancelled.length).toBe(1);
		await page.clock.fastForward(15_000);
		expect(reads).toHaveLength(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				value: false,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => reads.length).toBe(2);
		await page.getByRole("button", { name: "Beta node", exact: true }).click();
		await expect.poll(() => cancelled.length).toBe(2);
		await expect.poll(() => reads.length).toBe(3);
		expect(reads[2]).toBe("/beta/api/health");
		await page
			.getByRole("button", { name: "Close monitor", exact: true })
			.click();
		await expect.poll(() => cancelled.length).toBe(3);
		await page.clock.fastForward(15_000);
		expect(reads).toHaveLength(3);
		await page
			.getByRole("button", { name: "Open monitor", exact: true })
			.click();
		await expect.poll(() => reads.length).toBe(4);
		await page.clock.fastForward(3100);
		await expect(page.getByText("Node offline", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Retry", exact: true })
		).toBeEnabled();
		await expect(
			page.getByRole("heading", { name: "Ryu browser workspace" })
		).toBeVisible();
		release();
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(
			page.getByText("Connection restored", { exact: true })
		).toBeVisible();
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/extension-health-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("content-script status stops hidden and disposed work", async ({
	page,
}) => {
	let reads = 0;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/health", async (route) => {
		const index = ++reads;
		if (index === 1) {
			await pending;
		}
		await route.fulfill({ status: index < 3 ? 503 : 200, json: {} });
	});
	await page.clock.install();
	try {
		await page.goto("/extension-health-performance-proof.html?content");
		await expect.poll(() => reads).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				value: true,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.clock.fastForward(30_000);
		expect(reads).toBe(1);
		release();
		await page.waitForTimeout(50);
		await expect(page.locator("html")).toHaveAttribute(
			"data-content-phase",
			"checking"
		);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", {
				configurable: true,
				value: false,
			});
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => reads).toBe(2);
		await expect(page.locator("html")).toHaveAttribute(
			"data-content-phase",
			"node-unreachable"
		);
		await page.clock.fastForward(10_100);
		await expect.poll(() => reads).toBe(3);
		await expect(page.locator("html")).toHaveAttribute(
			"data-content-phase",
			"online"
		);
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/extension-content-health-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		await page
			.getByRole("button", { name: "Close monitor", exact: true })
			.click();
		await page.clock.fastForward(30_000);
		expect(reads).toBe(3);
		await expect(page.locator("html")).toHaveAttribute(
			"data-content-phase",
			"hidden"
		);
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
