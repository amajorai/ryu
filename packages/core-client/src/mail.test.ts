import { expect, it } from "bun:test";
import {
	appJsonValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";
import {
	type MailInboxRecord,
	mailDraftRecordSchema,
	mailEnvelopeSchema,
	mailEventRecordSchema,
	mailInboxRecordSchema,
	mailInboxRecordsSchema,
	mailJsonRecordSchema,
	mailMessageRecordSchema,
	mailStringRecordSchema,
	mailThreadRecordSchema,
	mailWebhookWriteReplySchema,
} from "./mail.ts";

it("validates complete native inbox/message projections without replacing JSON references", () => {
	const metadata = mailJsonRecordSchema.parse(
		JSON.parse('{"__proto__":{"future":[true,null]}}')
	);
	const inbox = {
		id: "i",
		name: "Inbox",
		address: "mail@example.test",
		provider: "webhook",
		created_at: "now",
		metadata,
	} satisfies MailInboxRecord;
	const rows = [inbox];
	expect(mailInboxRecordSchema.parse(inbox)).toBe(inbox);
	expect(mailInboxRecordSchema.parse(inbox).metadata).toBe(metadata);
	expect(mailInboxRecordsSchema.parse(rows)).toBe(rows);
	expect(
		mailEnvelopeSchema("inboxes", mailInboxRecordsSchema).parse({
			inboxes: rows,
		})
	).toBe(rows);
	expect(
		mailEnvelopeSchema("inboxes", mailInboxRecordsSchema).parse(rows)
	).toBe(rows);
	const attachment = {
		id: "hash",
		filename: "file",
		content_type: "text/plain",
		size: 12,
		inline: false,
	};
	const message = {
		id: "m",
		inbox_id: "i",
		direction: "future-direction",
		message_id: "<m@test>",
		from_addr: "a@test",
		to_addrs: ["b@test"],
		cc_addrs: [],
		bcc_addrs: [],
		subject: "Subject",
		created_at: "now",
		attachments: [attachment],
		future: metadata,
	};
	expect(mailMessageRecordSchema.parse(message)).toBe(message);
	expect(mailMessageRecordSchema.parse(message).attachments[0]).toBe(
		attachment
	);
	expect(
		mailMessageRecordSchema.safeParse({ ...message, to_addrs: [false] }).success
	).toBe(false);
	expect(
		mailMessageRecordSchema.safeParse({
			...message,
			attachments: [{ ...attachment, size: -1 }],
		}).success
	).toBe(false);
	expect(
		mailStringRecordSchema.safeParse(JSON.parse('{"__proto__":false}')).success
	).toBe(false);
});
it("accepts real draft attachment inputs and nullable body slots without fabricated ids or sizes", () => {
	const attachments = [
		{
			filename: "f",
			content: "YmFzZQ==",
			content_type: "text/plain",
			content_id: null,
			inline: false,
		},
	];
	const draft = {
		id: "d",
		inbox_id: "i",
		thread_id: null,
		client_id: null,
		to_addrs: [],
		cc_addrs: [],
		bcc_addrs: [],
		reply_to_addrs: [],
		subject: "Draft",
		text: null,
		html: null,
		headers: {},
		labels: [],
		attachments,
		send_at: null,
		status: "future-status",
		created_at: "now",
		updated_at: "later",
	};
	expect(mailDraftRecordSchema.parse(draft)).toBe(draft);
	expect(mailDraftRecordSchema.parse(draft).attachments).toBe(attachments);
	expect(
		mailDraftRecordSchema.safeParse({
			...draft,
			attachments: [{ filename: "f", content: 42 }],
		}).success
	).toBe(false);
	const legacy = {
		...draft,
		attachments: [
			{ id: "hash", filename: "f", content_type: "text/plain", size: 1 },
		],
	};
	expect(mailDraftRecordSchema.parse(legacy)).toBe(legacy);
});
it("retains native camelCase and legacy thread forms and bare webhook write receipts", () => {
	const thread = {
		inboxId: "i",
		threadId: "t",
		labels: [],
		senders: ["a@test"],
		recipients: ["b@test"],
		lastMessageId: "m",
		messageCount: 1,
		size: 42,
		subject: "Thread",
		preview: null,
		attachments: [],
		createdAt: "now",
		updatedAt: "later",
	};
	expect(mailThreadRecordSchema.parse(thread)).toBe(thread);
	const legacy = {
		id: "t",
		message_count: 1,
		participants: ["a@test"],
		subject: null,
	};
	expect(mailThreadRecordSchema.parse(legacy)).toBe(legacy);
	expect(
		mailThreadRecordSchema.safeParse({ ...thread, messageCount: "one" }).success
	).toBe(false);
	const webhook = {
		webhook_id: "w",
		url: "https://example.test",
		secret: null,
		enabled: true,
		event_types: [],
		inbox_ids: [],
		pod_ids: [],
		client_id: null,
		header_names: [],
		created_at: "now",
		updated_at: "later",
	};
	expect(mailWebhookWriteReplySchema.parse(webhook)).toBe(webhook);
	const wrapped = { secret: "new-secret", webhook };
	expect(mailWebhookWriteReplySchema.parse(wrapped)).toBe(wrapped);
});
it("validates required serde JSON payloads and own prototype entries without narrowing transport omission", () => {
	for (const payload of [
		null,
		true,
		42,
		"future",
		[1, null],
		JSON.parse('{"__proto__":{"future":true}}'),
	]) {
		const event = {
			event_id: "e",
			event_type: "future-event",
			inbox_id: null,
			message_id: null,
			payload,
			created_at: "now",
		};
		expect(mailEventRecordSchema.parse(event)).toBe(event);
	}
	expect(appJsonValueSchema.safeParse(undefined).success).toBe(false);
	expect(appResponseValueSchema.parse(undefined)).toBeUndefined();
	const invalid = JSON.parse('{"__proto__":null}');
	invalid.__proto__ = undefined;
	expect(appJsonValueSchema.safeParse(invalid).success).toBe(false);
});
