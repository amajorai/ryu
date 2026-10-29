import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/mail.ts
// Node-scoped Agent Mail client. Core owns authentication and the sidecar owns
// mail storage; this module keeps the desktop and Companion contracts typed.

import {
	type AppRequestValue,
	type AppResponseValue,
	appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import {
	type MailAttachmentRecord,
	type MailDraftRecord,
	type MailEventRecord,
	type MailInboxRecord,
	type MailMessageRecord,
	type MailStatusRecord,
	type MailThreadRecord,
	type MailWebhookRecord,
	type MailWebhookWriteReply,
	mailAttachmentDownloadSchema,
	mailDraftRecordSchema,
	mailDraftRecordsSchema,
	mailEnvelopeSchema,
	mailEventRecordsSchema,
	mailHeadersReplySchema,
	mailInboxRecordSchema,
	mailInboxRecordsSchema,
	mailMessageRecordSchema,
	mailMessageRecordsSchema,
	mailSecretReplySchema,
	mailStatusRecordSchema,
	mailThreadRecordsSchema,
	mailWebhookRecordsSchema,
	mailWebhookWriteReplySchema,
} from "@ryuhq/core-client/mail.ts";
import type { z } from "zod";

import { resolveMountedAppPath } from "./app-request.ts";
import { type ApiTarget, request } from "./client.ts";
import { encodePathId } from "./path-id.ts";

export type InboxProvider = "webhook" | "imap";

export type Inbox = MailInboxRecord;

export type AttachmentMeta = MailAttachmentRecord;

export type EmailMessage = MailMessageRecord;

export interface AttachmentInput {
	content?: string;
	content_base64?: string;
	content_id?: string;
	content_type: string;
	filename: string;
	inline?: boolean;
}

export type MailStatus = MailStatusRecord;

/** Native JSON.stringify draft values; Core owns method-specific validation. */
export interface MailInputRecord {
	[key: string]: AppRequestValue;
}

export interface CreateInboxInput {
	address: string;
	client_id?: string;
	metadata?: MailInputRecord;
	name: string;
	pod_id?: string;
	provider?: InboxProvider;
}

export interface SendInput {
	attachments?: AttachmentInput[];
	bcc?: string[];
	cc?: string[];
	clientId?: string;
	headers?: Record<string, string>;
	html?: string;
	inReplyTo?: string;
	labels?: string[];
	references?: string;
	replyTo?: string[];
	subject: string;
	text?: string;
	to: string[];
	trackOpens?: boolean;
}

export type MailDraft = MailDraftRecord;

export type MailWebhook = MailWebhookRecord;

export type MailEvent = MailEventRecord;

export interface MailRequestInput {
	body?: AppRequestValue;
	method?: "DELETE" | "GET" | "PATCH" | "POST";
	path: string;
}

export type MailThread = MailThreadRecord;

function unwrap<T>(
	value: Parameters<typeof appResponseValueSchema.parse>[0],
	key: string,
	fields: z.ZodType<T>
): T {
	return mailEnvelopeSchema(key, fields).parse(value);
}

function queryString(query: MailInputRecord): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, Array.isArray(value) ? value.join(",") : String(value));
	}
	return params.size ? `?${params}` : "";
}

export function getMailStatus(target: ApiTarget): Promise<MailStatus> {
	return request(target, "/api/mail/status", {}, gatewayJsonValueSchema).then(
		mailStatusRecordSchema.parse
	);
}

export async function listInboxes(target: ApiTarget): Promise<Inbox[]> {
	return unwrap<Inbox[]>(
		await request(target, "/api/mail/inboxes", {}, gatewayJsonValueSchema),
		"inboxes",
		mailInboxRecordsSchema
	);
}

export async function getInbox(target: ApiTarget, id: string): Promise<Inbox> {
	return unwrap<Inbox>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(id)}`,
			{},
			gatewayJsonValueSchema
		),
		"inbox",
		mailInboxRecordSchema
	);
}

export async function createInbox(
	target: ApiTarget,
	body: CreateInboxInput
): Promise<Inbox> {
	return unwrap<Inbox>(
		await request(
			target,
			"/api/mail/inboxes",
			{ method: "POST", body },
			gatewayJsonValueSchema
		),
		"inbox",
		mailInboxRecordSchema
	);
}

export async function renameInbox(
	target: ApiTarget,
	id: string,
	name: string
): Promise<Inbox> {
	return unwrap<Inbox>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(id)}`,
			{
				method: "PATCH",
				body: { name },
			},
			gatewayJsonValueSchema
		),
		"inbox",
		mailInboxRecordSchema
	);
}

