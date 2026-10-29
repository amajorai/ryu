// apps/desktop/src/lib/api/composio-triggers.ts
//
// Client for Core's Composio event-trigger subscriptions (`/api/composio/...`).
// A subscription binds a Composio trigger (e.g. SLACK_CHANNEL_MESSAGE_RECEIVED)
// to an agent; when the event fires, Composio's webhook hits Core which runs the
// agent. Note: delivery requires Core to be reachable at a public URL (Ryu
// Cloud) or via a relay — local Core won't receive the webhook.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

/** An agent↔Composio-trigger subscription. */
export interface TriggerSubscription {
	agentId: string;
	composioTriggerId: string | null;
	connectedAccountId: string;
	createdAt: string;
	id: string;
	/** Whether it watches an account connected to the agent's own identity. */
	ownAccount: boolean;
	targetKind?: string;
	toolkit: string;
	triggerSlug: string;
	workflowId?: string;
}

function connectResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
// Full native persisted TriggerSubscription. target_kind is Rust String;
// the existing mapper retains its exact invalid-target error and legacy defaults.
export const triggerSubscriptionResponseSchema = connectResponse(
	z.object({
		agent_id: z.string(),
		composio_trigger_id: z.string().nullish(),
		connected_account_id: z.string(),
		created_at: z.string(),
		id: z.string(),
		own_account: z.boolean().optional(),
		target_kind: z.string().optional(),
		toolkit: z.string(),
		trigger_slug: z.string(),
		workflow_id: z.string().nullish(),
	})
);
type SubscriptionWire = z.output<typeof triggerSubscriptionResponseSchema>;
const triggerSubscriptionsResponseSchema = connectResponse(
	z.object({
		subscriptions: z.array(triggerSubscriptionResponseSchema).nullish(),
	})
);
const triggerSubscriptionEnvelopeSchema = connectResponse(
	z.object({
		subscription: triggerSubscriptionResponseSchema,
		connectTriggerId: z.string().optional(),
	})
);
const triggerSubscriptionDeleteSchema = connectResponse(
	z.object({ ok: z.boolean() })
);

function toSubscription(s: SubscriptionWire): TriggerSubscription {
	if (
		s.target_kind &&
		s.target_kind !== "agent" &&
		s.target_kind !== "workflow"
	) {
		throw new Error("Invalid Connect target kind");
	}
	const subscription: TriggerSubscription = {
		id: s.id,
		agentId: s.agent_id,
		toolkit: s.toolkit,
		triggerSlug: s.trigger_slug,
		connectedAccountId: s.connected_account_id,
		composioTriggerId: s.composio_trigger_id ?? null,
		createdAt: s.created_at,
		ownAccount: s.own_account === true,
	};
	if (s.target_kind) {
		subscription.targetKind = s.target_kind;
	}
	if (s.workflow_id) {
		subscription.workflowId = s.workflow_id;
	}
	return subscription;
}

export async function fetchWorkflowConnectBindings(
	target: ApiTarget,
	workflowId: string,
	transport: typeof request = request
): Promise<TriggerSubscription[]> {
	if (!workflowId || workflowId.length > 256 || /\s/.test(workflowId)) {
		throw new Error("Invalid Connect workflow binding");
	}
	const response = triggerSubscriptionsResponseSchema.parse(
		await transport(
			target,
			"/api/composio/trigger-subscriptions",
			undefined,
			appResponseValueSchema
		)
	);
	return (response.subscriptions ?? [])
		.map(toSubscription)
		.filter(
			(binding) =>
				binding.targetKind === "workflow" && binding.workflowId === workflowId
		);
}

export async function bindWorkflowConnectTrigger(
	target: ApiTarget,
	workflowId: string,
	connectTriggerId: string,
	transport: typeof request = request
): Promise<TriggerSubscription> {
	if (
		!workflowId ||
		workflowId.length > 256 ||
		/\s/.test(workflowId) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			connectTriggerId
		)
	) {
		throw new Error("Invalid Connect workflow binding");
	}
	const result = triggerSubscriptionEnvelopeSchema.parse(
		await transport(
			target,
			"/api/composio/targets",
			{
				method: "POST",
				body: {
					connectTriggerId,
					target: { kind: "workflow", id: workflowId },
				},
			},
			appResponseValueSchema
		)
	);
	const binding = toSubscription(result.subscription);
	if (
		binding.targetKind !== "workflow" ||
		binding.workflowId !== workflowId ||
		!binding.id
	) {
		throw new Error("Core did not confirm the workflow binding");
	}
	return binding;
}

export async function fetchTriggerSubscriptions(
	target: ApiTarget
): Promise<TriggerSubscription[]> {
	const json = await request(
		target,
		"/api/composio/trigger-subscriptions",
		{},
		triggerSubscriptionsResponseSchema
	);
	return (json.subscriptions ?? []).map(toSubscription);
}

export interface SubscribeTriggerInput {
	agentId: string;
	connectedAccountId: string;
	/** The account is connected to the agent's own identity, not yours. Core
	 *  checks that it belongs to this agent and that its account access allows
	 *  it. */
	ownAccount?: boolean;
	toolkit: string;
	triggerSlug: string;
}

export async function subscribeTrigger(
	target: ApiTarget,
	input: SubscribeTriggerInput
): Promise<TriggerSubscription> {
	const json = await request(
		target,
		"/api/composio/triggers/subscribe",
		{
			method: "POST",
			body: {
				agent_id: input.agentId,
				toolkit: input.toolkit,
				trigger_slug: input.triggerSlug,
				connected_account_id: input.connectedAccountId,
				...(input.ownAccount ? { own_account: true } : {}),
			},
		},
		triggerSubscriptionEnvelopeSchema
	);
	return toSubscription(json.subscription);
}

export async function deleteTriggerSubscription(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/composio/trigger-subscriptions/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		triggerSubscriptionDeleteSchema
	);
}

export async function removeWorkflowConnectBinding(
	target: ApiTarget,
	workflowId: string,
	bindingId: string,
	transport: typeof request = request
): Promise<void> {
	const bindings = await fetchWorkflowConnectBindings(
		target,
		workflowId,
		transport
	);
	if (!bindings.some((binding) => binding.id === bindingId)) {
		throw new Error("Connect binding does not belong to this workflow");
	}
	triggerSubscriptionDeleteSchema.parse(
		await transport(
			target,
			`/api/composio/trigger-subscriptions/${encodeURIComponent(bindingId)}`,
			{ method: "DELETE" },
			appResponseValueSchema
		)
	);
}

/** Preserve each host's authenticated HTTP plumbing while sharing the wire contract. */
export function createWorkflowConnectClient(transport: typeof request) {
	return {
		list: (target: ApiTarget, id: string) =>
			fetchWorkflowConnectBindings(target, id, transport),
		bind: (target: ApiTarget, id: string, trigger: string) =>
			bindWorkflowConnectTrigger(target, id, trigger, transport),
		remove: (target: ApiTarget, id: string, binding: string) =>
			removeWorkflowConnectBinding(target, id, binding, transport),
	};
}
