import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

import type { ProofJsonRecord } from "./fixture-json.ts";
import {
	type FixtureReset,
	parseWorkflowFixtureSnapshot,
	type WorkflowDefinition,
} from "./workflow-fixture-contract.ts";

async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			appEvents: options.appEvents ?? [],
			composioTriggers: options.composioTriggers ?? [],
			failures: options.failures ?? {},
			toolkits: options.toolkits ?? [],
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

function savedWorkflow(
	id: string,
	name: string,
	triggers: ProofJsonRecord[] = []
): WorkflowDefinition {
	return {
		edges: [{ from: "input", to: "output" }],
		id,
		name,
		nodes: [
			{ id: "input", key: null, type: "input" },
			{ id: "output", key: null, type: "output" },
		],
		triggers,
	};
}

async function openTriggerNode(page: Page, workflowId: string) {
	await page.goto(`/?workflowId=${workflowId}`);
	const triggerNode = page.locator('.react-flow__node[data-id="__trigger__"]');
	await expect(triggerNode).toBeVisible();
	await triggerNode.click();
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

test("custom schedule cron saves its exact expression and reloads", async ({
	page,
}) => {
	const workflow = savedWorkflow("workflow-cron", "Weekday review");
	await resetFixture(page, { workflows: [workflow] });
	await openTriggerNode(page, workflow.id);
	await page.getByLabel("When this runs").click();
	await page.getByRole("option", { name: "Schedule", exact: true }).click();
	await page.getByLabel("Every").click();
	await page.getByRole("option", { name: "Custom cron", exact: true }).click();
	await page.getByLabel("Cron").fill("0 9 * * 1-5");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.triggers)
		.toEqual([{ type: "schedule", cron: "0 9 * * 1-5", every: null }]);
	await page.reload();
	await page.locator('.react-flow__node[data-id="__trigger__"]').click();
	await expect(page.getByLabel("Every")).toHaveText(/^Custom cron/);
	await expect(page.getByLabel("Cron")).toHaveValue("0 9 * * 1-5");
	expect((await fixtureState(page)).workflows[0]?.triggers).toEqual([
		{ type: "schedule", cron: "0 9 * * 1-5", every: null },
	]);
	await saveScreenshot(page, "workflows-trigger-custom-cron-reopen.png");
});

