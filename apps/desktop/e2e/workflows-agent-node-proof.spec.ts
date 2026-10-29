import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

const agentCatalog = [
	{
		description: "Reviews operational requests.",
		enabled: true,
		engine: "workflow-test",
		id: "agent-review",
		installed: true,
		name: "Review Agent",
		recommended: true,
		title: "Review Agent",
	},
	{
		description: "Not available for new runs.",
		enabled: false,
		engine: "workflow-test",
		id: "agent-disabled",
		installed: true,
		name: "Unavailable Agent",
		title: "Unavailable Agent",
	},
] as const;

import {
	type FixtureReset,
	parseWorkflowFixtureSnapshot,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

type WorkflowSeed = WorkflowDefinition;

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			agents: options.agents ?? [],
			apps: options.apps ?? [],
			failures: options.failures ?? {},
			mcp: options.mcp ?? { servers: [], tools: [] },
			skills: options.skills ?? [],
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

async function addRuntimeAgentNode(page: Page) {
	await page.getByPlaceholder("Search nodes").fill("Agent");
	const agentRows = page.getByRole("button", { name: "Agent", exact: true });
	await expect(agentRows).toHaveCount(2);
	await agentRows.nth(1).click();
}

async function chooseRuntimeAgent(page: Page, name = "Review Agent") {
	const picker = page.getByRole("combobox", { name: "Choose an agent" });
	await expect(picker).toBeVisible();
	await picker.click();
	await page.getByRole("option", { name: new RegExp(name) }).click();
	await expect(picker).toContainText(name);
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("Agent node rejects unavailable agents, inserts a live node variable and retries save", async ({
	page,
}) => {
	await resetFixture(page, {
		agents: [...agentCatalog],
		failures: { "workflows.save": 1 },
	});
	await page.goto("/?seed=empty");
	await page.getByLabel("Workflow name").fill("Summarize a request");
	await addNode(page, "Input");
	await page.getByLabel("Key").fill("request");
	await addRuntimeAgentNode(page);

	const picker = page.getByRole("combobox", { name: "Choose an agent" });
	await expect(picker).toBeVisible();
	await picker.click();
	const unavailableAgent = page.getByRole("option", {
		name: /Unavailable Agent/,
	});
	await expect(unavailableAgent).toBeDisabled();
	await page.getByRole("option", { name: /Review Agent/ }).click();
	await expect(picker).toContainText("Review Agent");

	const task = page.getByLabel("Task");
	await task.fill("Summarize now");
	await task.evaluate((element: HTMLTextAreaElement) => {
		element.focus();
		element.setSelectionRange(10, 10);
	});
	await page
		.getByRole("button", { name: "Insert variable", exact: true })
		.click();
	await page
		.getByRole("menuitem", {
			name: "{{nodes.input_1}} node output",
			exact: true,
		})
		.first()
		.click();
	await expect(task).toHaveValue("Summarize {{nodes.input_1}}now");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Fixture workflows.save temporarily unavailable"
	);
	expect((await fixtureState(page)).workflows).toEqual([]);
	await expect(task).toHaveValue("Summarize {{nodes.input_1}}now");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	let state = await fixtureState(page);
	const saves = state.calls.filter((call) => call.method === "workflows.save");
	expect(saves).toHaveLength(2);
	expect(saves[0]?.args).toEqual(saves[1]?.args);
	expect(saves[1]?.args.nodes).toEqual([
		{ id: "input_1", key: "request", type: "input" },
		{
			agent_id: "agent-review",
			id: "agent_2",
			task: "Summarize {{nodes.input_1}}now",
			type: "agent",
		},
	]);

	const saved = state.workflows[0];
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="agent_2"]').click();
	await expect(
		page.getByRole("combobox", { name: "Choose an agent" })
	).toContainText("Review Agent");
	await expect(page.getByLabel("Task")).toHaveValue(
		"Summarize {{nodes.input_1}}now"
	);
	state = await fixtureState(page);
	expect(state.workflows[0]?.nodes).toEqual(saves[1]?.args.nodes);
	await saveScreenshot(page, "workflows-agent-node-variable-retry-reopen.png");
});

