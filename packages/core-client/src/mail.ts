import { z } from "zod";
import { appJsonValueSchema } from "./app-request-json.ts";

// Complete sidecar records/projections: apps-store/mail/backend/src/main.rs and api.rs.
// Keep legacy optional fields and original JSON identities without normalizing wire names.
function preserveMailResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			fields.safeParse(value).success &&
			appJsonValueSchema.safeParse(value).success
	);
}
export const mailJsonRecordSchema = preserveMailResponse(
	z.record(z.string(), appJsonValueSchema)
);
export const mailStringRecordSchema = z.custom<Record<string, string>>(
	(value) =>
		z.record(z.string(), z.string()).safeParse(value).success &&
		Object.values(new Object(value)).every(
			(entry) => z.string().safeParse(entry).success
		)
);
export const mailProviderSchema = z.enum(["webhook", "imap"]);
const nullableString = z.string().nullish();
const optionalString = z.string().optional();
const nonnegativeNumber = z.number().finite().nonnegative();
export const mailInboxRecordSchema = preserveMailResponse(
	z.object({
		id: z.string(),
		name: z.string(),
		address: z.string(),
		provider: mailProviderSchema,
		created_at: z.string(),
		client_id: nullableString,
		pod_id: nullableString,
		metadata: mailJsonRecordSchema.optional(),
		updated_at: optionalString,
		description: nullableString,
		inbound_secret: optionalString,
	})
);
export type MailInboxRecord = z.output<typeof mailInboxRecordSchema>;
export const mailAttachmentRecordSchema = preserveMailResponse(
	z.object({
		id: z.string(),
		filename: z.string(),
		content_type: z.string(),
		size: nonnegativeNumber,
		inline: z.boolean().optional(),
		content_id: nullableString,
	})
);
export type MailAttachmentRecord = z.output<typeof mailAttachmentRecordSchema>;
export const mailMessageRecordSchema = preserveMailResponse(
	z.object({
		id: z.string(),
		inbox_id: z.string(),
		direction: z.string(),
		message_id: z.string(),
		from_addr: z.string(),
		to_addrs: z.array(z.string()),
		cc_addrs: z.array(z.string()),
		bcc_addrs: z.array(z.string()),
		subject: z.string(),
		created_at: z.string(),
		attachments: z.array(mailAttachmentRecordSchema),
		in_reply_to: optionalString,
		text: optionalString,
		html: optionalString,
		reply_to_addrs: z.array(z.string()).optional(),
		references: z.array(z.string()).optional(),
		thread_id: nullableString,
		extracted_text: nullableString,
		extracted_html: nullableString,
		preview: nullableString,
		headers: mailStringRecordSchema.optional(),
		labels: z.array(z.string()).optional(),
		status: optionalString,
		read: z.boolean().optional(),
		opened_at: nullableString,
		raw_size: nonnegativeNumber.optional(),
		provider_message_id: optionalString,
		updated_at: optionalString,
		client_id: nullableString,
		error: nullableString,
	})
);
export type MailMessageRecord = z.output<typeof mailMessageRecordSchema>;
export const mailInboxRecordsSchema = preserveMailResponse(
	z.array(mailInboxRecordSchema)
);
export const mailMessageRecordsSchema = preserveMailResponse(
	z.array(mailMessageRecordSchema)
);
export const mailStatusRecordSchema = preserveMailResponse(
	z.object({
		configured: z.boolean(),
		domainMode: z.string(),
		inbound: z.string(),
		inboxCount: nonnegativeNumber,
		sendConfigured: z.boolean(),
		apiVersion: optionalString,
	})
);
export type MailStatusRecord = z.output<typeof mailStatusRecordSchema>;
const draftAttachmentFields = {
	filename: z.string(),
	content_type: optionalString,
	content_id: nullableString,
	inline: z.boolean().optional(),
};
const draftAttachmentSchema = preserveMailResponse(
	z.union([
		z.object({ ...draftAttachmentFields, content: z.string() }),
		z.object({ ...draftAttachmentFields, content_base64: z.string() }),
		mailAttachmentRecordSchema,
	])
);
export const mailDraftRecordSchema = preserveMailResponse(
	z.object({
		id: z.string(),
		inbox_id: z.string(),
		thread_id: nullableString,
		client_id: nullableString,
		to_addrs: z.array(z.string()),
		cc_addrs: z.array(z.string()),
		bcc_addrs: z.array(z.string()),
		reply_to_addrs: z.array(z.string()),
		subject: z.string(),
		text: nullableString,
		html: nullableString,
		headers: mailStringRecordSchema,
		labels: z.array(z.string()),
		attachments: z.array(draftAttachmentSchema),
		send_at: nullableString,
		status: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
);
export type MailDraftRecord = z.output<typeof mailDraftRecordSchema>;
export const mailDraftRecordsSchema = preserveMailResponse(
	z.array(mailDraftRecordSchema)
);
const nativeThreadFields = z.object({
	inboxId: nullableString,
	threadId: nullableString,
	labels: z.array(z.string()),
	senders: z.array(z.string()),
	recipients: z.array(z.string()),
	lastMessageId: nullableString,
	messageCount: nonnegativeNumber,
	size: nonnegativeNumber,
	subject: nullableString,
	preview: nullableString,
	attachments: z.array(mailAttachmentRecordSchema),
	createdAt: nullableString,
	updatedAt: nullableString,
	messages: mailMessageRecordsSchema.optional(),
});
const legacyThreadFields = z.object({
	id: z.string(),
	latest_message: mailMessageRecordSchema.nullish(),
	message_count: nonnegativeNumber,
	participants: z.array(z.string()),
	subject: nullableString,
});
export const mailThreadRecordSchema = preserveMailResponse(
	z.union([nativeThreadFields, legacyThreadFields])
);
export type MailThreadRecord = z.output<typeof mailThreadRecordSchema>;
export const mailThreadRecordsSchema = preserveMailResponse(
	z.array(mailThreadRecordSchema)
);
export const mailWebhookRecordSchema = preserveMailResponse(
	z.object({
		webhook_id: z.string(),
		url: z.string(),
		secret: nullableString,
		enabled: z.boolean(),
		event_types: z.array(z.string()),
		inbox_ids: z.array(z.string()),
		pod_ids: z.array(z.string()),
		client_id: nullableString,
		header_names: z.array(z.string()),
		created_at: z.string(),
		updated_at: z.string(),
	})
);
export type MailWebhookRecord = z.output<typeof mailWebhookRecordSchema>;
export const mailWebhookRecordsSchema = preserveMailResponse(
	z.array(mailWebhookRecordSchema)
);
export const mailWebhookWriteReplySchema = preserveMailResponse(
	z.union([
		mailWebhookRecordSchema,
		z.object({ secret: nullableString, webhook: mailWebhookRecordSchema }),
	])
);
export type MailWebhookWriteReply = z.output<
	typeof mailWebhookWriteReplySchema
>;
export const mailEventRecordSchema = preserveMailResponse(
	z.object({
		event_id: z.string(),
		event_type: z.string(),
		inbox_id: nullableString,
		message_id: nullableString,
		payload: appJsonValueSchema,
		created_at: z.string(),
	})
);
export type MailEventRecord = z.output<typeof mailEventRecordSchema>;
export const mailEventRecordsSchema = preserveMailResponse(
	z.array(mailEventRecordSchema)
);
export const mailSecretReplySchema = preserveMailResponse(
	z.object({ inboundSecret: nullableString, inbound_secret: nullableString })
);
export const mailHeadersReplySchema = preserveMailResponse(
	z.object({
		header_names: z.array(z.string()).nullish(),
		headers: z.array(z.string()).nullish(),
	})
);
export const mailAttachmentDownloadSchema = preserveMailResponse(
	z.object({ url: z.string() })
);
/** Decode a complete selected record/array from both native envelopes and legacy bare replies. */
export function mailEnvelopeSchema<T>(key: string, fields: z.ZodType<T>) {
	return z.preprocess((value) => {
		const record = mailJsonRecordSchema.safeParse(value);
		return record.success && key in record.data ? record.data[key] : value;
	}, fields);
}
