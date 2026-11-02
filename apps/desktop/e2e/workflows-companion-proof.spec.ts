import { expect, test } from "@playwright/test";
import {
	addNode,
	fixtureState,
	resetFixture,
	saveScreenshot,
} from "./workflows-companion-proof.helpers.ts";

test("create, connect, configure, save, retry and reopen a workflow graph", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await resetFixture(page);
	await page.goto("/?seed=empty");
	await expect(
		page.getByRole("button", { name: "New workflow" })
	).toBeVisible();
	await page.getByLabel("Workflow name").fill("Quarterly review");
	await page.getByLabel("Description").fill("Normalize each submitted brief.");
	await page.getByRole("button", { name: "Hide palette" }).click();
	await expect(page.getByPlaceholder("Search nodes")).toBeHidden();
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.getByPlaceholder("Search nodes")).toBeVisible();

	await page.getByPlaceholder("Search nodes").fill("Input");
	await expect(
		page.getByRole("button", { name: "Output", exact: true })
	).toHaveCount(0);
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("brief");
	await addNode(page, "Transform");
	await page.getByLabel("Operation").click();
	await page.getByRole("option", { name: "template", exact: true }).click();
	await page.getByLabel("Template").fill("Review: {{input}}");
	await addNode(page, "Output");
	await page.getByLabel("Key").fill("summary");

	const inputHandle = page.locator(
		'.react-flow__node[data-id="input_1"] .react-flow__handle.source'
	);
	const transformHandle = page.locator(
		'.react-flow__node[data-id="transform_2"] .react-flow__handle.target'
	);
	const transformOutputHandle = page.locator(
		'.react-flow__node[data-id="transform_2"] .react-flow__handle.source'
	);
	const outputHandle = page.locator(
		'.react-flow__node[data-id="output_3"] .react-flow__handle.target'
	);
	await inputHandle.dragTo(transformHandle);
	await expect(page.locator(".react-flow__edge")).toHaveCount(1);
	await transformOutputHandle.dragTo(outputHandle);
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture workflows.save temporarily unavailable"
	);
	expect((await fixtureState(page)).workflows).toHaveLength(0);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const state = await fixtureState(page);
	const saves = state.calls.filter((call) => call.method === "workflows.save");
	expect(saves).toHaveLength(2);
	expect(saves[1]?.args).toEqual({
		id: "",
		name: "Quarterly review",
		description: "Normalize each submitted brief.",
		nodes: [
			{ id: "input_1", key: "brief", type: "input" },
			{
				id: "transform_2",
				op: "template",
				template: "Review: {{input}}",
				type: "transform",
			},
			{ id: "output_3", key: "summary", type: "output" },
		],
		edges: [
			{ from: "input_1", to: "transform_2" },
			{ from: "transform_2", to: "output_3" },
		],
		triggers: [],
	});
	expect(saves[0]?.args).toEqual(saves[1]?.args);
	const saved = state.workflows[0];
	expect(saved?.name).toBe("Quarterly review");
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Quarterly review"
	);
	await expect(page.getByLabel("Description")).toHaveValue(
		"Normalize each submitted brief."
	);
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await page.locator('.react-flow__node[data-id="transform_2"]').click();
	await expect(page.getByLabel("Template")).toHaveValue("Review: {{input}}");
	await page.getByRole("button", { name: "Hide palette" }).click();
	expect(pageErrors).toEqual([]);
	await saveScreenshot(page, "workflows-create-graph-save-retry.png");
});

test("invalid MCP JSON cannot overwrite the last valid args and survives reopening", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await addNode(page, "MCP");
	await page.getByLabel("Server").fill("spider");
	await page.getByLabel("Tool").fill("crawl");
	const args = page.getByLabel("Args (JSON)");
	await args.fill('{"query":"status","limit":2}');
	await args.fill('{"query":');

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	const expectedNode = {
		args: { limit: 2, query: "status" },
		id: "mcp_1",
		server: "spider",
		tool: "crawl",
		type: "mcp",
	};
	expect(saved?.nodes).toEqual([expectedNode]);
	expect(saved?.edges).toEqual([]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="mcp_1"]').click();
	const reopenedArgs = page.getByLabel("Args (JSON)");
	await expect(reopenedArgs).toBeVisible();
	expect(JSON.parse(await reopenedArgs.inputValue())).toEqual(
		expectedNode.args
	);
	expect(await page.getByLabel("Server").inputValue()).toBe("spider");
	expect(await page.getByLabel("Tool").inputValue()).toBe("crawl");
	await saveScreenshot(page, "workflows-mcp-json-validation-reopen.png");
});

