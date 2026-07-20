// apps/desktop/src/lib/api/email-transport.ts
//
// Typed client for the Core self-host email + policy-alert delivery API. All
// routes target the ACTIVE node (base URL + RYU_TOKEN via `request()`), never
// the control-plane backend: SMTP transport and alert recipients are node-local
// resources, resolved and delivered by Core (AGENTS.md: Core = what RUNS).
//
// Routes consumed (added by the Stage 2 Core agent):
//   GET  /api/email/transport   non-secret transport config plus `passwordSet`
//   PUT  /api/email/transport   persist config (+ password when supplied)
//   POST /api/email/test        send a test email over the saved transport
//   GET  /api/alerts/delivery   node-level policy-alert delivery targets
//   PUT  /api/alerts/delivery   persist policy-alert delivery targets

import { type ApiTarget, request } from "./client.ts";

/** The non-secret SMTP transport config as returned by `GET /api/email/transport`. */
export interface EmailTransport {
	from: string;
	host: string;
	/** True when a password secret is stored on the node (the value is never returned). */
	passwordSet: boolean;
	port: number;
	starttls: boolean;
	username: string;
}

/**
 * The PUT body. `password` is optional and write-only: omit it (or send blank)
 * to keep the stored secret intact - Core only overwrites when a non-empty value
 * is supplied, and there is no server-side "clear password" path.
 */
export interface EmailTransportInput {
	from: string;
	host: string;
	password?: string;
	port: number;
	starttls: boolean;
	username: string;
}

/**
 * A policy-alert fan-out target. Mirrors Core's `NotifyTarget` (internally
 * tagged on `kind`). The delivery card only edits `webhook` targets; `email`
 * recipients ride the separate `emails` array (see {@link AlertDeliveryTargets}),
 * matching Core's `AlertDeliveryBody`.
 */
export type AlertNotifyTarget =
	| { kind: "webhook"; url: string }
	| { kind: "telegram"; bot_token: string; chat_id: string }
	| { kind: "expo_push"; token: string }
	| { kind: "email"; to: string };

/**
 * The node's policy-alert delivery config. `targets` are the Fanout-tier
 * channels (webhook / Telegram / Expo push); `emails` are the Email-tier
 * recipients delivered over the shared BYO SMTP transport.
 */
export interface AlertDeliveryTargets {
	emails: string[];
	targets: AlertNotifyTarget[];
}

export function getEmailTransport(target: ApiTarget): Promise<EmailTransport> {
	return request<EmailTransport>(target, "/api/email/transport");
}

export async function putEmailTransport(
	target: ApiTarget,
	body: EmailTransportInput
): Promise<void> {
	await request(target, "/api/email/transport", { method: "PUT", body });
}

/**
 * Send a test email over the node's CURRENTLY SAVED transport. Callers must PUT
 * the form first if fields changed - Core tests the persisted config, not the
 * request body. Throws on a non-2xx (Core returns 502 with the SMTP error).
 */
export async function testEmail(
	target: ApiTarget,
	to: string
): Promise<{ messageId?: string; ok: boolean }> {
	return await request<{ messageId?: string; ok: boolean }>(
		target,
		"/api/email/test",
		{ method: "POST", body: { to } }
	);
}

export function getAlertDelivery(
	target: ApiTarget
): Promise<AlertDeliveryTargets> {
	return request<AlertDeliveryTargets>(target, "/api/alerts/delivery");
}

export async function putAlertDelivery(
	target: ApiTarget,
	body: AlertDeliveryTargets
): Promise<void> {
	await request(target, "/api/alerts/delivery", { method: "PUT", body });
}
