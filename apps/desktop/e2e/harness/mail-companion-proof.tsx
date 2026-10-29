import {
	ExtensionHost,
	shouldEnableCompanionFormEvents,
} from "@ryu/app-host/ExtensionHost";
import {
	capabilitiesFromGrants,
	type HostServices,
	type MailRequestPayload,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import type {
	MailProofApi,
	MailProofCall,
	MailProofContact,
	MailProofDraft,
	MailProofInbox,
	MailProofMessage,
	MailProofWebhook,
} from "./mail-companion-proof.types.ts";
import {
	type MailProofThread,
	mailProofContactSchema,
	mailProofDraftSchema,
	mailProofInboxSchema,
	mailProofMessageSchema,
	mailProofThreadSchema,
	mailProofWebhookSchema,
} from "./mail-companion-proof.types.ts";

const pluginId = "@ryu/mail";
const granted = capabilitiesFromGrants(["mail:crud"]);
const fixtureStorageKey = "ryu-mail-companion-proof-fixtures";

interface Failure {
	message: string;
	method: string;
}

interface MailFixtures {
	contacts: MailProofContact[];
	drafts: MailProofDraft[];
	inboxes: MailProofInbox[];
	messages: MailProofMessage[];
	threads: MailProofThread[];
	webhooks: MailProofWebhook[];
}

declare global {
	interface Window {
		__mailProof: MailProofApi;
	}
}

const calls: MailProofCall[] = [];
const failures: Failure[] = [];
let fixtures = makeFixtures();
let connected = false;
let root: Root | null = null;

function persistFixtures(): void {
	window.sessionStorage.setItem(fixtureStorageKey, JSON.stringify(fixtures));
}

const mailFixturesSchema = z.object({
	contacts: z.array(mailProofContactSchema),
	drafts: z.array(mailProofDraftSchema),
	inboxes: z.array(mailProofInboxSchema),
	messages: z.array(mailProofMessageSchema),
	threads: z.array(mailProofThreadSchema),
	webhooks: z.array(mailProofWebhookSchema),
});
function loadFixtures(emptyInboxes: boolean): MailFixtures {
	const saved = window.sessionStorage.getItem(fixtureStorageKey);
	if (saved) {
		return mailFixturesSchema.parse(JSON.parse(saved));
	}
	const initial = makeFixtures();
	if (emptyInboxes) {
		initial.inboxes = [];
		initial.messages = [];
		initial.drafts = [];
		initial.threads = [];
		initial.webhooks = [];
	}
	return initial;
}

function makeFixtures(): MailFixtures {
	const contacts: MailProofContact[] = [
		{
			displayName: "Avery Lane",
			email: "avery@example.test",
			id: "contact-avery",
		},
		{
			displayName: "Billing Desk",
			email: "billing@example.test",
			id: "contact-billing",
		},
		{
			displayName: "Ryu Operations",
			email: "ops@example.test",
			id: "contact-ops",
		},
	];
	const inboxes: MailProofInbox[] = [
		{
			address: "support@agent.test",
			created_at: "2026-09-01T10:00:00.000Z",
			id: "inbox-support",
			inbound_secret: "fixture-secret-support",
			name: "Support",
			provider: "webhook",
		},
		{
			address: "billing@agent.test",
			created_at: "2026-09-02T10:00:00.000Z",
			id: "inbox-billing",
			inbound_secret: "fixture-secret-billing",
			name: "Billing",
			provider: "imap",
		},
	];
	const messages: MailProofMessage[] = [
		{
			attachments: [
				{
					content_type: "text/plain",
					filename: "ticket-details.txt",
					id: "attachment-ticket",
					size: 1472,
				},
			],
			bcc_addrs: [],
			cc_addrs: ["ops@example.test"],
			created_at: "2026-09-27T09:30:00.000Z",
			direction: "inbound",
			from_addr: contacts[0]?.email ?? "",
			id: "message-ticket-42",
			inbox_id: "inbox-support",
			labels: ["support", "priority"],
			message_id: "<ticket-42@example.test>",
			preview: "The local fixture needs help with a sign-in issue.",
			read: false,
			status: "received",
			subject: "Ticket 42: sign-in help",
			text: "Hello, I cannot sign in to my local test account.",
			to_addrs: ["support@agent.test"],
		},
		{
			attachments: [],
			bcc_addrs: [],
			cc_addrs: [],
			created_at: "2026-09-26T14:15:00.000Z",
			direction: "inbound",
			from_addr: contacts[1]?.email ?? "",
			id: "message-invoice",
			inbox_id: "inbox-support",
			labels: ["billing"],
			message_id: "<invoice@example.test>",
			preview: "A fixture invoice is ready to review.",
			read: true,
			status: "received",
			subject: "Invoice question",
			text: "Please confirm the local invoice total.",
			to_addrs: ["support@agent.test"],
		},
		{
			attachments: [],
			bcc_addrs: [],
			cc_addrs: [],
			created_at: "2026-09-25T08:45:00.000Z",
			direction: "outbound",
			from_addr: "support@agent.test",
			id: "message-outbound",
			inbox_id: "inbox-support",
			labels: [],
			message_id: "<sent-before@example.test>",
			preview: "A prior locally stored reply.",
			read: true,
			status: "sent",
			subject: "Earlier response",
			text: "A previous response in the local fixture.",
			to_addrs: [contacts[0]?.email ?? ""],
		},
		{
			attachments: [],
			bcc_addrs: [],
			cc_addrs: [],
			created_at: "2026-09-24T11:00:00.000Z",
			direction: "inbound",
			from_addr: contacts[1]?.email ?? "",
			id: "message-billing-inbox",
			inbox_id: "inbox-billing",
			labels: [],
			message_id: "<billing-inbox@example.test>",
			preview: "A message for the billing inbox.",
			read: false,
			status: "received",
			subject: "Billing inbox fixture",
			text: "This message belongs to the other inbox.",
			to_addrs: ["billing@agent.test"],
		},
	];
	const drafts: MailProofDraft[] = [
		{
			attachments: [],
			id: "draft-follow-up",
			status: "draft",
			subject: "Fixture follow-up",
			text: "The saved local draft body.",
			to_addrs: [contacts[0]?.email ?? ""],
		},
	];
	return {
		contacts,
		drafts,
		inboxes,
		messages,
		threads: [
			{
				id: "thread-ticket-42",
				latest_message: messages[0],
				message_count: 2,
				participants: ["support@agent.test", contacts[0]?.email ?? ""],
				preview: "The sign-in issue is fixed in the fixture thread.",
				subject: "Ticket 42 thread",
			},
		],
		webhooks: [
			{
				enabled: true,
				event_types: ["message.received"],
				header_names: ["x-ryu-signature"],
				inbox_ids: ["inbox-support"],
				url: "https://hooks.example.test/mail-events",
				webhook_id: "webhook-fixture",
			},
		],
	};
}

function copy<T>(value: T): T {
	return structuredClone(value);
}

function record<Args>(method: string, args?: Args, path?: string): void {
	calls.push({
		...(args === undefined ? undefined : { args: copy(args) }),
		method,
		...(path ? { path } : undefined),
		status: 0,
	});
}

function recentCall(method: string, path?: string): MailProofCall {
	const call = [...calls].reverse().find((item) => {
		return item.method === method && (path === undefined || item.path === path);
	});
	if (!call) {
		throw new Error(
			`Local Mail fixture did not record ${method} ${path ?? ""}.`
		);
	}
	return call;
}

function takeFailure(method: string): void {
	const failureIndex = failures.findIndex(
		(failure) => failure.method === method
	);
	if (failureIndex === -1) {
		return;
	}
	const [failure] = failures.splice(failureIndex, 1);
	recentCall(method).status = 503;
	throw new Error(failure?.message ?? "The local Mail fixture failed.");
}

function mailServices(): HostServices {
	return {
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
		mailCreate: async (input) => {
			record("mail.create", input);
			takeFailure("mail.create");
			const created: MailProofInbox = {
				address: input.address,
				created_at: "2026-09-28T00:00:00.000Z",
				id: `inbox-created-${fixtures.inboxes.length + 1}`,
				inbound_secret: "fixture-secret-new-inbox",
				name: input.name,
				provider: "webhook",
			};
			fixtures.inboxes.push(created);
			persistFixtures();
			recentCall("mail.create").status = 201;
			return copy(created);
		},
		mailDelete: async ({ id }) => {
			record("mail.delete", { id });
			takeFailure("mail.delete");
			fixtures.inboxes = fixtures.inboxes.filter((inbox) => inbox.id !== id);
			fixtures.messages = fixtures.messages.filter(
				(message) => message.inbox_id !== id
			);
			persistFixtures();
			recentCall("mail.delete").status = 204;
		},
		mailInboundUrl: async ({ inboxId }) => {
			record("mail.inboundUrl", { inboxId });
			takeFailure("mail.inboundUrl");
			recentCall("mail.inboundUrl").status = 200;
			return { url: `https://mail.example.test/api/mail/inbound/${inboxId}` };
		},
		mailList: async () => {
			record("mail.list");
			takeFailure("mail.list");
			recentCall("mail.list").status = 200;
			return copy(fixtures.inboxes);
		},
		mailMessages: async ({ inboxId }) => {
			record("mail.messages", { inboxId });
			takeFailure("mail.messages");
			recentCall("mail.messages").status = 200;
			return copy(
				fixtures.messages.filter((message) => message.inbox_id === inboxId)
			);
		},
		mailRequest: async (input: MailRequestPayload) => {
			const method = input.method ?? "GET";
			const key = `mail.request:${method}:${input.path}`;
			record(key, input.body, input.path);
			takeFailure(key);
			const call = recentCall(key, input.path);
			const result = handleMailRequest(method, input.path, input.body);
			call.status = result.status;
			if (result.status >= 400) {
				throw new Error(
					result.message ?? "The local Mail fixture rejected the request."
				);
			}
			return appResponseValueSchema.parse(copy(result.value));
		},
		mailRotateSecret: async ({ id }) => {
			record("mail.rotateSecret", { id });
			takeFailure("mail.rotateSecret");
			const inbox = fixtures.inboxes.find((item) => item.id === id);
			if (!inbox) {
				recentCall("mail.rotateSecret").status = 404;
				throw new Error("Inbox was not found.");
			}
			inbox.inbound_secret = `fixture-secret-rotated-${id}`;
			persistFixtures();
			recentCall("mail.rotateSecret").status = 200;
			return inbox.inbound_secret;
		},
		mailSend: async (input) => {
			record("mail.send", input);
			takeFailure("mail.send");
			const inbox = fixtures.inboxes.find((item) => item.id === input.inboxId);
			if (!inbox) {
				recentCall("mail.send").status = 404;
				throw new Error("Inbox was not found.");
			}
			const message = sentMessage(
				input.inboxId,
				inbox.address,
				input.to,
				input.subject,
				input.text ?? input.html ?? "",
				input.inReplyTo
			);
			fixtures.messages.push(message);
			persistFixtures();
			recentCall("mail.send").status = 202;
			return copy(message);
		},
	};
}

function handleMailRequest(
	method: string,
	path: string,
	body: MailRequestPayload["body"]
) {
	if (method === "GET" && path === "/api/mail/webhooks") {
		return { status: 200, value: { webhooks: fixtures.webhooks } };
	}
	if (method === "POST" && path === "/api/mail/webhooks") {
		const input = z
			.object({
				event_types: z.array(z.string()).optional(),
				inbox_ids: z.array(z.string()).optional(),
				url: z.string().optional(),
			})
			.parse(body);
		if (!input.url?.startsWith("https://")) {
			return {
				message: "Webhook endpoint must use HTTPS.",
				status: 422,
				value: { error: { message: "Webhook endpoint must use HTTPS." } },
			};
		}
		const webhook: MailProofWebhook = {
			enabled: true,
			event_types: input.event_types ?? [],
			header_names: ["x-ryu-signature"],
			inbox_ids: input.inbox_ids ?? [],
			url: input.url,
			webhook_id: `webhook-${fixtures.webhooks.length + 1}`,
		};
		fixtures.webhooks.push(webhook);
		persistFixtures();
		return {
			status: 201,
			value: { webhook, signing_secret: "local-only-secret" },
		};
	}
	if (method === "GET" && path === "/api/mail/inboxes/inbox-support/threads") {
		return { status: 200, value: { threads: fixtures.threads } };
	}
	if (
		method === "GET" &&
		path.startsWith("/api/mail/inboxes/") &&
		path.endsWith("/drafts")
	) {
		return { status: 200, value: { drafts: fixtures.drafts } };
	}
	const draftCreateMatch = path.match(
		/^\/api\/mail\/inboxes\/([^/]+)\/drafts$/
	);
	if (method === "POST" && draftCreateMatch) {
		const input = z
			.object({
				attachments: z
					.array(z.object({ filename: z.string().optional() }))
					.optional(),
				sendAt: z.string().optional(),
				send_at: z.string().optional(),
				subject: z.string().optional(),
				text: z.string().optional(),
				to: z.array(z.string()).optional(),
			})
			.parse(body);
		const draft: MailProofDraft = {
			attachments: Array.isArray(input.attachments)
				? input.attachments.map((item, index) => ({
						filename: String(item.filename ?? "attachment"),
						id: `draft-attachment-${index + 1}`,
						size: 0,
					}))
				: [],
			id: `draft-${fixtures.drafts.length + 1}`,
			status: input.sendAt || input.send_at ? "scheduled" : "draft",
			subject: String(input.subject ?? ""),
			text: isNativeText(input.text) ? input.text : undefined,
			to_addrs: Array.isArray(input.to) ? input.to.map(String) : [],
		};
		fixtures.drafts.push(draft);
		persistFixtures();
		return { status: 201, value: draft };
	}
	const draftSendMatch = path.match(
		/^\/api\/mail\/inboxes\/([^/]+)\/drafts\/([^/]+)\/send$/
	);
	if (method === "POST" && draftSendMatch) {
		const [, inboxId, draftId] = draftSendMatch;
		const draft = fixtures.drafts.find((item) => item.id === draftId);
		const inbox = fixtures.inboxes.find((item) => item.id === inboxId);
		if (!(draft && inbox)) {
			return {
				message: "Draft or inbox was not found.",
				status: 404,
				value: null,
			};
		}
		fixtures.drafts = fixtures.drafts.filter((item) => item.id !== draftId);
		const message = sentMessage(
			inboxId,
			inbox.address,
			draft.to_addrs,
			draft.subject,
			draft.text ?? ""
		);
		fixtures.messages.push(message);
		persistFixtures();
		return { status: 202, value: message };
	}
	const attachmentMatch = path.match(/^\/api\/mail\/attachments\/([^/]+)$/);
	if (method === "GET" && attachmentMatch) {
		return {
			status: 200,
			value: {
				url: `${window.location.origin}/__mail-proof/download/${attachmentMatch[1]}`,
			},
		};
	}
	return {
		message: `No local Mail fixture route for ${method} ${path}.`,
		status: 404,
		value: {
			error: { message: `No local Mail fixture route for ${method} ${path}.` },
		},
	};
}

function sentMessage(
	inboxId: string,
	from: string,
	to: string[],
	subject: string,
	text: string,
	inReplyTo?: string
): MailProofMessage {
	return {
		attachments: [],
		bcc_addrs: [],
		cc_addrs: [],
		created_at: "2026-09-28T00:00:00.000Z",
		direction: "outbound",
		from_addr: from,
		id: `message-sent-${fixtures.messages.length + 1}`,
		inbox_id: inboxId,
		labels: [],
		message_id: `<local-send-${fixtures.messages.length + 1}@example.test>`,
		preview: text.slice(0, 100),
		read: true,
		status: "sent",
		subject,
		text,
		to_addrs: to,
		...(inReplyTo ? { in_reply_to: inReplyTo } : undefined),
	};
}

function mount(input: { appHtml: string; emptyInboxes?: boolean }): void {
	if (!input.appHtml) {
		throw new Error("Mail proof requires the compiled single-file Companion.");
	}
	calls.length = 0;
	fixtures = loadFixtures(input.emptyInboxes === true);
	persistFixtures();
	connected = false;
	const nonce = crypto.randomUUID();
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, pluginId);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Mail proof is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(ExtensionHost, {
			// This harness mounts the compiled first-party Path B bundle. Production
			// PluginHostPanel derives the same opt-in from Core's `first_party` field.
			allowForms: shouldEnableCompanionFormEvents(true, true),
			granted,
			nonce,
			onConnected: () => {
				connected = true;
			},
			services: mailServices(),
			srcdoc,
			title: "Mail proof",
		})
	);
}

function mountFormActionProof(input: { actionUrl: string }): void {
	connected = false;
	const appHtml = `<!doctype html><html lang="en"><body><main><h1>Form policy proof</h1><form action="${input.actionUrl}" method="post"><input name="local-fixture" value="never-submit"><button type="submit">Send probe</button></form></main></body></html>`;
	const nonce = crypto.randomUUID();
	const srcdoc = htmlCompanionSrcdoc(nonce, appHtml, pluginId);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Mail proof is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(ExtensionHost, {
			allowForms: shouldEnableCompanionFormEvents(true, true),
			granted,
			nonce,
			onConnected: () => {
				connected = true;
			},
			services: mailServices(),
			srcdoc,
			title: "Mail form action proof",
		})
	);
}

window.__mailProof = {
	calls: () => copy(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	failNext: (method, message) => {
		failures.push({ method, message });
	},
	mountFormActionProof,
	mount,
	state: () => copy({ ...fixtures, calls }),
};

document.body.dataset.harnessReady = "1";