test("Agent Delegate adds, assigns, removes and persists the remaining delegates", async ({
	page,
}) => {
	await resetFixture(page, { agents: [...agentCatalog] });
	await page.goto("/?seed=empty");
	await addNode(page, "Agent Delegate");
	await page.getByRole("button", { name: "Add delegate", exact: true }).click();
	await page.getByRole("button", { name: "Add delegate", exact: true }).click();
	const delegateTasks = page.getByRole("textbox", { name: "Delegate task" });
	await expect(delegateTasks).toHaveCount(2);
	const delegateAgentPickers = page.getByRole("combobox", {
		name: "Choose an agent",
	});
	await delegateAgentPickers.first().click();
	await page.getByRole("option", { name: /Review Agent/ }).click();
	await delegateTasks.nth(0).fill("Review request {{input}}");
	await delegateTasks.nth(1).fill("Discard this second delegate");
	await page.getByRole("button", { name: "Remove delegate" }).nth(1).click();
	await expect(delegateTasks).toHaveCount(1);
	await expect(delegateTasks.first()).toHaveValue("Review request {{input}}");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			caps: null,
			delegates: [
				{
					agent_id: "agent-review",
					id: "delegate_1",
					task: "Review request {{input}}",
				},
			],
			id: "agent_delegate_1",
			type: "agent_delegate",
		},
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="agent_delegate_1"]').click();
	await expect(
		page.getByRole("textbox", { name: "Delegate task" })
	).toHaveCount(1);
	await expect(
		page.getByRole("textbox", { name: "Delegate task" })
	).toHaveValue("Review request {{input}}");
	await expect(
		page.getByRole("combobox", { name: "Choose an agent" })
	).toContainText("Review Agent");
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(page, "workflows-agent-delegates-remove-reopen.png");
});

test("Sub-workflow picker excludes the current workflow and saves a selected helper", async ({
	page,
}) => {
	const workflows: WorkflowSeed[] = [
		{
			edges: [],
			id: "parent-flow",
			name: "Parent workflow",
			nodes: [{ id: "call-helper", type: "sub_workflow", workflow_id: "" }],
			triggers: [],
		},
		{
			edges: [],
			id: "helper-flow",
			name: "Reusable summary",
			nodes: [{ id: "helper-input", type: "input", key: "request" }],
			triggers: [],
		},
	];
	await resetFixture(page, { workflows });
	await page.goto("/?workflowId=parent-flow");
	await page.locator('.react-flow__node[data-id="call-helper"]').click();
	const workflowPicker = page.getByRole("combobox", { name: "Workflow" });
	await expect(workflowPicker).toBeVisible();
	await workflowPicker.click();
	await expect(
		page.getByRole("option", { name: "Parent workflow", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("option", { name: "Reusable summary", exact: true })
		.click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.nodes[0])
		.toMatchObject({ workflow_id: "helper-flow" });
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{ id: "call-helper", type: "sub_workflow", workflow_id: "helper-flow" },
	]);
	await page.goto("/?workflowId=parent-flow");
	await page.locator('.react-flow__node[data-id="call-helper"]').click();
	await expect(page.getByRole("combobox", { name: "Workflow" })).toContainText(
		"Reusable summary"
	);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(page, "workflows-subworkflow-picker-reopen.png");
});

test("Sub-workflow picker keeps manual references when no workflows are listed", async ({
	page,
}) => {
	await resetFixture(page);
	await page.goto("/?seed=empty");
	await addNode(page, "Sub-workflow");
	const workflowId = "existing-workflow-outside-current-list";
	await page
		.getByRole("textbox", { name: "Workflow", exact: true })
		.fill(workflowId);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{ id: "sub_workflow_1", type: "sub_workflow", workflow_id: workflowId },
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="sub_workflow_1"]').click();
	await expect(
		page.getByRole("textbox", { name: "Workflow", exact: true })
	).toHaveValue(workflowId);
	await saveScreenshot(
		page,
		"workflows-subworkflow-manual-reference-reopen.png"
	);
});

test("Skill catalog selection, optional agent and task persist together", async ({
	page,
}) => {
	await resetFixture(page, {
		agents: [...agentCatalog],
		skills: [
			{
				description: "Inspect a repository and identify security risks.",
				id: "security-audit",
				name: "Security Audit",
			},
		],
	});
	await page.goto("/?seed=empty");
	await addNode(page, "Skill");
	const skillPicker = page.getByRole("combobox", { name: "Skill" });
	await expect(skillPicker).toBeVisible();
	await skillPicker.click();
	await page
		.getByRole("option", { name: "Security Audit", exact: true })
		.click();
	await chooseRuntimeAgent(page);
	await page.getByLabel("Task").fill("Audit {{input}} for risky changes");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			agent_id: "agent-review",
			id: "skill_1",
			skill: "security-audit",
			task: "Audit {{input}} for risky changes",
			type: "skill",
		},
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="skill_1"]').click();
	await expect(page.getByRole("combobox", { name: "Skill" })).toContainText(
		"Security Audit"
	);
	await expect(
		page.getByRole("combobox", { name: "Choose an agent" })
	).toContainText("Review Agent");
	await expect(page.getByLabel("Task")).toHaveValue(
		"Audit {{input}} for risky changes"
	);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(
		page,
		"workflows-skill-catalog-agent-task-friendly-label.png"
	);
});

