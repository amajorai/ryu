import { z } from "zod";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/composio-triggers.ts
//
// Client for Core's Composio event-trigger subscriptions (`/api/composio/...`).
// A subscription binds a Composio trigger (e.g. SLACK_CHANNEL_MESSAGE_RECEIVED)
// to an agent; when the event fires, Composio's webhook hits Core which runs the
// agent. Note: delivery requires Core to be reachable at a public URL (Ryu
// Cloud) or via a relay — local Core won't receive the webhook.

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
	toolkit: string;
	triggerSlug: string;
}

interface SubscriptionWire {
	agent_id: string;
	composio_trigger_id?: string | null;
	connected_account_id: string;
	created_at: string;
	id: string;
	own_account?: boolean;
	toolkit: string;
	trigger_slug: string;
}

function toSubscription(s: SubscriptionWire): TriggerSubscription {
	return {
		id: s.id,
		agentId: s.agent_id,
		toolkit: s.toolkit,
		triggerSlug: s.trigger_slug,
		connectedAccountId: s.connected_account_id,
		composioTriggerId: s.composio_trigger_id ?? null,
		createdAt: s.created_at,
		ownAccount: s.own_account === true,
	};
}

export async function fetchTriggerSubscriptions(
	target: ApiTarget
): Promise<TriggerSubscription[]> {
	const json = await request<{ subscriptions?: SubscriptionWire[] }>(
		target,
		"/api/composio/trigger-subscriptions",
		{},
		fetchTriggerSubscriptionsResponseSchema
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
	const json = await request<{ subscription: SubscriptionWire }>(
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
		subscribeTriggerResponseSchema
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
		gatewayJsonValueSchema
	);
}

const fetchTriggerSubscriptionsResponseSchema: z.ZodType<{
	subscriptions?: SubscriptionWire[];
}> = retainValidatedResponse(
	z
		.object({
			subscriptions: z
				.array(
					z
						.object({
							agent_id: z.string(),
							composio_trigger_id: z.union([z.string(), z.null()]).optional(),
							connected_account_id: z.string(),
							created_at: z.string(),
							id: z.string(),
							own_account: z.boolean().optional(),
							toolkit: z.string(),
							trigger_slug: z.string(),
						})
						.passthrough()
				)
				.optional(),
		})
		.passthrough()
);
const subscribeTriggerResponseSchema: z.ZodType<{
	subscription: SubscriptionWire;
}> = retainValidatedResponse(
	z
		.object({
			subscription: z
				.object({
					agent_id: z.string(),
					composio_trigger_id: z.union([z.string(), z.null()]).optional(),
					connected_account_id: z.string(),
					created_at: z.string(),
					id: z.string(),
					own_account: z.boolean().optional(),
					toolkit: z.string(),
					trigger_slug: z.string(),
				})
				.passthrough(),
		})
		.passthrough()
);

function retainValidatedResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>((value) => fields.safeParse(value).success);
}
