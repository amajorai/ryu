// packages/core-client/src/webhooks.ts
//
// Platform-neutral client for Core's inbound webhook registry and protected
// secret-management routes. Desktop and native use the same wire normalization;
// the sandboxed Webhooks companion reaches these methods through its host bridge.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

export type WebhookEndpointKind = "composio" | "workflow";

export interface WebhookEndpoint {
	hasSecret: boolean;
	id: string;
	kind: WebhookEndpointKind;
	label: string;
	lastDelivery: number | null;
	path: string;
	publicUrl: string | null;
	subscriptionCount: number | null;
	workflowId: string | null;
	workflowName: string | null;
}

export interface WebhookRegistry {
	endpoints: WebhookEndpoint[];
	ingressKind: string;
	publicBaseUrl: string | null;
	up: boolean;
}

export interface WebhookIngressStatus {
	kind: string;
	publicUrl: string | null;
	up: boolean;
}

// Entire native registry/ingress/secret publishers. The optional fields retain
// existing older-node normalization; kind stays String for its future fallback.
function webhookResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const webhookEndpointResponseSchema = webhookResponse(
	z.object({
		has_secret: z.boolean().optional(),
		id: z.string(),
		kind: z.string(),
		label: z.string(),
		last_delivery: z.number().nullish(),
		path: z.string(),
		public_url: z.string().nullish(),
		subscription_count: z.number().nullish(),
		workflow_id: z.string().nullish(),
		workflow_name: z.string().nullish(),
	})
);
type WebhookEndpointWire = z.output<typeof webhookEndpointResponseSchema>;
export const webhookRegistryResponseSchema = webhookResponse(
	z.object({
		endpoints: z.array(webhookEndpointResponseSchema).nullish(),
		ingress_kind: z.string().optional(),
		public_base_url: z.string().nullish(),
		up: z.boolean().optional(),
	})
);
export const webhookIngressResponseSchema = webhookResponse(
	z.object({
		kind: z.string().optional(),
		public_url: z.string().nullish(),
		up: z.boolean().optional(),
	})
);
export const webhookSecretResponseSchema = webhookResponse(
	z.object({ secret: z.string().nullish() })
);
const webhookSecretWriteResponseSchema = webhookResponse(
	z.object({ secret: z.string().optional() })
);

function toEndpoint(endpoint: WebhookEndpointWire): WebhookEndpoint {
	return {
		hasSecret: endpoint.has_secret ?? false,
		id: endpoint.id,
		kind: endpoint.kind === "composio" ? "composio" : "workflow",
		label: endpoint.label,
		lastDelivery: endpoint.last_delivery ?? null,
		path: endpoint.path,
		publicUrl: endpoint.public_url ?? null,
		subscriptionCount: endpoint.subscription_count ?? null,
		workflowId: endpoint.workflow_id ?? null,
		workflowName: endpoint.workflow_name ?? null,
	};
}

export async function fetchWebhooks(
	target: ApiTarget
): Promise<WebhookRegistry> {
	const json = await request(
		target,
		"/api/webhooks",
		{},
		webhookRegistryResponseSchema
	);
	return {
		ingressKind: json.ingress_kind ?? "",
		publicBaseUrl: json.public_base_url ?? null,
		up: json.up ?? false,
		endpoints: (json.endpoints ?? []).map(toEndpoint),
	};
}

export async function fetchWebhookIngressStatus(
	target: ApiTarget
): Promise<WebhookIngressStatus> {
	const json = await request(
		target,
		"/api/webhook-ingress/status",
		{},
		webhookIngressResponseSchema
	);
	return {
		kind: json.kind ?? "",
		publicUrl: json.public_url ?? null,
		up: json.up ?? false,
	};
}

export async function fetchWebhookSecret(
	target: ApiTarget,
	id: string
): Promise<string | null> {
	const json = await request(
		target,
		`/api/webhooks/${encodeURIComponent(id)}/secret`,
		{},
		webhookSecretResponseSchema
	);
	return json.secret ?? null;
}

export async function setWebhookSecret(
	target: ApiTarget,
	id: string,
	secret?: string
): Promise<string> {
	const json = await request(
		target,
		`/api/webhooks/${encodeURIComponent(id)}/secret`,
		{
			body: secret === undefined ? {} : { secret },
			method: "POST",
		},
		webhookSecretWriteResponseSchema
	);
	if (!json.secret) {
		throw new Error("webhook secret response was empty");
	}
	return json.secret;
}