test("Skill manual fallback and default-LLM selection persist without catalogs", async ({
	page,
}) => {
	await resetFixture(page, { agents: [], skills: [] });
	await page.goto("/?seed=empty");
	await addNode(page, "Skill");
	const skillName = page.getByLabel("Skill");
	await expect(skillName).toHaveAttribute("placeholder", "research");
	await skillName.fill("local-research");
	const agentPicker = page.getByRole("combobox", { name: "Agent (optional)" });
	await agentPicker.click();
	await page
		.getByRole("option", { name: "(default LLM)", exact: true })
		.click();
	await page.getByLabel("Task").fill("Research {{input}} locally");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			agent_id: null,
			id: "skill_1",
			skill: "local-research",
			task: "Research {{input}} locally",
			type: "skill",
		},
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="skill_1"]').click();
	await expect(page.getByLabel("Skill")).toHaveValue("local-research");
	await expect(page.getByLabel("Task")).toHaveValue(
		"Research {{input}} locally"
	);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(page, "workflows-skill-manual-default-agent-reopen.png");
});

test("Tool node selects and restores a fully qualified MCP tool", async ({
	page,
}) => {
	await resetFixture(page, {
		mcp: {
			servers: [{ id: "spider", name: "spider" }],
			tools: [
				{
					description: "Fetches a page snapshot.",
					id: "spider.snapshot",
					name: "snapshot",
					server: "spider",
				},
			],
		},
	});
	await page.goto("/?seed=empty");
	await addNode(page, "Tool");
	const toolPicker = page.getByRole("combobox", { name: "Tool" });
	await expect(toolPicker).toBeVisible();
	await toolPicker.click();
	await page.getByRole("option", { name: /spider · snapshot/ }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{ args: {}, id: "tool_1", name: "spider.snapshot", type: "tool" },
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="tool_1"]').click();
	await expect(page.getByRole("combobox", { name: "Tool" })).toContainText(
		"spider · snapshot"
	);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(page, "workflows-tool-catalog-friendly-label.png");
});

test("Plugin node requires a catalog runnable selection and persists both IDs", async ({
	page,
}) => {
	await resetFixture(page, {
		apps: [
			{
				id: "@ryu/quality-kit",
				name: "Quality Kit",
				runnables: [
					{
						id: "audit-workflow",
						kind: "workflow",
						name: "Audit changes",
					},
				],
			},
		],
	});
	await page.goto("/?seed=empty");
	await addNode(page, "Plugin");
	const pluginPicker = page.getByRole("combobox", { name: "Plugin" });
	await expect(pluginPicker).toBeVisible();
	await pluginPicker.click();
	await page.getByRole("option", { name: "Quality Kit", exact: true }).click();
	const runnablePicker = page.getByRole("combobox", { name: "Runnable" });
	await expect(runnablePicker).toBeVisible();
	await runnablePicker.click();
	await page.getByRole("option", { name: "Audit changes (workflow)" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows.length)
		.toBe(1);
	const saved = (await fixtureState(page)).workflows[0];
	expect(saved?.nodes).toEqual([
		{
			args: {},
			id: "plugin_1",
			plugin_id: "@ryu/quality-kit",
			runnable_id: "audit-workflow",
			type: "plugin",
		},
	]);
	await page.goto(`/?workflowId=${saved?.id ?? ""}`);
	await page.locator('.react-flow__node[data-id="plugin_1"]').click();
	await expect(page.getByRole("combobox", { name: "Plugin" })).toContainText(
		"Quality Kit"
	);
	await expect(page.getByRole("combobox", { name: "Runnable" })).toContainText(
		"Audit changes (workflow)"
	);
	expect((await fixtureState(page)).workflows[0]?.nodes).toEqual(saved?.nodes);
	await saveScreenshot(page, "workflows-plugin-runnable-friendly-labels.png");
});
