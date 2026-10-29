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

const catalogAgent = {
	enabled: true,
	engine: "workflow-test",
	id: "agent-review",
	installed: true,
	name: "Review Agent",
	title: "Review Agent",
};

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: { agents: options.agents ?? [], workflows: options.workflows ?? [] },
	});
	expect(response.ok()).toBeTruthy();
}

async function fixtureState(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return parseWorkflowFixtureSnapshot(await response.text());
}

async function selectCanvasNode(page: Page, id: string) {
	await page.locator(`.react-flow__node[data-id="${id}"]`).click();
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Prompt node saves its instructions and optional agent selection", async ({
	page,
}) => {
	const workflow: WorkflowSeed = {
		edges: [],
		id: "prompt-node-workflow",
		name: "Prompt node settings",
		nodes: [
			{
				agent_id: null,
				id: "prompt_1",
				prompt: "Summarize {{input}}",
				type: "prompt",
			},
		],
		triggers: [],
	};
	await resetFixture(page, { agents: [catalogAgent], workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	await selectCanvasNode(page, "prompt_1");
	await page
		.getByLabel("Prompt template")
		.fill("Classify {{input}} for review");
	const picker = page.getByRole("combobox", { name: "Choose an agent" });
	await picker.click();
	await page.getByRole("option", { name: /Review Agent/ }).click();
	await expect(picker).toContainText("Review Agent");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes)
		.toEqual([
			{
				agent_id: "agent-review",
				id: "prompt_1",
				prompt: "Classify {{input}} for review",
				type: "prompt",
			},
		]);
	await page.reload();
	await selectCanvasNode(page, "prompt_1");
	await expect(page.getByLabel("Prompt template")).toHaveValue(
		"Classify {{input}} for review"
	);
	await expect(
		page.getByRole("combobox", { name: "Choose an agent" })
	).toContainText("Review Agent");
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual([
		{
			agent_id: "agent-review",
			id: "prompt_1",
			prompt: "Classify {{input}} for review",
			type: "prompt",
		},
	]);
	await saveScreenshot(page, "workflows-node-prompt-agent-settings-reopen.png");
});

