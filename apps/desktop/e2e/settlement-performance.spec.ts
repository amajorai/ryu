import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const checkoutRequestSchema = z.object({ checkoutId: z.string() });

test("settlement stops obsolete requests and retry delays", async ({
	page,
}) => {
	const calls: string[] = [];
	let cancelled = 0;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/api/credits/reconcile-topup")) {
			cancelled++;
		}
	});
	await page.route("**/api/credits/reconcile-topup", async (route) => {
		const id = checkoutRequestSchema.parse(
			route.request().postDataJSON()
		).checkoutId;
		calls.push(id);
		if (calls.length === 2) {
			await pending;
		}
		await route.fulfill({
			status: id === "second" ? 200 : 202,
			json: { credited: id === "second" },
		});
	});
	await page.clock.install();
	try {
		await page.goto("/settlement-performance-proof.html");
		await expect.poll(() => calls.length).toBe(1);
		await page.waitForTimeout(30);
		await page
			.getByRole("button", { name: "Close receipt", exact: true })
			.click();
		await page.clock.fastForward(15_000);
		expect(calls).toHaveLength(1);
		await page
			.getByRole("button", { name: "Open receipt", exact: true })
			.click();
		await expect.poll(() => calls.length).toBe(2);
		await page
			.getByRole("button", { name: "Next checkout", exact: true })
			.click();
		await expect.poll(() => cancelled).toBe(1);
		await expect(page.getByRole("status")).toContainText("Wallet credited");
		release();
		await page.clock.fastForward(15_000);
		expect(calls).toEqual(["first", "first", "second"]);
		await expect(page.getByRole("status")).toContainText("Wallet credited");
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/performance-sweep/settlement-lifetime-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
test("settlement retains the six-attempt budget for a pending checkout", async ({
	page,
}) => {
	let calls = 0;
	await page.route("**/api/credits/reconcile-topup", async (route) => {
		calls++;
		await route.fulfill({ status: 202, json: { credited: false } });
	});
	await page.clock.install();
	await page.goto("/settlement-performance-proof.html");
	await expect.poll(() => calls).toBe(1);
	for (let i = 2; i <= 6; i++) {
		await page.waitForTimeout(30);
		await page.clock.fastForward(1600);
		await expect.poll(() => calls).toBe(i);
	}
	await expect(page.getByRole("status")).toContainText("still syncing");
	await page.clock.fastForward(15_000);
	expect(calls).toBe(6);
});
