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
//
// Signing secrets are read and written through Core's app host bridge
// (`webhooks.secretGet` / `webhooks.secretSet`), where Core checks both the app's
// grant and the signed-in user's permission. The host-direct routes remain only
// as the fallback for an older Core that does not know those methods.

import {
	webhookSecretReadSchema,
	webhookSecretWriteSchema,
} from "@ryu/app-host/rpc";
import type {
	WebhookEndpoint,
	WebhookIngressStatus,
	WebhookRegistry,
} from "@ryuhq/core-client/webhooks.ts";
import {
	webhookIngressResponseSchema,
	webhookRegistryResponseSchema,
	webhookSecretResponseSchema,
} from "@ryuhq/core-client/webhooks.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { pluginHostInvoke, withLegacyBridgeFallback } from "./plugins.ts";

export type {
	WebhookEndpoint,
	WebhookEndpointKind,
	WebhookIngressStatus,
	WebhookRegistry,
} from "@ryuhq/core-client/webhooks.ts";

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

export interface WebhookRegistryWire {
	endpoints?: WebhookEndpointWire[] | null;
	ingress_kind?: string;
	public_base_url?: string | null;
	up?: boolean;
}

export interface WebhookIngressStatusWire {
	kind?: string;
	public_url?: string | null;
	up?: boolean;
}

const webhookEndpointWireSchema = z.object({
	has_secret: z.boolean().optional(),
	id: z.string(),
	kind: z.string(),
	label: z.string(),
	last_delivery: z.number().nullable().optional(),
	path: z.string(),
	public_url: z.string().nullable().optional(),
	subscription_count: z.number().nullable().optional(),
	workflow_id: z.string().nullable().optional(),
	workflow_name: z.string().nullable().optional(),
});

/** Runtime shape of the `webhooks.list` kernel operation's reply, which reaches
 *  the host as untyped JSON from the app host bridge. */
export const webhookRegistryWireSchema = z.object({
	endpoints: z.array(webhookEndpointWireSchema).optional(),
	ingress_kind: z.string().optional(),
	public_base_url: z.string().nullable().optional(),
	up: z.boolean().optional(),
});

/** Runtime shape of the `webhooks.ingressStatus` kernel operation's reply. */
export const webhookIngressStatusWireSchema = z.object({
	kind: z.string().optional(),
	public_url: z.string().nullable().optional(),
	up: z.boolean().optional(),
});

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

/** Normalize Core's snake_case registry (the `/api/webhooks` route and the
 *  `webhooks.list` kernel operation answer the same shape). */
export function toWebhookRegistry(json: WebhookRegistryWire): WebhookRegistry {
	return {
		ingressKind: json.ingress_kind ?? "",
		publicBaseUrl: json.public_base_url ?? null,
		up: json.up ?? false,
		endpoints: (json.endpoints ?? []).map(toEndpoint),
	};
}

/** Normalize Core's snake_case ingress status (route and kernel operation). */
export function toWebhookIngressStatus(
	json: WebhookIngressStatusWire
): WebhookIngressStatus {
	return {
		kind: json.kind ?? "",
		publicUrl: json.public_url ?? null,
		up: json.up ?? false,
	};
}

/** GET /api/webhooks — the unified webhook endpoint registry. */
export async function fetchWebhooks(
	target: ApiTarget
): Promise<WebhookRegistry> {
	return toWebhookRegistry(
		await request(
			target,
			"/api/webhooks",
			undefined,
			webhookRegistryResponseSchema
		)
	);
}

/** GET /api/webhook-ingress/status — the resolved public ingress URL + backend. */
export async function fetchWebhookIngressStatus(
	target: ApiTarget
): Promise<WebhookIngressStatus> {
	return toWebhookIngressStatus(
		await request(
			target,
			"/api/webhook-ingress/status",
			undefined,
			webhookIngressResponseSchema
		)
	);
}

/** GET /api/webhooks/:id/secret — the host-direct read an older Core without the
 *  `webhooks.secretGet` bridge method still needs (see {@link readWebhookSecret}). */
async function legacyFetchWebhookSecret(
	target: ApiTarget,
	id: string
): Promise<string | null> {
	const json = await request(
		target,
		`/api/webhooks/${encodeURIComponent(id)}/secret`,
		undefined,
		webhookSecretResponseSchema
	);
	return json.secret ?? null;
}

const setWebhookSecretResponseSchema = z
	.object({ secret: z.string().optional() })
	.passthrough();

/** POST /api/webhooks/:id/secret — the host-direct write for an older Core
 *  (see {@link writeWebhookSecret}). Omitting `secret` asks Core to mint one. */
async function legacySetWebhookSecret(
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
		setWebhookSecretResponseSchema
	);
	if (!json.secret) {
		throw new Error("webhook secret response was empty");
	}
	return json.secret;
}

/** A `webhooks.secretGet` reply as the Companion receives it. */
export type WebhookSecretReadRecord = z.output<typeof webhookSecretReadSchema>;
/** A `webhooks.secretSet` reply as the Companion receives it. */
export type WebhookSecretWriteRecord = z.output<
	typeof webhookSecretWriteSchema
>;

/** Check a `webhooks.secretGet` bridge reply (`{ secret: string | null }`). */
export function toWebhookSecretRead(value: unknown): WebhookSecretReadRecord {
	return webhookSecretReadSchema.parse(value);
}

/** Check a `webhooks.secretSet` bridge reply (`{ secret }`, never empty). */
export function toWebhookSecretWrite(value: unknown): WebhookSecretWriteRecord {
	const written = webhookSecretWriteSchema.parse(value);
	if (written.secret.length === 0) {
		throw new Error("webhook secret response was empty");
	}
	return written;
}

/**
 * Read one endpoint's signing secret for the `@ryu/webhooks` Companion through
 * Core's app host bridge (`webhooks.secretGet`). Core checks the app's approved
 * `webhooks:crud` grant AND the signed-in user's own permission on that endpoint
 * (workflow edit, or Gateway configure for Composio). Only an older Core that
 * lacks the method falls back to the host-direct route.
 */
export function readWebhookSecret(
	target: ApiTarget,
	pluginId: string,
	id: string
): Promise<WebhookSecretReadRecord> {
	return withLegacyBridgeFallback(
		"webhooks.secretGet",
		async () =>
			toWebhookSecretRead(
				await pluginHostInvoke(target, pluginId, "webhooks.secretGet", { id })
			),
		async () => ({ secret: await legacyFetchWebhookSecret(target, id) })
	);
}

/**
 * Set (or, without `secret`, mint) one workflow endpoint's signing secret
 * through Core's app host bridge (`webhooks.secretSet`), under the same two
 * checks as {@link readWebhookSecret} and the same narrow older-Core fallback.
 */
export function writeWebhookSecret(
	target: ApiTarget,
	pluginId: string,
	id: string,
	secret?: string
): Promise<WebhookSecretWriteRecord> {
	return withLegacyBridgeFallback(
		"webhooks.secretSet",
		async () =>
			toWebhookSecretWrite(
				await pluginHostInvoke(
					target,
					pluginId,
					"webhooks.secretSet",
					secret === undefined ? { id } : { id, secret }
				)
			),
		async () => ({ secret: await legacySetWebhookSecret(target, id, secret) })
	);
}
