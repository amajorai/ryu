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

test("Try again reloads saved workflows and makes the exact helper selectable", async ({
	page,
}) => {
	const helper: WorkflowSeed = {
		edges: [],
		id: "retry-helper-flow",
		name: "Shared account lookup",
		nodes: [{ id: "account-input", key: "account_id", type: "input" }],
		triggers: [{ type: "manual" }],
	};
	await resetFixture(page, {
		failures: { "workflows.list": 1 },
		workflows: [helper],
	});
	await page.goto("/");

	await expect(
		page.getByText("Fixture workflows.list temporarily unavailable")
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("Fixture workflows.list temporarily unavailable")
	).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);

	await addNode(page, "Sub-workflow");
	const workflowPicker = page.getByRole("combobox", { name: "Workflow" });
	await workflowPicker.click();
	await page
		.getByRole("option", { name: "Shared account lookup", exact: true })
		.click();
	await expect(workflowPicker).toContainText("Shared account lookup");
	const saveButton = page.getByRole("button", { name: "Save", exact: true });
	await saveButton.click();

	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(2);
	await expect(saveButton).toBeEnabled();
	const state = await fixtureState(page);
	const listCalls = state.calls.filter(
		(call) => call.method === "workflows.list"
	);
	const saveCalls = state.calls.filter(
		(call) => call.method === "workflows.save"
	);
	expect(listCalls).toHaveLength(3);
	expect(state.failures?.["workflows.list"]).toBe(0);
	expect(saveCalls).toHaveLength(1);
	expect(saveCalls[0]?.args).toEqual({
		edges: [],
		id: "",
		name: "New workflow",
		triggers: [],
		nodes: [
			{ id: "sub_workflow_1", type: "sub_workflow", workflow_id: helper.id },
		],
	});
	expect(state.workflows[0]).toEqual(helper);
	expect(state.workflows[1]).toEqual({
		...saveCalls[0]?.args,
		id: "app-actions-workflow-1",
	});
	expect(state.workflows[1]?.id).toBe("app-actions-workflow-1");
	await page.goto("/?workflowId=app-actions-workflow-1");
	await page.locator('.react-flow__node[data-id="sub_workflow_1"]').click();
	await expect(page.getByRole("combobox", { name: "Workflow" })).toContainText(
		"Shared account lookup"
	);
	await saveScreenshot(page, "workflows-app-try-again-recovered-helper.png");
});

test("New workflow clears the selected graph and saves a clean definition", async ({
	page,
}) => {
	const original: WorkflowSeed = {
		description: "Legacy details should not carry over",
		edges: [{ from: "legacy-input", to: "legacy-condition" }],
		id: "legacy-workflow",
		name: "Legacy approval flow",
		nodes: [
			{ id: "legacy-input", key: "legacy_request", type: "input" },
			{ expr: 'input != ""', id: "legacy-condition", type: "condition" },
		],
		triggers: [
			{ cron: "0 9 * * *", type: "schedule" },
			{ secret: "legacy-secret", type: "webhook" },
		],
	};
	await resetFixture(page, { workflows: [original] });
	await page.goto("/?workflowId=legacy-workflow");

	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Legacy approval flow"
	);
	await expect(
		page.locator('.react-flow__node[data-id="legacy-input"]')
	).toHaveCount(1);
	await page.getByRole("button", { name: "New workflow" }).click();

	await expect(page.getByLabel("Workflow name")).toHaveValue("New workflow");
	await expect(page.getByLabel("Description")).toHaveValue("");
	await expect(
		page.locator('.react-flow__node[data-id="legacy-input"]')
	).toHaveCount(0);
	await expect(
		page.locator('.react-flow__node[data-id="legacy-condition"]')
	).toHaveCount(0);
	await expect(
		page.locator('.react-flow__node[data-id="__trigger__"]')
	).toContainText("Manual");

	await page.getByLabel("Workflow name").fill("Clean import workflow");
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("new_request");
	const saveButton = page.getByRole("button", { name: "Save", exact: true });
	await saveButton.click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(2);
	await expect(saveButton).toBeEnabled();

	const state = await fixtureState(page);
	const saveCalls = state.calls.filter(
		(call) => call.method === "workflows.save"
	);
	expect(saveCalls).toHaveLength(1);
	expect(saveCalls[0]?.args).toEqual({
		edges: [],
		id: "",
		name: "Clean import workflow",
		nodes: [{ id: "input_1", key: "new_request", type: "input" }],
		triggers: [],
	});
	expect(state.workflows[0]).toEqual(original);
	expect(state.workflows[1]).toEqual({
		...saveCalls[0]?.args,
		id: "app-actions-workflow-1",
	});
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Clean import workflow"
	);
	await page.locator('.react-flow__node[data-id="input_1"]').click();
	await expect(page.getByLabel("Key")).toHaveValue("new_request");
	await saveScreenshot(
		page,
		"workflows-app-new-workflow-clears-stale-state.png"
	);
});