test("deleting a connected node removes its edges from the saved workflow", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await addNode(page, "Input");
	await addNode(page, "Transform");
	await addNode(page, "Output");
	await page
		.locator('.react-flow__node[data-id="input_1"] .react-flow__handle.source')
		.dragTo(
			page.locator(
				'.react-flow__node[data-id="transform_2"] .react-flow__handle.target'
			)
		);
	await page
		.locator(
			'.react-flow__node[data-id="transform_2"] .react-flow__handle.source'
		)
		.dragTo(
			page.locator(
				'.react-flow__node[data-id="output_3"] .react-flow__handle.target'
			)
		);
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);

	await page.locator('.react-flow__node[data-id="transform_2"]').click();
	await page.getByRole("button", { name: "Delete node" }).click();
	await expect(page.locator(".react-flow__edge")).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes.length)
		.toBe(2);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{ id: "input_1", key: null, type: "input" },
		{ id: "output_3", key: null, type: "output" },
	]);
	expect(saved?.edges).toEqual([]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await expect(page.locator(".react-flow__edge")).toHaveCount(0);
	await expect(
		page.locator('.react-flow__node[data-id="input_1"]')
	).toBeVisible();
	await expect(
		page.locator('.react-flow__node[data-id="output_3"]')
	).toBeVisible();
	await expect(
		page.locator('.react-flow__node[data-id="transform_2"]')
	).toHaveCount(0);
	await saveScreenshot(page, "workflows-delete-node-removes-edges.png");
});

test("schedule trigger settings save exactly and reopen on the trigger node", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("request");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const firstSave = (await fixtureState(page)).workflows[0];
	const triggerNode = page.locator('.react-flow__node[data-id="__trigger__"]');
	await expect(triggerNode).toBeVisible();
	await triggerNode.click();
	await page.locator("#trig-type").click();
	await page.getByRole("option", { name: "Schedule", exact: true }).click();
	await page.locator("#trig-every").click();
	await page.getByRole("option", { name: "6h", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.triggers.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.id).toBe(firstSave?.id);
	expect(saved?.triggers).toEqual([
		{ cron: null, every: "6h", type: "schedule" },
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	const reopenedTrigger = page.locator(
		'.react-flow__node[data-id="__trigger__"]'
	);
	await expect(reopenedTrigger).toBeVisible();
	await reopenedTrigger.click();
	await expect(page.locator("#trig-type")).toContainText("Schedule");
	await expect(page.locator("#trig-every")).toContainText("6h");
	expect((await fixtureState(page)).workflows[0]?.triggers).toEqual(
		saved?.triggers
	);
	await saveScreenshot(page, "workflows-schedule-trigger-reopen.png");
});

test("run and resume errors keep input available for retry, then complete visibly", async ({
	page,
}) => {
	await resetFixture(page, {
		failures: { "workflows.run": 1, "workflows.resume": 1 },
	});
	await page.goto("/?seed=empty");
	await page.getByLabel("Workflow name").fill("Review deployment");
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("request");
	await addNode(page, "Pause for review");
	await page.getByLabel("Prompt").fill("Approve this deployment?");
	await addNode(page, "Output");
	await page
		.locator('.react-flow__node[data-id="input_1"] .react-flow__handle.source')
		.dragTo(
			page.locator(
				'.react-flow__node[data-id="awakeable_2"] .react-flow__handle.target'
			)
		);
	await page
		.locator(
			'.react-flow__node[data-id="awakeable_2"] .react-flow__handle.source'
		)
		.dragTo(
			page.locator(
				'.react-flow__node[data-id="output_3"] .react-flow__handle.target'
			)
		);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const savedBeforeRun = (await fixtureState(page)).workflows[0];
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await page.getByLabel("request").fill("Deploy build 42");
	await page.getByRole("button", { name: "Run", exact: true }).last().click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture workflows.run temporarily unavailable"
	);
	await expect(page.getByLabel("request")).toHaveValue("Deploy build 42");
	await page.getByRole("button", { name: "Run", exact: true }).last().click();
	await expect(
		page.getByText("Awaiting input: Approve this deployment?")
	).toBeVisible();
	await page.getByLabel("Workflow response").fill("Approved by reviewer");
	await page.getByRole("button", { name: "Resume", exact: true }).click();
	await expect(
		page.getByText("Fixture workflows.resume temporarily unavailable")
	).toBeVisible();
	await expect(page.getByLabel("Workflow response")).toHaveValue(
		"Approved by reviewer"
	);
	await page.getByRole("button", { name: "Resume", exact: true }).click();
	await expect(
		page.getByText("completed", { exact: true }).last()
	).toBeVisible();
	await expect(
		page.getByText("Approved by reviewer", { exact: true })
	).toBeVisible();
	const state = await fixtureState(page);
	expect(state.calls.filter((call) => call.method === "workflows.run")).toEqual(
		[
			{
				args: {
					dryRun: false,
					id: savedBeforeRun?.id,
					input: { request: "Deploy build 42" },
				},
				method: "workflows.run",
			},
			{
				args: {
					dryRun: false,
					id: savedBeforeRun?.id,
					input: { request: "Deploy build 42" },
				},
				method: "workflows.run",
			},
		]
	);
	expect(
		state.calls
			.filter((call) => call.method === "workflows.resume")
			.map((call) => call.args)
	).toEqual([
		{ payload: "Approved by reviewer", runId: "workflow-run-1" },
		{ payload: "Approved by reviewer", runId: "workflow-run-1" },
	]);
	expect(state.runs["workflow-run-1"]).toMatchObject({
		awaitingNode: null,
		input: { request: "Deploy build 42" },
		output: { review: "Approved by reviewer" },
		status: "completed",
	});
	expect(state.workflows[0]).toEqual(savedBeforeRun);

	await page.goto(`/?workflowId=${savedBeforeRun?.id ?? ""}`);
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Review deployment"
	);
	await page.locator('.react-flow__node[data-id="awakeable_2"]').click();
	await expect(page.getByLabel("Prompt")).toHaveValue(
		"Approve this deployment?"
	);
	expect((await fixtureState(page)).workflows[0]).toEqual(savedBeforeRun);
	await saveScreenshot(page, "workflows-run-resume-retry-and-reopen.png");
});

