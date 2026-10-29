import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	agentPath,
	installOptimizerAgentRouteFixture,
	optimizerPath,
} from "./optimizer-agent-route-proof.fixture.ts";

async function openOptimizer(page: Page) {
	const activity = page.getByRole("tab", { name: "Activity", exact: true });
	// The editor's tab row scrolls instead of collapsing, so Activity is a tab
	// in the row rather than an entry in a "N more" menu.
	await expect(
		page
			.getByRole("tablist")
			.filter({ has: activity })
			.getByRole("button", { name: /Show \d+ more tabs/ })
	).toHaveCount(0);
	await activity.click();
	await page.getByRole("tab", { name: "Optimizations", exact: true }).click();
	await expect(
		page.getByText("Analyze recent sessions", { exact: true })
	).toBeVisible();
}

test("the actual agent editor reloads a committed apply failure and recovers its original receipt after analysis, newer edits and reopening", async ({
	page,
}) => {
	const evidenceDir = process.env.RYU_OPTIMIZER_AGENT_PROOF_DIR;
	if (!(evidenceDir && path.isAbsolute(evidenceDir))) {
		throw new Error(
			"RYU_OPTIMIZER_AGENT_PROOF_DIR must name a fresh absolute proof directory"
		);
	}
	mkdirSync(evidenceDir, { recursive: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const fixture = await installOptimizerAgentRouteFixture(page);
	await page.goto("/optimizer-agent-route-proof.html");
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Optimizer proof agent"
	);
	await openOptimizer(page);
	const beforeApplyReads = fixture.snapshot().agentReads;
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: "Retry recording suggestion",
			exact: true,
		})
	).toBeVisible();
	await expect
		.poll(() => fixture.snapshot().agentReads)
		.toBeGreaterThan(beforeApplyReads);
	await expect(page.getByRole("alert")).toContainText("500");
	await page.screenshot({
		path: path.join(evidenceDir, "recovery-required.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.getByRole("button", { name: "Run analysis", exact: true }).click();
	await page
		.locator("summary")
		.filter({ hasText: "Earlier suggestions (1)" })
		.click();
	await expect(
		page.getByText("Replaced by a newer analysis", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Retry recording suggestion",
			exact: true,
		})
	).toBeEnabled();
	const newerResponse = await page.evaluate(async (url) => {
		const response = await fetch(url, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer synthetic-optimizer-node",
				"x-ryu-user-jwt": "synthetic-optimizer-user",
			},
			body: JSON.stringify({ name: "Newer independently saved agent" }),
		});
		return { status: response.status, body: await response.json() };
	}, agentPath);
	expect(newerResponse.status).toBe(200);
	expect(newerResponse.body.agent.model).toBe("cheaper-model");
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Newer independently saved agent"
	);
	await openOptimizer(page);
	await expect(
		page.getByRole("button", {
			name: "Retry recording suggestion",
			exact: true,
		})
	).toBeEnabled();
	await page
		.getByRole("button", { name: "Retry recording suggestion", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("503");
	await expect(
		page.getByRole("button", {
			name: "Retry recording suggestion",
			exact: true,
		})
	).toBeEnabled();
	await page
		.getByRole("button", { name: "Retry recording suggestion", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Retry recording suggestion",
			exact: true,
		})
	).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		"Newer independently saved agent"
	);
	const {
		calls,
		unknown,
		model,
		revision,
		optimizerWrites,
		newerWrites,
		applyAttempts,
	} = fixture.snapshot();
	expect(model).toBe("cheaper-model");
	expect(revision).toBe(2);
	expect(optimizerWrites).toBe(1);
	expect(newerWrites).toBe(1);
	expect(applyAttempts).toBe(3);
	expect(calls.filter((call) => call.method === "POST")).toEqual([
		{
			method: "POST",
			path: `${optimizerPath}/original%2Fsuggestion/apply`,
			body: null,
			status: 500,
		},
		{
			method: "POST",
			path: `${optimizerPath}/analyze`,
			body: { candidateModels: [] },
			status: 200,
		},
		{
			method: "POST",
			path: `${optimizerPath}/original%2Fsuggestion/apply`,
			body: null,
			status: 503,
		},
		{
			method: "POST",
			path: `${optimizerPath}/original%2Fsuggestion/apply`,
			body: null,
			status: 200,
		},
	]);
	expect(unknown).toEqual([]);
	expect(errors).toEqual([]);
	await page
		.locator("summary")
		.filter({ hasText: "Earlier suggestions (1)" })
		.click();
	await expect(page.getByText("Applied", { exact: true })).toBeVisible();
	await expect(
		page.getByText("This agent is not installed yet.", { exact: false })
	).toHaveCount(0);
	await page.screenshot({
		path: path.join(evidenceDir, "recovery-completed-newer-agent.png"),
		fullPage: true,
		animations: "disabled",
	});
	writeFileSync(
		path.join(evidenceDir, "transport.json"),
		JSON.stringify(
			{
				calls,
				unknown,
				errors,
				currentAgent: fixture.snapshot().currentAgent,
				optimizerWrites,
				newerWrites,
			},
			null,
			2
		)
	);
});
