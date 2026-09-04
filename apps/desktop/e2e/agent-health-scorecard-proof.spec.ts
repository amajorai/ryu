import { expect, test } from "@playwright/test";

test("agent health scorecard updates when guardrails change", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));
	page.on("requestfailed", (request) => {
		failedRequests.push(
			`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`
		);
	});

	await page.goto("/agent-health-scorecard-proof.html");
	await expect(page).toHaveTitle("Agent health scorecard proof");
	await expect(page.getByTestId("proof-status")).toHaveText(
		"PRODUCTION EDITOR"
	);
	await expect(page.getByTestId("agent-health-scorecard")).toBeVisible();
	await expect(
		page.locator('[data-scorecard-ruleset="agent-config-1"]')
	).toBeVisible();
	await expect(page.getByTestId("health-grade")).toContainText("B");
	await expect(
		page.getByText("High-impact access is guarded", { exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: "/tmp/ryu-agent-health-scorecard-before.png",
	});

	await page
		.getByRole("switch", {
			name: "Require approval for high-impact access",
		})
		.click();
	await expect(page.getByTestId("health-grade")).toContainText("A");
	await expect(
		page
			.getByTestId("agent-health-scorecard")
			.getByText("This scorecard is a configuration review.")
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: "/tmp/ryu-agent-health-scorecard-after.png",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		fullPage: true,
		path: "/tmp/ryu-agent-health-scorecard-mobile.png",
	});

	await expect(page.locator("body")).not.toContainText("Application error");

	expect(consoleErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});
