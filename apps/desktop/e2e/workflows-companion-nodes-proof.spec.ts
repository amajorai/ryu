import { expect, test } from "@playwright/test";
import {
	addNode,
	fixtureState,
	resetFixture,
	saveScreenshot,
} from "./workflows-companion-proof.helpers.ts";

test("Recipe node selects a recorded recipe and persists parsed parameter mappings", async ({
	page,
}) => {
	await resetFixture(page, {
		failures: {},
		recipes: [
			{
				app: "Linear",
				description: "File an issue from the current request.",
				name: "Triage ticket",
				params: ["title", "project"],
				step_count: 4,
			},
		],
	});
	await page.goto("/?seed=empty");
	await addNode(page, "Recipe");
	const recipePicker = page.getByRole("combobox", { name: "Recipe" });
	await expect(recipePicker).toBeVisible();
	await recipePicker.click();
	await page
		.getByRole("option", { name: "Triage ticket", exact: true })
		.click();
	await page
		.getByLabel("Parameters (JSON)")
		.fill('{"title":"{{input}}","project":"ops"}');
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			id: "recipe_1",
			params: { project: "ops", title: "{{input}}" },
			recipe: "Triage ticket",
			type: "recipe",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="recipe_1"]').click();
	await expect(page.getByRole("combobox", { name: "Recipe" })).toHaveText(
		/^Triage ticket/
	);
	expect(
		JSON.parse(await page.getByLabel("Parameters (JSON)").inputValue())
	).toEqual({ project: "ops", title: "{{input}}" });
	await saveScreenshot(page, "workflows-recipe-catalog-params-reopen.png");
});

test("Recipe node keeps manual recipe names available when the recipe catalog is empty", async ({
	page,
}) => {
	await resetFixture(page, { failures: {}, recipes: [] });
	await page.goto("/?seed=empty");
	await addNode(page, "Recipe");
	const recipeName = "local-only-recipe";
	await page.getByLabel("Recipe").fill(recipeName);
	await page.getByLabel("Parameters (JSON)").fill('{"folder":"{{input}}"}');
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			id: "recipe_1",
			params: { folder: "{{input}}" },
			recipe: recipeName,
			type: "recipe",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="recipe_1"]').click();
	await expect(page.getByLabel("Recipe")).toHaveValue(recipeName);
	expect(
		JSON.parse(await page.getByLabel("Parameters (JSON)").inputValue())
	).toEqual({ folder: "{{input}}" });
	await saveScreenshot(page, "workflows-recipe-manual-fallback-reopen.png");
});

test("Ghost Action serializes the chosen action, target app and templated input", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await addNode(page, "Action");
	await page.getByLabel("Action").click();
	await page.getByRole("option", { name: "Type", exact: true }).click();
	await page.getByLabel("Target element").fill("Email message field");
	await page.getByLabel("App").fill("Gmail");
	await page.getByLabel("Text to type").fill("{{input}}");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			action: "type",
			id: "ghost_action_1",
			params: { text: "{{input}}" },
			target: { app: "Gmail", query: "Email message field" },
			type: "ghost_action",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="ghost_action_1"]').click();
	await expect(page.getByLabel("Action")).toHaveText(/^Type/);
	await expect(page.getByLabel("Target element")).toHaveValue(
		"Email message field"
	);
	await expect(page.getByLabel("App")).toHaveValue("Gmail");
	await expect(page.getByLabel("Text to type")).toHaveValue("{{input}}");
	await expect(
		page.locator('.react-flow__node[data-id="ghost_action_1"]')
	).toContainText("type → Email message field");
	await saveScreenshot(page, "workflows-ghost-action-config-reopen.png");
});

test("record dialog cancellation makes no host mutation", async ({ page }) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await page
		.getByRole("button", { name: "Record a task", exact: true })
		.click();
	await page.getByLabel("What are you doing?").fill("Send a follow-up email");
	await saveScreenshot(page, "workflows-record-task-cancel-dialog.png");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	const state = await fixtureState(page);
	expect(state.workflows).toEqual([]);
	expect(state.calls.some((call) => call.method === "ghost.recordStart")).toBe(
		false
	);
	expect(state.calls.some((call) => call.method === "ghost.recordStop")).toBe(
		false
	);
});

test("recorded desktop actions become editable workflow nodes and survive reopening", async ({
	page,
}) => {
	const recordedDraft = {
		description: "Click the submit button in the ticket form.",
		name: "Submit ticket",
		schema_version: 1,
		steps: [
			{
				action: "click",
				id: 1,
				params: {},
				target: { query: "button#submit" },
			},
		],
	};
	await resetFixture(page, {
		failures: {},
		recordStopResult: {
			draft: recordedDraft,
			event_count: 1,
			events: [
				{
					event_type: "click",
					element_name: "Submit",
					element_role: "button",
					ts_ms: 1,
				},
			],
			recording: false,
			started_at: new Date(0).toISOString(),
			task: "Submit ticket",
		},
	});
	await page.goto("/?seed=empty");
	await page
		.getByRole("button", { name: "Record a task", exact: true })
		.click();
	await page.getByLabel("What are you doing?").fill("Submit ticket");
	await page
		.getByRole("button", { name: "Start recording", exact: true })
		.click();
	await expect(page.getByText("Recording…")).toBeVisible();
	await page
		.getByRole("button", { name: "Stop & build workflow", exact: true })
		.click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved).toMatchObject({
		description: recordedDraft.description,
		edges: [
			{ from: "input", to: "click_1" },
			{ from: "click_1", to: "output" },
		],
		name: recordedDraft.name,
		nodes: [
			{ id: "input", key: null, type: "input" },
			{
				action: "click",
				id: "click_1",
				params: {},
				target: { query: "button#submit" },
				type: "ghost_action",
			},
			{ id: "output", key: null, type: "output" },
		],
		triggers: [],
	});
	const state = await fixtureState(page);
	expect(
		state.calls.find((call) => call.method === "ghost.recordStart")?.args
	).toEqual({
		task: "Submit ticket",
	});
	expect(state.calls.some((call) => call.method === "ghost.recordStop")).toBe(
		true
	);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await expect(page.getByLabel("Workflow name")).toHaveValue("Submit ticket");
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await expect(
		page.locator('.react-flow__node[data-id="click_1"]')
	).toContainText("click → button#submit");
	await page.locator('.react-flow__node[data-id="click_1"]').click();
	await expect(page.getByLabel("Action")).toContainText("Click");
	await saveScreenshot(page, "workflows-recorded-action-reopen.png");
});