test("Condition, state, delay, note and guardrail fields persist their exact values", async ({
	page,
}) => {
	const workflow: WorkflowSeed = {
		edges: [],
		id: "data-node-workflow",
		name: "Data node settings",
		nodes: [
			{ expr: 'input != ""', id: "condition_1", type: "condition" },
			{
				id: "set_state_2",
				key: "previous",
				type: "set_state",
				value: "{{input}}",
			},
			{ id: "delay_3", ms: 1000, type: "delay" },
			{ id: "note_4", text: "Old documentation", type: "note" },
			{ checks: ["pii"], id: "guardrails_5", type: "guardrails" },
		],
		triggers: [],
	};
	await resetFixture(page, { workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	await selectCanvasNode(page, "condition_1");
	await page.getByLabel("Expression").fill("input contains urgent");
	await selectCanvasNode(page, "set_state_2");
	await page.getByLabel("State key").fill("review_result");
	await page.getByLabel("Value template").fill("Approved: {{input}}");
	await selectCanvasNode(page, "delay_3");
	await page.getByLabel("Duration (ms)").fill("0");
	await expect(page.getByLabel("Duration (ms)")).toHaveValue("0");
	await page.getByLabel("Duration (ms)").fill("1500");
	await selectCanvasNode(page, "note_4");
	await page.getByLabel("Note").fill("Keep a copy of the approval context.");
	await selectCanvasNode(page, "guardrails_5");
	await page.getByRole("button", { name: "Jailbreak", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes)
		.toEqual([
			{ expr: "input contains urgent", id: "condition_1", type: "condition" },
			{
				id: "set_state_2",
				key: "review_result",
				type: "set_state",
				value: "Approved: {{input}}",
			},
			{ id: "delay_3", ms: 1500, type: "delay" },
			{
				id: "note_4",
				text: "Keep a copy of the approval context.",
				type: "note",
			},
			{ checks: ["jailbreak"], id: "guardrails_5", type: "guardrails" },
		]);

	await page.reload();
	await selectCanvasNode(page, "condition_1");
	await expect(page.getByLabel("Expression")).toHaveValue(
		"input contains urgent"
	);
	await selectCanvasNode(page, "set_state_2");
	await expect(page.getByLabel("State key")).toHaveValue("review_result");
	await expect(page.getByLabel("Value template")).toHaveValue(
		"Approved: {{input}}"
	);
	await selectCanvasNode(page, "delay_3");
	await expect(page.getByLabel("Duration (ms)")).toHaveValue("1500");
	await selectCanvasNode(page, "note_4");
	await expect(page.getByLabel("Note")).toHaveValue(
		"Keep a copy of the approval context."
	);
	await selectCanvasNode(page, "guardrails_5");
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual([
		{ expr: "input contains urgent", id: "condition_1", type: "condition" },
		{
			id: "set_state_2",
			key: "review_result",
			type: "set_state",
			value: "Approved: {{input}}",
		},
		{ id: "delay_3", ms: 1500, type: "delay" },
		{
			id: "note_4",
			text: "Keep a copy of the approval context.",
			type: "note",
		},
		{ checks: ["jailbreak"], id: "guardrails_5", type: "guardrails" },
	]);
	await saveScreenshot(
		page,
		"workflows-node-condition-state-delay-note-guardrails.png"
	);
});

test("Webhook node persists the endpoint URL and selected HTTP method", async ({
	page,
}) => {
	const workflow: WorkflowSeed = {
		edges: [],
		id: "webhook-node-workflow",
		name: "Webhook node settings",
		nodes: [
			{
				id: "webhook_1",
				method: "POST",
				type: "webhook",
				url: "https://old.example.test/events",
			},
		],
		triggers: [],
	};
	await resetFixture(page, { workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	await selectCanvasNode(page, "webhook_1");
	const url = "https://hooks.example.test/review-events";
	await page.getByLabel("URL").fill(url);
	await page.getByLabel("Method").click();
	await page.getByRole("option", { name: "PATCH", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes)
		.toEqual([{ id: "webhook_1", method: "PATCH", type: "webhook", url }]);
	await page.reload();
	await selectCanvasNode(page, "webhook_1");
	await expect(page.getByLabel("URL")).toHaveValue(url);
	await expect(page.getByLabel("Method")).toHaveText(/^PATCH/);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual([
		{ id: "webhook_1", method: "PATCH", type: "webhook", url },
	]);
	await saveScreenshot(page, "workflows-node-webhook-url-method-reopen.png");
});

test("Node ID changes persist for an unconnected note without changing its content", async ({
	page,
}) => {
	const workflow: WorkflowSeed = {
		edges: [],
		id: "node-id-workflow",
		name: "Node ID settings",
		nodes: [{ id: "note_1", text: "Retain this note.", type: "note" }],
		triggers: [],
	};
	await resetFixture(page, { workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	await selectCanvasNode(page, "note_1");
	await page.getByLabel("Node id").fill("deployment_note");
	await expect(
		page.locator('.react-flow__node[data-id="deployment_note"]')
	).toContainText("deployment_note");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes)
		.toEqual([
			{ id: "deployment_note", text: "Retain this note.", type: "note" },
		]);
	await page.reload();
	await selectCanvasNode(page, "deployment_note");
	await expect(page.getByLabel("Node id")).toHaveValue("deployment_note");
	await expect(page.getByLabel("Note")).toHaveValue("Retain this note.");
	await saveScreenshot(page, "workflows-node-id-edit-reopen.png");
});

test("Renaming a connected node preserves its incoming and outgoing edges", async ({
	page,
}) => {
	const workflow: WorkflowSeed = {
		edges: [
			{ from: "upstream_note", to: "note_1" },
			{ from: "note_1", to: "downstream_note" },
		],
		id: "connected-node-id-workflow",
		name: "Connected node ID settings",
		nodes: [
			{ id: "upstream_note", text: "Before", type: "note" },
			{ id: "note_1", text: "Rename this node.", type: "note" },
			{ id: "downstream_note", text: "After", type: "note" },
		],
		triggers: [],
	};
	await resetFixture(page, { workflows: [workflow] });
	await page.goto(`/?workflowId=${workflow.id}`);
	await selectCanvasNode(page, "note_1");
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await page.getByLabel("Node id").fill("review_note");
	await expect(page.getByLabel("Node id")).toHaveValue("review_note");
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => {
			const saved = (await fixtureState(page)).workflows[0];
			return { edges: saved?.edges, nodes: saved?.nodes };
		})
		.toEqual({
			edges: [
				{ from: "upstream_note", to: "review_note" },
				{ from: "review_note", to: "downstream_note" },
			],
			nodes: [
				{ id: "upstream_note", text: "Before", type: "note" },
				{ id: "review_note", text: "Rename this node.", type: "note" },
				{ id: "downstream_note", text: "After", type: "note" },
			],
		});
	await page.reload();
	await selectCanvasNode(page, "review_note");
	await expect(page.getByLabel("Node id")).toHaveValue("review_note");
	await expect(page.locator(".react-flow__edge")).toHaveCount(2);
	await saveScreenshot(page, "workflows-connected-node-id-rekey-reopen.png");
});
