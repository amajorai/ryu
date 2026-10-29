import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { parseWorkflowCompanionSnapshot } from "./workflow-companion-fixture-contract.ts";
import type { FixtureReset } from "./workflow-fixture-contract.ts";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			failures: options.failures ?? { "workflows.save": 1 },
			recipes: options.recipes,
			recordStopResult: options.recordStopResult,
			workflows: options.workflows ?? [],
		},
	});
	expect(response.ok()).toBeTruthy();
}

async function fixtureState(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return parseWorkflowCompanionSnapshot(await response.text());
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

test("Connect trigger bindings validate IDs and recover from bind and remove failures", async ({
	page,
}) => {
	const workflow = {
		edges: [],
		id: "workflow-connect",
		name: "Connect binding workflow",
		nodes: [{ id: "input", key: "request", type: "input" }],
		triggers: [
			{
				connected_account_id: null,
				toolkit: "",
				trigger_slug: "",
				type: "composio",
			},
		],
	};
	await resetFixture(page, {
		failures: {
			"workflows.bindConnectTrigger": 1,
			"workflows.removeConnectBinding": 1,
		},
		workflows: [workflow],
	});
	await page.goto("/?workflowId=workflow-connect");
	const triggerNode = page.locator('.react-flow__node[data-id="__trigger__"]');
	await expect(triggerNode).toBeVisible();
	await triggerNode.click();
	const triggerId = page.getByLabel("Connect trigger ID");
	const bind = page.getByRole("button", { name: "Bind trigger", exact: true });
	await expect(bind).toBeDisabled();
	await triggerId.fill("not-a-uuid");
	await expect(bind).toBeDisabled();
	expect(
		(await fixtureState(page)).calls.some(
			(call) => call.method === "workflows.bindConnectTrigger"
		)
	).toBe(false);
	await triggerId.fill("123e4567-e89b-12d3-a456-426614174000");
	await expect(bind).toBeEnabled();
	await bind.click();
	await expect(page.getByRole("alert")).toContainText(
		"Connect bindings are unavailable or the change could not be confirmed"
	);
	await expect(bind).toBeEnabled();
	await bind.click();
	await expect(
		page.getByText("github.issue.created", { exact: true })
	).toBeVisible();
	const bound = (await fixtureState(page)).bindings[workflow.id];
	expect(bound).toEqual([
		{
			agentId: "",
			composioTriggerId: "123e4567-e89b-12d3-a456-426614174000",
			connectedAccountId: "fixture-connected-account",
			createdAt: new Date(0).toISOString(),
			id: "binding-1",
			targetKind: "workflow",
			toolkit: "github",
			triggerId: "123e4567-e89b-12d3-a456-426614174000",
			triggerSlug: "github.issue.created",
			workflowId: workflow.id,
		},
	]);

	const remove = page.getByRole("button", {
		name: "Remove binding",
		exact: true,
	});
	await remove.click();
	await expect(page.getByRole("alert")).toContainText(
		"Connect bindings are unavailable or the change could not be confirmed"
	);
	await expect(
		page.getByText("github.issue.created", { exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Remove binding", exact: true })
		.click();
	await expect(
		page.getByText("No Connect triggers are bound to this workflow.")
	).toBeVisible();
	expect((await fixtureState(page)).bindings[workflow.id]).toEqual([]);
	const bindCalls = (await fixtureState(page)).calls.filter(
		(call) => call.method === "workflows.bindConnectTrigger"
	);
	expect(bindCalls.map((call) => call.args)).toEqual([
		{
			connectTriggerId: "123e4567-e89b-12d3-a456-426614174000",
			id: workflow.id,
		},
		{
			connectTriggerId: "123e4567-e89b-12d3-a456-426614174000",
			id: workflow.id,
		},
	]);
	const removeCalls = (await fixtureState(page)).calls.filter(
		(call) => call.method === "workflows.removeConnectBinding"
	);
	expect(removeCalls.map((call) => call.args)).toEqual([
		{ bindingId: "binding-1", id: workflow.id },
		{ bindingId: "binding-1", id: workflow.id },
	]);

	await page.reload();
	const reloadedTrigger = page.locator(
		'.react-flow__node[data-id="__trigger__"]'
	);
	await expect(reloadedTrigger).toBeVisible();
	await reloadedTrigger.click();
	await expect(
		page.getByText("No Connect triggers are bound to this workflow.")
	).toBeVisible();
	await saveScreenshot(page, "workflows-connect-binding-retry-empty.png");
});

test("refreshing Connect bindings shows upstream additions and retries a failed read", async ({
	page,
}) => {
	const workflow = {
		edges: [],
		id: "workflow-connect-refresh",
		name: "Refresh Connect bindings",
		nodes: [{ id: "input", key: "request", type: "input" }],
		triggers: [
			{
				connected_account_id: null,
				toolkit: "",
				trigger_slug: "",
				type: "composio",
			},
		],
	};
	// Connect-side additions arrive as Core trigger subscription records.
	const binding = {
		agentId: "",
		composioTriggerId: "123e4567-e89b-12d3-a456-426614174000",
		connectedAccountId: "fixture-connected-account",
		createdAt: new Date(0).toISOString(),
		id: "binding-from-connect",
		targetKind: "workflow",
		toolkit: "github",
		triggerId: "123e4567-e89b-12d3-a456-426614174000",
		triggerSlug: "github.pull_request.opened",
		workflowId: workflow.id,
	};
	await resetFixture(page, { failures: {}, workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	const triggerNode = page.locator('.react-flow__node[data-id="__trigger__"]');
	await expect(triggerNode).toBeVisible();
	await triggerNode.click();
	await expect(
		page.getByText("No Connect triggers are bound to this workflow.")
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await fixtureState(page)).calls.filter(
					(call) => call.method === "workflows.connectBindings"
				).length
		)
		.toBe(1);

	const injection = await page.request.post(
		"/__fixture/inject-connect-binding",
		{
			data: { binding, failNextRefresh: true, id: workflow.id },
		}
	);
	expect(injection.ok()).toBeTruthy();
	const refresh = page.getByRole("button", {
		name: "Refresh bindings",
		exact: true,
	});
	await refresh.click();
	await expect(page.getByRole("alert")).toContainText(
		"Connect bindings are unavailable or the change could not be confirmed"
	);
	await expect(
		page.getByText(binding.triggerSlug, { exact: true })
	).toHaveCount(0);
	await expect(refresh).toBeEnabled();

	await refresh.click();
	await expect(
		page.getByText(binding.triggerSlug, { exact: true })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	let state = await fixtureState(page);
	expect(state.bindings[workflow.id]).toEqual([binding]);
	expect(
		state.calls
			.filter((call) => call.method === "workflows.connectBindings")
			.map((call) => call.args)
	).toEqual([{ id: workflow.id }, { id: workflow.id }, { id: workflow.id }]);
	expect(
		state.calls.some((call) => call.method === "workflows.bindConnectTrigger")
	).toBe(false);

	await page.reload();
	await page.locator('.react-flow__node[data-id="__trigger__"]').click();
	await expect(
		page.getByText(binding.triggerSlug, { exact: true })
	).toBeVisible();
	state = await fixtureState(page);
	expect(state.bindings[workflow.id]).toEqual([binding]);
	expect(
		state.calls
			.filter((call) => call.method === "workflows.connectBindings")
			.map((call) => call.args)
	).toEqual([
		{ id: workflow.id },
		{ id: workflow.id },
		{ id: workflow.id },
		{ id: workflow.id },
	]);
	await saveScreenshot(page, "workflows-connect-binding-refresh-retry.png");
});

test("Notify User saves scoped recipients and acknowledgement modes without stale fields", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await page.getByLabel("Workflow name").fill("Review requests");
	await addNode(page, "Notify user");
	await page.getByRole("button", { name: "Team", exact: true }).click();
	await page.getByLabel("Team id").fill("team_reviewers");
	await expect(page.getByLabel("Team id")).toHaveValue("team_reviewers");
	await page.getByRole("button", { name: "People", exact: true }).click();
	const peopleSearch = page.getByLabel("Search organization people");
	await expect(page.getByRole("checkbox", { name: /Ada Chen/ })).toBeVisible();
	await peopleSearch.fill("Ada");
	await expect(page.getByRole("checkbox", { name: /Ada Chen/ })).toBeVisible();
	await expect(page.getByRole("checkbox", { name: /Bea Patel/ })).toHaveCount(
		0
	);
	await page.getByRole("checkbox", { name: /Ada Chen/ }).click();
	await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
	await peopleSearch.clear();
	await page.getByRole("button", { name: "Select all", exact: true }).click();
	await expect(page.getByText("3 selected", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(page.getByText("Select at least one person.")).toBeVisible();
	await page.getByRole("checkbox", { name: /Ada Chen/ }).click();
	await page.getByRole("checkbox", { name: /Bea Patel/ }).click();
	await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
	await page.getByLabel("Title").fill("Review {{input}}");
	await page.getByLabel("Body").fill("Please approve {{input}}.");
	await page.getByLabel("Acknowledgement").click();
	await page
		.getByRole("option", { name: "At least this many", exact: true })
		.click();
	await page.getByLabel("Required acks (n)").fill("3");
	await page.getByLabel("Ack timeout (ms, optional)").fill("90000");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	let state = await fixtureState(page);
	const quorumDefinition = state.workflows[0];
	const quorumNode = quorumDefinition?.nodes[0];
	expect(quorumNode).toEqual({
		ack_mode: { mode: "quorum", n: 3 },
		ack_timeout_ms: 90_000,
		body: "Please approve {{input}}.",
		id: "notify_user_1",
		target: { kind: "members", user_ids: ["user-ada", "user-bea"] },
		title: "Review {{input}}",
		type: "notify_user",
	});

	await page.locator('.react-flow__node[data-id="notify_user_1"]').click();
	await page.getByLabel("Acknowledgement").click();
	await page
		.getByRole("option", { name: "At least this percentage", exact: true })
		.click();
	await page.getByLabel("Required approval (%)").fill("67");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes[0])
		.toMatchObject({ ack_mode: { mode: "percentage", percent: 67 } });
	state = await fixtureState(page);
	expect(state.workflows[0]?.nodes[0]).toEqual({
		ack_mode: { mode: "percentage", percent: 67 },
		ack_timeout_ms: 90_000,
		body: "Please approve {{input}}.",
		id: "notify_user_1",
		target: { kind: "members", user_ids: ["user-ada", "user-bea"] },
		title: "Review {{input}}",
		type: "notify_user",
	});
	await page.goto(`/?workflowId=${state.workflows[0]?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="notify_user_1"]').click();
	await expect(page.getByLabel("Title")).toHaveValue("Review {{input}}");
	await expect(page.getByLabel("Body")).toHaveValue(
		"Please approve {{input}}."
	);
	await expect(page.getByLabel("Acknowledgement")).toHaveText(/^percentage/);
	await expect(page.getByLabel("Required approval (%)")).toHaveValue("67");
	await expect(page.getByRole("checkbox", { name: /Ada Chen/ })).toBeChecked();
	await expect(page.getByRole("checkbox", { name: /Bea Patel/ })).toBeChecked();
	await expect(page.getByLabel("Team id")).toHaveCount(0);
	await expect(page.getByLabel("Required acks (n)")).toHaveCount(0);
	await saveScreenshot(
		page,
		"workflows-notify-user-targets-acknowledgements.png"
	);
});

test("Channel Send persists Telegram and Slack-specific fields across reopen", async ({
	page,
}) => {
	await resetFixture(page, { failures: {} });
	await page.goto("/?seed=empty");
	await addNode(page, "Send to channel");
	await page.getByLabel("Bot token").fill("123456:fixture-token");
	await page
		.getByLabel("Send to (chat id / @username)")
		.fill("@release_reviewers");
	await page.getByLabel("Message").fill("Review build {{input}}");

	await addNode(page, "Send to channel");
	await page.getByLabel("Channel").click();
	await page.getByRole("option", { name: "Slack", exact: true }).click();
	await page
		.getByLabel("Webhook URL")
		.fill("https://hooks.slack.com/services/test/coverage");
	await page.getByLabel("Message").fill("Build {{input}} is ready");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			bot_token: "123456:fixture-token",
			id: "channel_send_1",
			platform: "telegram",
			recipient: "@release_reviewers",
			text: "Review build {{input}}",
			type: "channel_send",
		},
		{
			id: "channel_send_2",
			platform: "slack",
			recipient: "",
			text: "Build {{input}} is ready",
			type: "channel_send",
			webhook_url: "https://hooks.slack.com/services/test/coverage",
		},
	]);

	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="channel_send_1"]').click();
	await expect(page.getByLabel("Channel")).toHaveText(/^Telegram/);
	await expect(page.getByLabel("Bot token")).toHaveValue(
		"123456:fixture-token"
	);
	await expect(page.getByLabel("Bot token")).toHaveAttribute(
		"type",
		"password"
	);
	await expect(page.getByLabel("Send to (chat id / @username)")).toHaveValue(
		"@release_reviewers"
	);
	await expect(page.getByLabel("Message")).toHaveValue(
		"Review build {{input}}"
	);

	await page.locator('.react-flow__node[data-id="channel_send_2"]').click();
	await expect(page.getByLabel("Channel")).toHaveText(/^Slack/);
	await expect(page.getByLabel("Webhook URL")).toHaveValue(
		"https://hooks.slack.com/services/test/coverage"
	);
	await expect(page.getByLabel("Message")).toHaveValue(
		"Build {{input}} is ready"
	);
	await saveScreenshot(page, "workflows-channel-send-platform-settings.png");
});

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