export async function rotateInboundSecret(
	target: ApiTarget,
	id: string
): Promise<string> {
	const response = mailSecretReplySchema.parse(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(id)}/rotate-secret`,
			{
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return response.inboundSecret ?? response.inbound_secret ?? "";
}

export async function deleteInbox(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/mail/inboxes/${encodePathId(id)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

export async function listMessages(
	target: ApiTarget,
	inboxId: string,
	query: MailInputRecord = {}
): Promise<EmailMessage[]> {
	return unwrap<EmailMessage[]>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/messages${queryString(query)}`,
			{},
			gatewayJsonValueSchema
		),
		"messages",
		mailMessageRecordsSchema
	);
}

export async function searchMessages(
	target: ApiTarget,
	inboxId: string,
	q: string,
	query: MailInputRecord = {}
): Promise<EmailMessage[]> {
	return listMessages(target, inboxId, { ...query, q });
}

export async function getMessage(
	target: ApiTarget,
	id: string
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/messages/${encodePathId(id)}`,
			{},
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function updateMessage(
	target: ApiTarget,
	inboxId: string,
	messageId: string,
	body: {
		addLabels?: string[];
		labels?: string[];
		read?: boolean;
		removeLabels?: string[];
	}
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/messages/${encodePathId(messageId)}`,
			{ method: "PATCH", body },
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function deleteMessage(
	target: ApiTarget,
	inboxId: string,
	messageId: string
): Promise<void> {
	await request(
		target,
		`/api/mail/inboxes/${encodePathId(inboxId)}/messages/${encodePathId(messageId)}`,
		{
			method: "DELETE",
		},
		gatewayJsonValueSchema
	);
}

export async function sendMessage(
	target: ApiTarget,
	inboxId: string,
	body: SendInput,
	idempotencyKey?: string
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/send`,
			{
				method: "POST",
				body,
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
			},
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function replyMessage(
	target: ApiTarget,
	inboxId: string,
	messageId: string,
	body: Partial<SendInput> = {}
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/messages/${encodePathId(messageId)}/reply`,
			{ method: "POST", body },
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function replyAllMessage(
	target: ApiTarget,
	inboxId: string,
	messageId: string,
	body: Partial<SendInput> = {}
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/messages/${encodePathId(messageId)}/reply-all`,
			{ method: "POST", body },
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function forwardMessage(
	target: ApiTarget,
	inboxId: string,
	messageId: string,
	body: SendInput
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/messages/${encodePathId(messageId)}/forward`,
			{ method: "POST", body },
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function listThreads(
	target: ApiTarget,
	inboxId: string,
	search?: string
): Promise<MailThread[]> {
	const path = search
		? `/api/mail/inboxes/${encodePathId(inboxId)}/threads/search?q=${encodeURIComponent(search)}`
		: `/api/mail/inboxes/${encodePathId(inboxId)}/threads`;
	return unwrap(
		await request(target, path, {}, gatewayJsonValueSchema),
		"threads",
		mailThreadRecordsSchema
	);
}

export async function getThread(
	target: ApiTarget,
	inboxId: string,
	threadId: string
): Promise<EmailMessage[]> {
	return unwrap(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/threads/${encodePathId(threadId)}`,
			{},
			gatewayJsonValueSchema
		),
		"messages",
		mailMessageRecordsSchema
	);
}

export async function listDrafts(
	target: ApiTarget,
	inboxId: string
): Promise<MailDraft[]> {
	return unwrap(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/drafts`,
			{},
			gatewayJsonValueSchema
		),
		"drafts",
		mailDraftRecordsSchema
	);
}

export async function createDraft(
	target: ApiTarget,
	inboxId: string,
	body: MailInputRecord
): Promise<MailDraft> {
	return request(
		target,
		`/api/mail/inboxes/${encodePathId(inboxId)}/drafts`,
		{
			method: "POST",
			body,
		},
		gatewayJsonValueSchema
	).then(mailDraftRecordSchema.parse);
}

export async function updateDraft(
	target: ApiTarget,
	inboxId: string,
	draftId: string,
	body: MailInputRecord
): Promise<MailDraft> {
	return request(
		target,
		`/api/mail/inboxes/${encodePathId(inboxId)}/drafts/${encodePathId(draftId)}`,
		{
			method: "PATCH",
			body,
		},
		gatewayJsonValueSchema
	).then(mailDraftRecordSchema.parse);
}

export async function deleteDraft(
	target: ApiTarget,
	inboxId: string,
	draftId: string
): Promise<void> {
	await request(
		target,
		`/api/mail/inboxes/${encodePathId(inboxId)}/drafts/${encodePathId(draftId)}`,
		{
			method: "DELETE",
		},
		gatewayJsonValueSchema
	);
}

export async function sendDraft(
	target: ApiTarget,
	inboxId: string,
	draftId: string,
	idempotencyKey?: string
): Promise<EmailMessage> {
	return unwrap<EmailMessage>(
		await request(
			target,
			`/api/mail/inboxes/${encodePathId(inboxId)}/drafts/${encodePathId(draftId)}/send`,
			{
				method: "POST",
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
			},
			gatewayJsonValueSchema
		),
		"message",
		mailMessageRecordSchema
	);
}

export async function listWebhooks(target: ApiTarget): Promise<MailWebhook[]> {
	return unwrap(
		await request(target, "/api/mail/webhooks", {}, gatewayJsonValueSchema),
		"webhooks",
		mailWebhookRecordsSchema
	);
}

export async function createWebhook(
	target: ApiTarget,
	body: MailInputRecord,
	inboxId?: string
): Promise<MailWebhookWriteReply> {
	return request(
		target,
		inboxId
			? `/api/mail/inboxes/${encodePathId(inboxId)}/webhooks`
			: "/api/mail/webhooks",
		{ method: "POST", body },
		gatewayJsonValueSchema
	).then(mailWebhookWriteReplySchema.parse);
}

export async function updateWebhook(
	target: ApiTarget,
	id: string,
	body: MailInputRecord
): Promise<MailWebhookWriteReply> {
	return request(
		target,
		`/api/mail/webhooks/${encodePathId(id)}`,
		{
			method: "PATCH",
			body,
		},
		gatewayJsonValueSchema
	).then(mailWebhookWriteReplySchema.parse);
}

export async function deleteWebhook(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request(
		target,
		`/api/mail/webhooks/${encodePathId(id)}`,
		{ method: "DELETE" },
		gatewayJsonValueSchema
	);
}

export async function listWebhookHeaders(
	target: ApiTarget,
	id: string
): Promise<string[]> {
	const response = mailHeadersReplySchema.parse(
		await request(
			target,
			`/api/mail/webhooks/${encodePathId(id)}/headers`,
			{},
			gatewayJsonValueSchema
		)
	);
	return response.header_names ?? response.headers ?? [];
}
export async function updateWebhookHeaders(
	target: ApiTarget,
	id: string,
	headers: Record<string, string>
): Promise<string[]> {
	const response = mailHeadersReplySchema.parse(
		await request(
			target,
			`/api/mail/webhooks/${encodePathId(id)}/headers`,
			{
				method: "PATCH",
				body: { headers },
			},
			gatewayJsonValueSchema
		)
	);
	return response.header_names ?? response.headers ?? [];
}

export async function listEvents(
	target: ApiTarget,
	inboxId?: string
): Promise<MailEvent[]> {
	return unwrap(
		await request(
			target,
			inboxId
				? `/api/mail/inboxes/${encodePathId(inboxId)}/events`
				: "/api/mail/events",
			{},
			gatewayJsonValueSchema
		),
		"events",
		mailEventRecordsSchema
	);
}

export async function downloadAttachment(
	target: ApiTarget,
	attachmentId: string
): Promise<{ url: string }> {
	return request(
		target,
		`/api/mail/attachments/${encodePathId(attachmentId)}`,
		{},
		gatewayJsonValueSchema
	).then(mailAttachmentDownloadSchema.parse);
}

/** The mount Core serves Agent Mail on. A constant, never a parameter: the
 *  companion frame contributes the sub-path and nothing else. */
const MAIL_MOUNT = "/api/mail";

/**
 * Resolve a companion-chosen `mail.request` path with the WHATWG URL semantics
 * `fetch` applies (tab/LF/CR removal, dot-segment collapse) and return the
 * normalized path only when it still lies beneath {@link MAIL_MOUNT}.
 */
function resolveMailRequestPath(path: string): string | null {
	if (!path.startsWith(`${MAIL_MOUNT}/`)) {
		return null;
	}
	return resolveMountedAppPath(MAIL_MOUNT, path.slice(MAIL_MOUNT.length));
}

export async function mailRequest(
	target: ApiTarget,
	input: MailRequestInput
): Promise<AppResponseValue> {
	const path = resolveMailRequestPath(input.path);
	if (!path) {
		throw new Error(
			`Refusing to forward "${input.path}" — a mail request path must stay beneath ${MAIL_MOUNT} once normalized.`
		);
	}
	return request(
		target,
		path,
		{
			method: input.method ?? "GET",
			body: appRequestValueSchema.parse(input.body),
		},
		gatewayJsonValueSchema
	).then(appResponseValueSchema.parse);
}
