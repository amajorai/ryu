import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/polar-credit-balance-proof.html";
const PROOF_PATH =
	"/Users/jiawei/Documents/Code/ryu/apps/desktop/artifacts/polar-credit-balance-proof.png";

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

function expectCleanRuntime(issues: RuntimeIssues): void {
	expect(issues.consoleErrors, "console.error output").toEqual([]);
	expect(issues.pageErrors, "uncaught page errors").toEqual([]);
	expect(issues.requestFailures, "failed browser requests").toEqual([]);
}

test("shows the Polar aggregate and provider-specific allocation", async ({
	page,
}) => {
	const issues = observeRuntimeIssues(page);
	await page.goto(STORY_URL);

	const proof = page.getByTestId("polar-credit-balance-proof");
	await expect(proof).toBeVisible();
	await expect(proof.getByText("Polar balance")).toBeVisible();
	await expect(proof.getByText("$12.50")).toBeVisible();
	await expect(
		proof.getByText("Polar maintains this aggregate credit meter")
	).toBeVisible();
	await expect(proof.getByText("Provider-specific allocations")).toBeVisible();
	await expect(proof.getByText("Ryu Fast")).toBeVisible();
	await expect(proof.getByText("$2.50")).toBeVisible();
	await expect(proof.getByText("Allocated free provider only")).toBeVisible();
	await expect(proof.getByText("Plan credits")).toHaveCount(0);
	await expect(proof.getByText("On-demand credits")).toHaveCount(0);
	await expect(proof.getByTestId("proof-status")).toContainText(
		"provider-specific allocation"
	);
	expectCleanRuntime(issues);
	await page.screenshot({ fullPage: true, path: PROOF_PATH });
});