test("version history diffs a saved change and restores the exact prior definition", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await page.getByLabel("Workflow name").fill("Versioned workflow");
	await page.getByLabel("Description").fill("Original instructions");
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("brief");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const original = (await fixtureState(page)).workflows[0];
	await page.getByRole("button", { name: "Save version", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).versions[original?.id ?? ""]?.length
		)
		.toBe(1);

	await page.getByLabel("Description").fill("Updated instructions");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.description)
		.toBe("Updated instructions");
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: /History/ }).click();
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).calls.filter(
					(call) => call.method === "workflows.versionsList"
				).length
		)
		.toBeGreaterThanOrEqual(2);
	const versionRow = page.getByRole("listitem").first();
	await expect(versionRow).toBeVisible();
	await expect(versionRow).toContainText("Diff");
	await versionRow.getByRole("button", { name: "Diff", exact: true }).click();
	const diff = page.locator("pre").last();
	await expect(diff).toContainText('-  "description": "Original instructions"');
	await expect(diff).toContainText('+  "description": "Updated instructions"');
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(page.getByLabel("Description")).toHaveValue(
		"Original instructions"
	);
	const restored = (await fixtureState(page)).workflows[0];
	expect(restored).toEqual(original);
	await expect(page.getByRole("button", { name: /History/ })).toBeVisible();

	await page.goto(`/?workflowId=${original?.id ?? ""}`);
	await expect(page.getByLabel("Workflow name")).toHaveValue(
		"Versioned workflow"
	);
	await expect(page.getByLabel("Description")).toHaveValue(
		"Original instructions"
	);
	await page.locator('.react-flow__node[data-id="input_1"]').click();
	await expect(page.getByLabel("Key")).toHaveValue("brief");
	expect((await fixtureState(page)).workflows[0]).toEqual(original);
	await saveScreenshot(page, "workflows-version-history-restore-reopen.png");
});
