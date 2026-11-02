import { expect, test } from "@playwright/test";
import {
	addNode,
	fixtureState,
	resetFixture,
	saveScreenshot,
} from "./workflows-companion-proof.helpers.ts";

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
