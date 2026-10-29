import { expect, test } from "bun:test";
import {
	type WorkflowConnectBindingRecord,
	workflowConnectBindingRecordSchema,
	workflowConnectBindingRecordsSchema,
	workflowWebhookRecordSchema,
} from "./workflow-binding-records.ts";

test("Connect bindings retain complete normalized records and legacy optional metadata", () => {
	const legacy = {
		agentId: "agent",
		composioTriggerId: null,
		connectedAccountId: "account",
		createdAt: "2026-10-06T00:00:00Z",
		id: "binding",
		toolkit: "slack",
		triggerSlug: "message_received",
	};
	const bound = {
		...legacy,
		targetKind: "workflow",
		workflowId: "workflow",
		future: { enabled: true },
	} satisfies WorkflowConnectBindingRecord & { future: { enabled: boolean } };
	const bindings = [legacy, bound];
	expect(workflowConnectBindingRecordSchema.parse(legacy)).toBe(legacy);
	expect(workflowConnectBindingRecordSchema.parse(bound)).toBe(bound);
	expect(workflowConnectBindingRecordsSchema.parse(bindings)).toBe(bindings);
	expect(
		workflowConnectBindingRecordSchema.safeParse({ id: "incomplete" }).success
	).toBe(false);
	expect(
		workflowConnectBindingRecordSchema.safeParse({
			...bound,
			connectedAccountId: null,
		}).success
	).toBe(false);
});

test("webhook replies retain resolved URLs and the existing unavailable signal", () => {
	for (const url of [
		"",
		"https://node.example/api/workflows/workflow/webhook",
	]) {
		const reply = { url };
		expect(workflowWebhookRecordSchema.parse(reply)).toBe(reply);
	}
	expect(workflowWebhookRecordSchema.safeParse({ url: null }).success).toBe(
		false
	);
});
