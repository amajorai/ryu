import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type FixtureReset,
	parseWorkflowFixtureSnapshot,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

type WorkflowSeed = WorkflowDefinition;

const previewWorkflow: WorkflowSeed = {
	description: "Read-only customer lookup preview",
	edges: [{ from: "customer-input", to: "customer-output" }],
	id: "customer-preview-flow",
	name: "Customer lookup preview",
	nodes: [
		{ id: "customer-input", key: "customer_id", type: "input" },
		{ id: "customer-output", key: "summary", type: "output" },
	],
	triggers: [{ type: "manual" }],
};

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			failures: options.failures ?? {},
			recordStopResult: options.recordStopResult,
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

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Canvas Record starts and stops the recorder, then saves the captured action graph", async ({
	page,
}) => {
	const original: WorkflowSeed = {
		description: "Existing workflow remains unchanged",
		edges: [],
		id: "record-entry-workflow",
		name: "Record entry workflow",
		nodes: [{ id: "existing-input", key: "request", type: "input" }],
		triggers: [{ type: "manual" }],
	};
	await resetFixture(page, { workflows: [original] });
	await page.goto("/?workflowId=record-entry-workflow");
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Record entry workflow"
	);
	await page.getByRole("button", { name: "Record", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await page.getByLabel("What are you doing?").fill("  Apply launch label  ");
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(dialog.getByText("Recording…")).toBeVisible();
	await expect(dialog.getByText("Actions")).toBeVisible();
	await page
		.getByRole("button", { name: "Stop & build workflow", exact: true })
		.click();

	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(2);
	await expect(dialog).toBeHidden();
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Apply launch label"
	);

	const state = await fixtureState(page);
	const startCall = state.calls.find(
		(call) => call.method === "ghost.recordStart"
	);
	const stopCall = state.calls.find(
		(call) => call.method === "ghost.recordStop"
	);
	const saveCall = state.calls.find((call) => call.method === "workflows.save");
	expect(startCall?.args).toEqual({ task: "Apply launch label" });
	expect(stopCall?.args).toEqual({});
	expect(saveCall?.args).toEqual({
		description: "A label is applied to the launch request.",
		edges: [
			{ from: "input", to: "click_1" },
			{ from: "click_1", to: "output" },
		],
		id: "",
		name: "Apply launch label",
		nodes: [
			{ id: "input", key: null, type: "input" },
			{
				action: "click",
				id: "click_1",
				params: { label: "launch" },
				target: {
					query: "button#assign-label",
					role: "button",
				},
				type: "ghost_action",
			},
			{ id: "output", key: null, type: "output" },
		],
		triggers: [],
	});
	expect(state.recording).toBeNull();
	expect(state.workflows[0]).toEqual(original);
	expect(state.workflows[1]).toEqual({
		...saveCall?.args,
		id: "final-actions-workflow-1",
	});
	await page.locator('.react-flow__node[data-id="click_1"]').click();
	await expect(page.getByLabel("Action")).toContainText("Click");
	await expect(page.getByLabel("Target element")).toHaveValue(
		"button#assign-label"
	);
	await saveScreenshot(page, "workflows-canvas-record-start-stop-build.png");
});

test("Dry run sends the preview flag and renders its read-only result", async ({
	page,
}) => {
	await resetFixture(page, { workflows: [previewWorkflow] });
	await page.goto("/?workflowId=customer-preview-flow");
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Customer lookup preview"
	);
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByText("Run workflow", { exact: true })).toBeVisible();
	await page.getByLabel("customer_id").fill("cust-204");
	const dryRunCheckbox = page.getByRole("checkbox", { name: "Dry run" });
	await dryRunCheckbox.check();
	await expect(dryRunCheckbox).toBeChecked();
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await expect(
		page.getByText("Read-only dry run — no changes made", { exact: true })
	).toBeVisible();
	const resultRow = page.getByText("Result", { exact: true }).locator("..");
	await expect(resultRow.getByText("completed", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Preview result for cust-204", { exact: true })
	).toBeVisible();
	const state = await fixtureState(page);
	const runCalls = state.calls.filter(
		(call) => call.method === "workflows.run"
	);
	expect(runCalls).toHaveLength(1);
	expect(runCalls[0]?.args).toEqual({
		dryRun: true,
		id: previewWorkflow.id,
		input: { customer_id: "cust-204" },
	});
	await saveScreenshot(page, "workflows-run-panel-dry-run-result.png");
});

test("RunPanel close discards an unsubmitted input without starting a run", async ({
	page,
}) => {
	await resetFixture(page, { workflows: [previewWorkflow] });
	await page.goto("/?workflowId=customer-preview-flow");
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Customer lookup preview"
	);
	await page.getByRole("button", { name: "Run", exact: true }).click();
	const input = page.getByLabel("customer_id");
	await input.fill("cancel-this-preview");
	await page.getByRole("button", { name: "×", exact: true }).click();
	await expect(page.getByText("Run workflow", { exact: true })).toHaveCount(0);
	await expect(input).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).calls.filter(
					(call) => call.method === "workflows.run"
				).length
		)
		.toBe(0);

	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByLabel("customer_id")).toHaveValue("");
	await expect(page.getByText("Run workflow", { exact: true })).toBeVisible();
	await saveScreenshot(page, "workflows-run-panel-close-reset-draft.png");
});
