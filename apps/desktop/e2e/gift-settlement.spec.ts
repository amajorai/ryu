import { expect, type Route, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("checkout replacement cancels its old read and renders the current gift status", async ({
	page,
}) => {
	const requests: Route[] = [];
	let cancelled = 0;
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/api/gifts/reconcile")) {
			cancelled += 1;
		}
	});
	await page.route("**/api/gifts/reconcile", (route) => {
		requests.push(route);
	});
	await page.goto("/gift-settlement-proof.html");
	await expect.poll(() => requests.length).toBe(1);
	await expect(page.getByRole("status")).toContainText(
		"Verifying your gift payment"
	);
	await page
		.getByRole("button", { name: "Switch fixture checkout", exact: true })
		.click();
	await expect.poll(() => requests.length).toBe(2);
	await expect.poll(() => cancelled).toBe(1);
	expect(requests[1].request().postDataJSON()).toEqual({
		checkoutId: "fixture-checkout-b",
	});
	await requests[1].fulfill({ json: { status: "active" } });
	await expect(page.getByRole("status")).toContainText("Gift ready");
	await page.screenshot({
		path: proofEvidencePath("performance-sweep/gift-settlement-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
test("six pending replies finish without a final delay or further retries", async ({
	page,
}) => {
	const start = new Date("2026-09-13T10:00:00Z");
	await page.clock.install({ time: start });
	await page.clock.pauseAt(new Date(start.getTime() + 1000));
	let reads = 0;
	await page.route("**/api/gifts/reconcile", async (route) => {
		reads += 1;
		await route.fulfill({ status: 202, json: { status: "pending" } });
	});
	await page.goto("/gift-settlement-proof.html");
	await expect.poll(() => reads).toBe(1);
	for (let attempt = 2; attempt <= 6; attempt += 1) {
		await page.clock.fastForward(1500);
		await expect.poll(() => reads).toBe(attempt);
	}
	await expect(page.getByRole("status")).toContainText(
		"Your gift is still syncing"
	);
	await page.clock.fastForward(60_000);
	expect(reads).toBe(6);
	await page
		.getByRole("button", { name: "Unmount status", exact: true })
		.click();
	await page.clock.fastForward(60_000);
	expect(reads).toBe(6);
});
