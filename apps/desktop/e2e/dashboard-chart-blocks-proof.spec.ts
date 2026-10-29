import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/dashboard-chart-blocks-proof.html";

interface RuntimeIssues {
	consoleErrors: string[];
	pageErrors: string[];
	requestFailures: string[];
}

function observeRuntimeIssues(page: Page): RuntimeIssues {
	const issues: RuntimeIssues = {
		consoleErrors: [],
		pageErrors: [],
		requestFailures: [],
	};
	page.on("console", (message) => {
		if (message.type() === "error") {
			issues.consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => issues.pageErrors.push(error.message));
	page.on("requestfailed", (request) => {
		const failure = request.failure();
		issues.requestFailures.push(
			`${request.method()} ${request.url()}: ${failure?.errorText ?? "unknown error"}`
		);
	});
	return issues;
}

test("renders the dashboard chart-block composition cleanly", async ({
	page,
}) => {
	const issues = observeRuntimeIssues(page);
	await page.setViewportSize({ height: 1200, width: 1280 });
	await page.goto(STORY_URL);

	await expect(page).toHaveTitle("Dashboard chart blocks proof");
	await expect(page.getByTestId("dashboard-chart-blocks-proof")).toBeVisible();
	await expect(page.locator('[data-slot="chart"]')).toHaveCount(4);
	await expect(page.getByText("Requests by provider")).toBeVisible();
	await expect(
		page.getByLabel("Pie Chart dashboard chart").getByText("OpenAI")
	).toBeVisible();
	for (const label of [
		"Area chart dashboard chart",
		"Pie chart dashboard chart",
		"Bar chart dashboard chart",
		"Line chart dashboard chart",
	]) {
		await expect(page.getByRole("img", { name: label })).toBeVisible();
	}
	await expect(page.getByTestId("proof-status")).toContainText(
		"four chart kinds"
	);

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("dashboard-chart-blocks-proof.png"),
	});

	expect(issues.consoleErrors, "console.error output").toEqual([]);
	expect(issues.pageErrors, "uncaught page errors").toEqual([]);
	expect(issues.requestFailures, "failed browser requests").toEqual([]);
});
