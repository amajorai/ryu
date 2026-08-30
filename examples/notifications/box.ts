#!/usr/bin/env bun

/**
 * Create a Ryu Box, then publish its lifecycle result to Ryu Notify. A second
 * optional command demonstrates the same event path for work inside the Box.
 *
 * Required: BOX_BASE_URL, BOX_API_TOKEN, NOTIFY_BASE_URL, NOTIFY_API_TOKEN.
 */

import { createNotifyClient } from "./notification-client.ts";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required.`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createBoxAndNotify(): Promise<void> {
	const boxBaseUrl = required("BOX_BASE_URL").replace(/\/$/u, "");
	const boxToken = required("BOX_API_TOKEN");
	const createKey =
		process.env.BOX_IDEMPOTENCY_KEY?.trim() || `box-${Date.now()}`;
	const response = await fetch(`${boxBaseUrl}/v1/boxes`, {
		body: JSON.stringify({
			name: process.env.BOX_NAME?.trim() || "notify-example",
			network: "none",
			size: "small",
		}),
		headers: {
			Authorization: `Bearer ${boxToken}`,
			"Content-Type": "application/json",
			"Idempotency-Key": createKey,
		},
		method: "POST",
	});
	const payload: unknown = await response.json();
	if (!(response.ok && isRecord(payload) && isRecord(payload.box))) {
		throw new Error(`Ryu Box returned HTTP ${response.status}.`);
	}
	const boxId = typeof payload.box.id === "string" ? payload.box.id : null;
	const status =
		typeof payload.box.status === "string" ? payload.box.status : null;
	if (!(boxId && status)) {
		throw new Error("Ryu Box returned no id or status.");
	}

	const notify = createNotifyClient({
		apiKey: required("NOTIFY_API_TOKEN"),
		baseUrl: required("NOTIFY_BASE_URL"),
	});
	const event = await notify.publish(
		{
			body: `Box ${boxId} is ${status}.`,
			data: { boxId, status },
			externalId: boxId,
			fingerprint: `box:${boxId}`,
			level: status === "ready" ? "success" : "info",
			source: "box",
			title: "Box ready",
			type: "box.ready",
		},
		`box:${boxId}:ready`
	);
	console.log(JSON.stringify({ boxId, eventId: event.id, status }, null, 2));
}

if (import.meta.main) {
	await createBoxAndNotify();
}
