import { z } from "zod";
export interface MailProofCall {
	args?: unknown;
	method: string;
	path?: string;
	status: number;
}

export const mailProofContactSchema = z.object({
	displayName: z.string(),
	email: z.string(),
	id: z.string(),
});
export type MailProofContact = z.infer<typeof mailProofContactSchema>;
export const mailProofInboxSchema = z.object({
	address: z.string(),
	created_at: z.string(),
	id: z.string(),
	inbound_secret: z.string().optional(),
	name: z.string(),
	provider: z.enum(["webhook", "imap"]),
});
export type MailProofInbox = z.infer<typeof mailProofInboxSchema>;
export const mailProofMessageSchema = z.object({
	attachments: z.array(
		z.object({
			content_type: z.string(),
			filename: z.string(),
			id: z.string(),
			size: z.number(),
		})
	),
	bcc_addrs: z.array(z.string()),
	cc_addrs: z.array(z.string()),
	created_at: z.string(),
	direction: z.enum(["inbound", "outbound"]),
	from_addr: z.string(),
	id: z.string(),
	in_reply_to: z.string().optional(),
	inbox_id: z.string(),
	labels: z.array(z.string()),
	message_id: z.string(),
	preview: z.string(),
	read: z.boolean(),
	status: z.string(),
	subject: z.string(),
	text: z.string(),
	to_addrs: z.array(z.string()),
});
export type MailProofMessage = z.infer<typeof mailProofMessageSchema>;
export const mailProofDraftSchema = z.object({
	attachments: z.array(
		z.object({ filename: z.string(), id: z.string(), size: z.number() })
	),
	id: z.string(),
	status: z.string(),
	subject: z.string(),
	text: z.string().optional(),
	to_addrs: z.array(z.string()),
});
export type MailProofDraft = z.infer<typeof mailProofDraftSchema>;
export const mailProofWebhookSchema = z.object({
	enabled: z.boolean(),
	event_types: z.array(z.string()),
	header_names: z.array(z.string()),
	inbox_ids: z.array(z.string()),
	url: z.string(),
	webhook_id: z.string(),
});
export type MailProofWebhook = z.infer<typeof mailProofWebhookSchema>;
export const mailProofThreadSchema = z.object({
	id: z.string(),
	latest_message: mailProofMessageSchema.optional(),
	message_count: z.number(),
	participants: z.array(z.string()),
	preview: z.string(),
	subject: z.string(),
});
export type MailProofThread = z.infer<typeof mailProofThreadSchema>;

export interface MailProofState {
	calls: MailProofCall[];
	contacts: MailProofContact[];
	drafts: MailProofDraft[];
	inboxes: MailProofInbox[];
	messages: MailProofMessage[];
	webhooks: MailProofWebhook[];
}

export interface MailProofApi {
	calls: () => MailProofCall[];
	clearCalls: () => void;
	connected: () => boolean;
	failNext: (method: string, message: string) => void;
	mount: (input: { appHtml: string; emptyInboxes?: boolean }) => void;
	mountFormActionProof: (input: { actionUrl: string }) => void;
	state: () => MailProofState;
}
