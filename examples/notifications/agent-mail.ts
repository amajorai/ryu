#!/usr/bin/env bun

/**
 * Send one Agent Inboxes message, then publish the hand-off as a Ryu Notify
 * event. The example keeps the two service credentials separate.
 *
 * Required: MAIL_BASE_URL, MAIL_API_TOKEN, MAIL_INBOX_ID, MAIL_TO,
 * NOTIFY_BASE_URL, NOTIFY_API_TOKEN.
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

export async function sendAgentMail(): Promise<void> {
	const mailBaseUrl = required("MAIL_BASE_URL").replace(/\/$/u, "");
	const mailToken = required("MAIL_API_TOKEN");
	const inboxId = required("MAIL_INBOX_ID");
	const to = required("MAIL_TO");
	const subject = process.env.MAIL_SUBJECT?.trim() || "Ryu Mail example";
	const text =
		process.env.MAIL_TEXT?.trim() ||
		"This message was sent by the Agent Inboxes + Ryu Notify example.";
	const response = await fetch(
		`${mailBaseUrl}/api/mail/inboxes/${encodeURIComponent(inboxId)}/send`,
		{
			body: JSON.stringify({
				subject,
				text,
				to: [to],
			}),
			headers: {
				Authorization: `Bearer ${mailToken}`,
				"Content-Type": "application/json",
			},
			method: "POST",
		}
	);
	const payload: unknown = await response.json();
	if (!(response.ok && isRecord(payload) && isRecord(payload.message))) {
		throw new Error(`Agent Mail returned HTTP ${response.status}.`);
	}
	const messageId =
		typeof payload.message.id === "string" ? payload.message.id : null;
	if (!messageId) {
		throw new Error("Agent Mail returned no message id.");
	}

	const notify = createNotifyClient({
		apiKey: required("NOTIFY_API_TOKEN"),
		baseUrl: required("NOTIFY_BASE_URL"),
	});
	const event = await notify.publish(
		{
			body: `Message handed to the mail transport for ${to}.`,
			data: { inboxId, messageId, subject, to },
			externalId: messageId,
			fingerprint: `mail:${inboxId}`,
			level: "success",
			source: "agent-mail",
			title: "Agent Mail sent",
			type: "mail.sent",
		},
		`mail:${messageId}`
	);
	console.log(JSON.stringify({ eventId: event.id, messageId }, null, 2));
}

if (import.meta.main) {
	await sendAgentMail();
}