test("App event trigger selection saves and restores a qualified event", async ({
	page,
}) => {
	const workflow = savedWorkflow("workflow-event", "Meeting follow-up");
	const event = {
		description: "Raised when a meeting finishes processing.",
		id: "@ryu/meetings#meeting.ended",
		plugin: "@ryu/meetings",
		title: "Meeting ended",
	};
	await resetFixture(page, { appEvents: [event], workflows: [workflow] });
	await openTriggerNode(page, workflow.id);
	await page.getByLabel("When this runs").click();
	await page.getByRole("option", { name: "App event", exact: true }).click();
	const eventPicker = page.getByRole("combobox", { name: "Event" });
	await expect(eventPicker).toBeVisible();
	await eventPicker.click();
	await page.getByRole("option", { name: /Meeting ended/ }).click();
	await expect(page.getByText(event.id, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.triggers)
		.toEqual([{ type: "event", event: event.id }]);
	let state = await fixtureState(page);
	expect(
		state.calls.some((call) => call.method === "workflows.hookEvents")
	).toBe(true);

	await page.reload();
	await page.locator('.react-flow__node[data-id="__trigger__"]').click();
	await expect(page.getByRole("combobox", { name: "Event" })).toHaveText(
		/^Meeting ended/
	);
	await expect(page.getByText(event.id, { exact: true })).toBeVisible();
	state = await fixtureState(page);
	expect(state.workflows[0]?.triggers).toEqual([
		{ type: "event", event: event.id },
	]);
	await saveScreenshot(page, "workflows-trigger-app-event-reopen.png");
});

test("Composio status retry loads toolkit and trigger choices before saving the binding fields", async ({
	page,
}) => {
	const workflow = savedWorkflow("workflow-composio", "GitHub follow-up");
	await resetFixture(page, {
		composioTriggers: [
			{
				displayName: "Pull request opened",
				name: "GITHUB_PULL_REQUEST_OPENED",
			},
		],
		failures: { "workflows.composio": 1 },
		toolkits: [{ name: "GitHub", slug: "github" }],
		workflows: [workflow],
	});
	await openTriggerNode(page, workflow.id);
	await page.getByLabel("When this runs").click();
	await page
		.getByRole("option", { name: "Composio event", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText(
		"Integration status is unavailable."
	);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const toolkitPicker = page.getByRole("combobox", { name: "Toolkit" });
	await expect(toolkitPicker).toBeVisible();
	await toolkitPicker.click();
	await page.getByRole("option", { name: "GitHub", exact: true }).click();
	const triggerPicker = page.getByRole("combobox", { name: "Trigger" });
	await expect(triggerPicker).toBeVisible();
	await triggerPicker.click();
	await page
		.getByRole("option", { name: "Pull request opened", exact: true })
		.click();
	await page.getByLabel("Account").fill("connected-account-123");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.triggers)
		.toEqual([
			{
				connected_account_id: "connected-account-123",
				toolkit: "github",
				trigger_slug: "GITHUB_PULL_REQUEST_OPENED",
				type: "composio",
			},
		]);
	let state = await fixtureState(page);
	const composioCalls = state.calls.filter(
		(call) => call.method === "workflows.composio"
	);
	expect(composioCalls.slice(0, 3).map((call) => call.args)).toEqual([
		{ kind: "status" },
		{ kind: "status" },
		{ kind: "toolkits" },
	]);
	expect(
		composioCalls.some(
			(call) =>
				JSON.stringify(call.args) ===
				JSON.stringify({ kind: "triggers", toolkit: "github" })
		)
	).toBe(true);

	await page.reload();
	await page.locator('.react-flow__node[data-id="__trigger__"]').click();
	await expect(page.getByRole("combobox", { name: "Toolkit" })).toHaveText(
		/^GitHub/
	);
	await expect(page.getByRole("combobox", { name: "Trigger" })).toHaveText(
		/^Pull request opened/
	);
	await expect(page.getByLabel("Account")).toHaveValue("connected-account-123");
	state = await fixtureState(page);
	expect(state.workflows[0]?.triggers).toEqual([
		{
			connected_account_id: "connected-account-123",
			toolkit: "github",
			trigger_slug: "GITHUB_PULL_REQUEST_OPENED",
			type: "composio",
		},
	]);
	await saveScreenshot(page, "workflows-trigger-composio-retry-reopen.png");
});

test("webhook secret reveal/copy and bridge URL survive workflow reload", async ({
	page,
}) => {
	const workflow = savedWorkflow("workflow-webhook", "Signed inbound webhook");
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await resetFixture(page, { workflows: [workflow] });
	await openTriggerNode(page, workflow.id);
	await page.getByLabel("When this runs").click();
	await page.getByRole("option", { name: "Webhook", exact: true }).click();
	const secret = "fixture-webhook-secret-42";
	const secretInput = page.getByLabel("Signing secret");
	await secretInput.fill(secret);
	await expect(secretInput).toHaveAttribute("type", "password");
	await page
		.getByRole("button", { name: "Reveal secret", exact: true })
		.click();
	await expect(secretInput).toHaveAttribute("type", "text");
	const copy = page.getByRole("button", { name: "Copy secret", exact: true });
	await expect(copy).toBeEnabled();
	await copy.click();
	await expect
		.poll(async () => page.evaluate(() => navigator.clipboard.readText()))
		.toBe(secret);
	await page.getByRole("button", { name: "Hide secret", exact: true }).click();
	await expect(secretInput).toHaveAttribute("type", "password");

	const webhookUrl = `https://node.example.test/api/workflows/${workflow.id}/webhook`;
	await expect(page.getByText(webhookUrl, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(async () => (await fixtureState(page)).workflows[0]?.triggers)
		.toEqual([{ type: "webhook", secret }]);
	let state = await fixtureState(page);
	expect(
		state.calls
			.filter((call) => call.method === "workflows.webhook")
			.map((call) => call.args)
	).toEqual([{ id: workflow.id }]);

	await page.reload();
	await page.locator('.react-flow__node[data-id="__trigger__"]').click();
	await expect(page.getByLabel("Signing secret")).toHaveValue(secret);
	await expect(page.getByLabel("Signing secret")).toHaveAttribute(
		"type",
		"password"
	);
	await expect(page.getByText(webhookUrl, { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: "Reveal secret", exact: true })
		.click();
	await expect(page.getByLabel("Signing secret")).toHaveAttribute(
		"type",
		"text"
	);
	state = await fixtureState(page);
	expect(state.workflows[0]?.triggers).toEqual([{ type: "webhook", secret }]);
	expect(
		state.calls
			.filter((call) => call.method === "workflows.webhook")
			.map((call) => call.args)
	).toEqual([{ id: workflow.id }, { id: workflow.id }]);
	await saveScreenshot(page, "workflows-trigger-webhook-secret-url-reopen.png");
});
