import { expect, test } from "bun:test";
import {
	bindWorkflowConnectTrigger,
	fetchWorkflowConnectBindings,
	subscribeTrigger,
} from "./composio-triggers.ts";

const wire = {
	id: "binding-a",
	agent_id: "",
	toolkit: "gmail",
	trigger_slug: "GMAIL_EVENT",
	connected_account_id: "account-a",
	created_at: "2026-09-13T00:00:00Z",
	target_kind: "workflow",
	workflow_id: "workflow-a",
};

test("Connect binding carries verified Core identity and only the workflow selector", async () => {
	let seen: Request | undefined;
	const result = await bindWorkflowConnectTrigger(
		{
			url: "https://node.example.test",
			token: "node-token",
			userJwt: "user-jwt",
			fetch: async (input, init) => {
				seen = new Request(input, init);
				return Response.json({
					subscription: { ...wire, private_token: "not-returned" },
				});
			},
		},
		"workflow-a",
		"00000000-0000-4000-8000-000000000001"
	);
	expect(seen?.url).toBe("https://node.example.test/api/composio/targets");
	expect(seen?.headers.get("x-ryu-user-jwt")).toBe("user-jwt");
	expect(await seen?.json()).toEqual({
		connectTriggerId: "00000000-0000-4000-8000-000000000001",
		target: { kind: "workflow", id: "workflow-a" },
	});
	expect(result.workflowId).toBe("workflow-a");
	expect(result).not.toHaveProperty("private_token");
});

test("workflow bindings exclude agent targets and other workflows", async () => {
	const result = await fetchWorkflowConnectBindings(
		{
			url: "https://node.example.test",
			token: "fixture",
			fetch: async () =>
				Response.json({
					subscriptions: [
						wire,
						{ ...wire, id: "other", workflow_id: "workflow-b" },
						{ ...wire, id: "agent", target_kind: "agent" },
					],
				}),
		},
		"workflow-a"
	);
	expect(result.map((binding) => binding.id)).toEqual(["binding-a"]);
});

test("binding refuses malformed selectors before I/O and mismatched confirmations", async () => {
	let calls = 0;
	const target = {
		url: "https://node.example.test",
		token: "fixture",
		fetch: async () => {
			calls++;
			return Response.json({ subscription: { ...wire, workflow_id: "other" } });
		},
	};
	await expect(
		bindWorkflowConnectTrigger(target, "workflow-a", "provider-id")
	).rejects.toThrow("Invalid");
	expect(calls).toBe(0);
	await expect(
		bindWorkflowConnectTrigger(
			target,
			"workflow-a",
			"00000000-0000-4000-8000-000000000001"
		)
	).rejects.toThrow("did not confirm");
});

test("own-account triggers send own_account and read it back", async () => {
	const bodies: unknown[] = [];
	const transport = {
		url: "https://node.example.test",
		token: "fixture",
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const sent = new Request(input, init);
			const body = (await sent.json()) as Record<string, unknown>;
			bodies.push(body);
			return Response.json({
				subscription: {
					...wire,
					agent_id: "agent-a",
					target_kind: "agent",
					workflow_id: null,
					own_account: body.own_account === true,
				},
			});
		},
	};
	const input = {
		agentId: "agent-a",
		connectedAccountId: "own-a",
		toolkit: "gmail",
		triggerSlug: "GMAIL_EVENT",
	};
	const own = await subscribeTrigger(transport, { ...input, ownAccount: true });
	const yours = await subscribeTrigger(transport, input);
	expect(bodies[0]).toMatchObject({ own_account: true });
	expect(bodies[1]).not.toHaveProperty("own_account");
	expect(own.ownAccount).toBe(true);
	expect(yours.ownAccount).toBe(false);
});
