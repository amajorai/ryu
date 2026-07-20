// apps/desktop/src/lib/api/webhooks.ts
//
// Client for Core's unified webhook endpoint registry (webhook-unify #3):
//   - GET /api/webhooks               → every inbound webhook receiver on this
//                                        node (composio + workflow triggers), each
//                                        carrying its RESOLVED PUBLIC URL, whether a
//                                        secret is set, and its last-delivery time.
//   - GET /api/webhook-ingress/status → the active ingress backend + the overall
//                                        public URL (if a tunnel/relay resolved one).
//
// IMPORTANT: every reachable URL shown to the user comes from a SERVER field
// (`publicUrl` per endpoint, or the status `publicUrl` for the header). We never
// derive a URL from the node base (that is localhost:7980 — the anti-goal). Core
// already resolves the composio-vs-workflow / relay-vs-tunnel divergence: the
// composio endpoint carries the raw stored URL (populated even under RyuRelay),
// while workflow endpoints are `base + path` and are `null` under RyuRelay (the
// managed relay is not path-addressable). We render the field verbatim — a null
// `publicUrl` is an honest "no reachable URL yet", not something to recompute.

import { type ApiTarget, request } from "./client.ts";

/** Kind of receiver behind an endpoint. `composio` is the shared trigger webhook
 *  (N subscriptions, one URL); `workflow` is a per-workflow Webhook trigger. */
export type WebhookEndpointKind = "composio" | "workflow";

/** One inbound webhook endpoint from the registry. */
export interface WebhookEndpoint {
	/** Whether a signing secret is configured for this endpoint. */
	hasSecret: boolean;
	/** Stable id: `"composio"` or the workflow id. */
	id: string;
	kind: WebhookEndpointKind;
	/** Human label (e.g. "Composio triggers" or the workflow name). */
	label: string;
	/** Unix-seconds timestamp of the last accepted delivery, or `null`. */
	lastDelivery: number | null;
	/** The path Core listens on (e.g. `/api/composio/webhook`). */
	path: string;
	/** The RESOLVED, reachable public URL to paste into the external service, or
	 *  `null` when no reachable URL exists yet (ingress not up, or a workflow path
	 *  under the non-addressable RyuRelay). Never a localhost URL. */
	publicUrl: string | null;
	/** composio only: number of trigger subscriptions bound to this webhook. */
	subscriptionCount: number | null;
	/** workflow only: the owning workflow's id. */
	workflowId: string | null;
	/** workflow only: the owning workflow's name. */
	workflowName: string | null;
}

/** The full registry response. */
export interface WebhookRegistry {
	endpoints: WebhookEndpoint[];
	/** The active ingress backend kind (e.g. `ryu-relay`, `cloudflared`). */
	ingressKind: string;
	/** The origin base for path-addressable (tunnel) backends, else `null`
	 *  (RyuRelay), in which case per-workflow URLs are advertised as `null`. */
	publicBaseUrl: string | null;
	/** True once any public URL has been resolved (ingress can receive webhooks). */
	up: boolean;
}

/** The ingress backend status (header banner source). */
export interface WebhookIngressStatus {
	/** The configured backend kind (e.g. `ryu-relay`, `tailscale-funnel`). */
	kind: string;
	/** The overall resolved public ingress URL, or `null` when not up. */
	publicUrl: string | null;
	/** True once a public URL has been resolved. */
	up: boolean;
}

interface WebhookEndpointWire {
	has_secret?: boolean;
	id: string;
	kind: string;
	label: string;
	last_delivery?: number | null;
	path: string;
	public_url?: string | null;
	subscription_count?: number | null;
	workflow_id?: string | null;
	workflow_name?: string | null;
}

interface WebhookRegistryWire {
	endpoints?: WebhookEndpointWire[];
	ingress_kind?: string;
	public_base_url?: string | null;
	up?: boolean;
}

interface WebhookIngressStatusWire {
	kind?: string;
	public_url?: string | null;
	up?: boolean;
}

function toEndpoint(e: WebhookEndpointWire): WebhookEndpoint {
	return {
		id: e.id,
		kind: e.kind === "composio" ? "composio" : "workflow",
		label: e.label,
		path: e.path,
		publicUrl: e.public_url ?? null,
		hasSecret: e.has_secret ?? false,
		lastDelivery: e.last_delivery ?? null,
		subscriptionCount: e.subscription_count ?? null,
		workflowId: e.workflow_id ?? null,
		workflowName: e.workflow_name ?? null,
	};
}

/** GET /api/webhooks — the unified webhook endpoint registry. */
export async function fetchWebhooks(
	target: ApiTarget
): Promise<WebhookRegistry> {
	const json = await request<WebhookRegistryWire>(target, "/api/webhooks");
	return {
		ingressKind: json.ingress_kind ?? "",
		publicBaseUrl: json.public_base_url ?? null,
		up: json.up ?? false,
		endpoints: (json.endpoints ?? []).map(toEndpoint),
	};
}

/** GET /api/webhook-ingress/status — the resolved public ingress URL + backend. */
export async function fetchWebhookIngressStatus(
	target: ApiTarget
): Promise<WebhookIngressStatus> {
	const json = await request<WebhookIngressStatusWire>(
		target,
		"/api/webhook-ingress/status"
	);
	return {
		kind: json.kind ?? "",
		publicUrl: json.public_url ?? null,
		up: json.up ?? false,
	};
}
