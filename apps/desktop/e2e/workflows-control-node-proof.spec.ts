import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

import {
	type FixtureReset,
	parseWorkflowFixtureSnapshot,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

type WorkflowSeed = WorkflowDefinition;

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			failures: options.failures ?? {},
			workflows: options.workflows ?? [],
		},
	});
	expect(response.ok()).toBeTruthy();
}

async function fixtureState(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return parseWorkflowFixtureSnapshot(await response.text());
}

async function addNode(page: Page, name: string) {
	await page.getByPlaceholder("Search nodes").fill(name);
	await page.getByRole("button", { name, exact: true }).click();
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("While node switches gate/loop state and persists expression, body and validated cap", async ({
	page,
}) => {
	const helper: WorkflowSeed = {
		edges: [],
		id: "loop-helper",
		name: "Review one item",
		nodes: [{ id: "helper-input", key: "item", type: "input" }],
		triggers: [],
	};
	await resetFixture(page, { workflows: [helper] });
	await page.goto("/?seed=empty");
	await page.getByLabel("Workflow name").fill("Review until complete");
	await addNode(page, "While");
	await expect(
		page.getByRole("button", { name: "One-shot gate" })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "Loop", exact: true }).click();
	await page.getByLabel("Repeat while").fill("input < 3");
	const bodyPicker = page.getByRole("combobox", { name: "Loop body workflow" });
	await bodyPicker.click();
	await page
		.getByRole("option", { name: "Review one item", exact: true })
		.click();
	const maxIterations = page.getByLabel("Max iterations");
	await expect(maxIterations).toHaveAttribute("min", "1");
	await expect(maxIterations).toHaveAttribute("max", "100");
	await maxIterations.fill("0");
	await expect(maxIterations).toHaveValue("");
	await maxIterations.fill("8");
	await expect(maxIterations).toHaveValue("8");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () =>
			(await fixtureState(page)).workflows.some(
				(workflow) => workflow.name === "Review until complete"
			)
		)
		.toBe(true);
	let saved = (await fixtureState(page)).workflows.find(
		(workflow) => workflow.name === "Review until complete"
	);
	expect(saved?.nodes).toEqual([
		{
			body_workflow_id: "loop-helper",
			expr: "input < 3",
			id: "while_1",
			max_iterations: 8,
			type: "while",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="while_1"]').click();
	await expect(page.getByLabel("Repeat while")).toHaveValue("input < 3");
	await expect(page.getByLabel("Max iterations")).toHaveValue("8");
	await expect(
		page.getByRole("combobox", { name: "Loop body workflow" })
	).toContainText("Review one item");
	await page
		.getByRole("button", { name: "One-shot gate", exact: true })
		.click();
	await expect(page.getByLabel("Condition")).toHaveValue("input < 3");
	await expect(page.getByLabel("Loop body workflow")).toHaveCount(0);
	await expect(page.getByLabel("Max iterations")).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).workflows.find(
					(workflow) => workflow.id === saved?.id
				)?.nodes[0]?.body_workflow_id
		)
		.toBeNull();
	saved = (await fixtureState(page)).workflows.find(
		(workflow) => workflow.id === saved?.id
	);
	expect(saved?.nodes).toEqual([
		{
			body_workflow_id: null,
			expr: "input < 3",
			id: "while_1",
			max_iterations: 8,
			type: "while",
		},
	]);
	await saveScreenshot(page, "workflows-while-loop-gate-state-reopen.png");
});

test("Reliability policy normalizes bounds, saves error filters, retries save, and can be disabled", async ({
	page,
}) => {
	await resetFixture(page, { failures: { "workflows.save": 1 } });
	await page.goto("/?seed=empty");
	await addNode(page, "Tool");
	await page.getByLabel("Tool").fill("ops.lookup");
	const retrySwitch = page.getByRole("switch", { name: "Retry on failure" });
	await expect(retrySwitch).not.toBeChecked();
	await expect(page.getByLabel("Max attempts")).toHaveCount(0);
	await retrySwitch.click();
	await expect(retrySwitch).toBeChecked();

	const maxAttempts = page.getByLabel("Max attempts");
	await expect(maxAttempts).toHaveAttribute("min", "1");
	await maxAttempts.fill("0");
	await expect(maxAttempts).toHaveValue("1");
	await maxAttempts.fill("4");
	const initialBackoff = page.getByLabel("Initial backoff (ms)");
	await initialBackoff.fill("0");
	await expect(initialBackoff).toHaveValue("0");
	await initialBackoff.fill("250");
	const coefficient = page.getByLabel("Backoff ×");
	await expect(coefficient).toHaveAttribute("min", "1");
	await coefficient.fill("0");
	await expect(coefficient).toHaveValue("1");
	await coefficient.fill("1.5");
	await page.getByLabel("Max backoff (ms)").fill("8000");
	const jitter = page.getByLabel("Jitter (0–1)");
	await expect(jitter).toHaveAttribute("min", "0");
	await expect(jitter).toHaveAttribute("max", "1");
	await jitter.fill("0.35");
	await page
		.getByLabel("Non-retryable errors")
		.fill("AUTH, invalid input,, network");
	await page.getByLabel("Timeout (ms)").fill("30000");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture workflows.save temporarily unavailable"
	);
	await expect(maxAttempts).toHaveValue("4");
	await expect(jitter).toHaveValue("0.35");
	expect((await fixtureState(page)).workflows).toEqual([]);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			args: {},
			id: "tool_1",
			name: "ops.lookup",
			retry: {
				backoff_coefficient: 1.5,
				initial_interval_ms: 250,
				jitter_fraction: 0.35,
				max_attempts: 4,
				max_interval_ms: 8000,
				non_retryable_errors: ["AUTH", "invalid input", "network"],
			},
			timeout_ms: 30_000,
			type: "tool",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="tool_1"]').click();
	await expect(
		page.getByRole("switch", { name: "Retry on failure" })
	).toBeChecked();
	await expect(page.getByLabel("Max attempts")).toHaveValue("4");
	await expect(page.getByLabel("Initial backoff (ms)")).toHaveValue("250");
	await expect(page.getByLabel("Backoff ×")).toHaveValue("1.5");
	await expect(page.getByLabel("Max backoff (ms)")).toHaveValue("8000");
	await expect(page.getByLabel("Jitter (0–1)")).toHaveValue("0.35");
	await expect(page.getByLabel("Non-retryable errors")).toHaveValue(
		"AUTH, invalid input, network"
	);
	await expect(page.getByLabel("Timeout (ms)")).toHaveValue("30000");
	await saveScreenshot(page, "workflows-retry-policy-persisted.png");

	await page.getByRole("switch", { name: "Retry on failure" }).click();
	await expect(page.getByLabel("Max attempts")).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes[0]?.retry)
		.toBeUndefined();
	expect((await fixtureState(page)).workflows[0]?.nodes[0]).toEqual({
		args: {},
		id: "tool_1",
		name: "ops.lookup",
		timeout_ms: 30_000,
		type: "tool",
	});
});
