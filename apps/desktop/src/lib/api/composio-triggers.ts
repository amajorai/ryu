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
	toolkit: string;
	triggerSlug: string;
}

interface SubscriptionWire {
	agent_id: string;
	composio_trigger_id?: string | null;
	connected_account_id: string;
	created_at: string;
	id: string;
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
	};
}

export async function fetchTriggerSubscriptions(
	target: ApiTarget
): Promise<TriggerSubscription[]> {
	const json = await request<{ subscriptions?: SubscriptionWire[] }>(
		target,
		"/api/composio/trigger-subscriptions"
	);
	return (json.subscriptions ?? []).map(toSubscription);
}

export interface SubscribeTriggerInput {
	agentId: string;
	connectedAccountId: string;
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
			},
		}
	);
	return toSubscription(json.subscription);
}

export async function deleteTriggerSubscription(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		`/api/composio/trigger-subscriptions/${encodeURIComponent(id)}`,
		{ method: "DELETE" }
	);
}
