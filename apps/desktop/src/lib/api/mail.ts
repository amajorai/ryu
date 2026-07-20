// apps/desktop/src/lib/api/mail.ts
//
// Typed client for self-host Agent Inboxes (Stage 3). Targets the ACTIVE node
// (base URL + RYU_TOKEN via `request()`), never the control-plane backend:
// receiving/storing/sending agent mail is node-local (AGENTS.md: Core = what
// RUNS). The shared REST shape mirrors the managed mail router so one UI drives
// both planes; this client is the self-host half.
//
// Routes (Core `apps/core/src/mail/api.rs`):
//   GET    /api/mail/status
//   GET    /api/mail/inboxes           POST /api/mail/inboxes
//   GET    /api/mail/inboxes/:id        PATCH /api/mail/inboxes/:id   DELETE …
//   POST   /api/mail/inboxes/:id/rotate-secret
//   GET    /api/mail/inboxes/:id/messages
//   GET    /api/mail/messages/:id
//   POST   /api/mail/inboxes/:id/send

import { type ApiTarget, request } from "./client.ts";

export type InboxProvider = "webhook" | "imap";

export interface Inbox {
	address: string;
	created_at: string;
	id: string;
	inbound_secret: string;
	name: string;
	provider: InboxProvider;
}

export interface AttachmentMeta {
	content_type: string;
	filename: string;
	id: string;
	size: number;
}

export interface EmailMessage {
	attachments: AttachmentMeta[];
	cc_addrs: string[];
	created_at: string;
	/** "inbound" | "outbound". */
	direction: string;
	from_addr: string;
	html?: string;
	id: string;
	in_reply_to?: string;
	inbox_id: string;
	message_id: string;
	provider_message_id?: string;
	subject: string;
	text?: string;
	to_addrs: string[];
}

export interface MailStatus {
	configured: boolean;
	domainMode: "byo" | "managed";
	inbound: "webhook" | "imap" | "sns";
	inboxCount: number;
	sendConfigured: boolean;
}

export interface CreateInboxInput {
	address: string;
	name: string;
	provider?: InboxProvider;
}

export interface SendInput {
	cc?: string[];
	html?: string;
	inReplyTo?: string;
	subject: string;
	text?: string;
	to: string[];
}

export function getMailStatus(target: ApiTarget): Promise<MailStatus> {
	return request<MailStatus>(target, "/api/mail/status");
}

export async function listInboxes(target: ApiTarget): Promise<Inbox[]> {
	const res = await request<{ inboxes: Inbox[] }>(target, "/api/mail/inboxes");
	return res.inboxes;
}

export async function createInbox(
	target: ApiTarget,
	body: CreateInboxInput
): Promise<Inbox> {
	const res = await request<{ inbox: Inbox }>(target, "/api/mail/inboxes", {
		method: "POST",
		body,
	});
	return res.inbox;
}

export async function renameInbox(
	target: ApiTarget,
	id: string,
	name: string
): Promise<Inbox> {
	const res = await request<{ inbox: Inbox }>(
		target,
		`/api/mail/inboxes/${id}`,
		{ method: "PATCH", body: { name } }
	);
	return res.inbox;
}

export async function rotateInboundSecret(
	target: ApiTarget,
	id: string
): Promise<string> {
	const res = await request<{ inboundSecret: string }>(
		target,
		`/api/mail/inboxes/${id}/rotate-secret`,
		{ method: "POST" }
	);
	return res.inboundSecret;
}

export async function deleteInbox(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(target, `/api/mail/inboxes/${id}`, { method: "DELETE" });
}

export async function listMessages(
	target: ApiTarget,
	inboxId: string
): Promise<EmailMessage[]> {
	const res = await request<{ messages: EmailMessage[] }>(
		target,
		`/api/mail/inboxes/${inboxId}/messages`
	);
	return res.messages;
}

export async function getMessage(
	target: ApiTarget,
	id: string
): Promise<EmailMessage> {
	const res = await request<{ message: EmailMessage }>(
		target,
		`/api/mail/messages/${id}`
	);
	return res.message;
}

export async function sendMessage(
	target: ApiTarget,
	inboxId: string,
	body: SendInput
): Promise<EmailMessage> {
	const res = await request<{ message: EmailMessage }>(
		target,
		`/api/mail/inboxes/${inboxId}/send`,
		{ method: "POST", body }
	);
	return res.message;
}
