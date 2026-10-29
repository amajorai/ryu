import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/credit-usage-charts-proof.html";

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
	page.on("pageerror", (error) => {
		issues.pageErrors.push(error.message);
	});
	page.on("requestfailed", (request) => {
		const failure = request.failure();
		issues.requestFailures.push(
			`${request.method()} ${request.url()}: ${failure?.errorText ?? "unknown error"}`
		);
	});
	return issues;
}

async function openProof(page: Page): Promise<RuntimeIssues> {
	const issues = observeRuntimeIssues(page);
	await page.goto(STORY_URL);
	await expect(page.getByTestId("usage-analytics-dashboard")).toBeVisible();
	return issues;
}

function expectCleanRuntime(issues: RuntimeIssues): void {
	expect(issues.consoleErrors, "console.error output").toEqual([]);
	expect(issues.pageErrors, "uncaught page errors").toEqual([]);
	expect(issues.requestFailures, "failed browser requests").toEqual([]);
}

test("shows canonical gateway rollup totals beside the credit ledger", async ({
	page,
}) => {
	const issues = await openProof(page);

	await expect(page.getByTestId("credit-usage-view")).toBeVisible();
	await expect(page.getByTestId("subscription-usage-dashboard")).toBeVisible();
	await expect(page.getByText("Work account")).toBeVisible();
	await expect(page.getByText("Personal account")).toBeVisible();
	await expect(page.getByText("Team account")).toBeVisible();
	await expect(
		page.getByText("Reconnect this subscription to refresh its access token.")
	).toBeVisible();
	await expect(page.getByTestId("subscription-usage-cost-note")).toContainText(
		"not an invoice"
	);
	await expect(
		page.getByRole("progressbar", { name: "Session: 72% left" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Credit usage analytics" })
	).toBeVisible();
	await expect(page.getByTestId("usage-kpi-requests")).toContainText("6");
	await expect(page.getByTestId("usage-kpi-errors")).toContainText("3");
	await expect(page.getByTestId("usage-kpi-avg-latency")).toContainText(
		"375 ms"
	);
	await expect(page.getByTestId("usage-kpi-active-nodes")).toContainText("1");
	await expect(page.getByTestId("usage-trend-metric")).toBeVisible();
	await expect(page.getByTestId("usage-trend-selected")).toContainText("6");
	await page
		.getByTestId("usage-trend-metric")
		.getByRole("button", { name: "Tokens", exact: true })
		.click();
	await expect(page.getByTestId("usage-trend-selected")).toContainText("150");
	await expect(page.getByTestId("usage-analytics-chart-trend")).toContainText(
		"Tokens at"
	);
	await page
		.getByTestId("usage-trend-metric")
		.getByRole("button", { name: "Requests", exact: true })
		.click();
	await expect(page.getByTestId("usage-trend-selected")).toContainText("6");

	for (const kind of [
		"trend",
		"source",
		"provider",
		"feature-mix",
		"model",
		"provider-ranking",
		"heatmap",
	]) {
		await expect(
			page.getByTestId(`usage-analytics-chart-${kind}`)
		).toBeVisible();
	}

	for (const kind of ["reason", "model", "provider"]) {
		const chart = page.getByTestId(`usage-chart-${kind}`);
		await expect(chart).toBeVisible();
		await expect(chart.locator("[data-slot='chart']")).toHaveCount(1);
		await expect(chart.locator("svg")).toHaveCount(1);
	}

	await expect(page.getByText("Summarize release notes")).toBeVisible();
	await expect(page.getByText("Top-up")).toBeVisible();
	expectCleanRuntime(issues);
});

test("keeps credit receipts out of spend breakdowns", async ({ page }) => {
	const issues = await openProof(page);

	await expect(page.getByTestId("usage-chart-reason")).not.toContainText(
		"Top-up"
	);
	await expect(
		page.getByTestId("usage-chart-reason").getByText("Model usage")
	).toBeVisible();
	expectCleanRuntime(issues);
});

test("keeps totals stable across controls, empties, and recovery", async ({
	page,
}) => {
	const issues = await openProof(page);
	const requests = page.getByTestId("usage-kpi-requests");
	const errors = page.getByTestId("usage-kpi-errors");
	const averageLatency = page.getByTestId("usage-kpi-avg-latency");

	await page.getByRole("button", { name: "This node", exact: true }).click();
	await expect(
		page.getByText("Only usage routed through the selected node.")
	).toBeVisible();
	await expect(requests).toContainText("6");
	await expect(errors).toContainText("3");
	await expect(averageLatency).toContainText("375 ms");

	await page.getByRole("button", { name: "15 min", exact: true }).click();
	await expect(page.getByText("Requests at 15 min resolution.")).toBeVisible();
	await expect(requests).toContainText("6");
	await expect(errors).toContainText("3");
	await expect(averageLatency).toContainText("375 ms");

	await page.getByRole("combobox", { name: "Filter by provider" }).click();
	await page.getByRole("option", { name: "openai", exact: true }).click();
	await expect(requests).toContainText("6");

	await page.getByRole("combobox", { name: "Filter by model" }).click();
	await page.getByRole("option", { name: "gpt-4.1-mini", exact: true }).click();
	await expect(requests).toContainText("6");
	await expect(errors).toContainText("3");
	await expect(averageLatency).toContainText("375 ms");

	await page.getByRole("combobox", { name: "Filter by model" }).click();
	await page
		.getByRole("option", { name: "claude-sonnet-4", exact: true })
		.click();
	await expect(requests).toContainText("0");
	await expect(errors).toContainText("0");
	await expect(averageLatency).toContainText("—");
	await expect(page.getByText("No requests in this range.")).toBeVisible();

	await page.getByRole("combobox", { name: "Filter by model" }).click();
	await page.getByRole("option", { name: "All models", exact: true }).click();
	await expect(requests).toContainText("6");
	await expect(errors).toContainText("3");
	await expect(averageLatency).toContainText("375 ms");
	await expect(page.getByText("No requests in this range.")).toHaveCount(0);
	await expect(page.getByTestId("proof-status")).toContainText(
		"provider/model filters"
	);
	expectCleanRuntime(issues);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("usage-subscription-dashboard-proof.png"),
	});
});
