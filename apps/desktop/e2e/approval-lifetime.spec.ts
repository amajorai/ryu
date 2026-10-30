import path from "node:path";
import { expect, type Route, test } from "@playwright/test";
import { LOGIN_APPROVAL_EXPIRES_IN_SECONDS } from "@ryu/auth/lib/login-approval-contract";

test("account replacement cancels pending snapshots and unmount closes the stream", async ({
	page,
}) => {
	const pending: Route[] = [];
	const streams: Route[] = [];
	let failedReads = 0;
	let failedStreams = 0;
	page.on("requestfailed", (request) => {
		if (request.url().endsWith("/pending")) {
			failedReads += 1;
		}
		if (request.url().endsWith("/stream")) {
			failedStreams += 1;
		}
	});
	await page.route("**/api/login-approvals/pending", (route) => {
		pending.push(route);
	});
	await page.route("**/api/login-approvals/stream", (route) => {
		streams.push(route);
	});
	await page.goto("/approval-lifetime-proof.html");
	await expect.poll(() => pending.length).toBe(1);
	await page
		.getByRole("button", { name: "Switch fixture account", exact: true })
		.click();
	await expect.poll(() => pending.length).toBe(2);
	await expect.poll(() => failedReads).toBe(1);
	expect(streams).toHaveLength(0);
	await pending[1].fulfill({ json: { requests: [] } });
	await expect.poll(() => streams.length).toBe(1);
	await page
		.getByRole("button", { name: "Unmount listener", exact: true })
		.click();
	await expect.poll(() => failedStreams).toBe(1);
	await page
		.getByRole("button", { name: "Mount listener", exact: true })
		.click();
	await expect.poll(() => pending.length).toBe(3);
	await pending[2].fulfill({
		json: {
			requests: [
				{
					clientId: "ryu-desktop",
					createdAt: new Date(Date.now()).toISOString(),
					deviceLabel: "Performance fixture device",
					expiresAt: new Date(
						Date.now() + LOGIN_APPROVAL_EXPIRES_IN_SECONDS * 1000
					).toISOString(),
					id: "fixture-approval",
					ipAddress: null,
					status: "pending",
					surface: "desktop",
					userAgent: "Performance test",
					userCode: "ABCD2345",
				},
			],
		},
	});
	// The prompt is a lazy chunk; a cold dev server compiles it on first use.
	await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
	await expect(
		page.getByText("Performance fixture device", { exact: true })
	).toBeVisible();
	await expect.poll(() => streams.length).toBe(2);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep/approval-lifetime-completed.png"
		),
		fullPage: true,
		animations: "disabled",
	});
	expect(pending).toHaveLength(3);
});
