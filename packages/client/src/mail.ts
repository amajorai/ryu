import { z } from "zod";
import { assertSafeRequestPath } from "./path-id.ts";
import {
	buildHeaders,
	buildUrl as buildRequestUrl,
	request as sendRequest,
} from "./request.ts";
import type { RyuClientOptions } from "./types.ts";
import { wireJsonRecordSchema, wireJsonSchema } from "./wire-json.ts";

export type MailInboxProvider = "webhook" | "imap";

/** How a hosted Mail inbox was created. Later servers may add values. */
export type MailInboxCreatedVia =
	| "session"
	| "api_key"
	| "oauth"
	| "gateway_key"
	| (string & {});

/** The credential that created a hosted Mail inbox (ids only, never a secret). */
export interface MailInboxCreatedWith {
	/** The Ryu API key's id (never the key), when `via` is `api_key`. */
	apiKeyId: string | null;
	/** The node gateway credential's id, when `via` is `gateway_key`. */
	gatewayCredentialId: string | null;
	/** The OAuth client id of the hosted MCP app, when `via` is `oauth`. */
	oauthClientId: string | null;
	/** The service account an API key acted as, or null. */
	serviceAccountId: string | null;
	/** How the inbox was created: the console, a Ryu API key, a hosted MCP app, or a node. */
	via: MailInboxCreatedVia;
}

export interface MailInbox {
	/** The inbox's email address. */
	address: string;
	/** The agent that owns this inbox, when it is an agent's own inbox. */
	agentId: string | null;
	/** Your own id for the inbox, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/**
	 * Hosted Mail only: which credential created the inbox, or null for an inbox
	 * created before this was recorded. Returned on every inbox reply (reads,
	 * lists, creates, agent-inbox replays, updates and address changes) only to
	 * callers who may manage Mail: a Ryu API key with mail:manage whose principal
	 * holds mail.manage, a member with mail.manage, or the owner of a personal
	 * account. Omitted for mail:read keys, read-only members, hosted MCP apps and
	 * node gateway keys.
	 *
	 * Self-hosted Mail never sends it, and a value of an unexpected shape is left out.
	 */
	createdWith?: MailInboxCreatedWith | null;
	/** A note about the inbox. */
	description?: string | null;
	/** The inbox id. */
	id: string;
	/** Your own key-value data. */
	metadata: z.infer<typeof wireJsonRecordSchema>;
	/** Display name, also the sender name. */
	name: string;
	/** The pod the inbox is in, or null. */
	podId: string | null;
	/** How mail arrives: a signed relay webhook or IMAP. */
	provider: MailInboxProvider;
	/** ISO 8601 timestamp. */
	updatedAt: string;
	/**
	 * Whether a `webhookUrl` is set.
	 *
	 * Omitted by servers that do not report it.
	 */
	webhookConfigured?: boolean;
	/**
	 * Returned once, by the call that minted it. Reads never include it.
	 *
	 * The inbox webhook's signing secret (`whsec_...`), minted by the `createInbox` or `updateInbox` call that sets a URL on an inbox without a secret or passes `rotateWebhookSecret: true`. Store it when it is returned.
	 */
	webhookSecret?: string;
	/**
	 * Whether `webhookUrl` deliveries are signed; false for an inbox webhook set
	 * before signing until its secret is rotated.
	 *
	 * Setting its URL again also turns signing on. Omitted by servers that do not report it.
	 */
	webhookSigned?: boolean;
	/**
	 * Null unless the caller may manage Mail: hosted Mail returns it to a Ryu API
	 * key only with mail:manage.
	 *
	 * Where `message.received` is POSTed. Omitted by servers that do not report it.
	 */
	webhookUrl?: string | null;
}

export interface MailAttachment {
	/** The Content-ID an inline part is referenced by (`cid:`), or null. */
	contentId: string | null;
	/** The MIME type, or null when unknown. */
	contentType: string | null;
	/** The file name, or null when it has none. */
	filename: string | null;
	/** The id to download it with (`GET /api/mail/attachments/{id}`). */
	id: string | null;
	/** Whether it is an inline part. */
	inline: boolean;
	/** Size in bytes. */
	size: number;
}

export interface MailMessage {
	/** Attachment metadata. */
	attachments: MailAttachment[];
	/** Blind-copy recipients (outbound only). */
	bcc: string[];
	/** Copy recipients. */
	cc: string[];
	/** The `clientId` it was sent with, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** `inbound` or `outbound`. */
	direction: "inbound" | "outbound" | string;
	/** Why a send failed, or null. */
	error: string | null;
	/** The HTML body Mail extracted from an inbound message. */
	extractedHtml: string | null;
	/** The plain-text body Mail extracted from an inbound message. */
	extractedText: string | null;
	/** The sender address. */
	from: string | null;
	/** MIME headers, by name. */
	headers: Record<string, string>;
	/** The HTML body. */
	html: string | null;
	/** The message id Mail assigned. */
	id: string;
	/** The inbox it belongs to. */
	inboxId: string;
	/** The `Message-ID` it answers, or null. */
	inReplyTo: string | null;
	/** Labels, such as `sent` or your own. */
	labels: string[];
	/** The RFC 5322 `Message-ID` header. */
	messageId: string | null;
	/** When a tracked message was first opened, or null. */
	openedAt: string | null;
	/** The start of the text body, whitespace collapsed. */
	preview: string | null;
	/** Whether it is marked read. */
	read: boolean;
	/** The `References` Message-IDs, oldest first. */
	references: string[];
	/** The Reply-To address, or null. */
	replyTo: string | null;
	sesMessageId: string | null;
	/**
	 * Delivery state: `received` for inbound mail; outbound moves through
	 * `queued`, `sent`, `delivered` and `opened`, or ends `bounced`, `complained`
	 * or `failed` (hosted Mail).
	 */
	status: string;
	/** The subject line. */
	subject: string | null;
	/** The plain-text body. */
	text: string | null;
	/** The conversation it belongs to. */
	threadId: string | null;
	/** Recipients. */
	to: string[];
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface MailAttachmentInput {
	/** Base64-encoded content. */
	content?: string;
	/** Base64-encoded content, under another name; `content` wins when both are set. */
	contentBase64?: string;
	/** Content-ID for an inline part, referenced as `cid:` in HTML. */
	contentId?: string;
	/** MIME type, such as `application/pdf`. */
	contentType?: string;
	/** The file name recipients see. */
	filename: string;
	/** Send as an inline part instead of an attachment. */
	inline?: boolean;
	/** Public HTTPS URL to fetch instead of `content`. */
	url?: string;
}

export interface MailSendInput {
	/** Files to attach, each with `content` or `url`. */
	attachments?: MailAttachmentInput[];
	/** Blind-copy recipients. Each entry is an address or `Name <address>`. */
	bcc?: string[];
	/** Copy recipients. Each entry is an address or `Name <address>`. */
	cc?: string[];
	/**
	 * Your own id for this message. A second send from the same inbox with the
	 * same `clientId` returns the stored message instead of sending again; it is
	 * also echoed on the message.
	 */
	clientId?: string;
	/**
	 * Extra MIME headers, by name. Hosted Mail accepts at most 64 and refuses
	 * names it sets itself; a refused name answers 400.
	 */
	headers?: Record<string, string>;
	/**
	 * HTML body. Send `text`, `html` or both (or only attachments); text and HTML
	 * together may be at most 4 MiB on hosted Mail.
	 */
	html?: string;
	/** The RFC 5322 `Message-ID` this message answers, for threading. */
	inReplyTo?: string;
	/**
	 * Labels stored on the sent message (hosted Mail: at most 64, each at most
	 * 128 characters).
	 */
	labels?: string[];
	/**
	 * Space-separated Message-IDs of the conversation, oldest first, for
	 * threading.
	 */
	references?: string[] | string;
	/**
	 * Addresses replies should go to. Each entry is an address or `Name
	 * <address>`.
	 */
	replyTo?: string[];
	/** Subject line (hosted Mail: at most 998 bytes). */
	subject: string;
	/** Plain-text body. */
	text?: string;
	/** Recipients; at least one. Each entry is an address or `Name <address>`. */
	to: string[];
	/**
	 * Add an open-tracking pixel to the HTML body, so a `message.opened` event
	 * fires on the first open. Ignored without `html`, and on a deployment that
	 * has not enabled open tracking.
	 */
	trackOpens?: boolean;
}

/**
 * What `forward()` takes: a send body whose `subject` is optional, since both
 * Mail servers default it to `Fwd: <original subject>` and default the body
 * to the forwarded message.
 */
export type MailForwardInput = Omit<
	MailSendInput,
	"html" | "subject" | "text"
> & {
	/** HTML body. Defaults to the original message's HTML. */
	html?: string;
	/** Subject line. Defaults to the original's, with `Fwd: ` added. */
	subject?: string;
	/** Plain-text body. Defaults to the original message's text. */
	text?: string;
};

export interface MailDraft {
	/** Attachment metadata. */
	attachments: MailAttachment[];
	/** Blind-copy recipients. */
	bcc: string[];
	/** Copy recipients. */
	cc: string[];
	/** Your own id for the draft, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** Extra headers sent with the message. */
	headers: Record<string, string>;
	/** The HTML body; null when there is none. */
	html: string | null;
	/** The draft id. */
	id: string;
	/** The inbox the draft sends from. */
	inboxId: string;
	/** Labels on the draft. */
	labels: string[];
	/** Reply-To addresses. */
	replyTo: string[];
	/** When a scheduled draft is sent; null when it is not scheduled. */
	sendAt: string | null;
	/**
	 * `draft`, `scheduled`, `sending`, `sent`, `failed` or `unresolved`. An
	 * `unresolved` draft may already have been sent; it is sent again only with
	 * `confirmNotSent: true`.
	 */
	status:
		| "draft"
		| "scheduled"
		| "sending"
		| "sent"
		| "cancelled"
		| "unresolved"
		| string;
	/** The subject. */
	subject: string;
	/** The plain-text body; null when there is none. */
	text: string | null;
	/** The thread it replies in; null for a new conversation. */
	threadId: string | null;
	/** Recipients. */
	to: string[];
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

/**
 * How a managed webhook signs deliveries. `standard` webhooks sign the
 * `webhook-*` and `svix-*` headers with Standard Webhooks. `legacy` webhooks
 * (created before Standard Webhooks signing) keep a raw-key `svix-signature`
 * until their secret is rotated, which moves them to `standard`.
 */
export type MailWebhookSignatureScheme = "standard" | "legacy";

export interface MailWebhook {
	/** Your own id for the webhook, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** Whether deliveries are sent; `false` while paused. */
	enabled: boolean;
	/** The event types delivered. */
	eventTypes: string[];
	/** Names of the custom headers; values are write-only. */
	headers: string[];
	/** The webhook id. */
	id: string;
	/** Deliver only events of these inboxes; empty for no inbox filter. */
	inboxIds: string[];
	/** Deliver only events of inboxes in these pods; empty for no pod filter. */
	podIds: string[];
	/**
	 * `standard`: Standard Webhooks signatures. `legacy`: a webhook created
	 * before them, whose `svix-signature` is keyed with the UTF-8 bytes of the
	 * whole secret.
	 *
	 * Omitted by servers that predate Standard Webhooks signing.
	 */
	signatureScheme?: MailWebhookSignatureScheme;
	/** ISO 8601 timestamp. */
	updatedAt: string;
	/** The HTTPS endpoint events are POSTed to. */
	url: string;
}

/** A managed webhook and, only when one was just minted, its signing secret. */
export interface MailWebhookWithSecret {
	/**
	 * The `whsec_` signing secret, returned only when it is minted or rotated.
	 */
	secret: string | null;
	/** The webhook (a MailWebhook). */
	webhook: MailWebhook;
}

export interface MailWebhookCreateInput {
	/**
	 * Your own id for the webhook. Creating again with the same `clientId`
	 * returns the existing webhook.
	 */
	clientId?: string;
	enabled?: boolean;
	/**
	 * Events to deliver, such as `message.received`, `message.sent`,
	 * `message.delivered`, `message.bounced`, `message.complained`,
	 * `message.rejected` or `message.opened`. Omit for the standard set; an empty
	 * list answers 400.
	 */
	eventTypes?: string[];
	/**
	 * Custom headers sent with every delivery. Values are write-only, and names
	 * Mail sets itself (`webhook-*`, `svix-*`, `host`, `cookie`,
	 * `content-length`) are refused.
	 */
	headers?: Record<string, string>;
	/** Deliver only events of these inboxes. */
	inboxIds?: string[];
	/** Deliver only events of inboxes in these pods. */
	podIds?: string[];
	/**
	 * Public HTTPS endpoint. Loopback, private, link-local and metadata targets
	 * are refused.
	 */
	url: string;
}

export interface MailEvent {
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** The event's details; the members depend on `eventType`. */
	data: z.infer<typeof wireJsonRecordSchema>;
	/** The event id; a webhook delivery carries the same id. */
	eventId: string;
	/** What happened, such as `message.received` or `message.delivered`. */
	eventType: string;
	/** The inbox the event concerns; null when none. */
	inboxId: string | null;
	/** The message the event concerns; null when none. */
	messageId: string | null;
}

/** A one-use hosted Mail realtime ticket (`POST /api/mail/realtime/tickets`). */
export interface MailRealtimeTicket {
	/** ISO 8601 timestamp. */
	expiresAt: string;
	/** Seconds until the ticket expires unused. */
	expiresIn: number;
	/**
	 * The WebSocket path to open, relative to the Mail origin.
	 *
	 * For example `/api/mail/realtime`.
	 */
	path: string;
	/**
	 * The WebSocket subprotocols to offer, in order: `ryu-mail.v1` and
	 * `ryu-ticket.<ticket>`.
	 *
	 * Pass them as the `Sec-WebSocket-Protocol` list.
	 */
	protocols: string[];
	/** The single-use ticket; it is spent by the first upgrade that offers it. */
	ticket: string;
	/** The absolute `wss://` (or `ws://`) socket URL; it carries no credential. */
	url: string;
}

/**
 * The part of a socket `connectRealtimeWithTicket` uses. The global
 * `WebSocket` and the `ws` package's class both satisfy it.
 */
export interface MailWebSocketLike {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void
	): void;
	addEventListener(type: "open", listener: () => void): void;
	close(code?: number, reason?: string): void;
	send(data: string): void;
}

/**
 * A WebSocket constructor for runtimes without a global `WebSocket` (Node
 * before 22): for example the `ws` package's default export, passed as is.
 */
export type MailWebSocketConstructor = new (
	url: string,
	protocols?: string | string[]
) => MailWebSocketLike;

export interface MailThread {
	/** The thread id. */
	id: string;
	/** The newest message of the thread (a MailMessage), or null. */
	latestMessage: MailMessage | null;
	/** How many messages the thread holds. */
	messageCount: number;
	/** Addresses that sent or received mail in the thread. */
	participants: string[];
	/** The thread's subject; null when it has none. */
	subject: string | null;
}

export interface MailPod {
	/** Your own id for the pod, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** The pod id. */
	id: string;
	/** The pod's name. */
	name: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

/** One DNS record to publish for a custom domain. */
export interface MailDnsRecord {
	/** The record's host name. */
	name: string;
	/** The MX priority, for MX records. */
	priority?: number;
	/**
	 * What the record is for: `dkim`, `inbound` (MX) or `spf`.
	 *
	 * Omitted by servers that do not report it.
	 */
	purpose?: "dkim" | "inbound" | "spf" | string;
	/**
	 * Whether the domain needs the record to verify.
	 *
	 * The DKIM records. Omitted by servers that do not report it.
	 */
	required?: boolean;
	/** The suggested TTL, in seconds. */
	ttl?: number;
	/** The record type, such as `TXT`, `CNAME` or `MX`. */
	type: "CNAME" | "MX" | "TXT" | string;
	/** The record's value. */
	value: string;
}

export type MailDomainStatus = "pending" | "verified" | "failed";

export interface MailDomain {
	/** Your own id for the domain, or null. */
	clientId: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** The domain mail is sent from. */
	domain: string;
	/** The domain id. */
	id: string;
	/**
	 * When the DNS records were last checked; null before the first check.
	 *
	 * Omitted by servers that do not report it.
	 */
	lastCheckedAt?: string | null;
	/** The pod whose inboxes may use the domain; null for every inbox. */
	podId: string | null;
	/**
	 * The DNS records to publish.
	 *
	 * Publish them before calling `verifyDomain`.
	 */
	records: MailDnsRecord[];
	/** `pending`, `verified` or `failed`. */
	status: MailDomainStatus | string;
	/** Whether addresses on subdomains of `domain` are allowed. */
	subdomainsEnabled: boolean;
	/** Whether open tracking is allowed for mail sent from the domain. */
	trackingEnabled: boolean;
	/** ISO 8601 timestamp. */
	updatedAt: string;
	/**
	 * Why the last verification failed; null otherwise.
	 *
	 * The reason is in caller-safe words. The domain stays `pending`; call `verifyDomain` again later. Omitted by servers that do not report it.
	 */
	verificationError?: string | null;
	/**
	 * When the domain was verified; null until then.
	 *
	 * Omitted by servers that do not report it.
	 */
	verifiedAt?: string | null;
}

export interface MailListEntry {
	/** ISO 8601 timestamp. Hosted Mail leaves it out of add and read answers. */
	createdAt: string;
	/** The address or domain. */
	entry: string;
	/** `email` or `domain`. */
	entryType: "email" | "domain" | string;
	/** The entry id. */
	id: string;
	/** Why the entry exists; null when none was given. */
	reason: string | null;
}

export interface MailWebhookDelivery {
	/** How many attempts were made. */
	attempts: number;
	/** When an attempt succeeded; null until then. */
	deliveredAt: string | null;
	/** The event delivered. */
	eventId: string;
	/** The delivery id. */
	id: string;
	/** Why the last attempt failed; null when none failed. */
	lastError: string | null;
	/** `pending`, `retrying`, `delivered` or `failed` (no attempts left). */
	status: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface MailStatus {
	/** The Mail API version. */
	apiVersion: string;
	/** Whether Mail is configured on this deployment. */
	configured: boolean;
	/** The domain hosted inboxes use; null when unset. */
	domain: string | null;
	/** `managed`: Ryu's domain. `byo`: your own domain. */
	domainMode: "byo" | "managed" | string;
	/** How inbound mail arrives: `sns`, `webhook` or `imap`. */
	inbound: "webhook" | "imap" | "sns" | string;
	/** How many inboxes exist, where the deployment reports it. */
	inboxCount: number;
	/** Whether a sending transport is configured. */
	sendConfigured: boolean;
}

/**
 * Why an address cannot be claimed (hosted Agent Inboxes). Current servers
 * answer `address_unavailable` for a taken, held, or retired address;
 * `taken` and `held` come only from older servers.
 */
export type MailAddressUnavailableReason =
	| "address_unavailable"
	| "blocked"
	| "held"
	| "invalid"
	| "reserved"
	| "taken";

/** `GET /api/mail/addresses/check` — whether an address can be claimed. */
export interface MailAddressCheck {
	/** The full address checked; null when the requested name is not valid. */
	address: string | null;
	/** Whether the address can be claimed now. */
	available: boolean;
	/** Why it cannot be claimed, in words. Omitted by older servers. */
	message?: string;
	/**
	 * Why it cannot: `blocked`, `held` (recently released and not yet claimable),
	 * `invalid`, `reserved` or `taken`; null when available.
	 */
	reason: MailAddressUnavailableReason | null;
	/**
	 * Up to three similar addresses that are available.
	 *
	 * Full addresses.
	 */
	suggestions: string[];
}

/** Who may claim agent addresses on the organization mailbox. */
export type MailAliasClaimPolicy = "agents" | "approval" | "admins_only";

/** The owner's one permanent mailbox (`GET /api/mail/mailbox`). */
export interface MailMailbox {
	address: string;
	aliasClaimPolicy: MailAliasClaimPolicy;
	/** The host agent addresses live on (`<label>.mail.<base>`), or null until chosen. */
	aliasHost: string | null;
	brandingRemoved: boolean;
	createdAt: string;
	enabled: boolean;
	handle: string;
	id: string;
	lifecycleState: "active" | "grace" | "deactivated";
	name: string;
	primaryLockedAt: string;
}

/** `GET /api/mail/mailbox`: the mailbox, or the legacy inboxes to adopt one from. */
export interface MailMailboxState {
	aliasHostsEnabled: boolean;
	mailbox: MailMailbox | null;
	selection: {
		candidates: { address: string; inboxId: string; name: string }[];
		required: boolean;
	};
}

/** An agent's permanent address on the organization mailbox. */
export interface MailAlias {
	address: string;
	agentId: string;
	claimedAt: string;
	claimedVia: "agent_tool" | "dashboard" | "desktop" | "migration";
	displayName: string;
	domainId: string | null;
	host: string;
	id: string;
	kind: "alias" | "legacy";
	localPart: string;
	nodeId: string | null;
	pendingExpiresAt: string | null;
	/** Until when a revoke can be undone for the same agent. */
	reinstatableUntil: string | null;
	revokedAt: string | null;
	revokeReason: string | null;
	status: "pending" | "active" | "revoked";
}

/** Why a mailbox handle or agent address cannot be claimed. */
export type MailAliasUnavailableReason =
	| "address_unavailable"
	| "admin_only"
	| "blocked"
	| "invalid"
	| "reserved";

/** Whether a mailbox handle or agent address can be claimed. */
export interface MailAliasAvailability {
	address: string;
	available: boolean;
	message?: string;
	reason?: MailAliasUnavailableReason;
	/** Available alternatives (full addresses). */
	suggestions: string[];
}

/** `GET /api/mail/mailbox/check`: the handle, its address, and its alias host. */
export interface MailMailboxHandleCheck extends MailAliasAvailability {
	aliasHost: string | null;
	handle: string;
}

/** `GET /api/mail/aliases`: one page of aliases with the owner's usage. */
export interface MailAliasPage {
	aliases: MailAlias[];
	nextCursor: string | null;
	usage: { limit: number | null; used: number };
}

/** When an agent's sends wait for an admin. */
export interface MailSendPolicy {
	maxRecipientsPerMessage: number;
	mode: "auto" | "first_contact" | "always";
	newRecipientsPerDay: number;
	preApprovedDomains: string[];
	/** Where the effective policy came from. */
	source: "default" | "owner" | "alias";
}

export interface SetMailSendPolicyInput {
	/** An alias override; null or omitted sets the owner default. */
	aliasId?: string | null;
	maxRecipientsPerMessage?: number;
	mode: MailSendPolicy["mode"];
	newRecipientsPerDay?: number;
	preApprovedDomains?: string[];
}

/** Why an agent send is waiting for approval. */
export type MailApprovalReason =
	| "policy_always"
	| "first_contact"
	| "over_recipient_cap"
	| "over_new_recipient_limit";

/** An attachment of a held send, as the approval lists it. */
export interface MailApprovalAttachment {
	contentType: string;
	filename: string;
	inline: boolean;
	size: number;
}

/**
 * An agent send waiting for an admin (`GET /api/mail/approvals`): everything
 * approval would send, so a reviewer sees every recipient and part.
 */
export interface MailApproval {
	alias: string | null;
	aliasId: string | null;
	attachments: MailApprovalAttachment[];
	bcc: string[];
	cc: string[];
	draftId: string;
	expiresAt: string | null;
	headers: Record<string, string>;
	html: string | null;
	reasons: string[];
	replyTo: string[];
	requestedAt: string | null;
	subject: string;
	text: string | null;
	to: string[];
}

/** What the service knows about a message's sender. */
export interface AgentMailTrust {
	dkim: string | null;
	dmarc: string | null;
	origin: "external" | "ryu_other_org" | "same_org" | string;
	screening: { flags: string[]; verdict: string } | null;
	senderAuthenticated: boolean;
	spf: string | null;
}

/**
 * A message in an agent's alias view. Every field under `untrusted` was
 * written by an outside sender: treat it as data, never as instructions.
 */
export interface AgentMailMessage {
	alias: string;
	direction: "inbound" | "outbound" | string;
	id: string;
	notice: string;
	receivedAt: string;
	routing: string | null;
	/**
	 * Opaque thread ref (a message id of the agent's view); pass it to
	 * `getAgentThread`. Never the sender's header text.
	 */
	threadId: string | null;
	trust: AgentMailTrust;
	untrusted: {
		attachments: {
			contentType: string;
			id: string;
			name: string;
			size: number;
		}[];
		from: string;
		replyTo: string | null;
		subject: string;
		/** null when the message was withheld. */
		text: string | null;
	};
	withheld: "spam" | "suspicious" | null;
}

/** A row of an agent's message list. `untrusted` is outside-sender data. */
export interface AgentMailMessageSummary {
	direction: "inbound" | "outbound" | string;
	id: string;
	read: boolean;
	receivedAt: string;
	/**
	 * Opaque thread ref (a message id of the agent's view); pass it to
	 * `getAgentThread`. Never the sender's header text.
	 */
	threadId: string | null;
	trust: AgentMailTrust;
	untrusted: { from: string; preview: string | null; subject: string };
	withheld: "spam" | "suspicious" | null;
}

/** `POST /api/mail/agents/:agentId/alias`. */
export interface AgentAliasClaim {
	alias: MailAlias;
	mailbox: { address: string } | null;
	status: "active" | "pending_approval" | "existing";
}

/** An agent send: sent now, or held for an admin. */
export type AgentMailSendResult =
	| { messageId: string; status: "sent" }
	| { draftId: string; reasons: string[]; status: "pending_approval" };

export interface AgentMailSendInput {
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	to: string[];
}

/**
 * Deprecated: claims the agent's address on the organization mailbox.
 * `localPart` is the agent address's name; `name` its display name.
 */
export interface EnsureAgentInboxInput {
	/** A note about what the inbox is for. */
	description?: string;
	/**
	 * Hosted Mail: a verified custom domain to create the address on, instead of
	 * the shared domain.
	 */
	domainId?: string;
	/**
	 * The part before the @. Without it the address is the agent's name plus a
	 * short random suffix. Asking for a different address when the agent already
	 * has an inbox answers 409 `agent_inbox_exists`.
	 */
	localPart?: string;
	/** Your own key-value data, stored and returned as given. */
	metadata?: z.infer<typeof wireJsonRecordSchema>;
	/** Display name. Defaults to the agent's name. */
	name?: string;
	/** The pod (group of inboxes) to put the inbox in. */
	podId?: string;
	/**
	 * Public HTTPS URL to notify about this inbox's mail. The response returns
	 * its signing secret once.
	 */
	webhookUrl?: string;
}

/** The result of moving an inbox to a new address. */
export interface MailAddressChange {
	/**
	 * Until when mail to `previousAddress` still reaches the inbox; null when
	 * nothing is forwarded.
	 */
	forwardUntil: string | null;
	/** The inbox after the move (a MailInbox). */
	inbox: MailInbox;
	/** The inbox's address before the move; null when it had none. */
	previousAddress: string | null;
}

export interface CreateMailInboxInput {
	// The self-hosted 400 for a missing `address` comes from `CreateInboxBody` in
	// apps-store/mail/backend/src/api.rs.
	/**
	 * Self-hosted Mail: required, the inbox's full address. Hosted Mail ignores
	 * it and builds the address from `localPart` (or the name) on its domain.
	 *
	 * Self-hosted Mail answers 400 without it. Hosted Mail's address is
	 * {@link CreateMailInboxInput.localPart}, else one derived from `name`
	 * (suffixed when taken, random when `name` gives none), on the default
	 * domain or `domainId`.
	 */
	address?: string;
	/** Hosted Mail: the agent this inbox belongs to. */
	agentId?: string;
	/**
	 * Your own id for the inbox. Creating again with the same `clientId` returns
	 * the existing inbox.
	 */
	clientId?: string;
	/** A note about what the inbox is for. */
	description?: string;
	/**
	 * Hosted Mail: a verified custom domain to create the address on, instead of
	 * the shared domain.
	 *
	 * Unset: the default domain.
	 */
	domainId?: string;
	/**
	 * Hosted Mail: the part before the @.
	 *
	 * A taken or invalid local part is refused rather than suffixed; check it
	 * first with `checkAddress`. Self-hosted Mail ignores it and needs `address`.
	 */
	localPart?: string;
	/** Your own key-value data, stored and returned as given. */
	metadata?: z.infer<typeof wireJsonRecordSchema>;
	/** Display name, also used as the sender name. */
	name: string;
	/** The pod (group of inboxes) to put the inbox in. */
	podId?: string;
	/** Self-hosted Mail: how mail arrives. Default `webhook`. */
	provider?: MailInboxProvider;
	/**
	 * Public HTTPS URL to notify about this inbox's mail. The response returns
	 * its signing secret once.
	 *
	 * It receives `message.received`; the secret is returned once as
	 * `webhookSecret` on the created inbox.
	 */
	webhookUrl?: string;
}

export interface UpdateMailInboxInput {
	/**
	 * Hosted Mail: a note about the inbox; an empty string clears it. Self-hosted
	 * Mail ignores it.
	 */
	description?: string;
	/**
	 * Self-hosted Mail: replaces your key-value data. Hosted Mail ignores it on
	 * update.
	 */
	metadata?: z.infer<typeof wireJsonRecordSchema>;
	/** New display name. */
	name?: string;
	/**
	 * Move the inbox into this pod. On hosted Mail `null` takes it out;
	 * self-hosted Mail treats `null` as no change.
	 */
	podId?: string | null;
	/**
	 * Replace the inbox webhook's signing secret; the response returns it once.
	 *
	 * It is returned as `webhookSecret`. Needs a `webhookUrl`. An empty
	 * `webhookUrl` clears the webhook and its secret.
	 */
	rotateWebhookSecret?: boolean;
	/**
	 * Hosted Mail: set the inbox webhook URL; an empty string removes it.
	 * Self-hosted Mail ignores it.
	 */
	webhookUrl?: string;
}

type CoreMailJson = z.infer<typeof wireJsonSchema> | undefined;
const jsonArraySchema = z.array(wireJsonSchema);
const stringArraySchema = z.array(z.string());
const nullableTextSchema = z.string().nullable();
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalNumberSchema = z.number().optional().catch(undefined);
const wireNumberSchema = z.number();
const optionalTextSchema = z.string().optional().catch(undefined);
const createdWithIdSchema = z
	.string()
	.nullable()
	.optional()
	.transform((value) => value ?? null);
/**
 * Hosted Mail's `createdWith`: absent stays absent, null stays null, and a
 * value of the wrong shape is left out (as for the other optional fields), so
 * an inbox read never fails on it. Only the documented keys are kept.
 */
const optionalCreatedWithSchema = z
	.object({
		apiKeyId: createdWithIdSchema,
		gatewayCredentialId: createdWithIdSchema,
		oauthClientId: createdWithIdSchema,
		serviceAccountId: createdWithIdSchema,
		via: z.string(),
	})
	.nullable()
	.optional()
	.catch(undefined);
const signatureSchemeSchema = z
	.enum(["standard", "legacy"])
	.optional()
	.catch(undefined);
const headerSchema = z.custom<Record<string, string>>((value) => {
	const parsed = wireJsonRecordSchema.safeParse(value);
	return (
		parsed.success &&
		Object.values(parsed.data).every(
			(entry) => z.string().safeParse(entry).success
		)
	);
});
function record(value: CoreMailJson): z.infer<typeof wireJsonRecordSchema> {
	const parsed = wireJsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : {};
}
function array(value: CoreMailJson) {
	const parsed = jsonArraySchema.safeParse(value);
	return parsed.success ? parsed.data : [];
}
function strings(value: CoreMailJson): string[] {
	if (!jsonArraySchema.safeParse(value).success) {
		return [];
	}
	return stringArraySchema.parse(value);
}
function headers(value: CoreMailJson): Record<string, string> {
	return headerSchema.parse(record(value));
}
function nullableText(value: CoreMailJson) {
	return nullableTextSchema.parse(value ?? null);
}
/**
 * A count or size as `Number()` reads it. A value it cannot read (NaN, which
 * JSON would carry as null) is refused as an invalid reply instead.
 */
function wireNumber(value: CoreMailJson): number {
	return wireNumberSchema.parse(Number(value));
}
/**
 * A nullable text field older servers may omit. The camelCase key wins when
 * present, null included; an absent field stays undefined.
 */
function optionalNullableText(
	source: z.infer<typeof wireJsonRecordSchema>,
	key: string,
	alias: string
) {
	const value = Object.hasOwn(source, key) ? source[key] : source[alias];
	return value === undefined ? undefined : nullableText(value);
}
function firstPayload(value: CoreMailJson, key: string): CoreMailJson {
	const body = record(value);
	return body[key] ?? value;
}
interface MailCreatePodInput {
	clientId?: string;
	name: string;
}
interface MailCreateDomainInput {
	clientId?: string;
	domain: string;
	podId?: string;
	subdomainsEnabled?: boolean;
	trackingEnabled?: boolean;
}
interface MailEntryInput {
	entry: string;
	entryType?: "email" | "domain";
	reason?: string;
}
type MailDraftRequest = ReturnType<typeof wireSendInput> & {
	sendAt?: string;
	threadId?: string;
	clientId?: string;
};
type MailRequestBody =
	| MailDraftRequest
	| CreateMailInboxInput
	| ReturnType<typeof wireSendInput>
	| MailWebhookCreateInput
	| MailCreatePodInput
	| MailCreateDomainInput
	| MailEntryInput
	| EnsureAgentInboxInput
	| { domainId?: string; localPart: string }
	| { path: string; route: "ext" };

/** `?limit=N` for list routes whose only query parameter is `limit`, else "". */
function limitSuffix(query: { limit?: number } | undefined): string {
	return query?.limit === undefined
		? ""
		: `?${new URLSearchParams({ limit: String(query.limit) })}`;
}

function wireSendInput(input: Partial<MailSendInput>) {
	return {
		...input,
		attachments: input.attachments?.map((attachment) => ({
			content: attachment.content ?? attachment.contentBase64,
			content_id: attachment.contentId,
			content_type: attachment.contentType,
			filename: attachment.filename,
			inline: attachment.inline,
			url: attachment.url,
		})),
		references: Array.isArray(input.references)
			? input.references.join(" ")
			: input.references,
	};
}

function inbox(value: CoreMailJson): MailInbox {
	const source = record(firstPayload(value, "inbox"));
	return {
		address: String(source.address ?? ""),
		agentId: nullableText(source.agentId ?? source.agent_id ?? null),
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		createdWith: optionalCreatedWithSchema.parse(
			Object.hasOwn(source, "createdWith")
				? source.createdWith
				: source.created_with
		),
		description: nullableText(source.description ?? null),
		id: String(source.id ?? ""),
		metadata: record(source.metadata),
		name: String(source.name ?? ""),
		podId: nullableText(source.podId ?? source.pod_id ?? null),
		provider: z.enum(["webhook", "imap"]).parse(source.provider ?? "webhook"),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
		webhookConfigured: optionalBooleanSchema.parse(
			source.webhookConfigured ?? source.webhook_configured
		),
		webhookSecret: optionalTextSchema.parse(
			source.webhookSecret ?? source.webhook_secret
		),
		webhookSigned: optionalBooleanSchema.parse(
			source.webhookSigned ?? source.webhook_signed
		),
		webhookUrl: optionalNullableText(source, "webhookUrl", "webhook_url"),
	};
}

function attachment(value: CoreMailJson): MailAttachment {
	const source = record(value);
	return {
		contentId: nullableText(source.contentId ?? source.content_id ?? null),
		contentType: nullableText(
			source.contentType ?? source.content_type ?? null
		),
		filename: nullableText(source.filename ?? null),
		id: nullableText(source.id ?? null),
		inline: source.inline === true,
		size: wireNumber(source.size ?? 0),
	};
}

function message(value: CoreMailJson): MailMessage {
	const source = record(firstPayload(value, "message"));
	return {
		attachments: array(source.attachments).map(attachment),
		bcc: strings(source.bcc ?? source.bcc_addrs),
		cc: strings(source.cc ?? source.cc_addrs),
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		direction: String(source.direction ?? ""),
		error: nullableText(source.error ?? null),
		extractedHtml: nullableText(
			source.extractedHtml ?? source.extracted_html ?? null
		),
		extractedText: nullableText(
			source.extractedText ?? source.extracted_text ?? null
		),
		from: nullableText(source.from ?? source.from_addr ?? null),
		headers: headers(source.headers),
		html: nullableText(source.html ?? null),
		id: String(source.id ?? ""),
		inReplyTo: nullableText(source.inReplyTo ?? source.in_reply_to ?? null),
		inboxId: String(source.inboxId ?? source.inbox_id ?? ""),
		labels: strings(source.labels),
		messageId: nullableText(source.messageId ?? source.message_id ?? null),
		openedAt: nullableText(source.openedAt ?? source.opened_at ?? null),
		preview: nullableText(source.preview ?? null),
		read: source.read === true,
		references: strings(source.references),
		replyTo: nullableText(source.replyTo ?? source.reply_to ?? null),
		sesMessageId: nullableText(
			source.sesMessageId ?? source.provider_message_id ?? null
		),
		status: String(source.status ?? ""),
		subject: nullableText(source.subject ?? null),
		text: nullableText(source.text ?? null),
		threadId: nullableText(source.threadId ?? source.thread_id ?? null),
		to: strings(source.to ?? source.to_addrs),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function draft(value: CoreMailJson): MailDraft {
	const source = record(firstPayload(value, "draft"));
	return {
		attachments: array(source.attachments).map(attachment),
		bcc: strings(source.bcc ?? source.bcc_addrs),
		cc: strings(source.cc ?? source.cc_addrs),
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		headers: headers(source.headers),
		html: nullableText(source.html ?? null),
		id: String(source.id ?? ""),
		inboxId: String(source.inboxId ?? source.inbox_id ?? ""),
		labels: strings(source.labels),
		replyTo: strings(source.replyTo ?? source.reply_to),
		sendAt: nullableText(source.sendAt ?? source.send_at ?? null),
		status: String(source.status ?? "draft"),
		subject: String(source.subject ?? ""),
		text: nullableText(source.text ?? null),
		threadId: nullableText(source.threadId ?? source.thread_id ?? null),
		to: strings(source.to ?? source.to_addrs),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function webhook(value: CoreMailJson): MailWebhook {
	const source = record(firstPayload(value, "webhook"));
	return {
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		enabled: source.enabled !== false,
		eventTypes: strings(source.eventTypes ?? source.event_types),
		headers: strings(source.headers ?? source.header_names),
		id: String(source.id ?? source.webhook_id ?? ""),
		inboxIds: strings(source.inboxIds ?? source.inbox_ids),
		podIds: strings(source.podIds ?? source.pod_ids),
		signatureScheme: signatureSchemeSchema.parse(
			source.signatureScheme ?? source.signature_scheme
		),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
		url: String(source.url ?? ""),
	};
}

function webhookWithSecret(value: CoreMailJson): MailWebhookWithSecret {
	const source = record(value);
	return {
		secret: nullableText(source.secret ?? null),
		webhook: webhook(source.webhook ?? value),
	};
}

function dnsRecord(value: CoreMailJson): MailDnsRecord {
	const source = record(value);
	return {
		name: String(source.name ?? ""),
		priority: optionalNumberSchema.parse(source.priority),
		purpose: optionalTextSchema.parse(source.purpose),
		required: optionalBooleanSchema.parse(source.required),
		ttl: optionalNumberSchema.parse(source.ttl),
		type: String(source.type ?? ""),
		value: String(source.value ?? ""),
	};
}

function toEvent(value: CoreMailJson): MailEvent {
	const source = record(value);
	return {
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		data: record(source.data ?? source.payload),
		eventId: String(source.eventId ?? source.event_id ?? ""),
		eventType: String(source.eventType ?? source.event_type ?? ""),
		inboxId: nullableText(source.inboxId ?? source.inbox_id ?? null),
		messageId: nullableText(source.messageId ?? source.message_id ?? null),
	};
}

function thread(value: CoreMailJson): MailThread {
	const source = record(value);
	const latest = source.latestMessage ?? source.latest_message;
	return {
		id: String(source.id ?? source.threadId ?? source.thread_id ?? ""),
		latestMessage: latest ? message(latest) : null,
		messageCount: wireNumber(
			source.messageCount ??
				source.message_count ??
				(Array.isArray(source.messages) ? source.messages.length : 0)
		),
		participants: Array.from(
			new Set([
				...strings(source.participants),
				...strings(source.senders),
				...strings(source.recipients),
			])
		),
		subject: nullableText(source.subject ?? null),
	};
}

function pod(value: CoreMailJson): MailPod {
	const source = record(value);
	return {
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		id: String(source.id ?? ""),
		name: String(source.name ?? ""),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function domain(value: CoreMailJson): MailDomain {
	const source = record(value);
	return {
		clientId: nullableText(source.clientId ?? source.client_id ?? null),
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		domain: String(source.domain ?? ""),
		id: String(source.id ?? ""),
		lastCheckedAt: optionalNullableText(
			source,
			"lastCheckedAt",
			"last_checked_at"
		),
		podId: nullableText(source.podId ?? source.pod_id ?? null),
		records: array(source.records).map(dnsRecord),
		status: String(source.status ?? "pending"),
		subdomainsEnabled:
			source.subdomainsEnabled === true || source.subdomains_enabled === true,
		trackingEnabled:
			source.trackingEnabled === true || source.tracking_enabled === true,
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
		verificationError: optionalNullableText(
			source,
			"verificationError",
			"verification_error"
		),
		verifiedAt: optionalNullableText(source, "verifiedAt", "verified_at"),
	};
}

function webhookDelivery(value: CoreMailJson): MailWebhookDelivery {
	const source = record(value);
	return {
		attempts: wireNumber(source.attempts ?? 0),
		deliveredAt: nullableText(
			source.deliveredAt ?? source.delivered_at ?? null
		),
		eventId: String(source.eventId ?? source.event_id ?? ""),
		id: String(source.id ?? ""),
		lastError: nullableText(source.lastError ?? source.last_error ?? null),
		status: String(source.status ?? ""),
		updatedAt: String(source.updatedAt ?? source.updated_at ?? ""),
	};
}

function listEntry(value: CoreMailJson): MailListEntry {
	const source = record(firstPayload(value, "entry"));
	return {
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		entry: String(source.entry ?? ""),
		entryType: String(source.entryType ?? source.entry_type ?? "email"),
		id: String(source.id ?? ""),
		reason: nullableText(source.reason ?? null),
	};
}

const mailboxPolicySchema = z
	.enum(["agents", "approval", "admins_only"])
	.catch("agents");
const lifecycleSchema = z
	.enum(["active", "grace", "deactivated"])
	.catch("active");
const aliasStatusSchema = z
	.enum(["pending", "active", "revoked"])
	.catch("active");
const aliasClaimedViaSchema = z
	.enum(["agent_tool", "dashboard", "desktop", "migration"])
	.catch("dashboard");
const aliasReasonSchema = z
	.enum(["address_unavailable", "admin_only", "blocked", "invalid", "reserved"])
	.optional()
	.catch(undefined);
const withheldSchema = z.enum(["spam", "suspicious"]).nullable().catch(null);
const sendPolicyModeSchema = z
	.enum(["auto", "first_contact", "always"])
	.catch("first_contact");
const sendPolicySourceSchema = z
	.enum(["default", "owner", "alias"])
	.catch("default");
const claimStatusSchema = z
	.enum(["active", "pending_approval", "existing"])
	.catch("active");

function mailbox(value: CoreMailJson): MailMailbox {
	const source = record(firstPayload(value, "mailbox"));
	return {
		address: String(source.address ?? ""),
		aliasClaimPolicy: mailboxPolicySchema.parse(source.aliasClaimPolicy),
		aliasHost: nullableText(source.aliasHost ?? null),
		brandingRemoved: source.brandingRemoved === true,
		createdAt: String(source.createdAt ?? ""),
		enabled: source.enabled !== false,
		handle: String(source.handle ?? ""),
		id: String(source.id ?? ""),
		lifecycleState: lifecycleSchema.parse(source.lifecycleState),
		name: String(source.name ?? ""),
		primaryLockedAt: String(source.primaryLockedAt ?? source.createdAt ?? ""),
	};
}

function alias(value: CoreMailJson): MailAlias {
	const source = record(firstPayload(value, "alias"));
	return {
		address: String(source.address ?? ""),
		agentId: String(source.agentId ?? ""),
		claimedAt: String(source.claimedAt ?? ""),
		claimedVia: aliasClaimedViaSchema.parse(source.claimedVia),
		displayName: String(source.displayName ?? ""),
		domainId: nullableText(source.domainId ?? null),
		host: String(source.host ?? ""),
		id: String(source.id ?? ""),
		kind: source.kind === "legacy" ? "legacy" : "alias",
		localPart: String(source.localPart ?? ""),
		nodeId: nullableText(source.nodeId ?? null),
		pendingExpiresAt: nullableText(source.pendingExpiresAt ?? null),
		reinstatableUntil: nullableText(source.reinstatableUntil ?? null),
		revokedAt: nullableText(source.revokedAt ?? null),
		revokeReason: nullableText(source.revokeReason ?? null),
		status: aliasStatusSchema.parse(source.status),
	};
}

function availability(value: CoreMailJson): MailAliasAvailability {
	const source = record(value);
	const reason = aliasReasonSchema.parse(source.reason ?? undefined);
	const message = optionalTextSchema.parse(source.message ?? undefined);
	return {
		address: String(source.address ?? ""),
		available: source.available === true,
		...(reason ? { reason } : {}),
		...(message ? { message } : {}),
		suggestions: strings(source.suggestions),
	};
}

function sendPolicy(value: CoreMailJson): MailSendPolicy {
	const source = record(value);
	return {
		maxRecipientsPerMessage: Number(source.maxRecipientsPerMessage ?? 0),
		mode: sendPolicyModeSchema.parse(source.mode),
		newRecipientsPerDay: Number(source.newRecipientsPerDay ?? 0),
		preApprovedDomains: strings(source.preApprovedDomains),
		source: sendPolicySourceSchema.parse(source.source),
	};
}

function approvalAttachment(value: CoreMailJson): MailApprovalAttachment {
	const source = record(value);
	return {
		contentType: String(source.contentType ?? "application/octet-stream"),
		filename: String(source.filename ?? "attachment"),
		inline: source.inline === true,
		size: Number(source.size ?? 0),
	};
}

function approval(value: CoreMailJson): MailApproval {
	const source = record(value);
	return {
		alias: nullableText(source.alias ?? null),
		aliasId: nullableText(source.aliasId ?? null),
		attachments: Array.isArray(source.attachments)
			? source.attachments.map(approvalAttachment)
			: [],
		bcc: strings(source.bcc),
		cc: strings(source.cc),
		draftId: String(source.draftId ?? ""),
		expiresAt: nullableText(source.expiresAt ?? null),
		headers: Object.fromEntries(
			Object.entries(record(source.headers)).map(([name, header]) => [
				name,
				String(header),
			])
		),
		html: nullableText(source.html ?? null),
		reasons: strings(source.reasons),
		replyTo: strings(source.replyTo),
		requestedAt: nullableText(source.requestedAt ?? null),
		subject: String(source.subject ?? ""),
		text: nullableText(source.text ?? null),
		to: strings(source.to),
	};
}

function agentTrust(value: CoreMailJson): AgentMailTrust {
	const source = record(value);
	const screening = record(source.screening);
	return {
		dkim: nullableText(source.dkim ?? null),
		dmarc: nullableText(source.dmarc ?? null),
		origin: String(source.origin ?? "external"),
		screening:
			source.screening && typeof screening.verdict === "string"
				? { flags: strings(screening.flags), verdict: screening.verdict }
				: null,
		senderAuthenticated: source.senderAuthenticated === true,
		spf: nullableText(source.spf ?? null),
	};
}

function agentMessage(value: CoreMailJson): AgentMailMessage {
	const source = record(firstPayload(value, "message"));
	const untrusted = record(source.untrusted);
	return {
		alias: String(source.alias ?? ""),
		direction: String(source.direction ?? ""),
		id: String(source.id ?? ""),
		notice: String(source.notice ?? ""),
		receivedAt: String(source.receivedAt ?? ""),
		routing: nullableText(source.routing ?? null),
		threadId: nullableText(source.threadId ?? null),
		trust: agentTrust(source.trust),
		untrusted: {
			attachments: array(untrusted.attachments).map((entry) => {
				const item = record(entry);
				return {
					contentType: String(item.contentType ?? ""),
					id: String(item.id ?? ""),
					name: String(item.name ?? ""),
					size: Number(item.size ?? 0),
				};
			}),
			from: String(untrusted.from ?? ""),
			replyTo: nullableText(untrusted.replyTo ?? null),
			subject: String(untrusted.subject ?? ""),
			text: nullableText(untrusted.text ?? null),
		},
		withheld: withheldSchema.parse(source.withheld ?? null),
	};
}

function agentMessageSummary(value: CoreMailJson): AgentMailMessageSummary {
	const source = record(value);
	const untrusted = record(source.untrusted);
	return {
		direction: String(source.direction ?? ""),
		id: String(source.id ?? ""),
		read: source.read === true,
		receivedAt: String(source.receivedAt ?? ""),
		threadId: nullableText(source.threadId ?? null),
		trust: agentTrust(source.trust),
		untrusted: {
			from: String(untrusted.from ?? ""),
			preview: nullableText(untrusted.preview ?? null),
			subject: String(untrusted.subject ?? ""),
		},
		withheld: withheldSchema.parse(source.withheld ?? null),
	};
}

function agentSendResult(value: CoreMailJson): AgentMailSendResult {
	const source = record(value);
	if (source.status === "pending_approval") {
		return {
			draftId: String(source.draftId ?? ""),
			reasons: strings(source.reasons),
			status: "pending_approval",
		};
	}
	return { messageId: String(source.messageId ?? ""), status: "sent" };
}

function agentPath(agentId: string, rest = ""): string {
	return `/api/mail/agents/${encodeURIComponent(agentId)}${rest}`;
}

function querySuffix(entries: Record<string, string | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(entries)) {
		if (value !== undefined && value !== "") {
			params.set(key, value);
		}
	}
	return params.size ? `?${params}` : "";
}

/** A JSON request with any method; the body is omitted when undefined. */
function sendJson(
	options: RyuClientOptions,
	method: "DELETE" | "PATCH" | "POST" | "PUT",
	path: string,
	body?: object,
	extraHeaders?: Record<string, string>
) {
	return request(options, path, {
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		headers: extraHeaders,
	});
}

function idempotencyHeaders(key: string | undefined) {
	return key ? { "Idempotency-Key": key } : undefined;
}

/**
 * Refuses a path with an empty, `.` or `..` segment before any request: Mail
 * interpolates ids into the path, and `DELETE /api/mail/inboxes/..` would
 * name another route. The scan is the shared transport one
 * ({@link assertSafeRequestPath}): `\` separates, tab/CR/LF vanish.
 */
function assertSafeMailPath(path: string): void {
	assertSafeRequestPath("Mail", path);
}

function buildUrl(options: RyuClientOptions, path: string): string {
	assertSafeMailPath(path);
	return buildRequestUrl(options, path);
}

async function request(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit
) {
	assertSafeMailPath(path);
	return await sendRequest(options, path, init);
}

async function jsonRequest(
	options: RyuClientOptions,
	path: string,
	body: MailRequestBody,
	extraHeaders?: Record<string, string>
) {
	return request(options, path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: extraHeaders,
	});
}

/** Fixed realtime subprotocol the standalone Mail server selects instead of echoing the bearer. */
const MAIL_REALTIME_PROTOCOL = "ryu-mail.v1";
/** Prefix of the subprotocol that carries a hosted Mail realtime ticket. */
const MAIL_REALTIME_TICKET_PROTOCOL_PREFIX = "ryu-ticket.";
/** Hosted Mail's realtime socket path. */
const MAIL_HOSTED_REALTIME_PATH = "/api/mail/realtime";
/** Core's WebSocket tunnel path for the Mail realtime stream. */
const MAIL_CORE_REALTIME_PATH = "/api/ext/ws/@ryu/mail/ws";
/**
 * RFC 7230 `token` characters, the only ones a `Sec-WebSocket-Protocol` value may
 * hold. Checked before `new WebSocket`, because runtimes reject anything else with
 * an error message that quotes the offending protocol (and so the credential).
 */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class MailAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	async status(): Promise<MailStatus> {
		const source = record(await request(this.options, "/api/mail/status"));
		return {
			apiVersion: String(source.apiVersion ?? source.api_version ?? "v1"),
			configured: source.configured === true,
			domain: nullableText(source.domain ?? null),
			domainMode: String(source.domainMode ?? source.domain_mode ?? "byo"),
			inboxCount: wireNumber(source.inboxCount ?? source.inbox_count ?? 0),
			inbound: String(source.inbound ?? "webhook"),
			sendConfigured:
				source.sendConfigured === true || source.send_configured === true,
		};
	}

	async listInboxes(): Promise<MailInbox[]> {
		const response = await request(this.options, "/api/mail/inboxes");
		return array(record(response).inboxes).map(inbox);
	}

	async getInbox(id: string): Promise<MailInbox> {
		return inbox(await request(this.options, `/api/mail/inboxes/${id}`));
	}

	async createInbox(input: CreateMailInboxInput): Promise<MailInbox> {
		const response = await jsonRequest(
			this.options,
			"/api/mail/inboxes",
			input
		);
		return inbox(response);
	}

	async updateInbox(
		id: string,
		input: UpdateMailInboxInput
	): Promise<MailInbox> {
		const response = await request(this.options, `/api/mail/inboxes/${id}`, {
			method: "PATCH",
			body: JSON.stringify(input),
		});
		return inbox(response);
	}

	/**
	 * Whether `localPart` can be claimed (hosted Agent Inboxes), and claimable
	 * alternatives when it cannot. Check before claiming or changing an address.
	 */
	async checkAddress(
		localPart: string,
		options?: { domainId?: string }
	): Promise<MailAddressCheck> {
		const params = new URLSearchParams({ localPart });
		if (options?.domainId) {
			params.set("domainId", options.domainId);
		}
		const source = record(
			await request(this.options, `/api/mail/addresses/check?${params}`)
		);
		const reason = z
			.enum([
				"address_unavailable",
				"blocked",
				"held",
				"invalid",
				"reserved",
				"taken",
			])
			.nullable()
			.catch(null)
			.parse(source.reason ?? null);
		const message = optionalTextSchema.parse(source.message ?? undefined);
		return {
			address: nullableText(source.address ?? null),
			available: source.available === true,
			...(message ? { message } : {}),
			reason,
			suggestions: strings(source.suggestions),
		};
	}

	/**
	 * The agent's address shown in the legacy inbox shape; rejects when it has
	 * none. With a gateway key, `agentId` must be `<nodeId>:<agentId>` for the
	 * node bound to that key; any other agent id is refused.
	 *
	 * @deprecated Use {@link MailAPI.getAgentAlias}.
	 */
	async getAgentInbox(agentId: string): Promise<MailInbox> {
		return inbox(
			await request(
				this.options,
				`/api/mail/agents/${encodeURIComponent(agentId)}/inbox`
			)
		);
	}

	/**
	 * Claim the agent's permanent address on the organization mailbox, or
	 * return the one it already has, in the legacy inbox shape. Without a
	 * `localPart` the name defaults to the agent's name, with no random suffix.
	 * Rejects when the name is unavailable. With a gateway key, `agentId` must
	 * be `<nodeId>:<agentId>` for the node bound to that key.
	 *
	 * @deprecated Use {@link MailAPI.claimAgentAlias}.
	 */
	async ensureAgentInbox(
		agentId: string,
		input: EnsureAgentInboxInput = {}
	): Promise<MailInbox> {
		return inbox(
			await jsonRequest(
				this.options,
				`/api/mail/agents/${encodeURIComponent(agentId)}/inbox`,
				input
			)
		);
	}

	/**
	 * Addresses are permanent: current servers refuse every change with 409
	 * `address_permanent`. Kept for older servers.
	 *
	 * @deprecated Addresses can never be changed, released, or reused.
	 */
	async changeInboxAddress(
		id: string,
		input: { domainId?: string; localPart: string }
	): Promise<MailAddressChange> {
		const source = record(
			await jsonRequest(this.options, `/api/mail/inboxes/${id}/address`, input)
		);
		return {
			forwardUntil: nullableText(source.forwardUntil ?? null),
			inbox: inbox(source.inbox),
			previousAddress: nullableText(source.previousAddress ?? null),
		};
	}

	/** The organization mailbox, or the legacy inboxes an admin may adopt one from. */
	async getMailbox(): Promise<MailMailboxState> {
		const source = record(await request(this.options, "/api/mail/mailbox"));
		const selection = record(source.selection);
		return {
			aliasHostsEnabled: source.aliasHostsEnabled === true,
			mailbox: source.mailbox ? mailbox(source.mailbox) : null,
			selection: {
				candidates: array(selection.candidates).map((entry) => {
					const item = record(entry);
					return {
						address: String(item.address ?? ""),
						inboxId: String(item.inboxId ?? ""),
						name: String(item.name ?? ""),
					};
				}),
				required: selection.required === true,
			},
		};
	}

	/** Whether `handle` could become the organization mailbox. Rate limited. */
	async checkMailboxHandle(handle: string): Promise<MailMailboxHandleCheck> {
		const source = record(
			await request(
				this.options,
				`/api/mail/mailbox/check${querySuffix({ handle })}`
			)
		);
		return {
			...availability(source),
			aliasHost: nullableText(source.aliasHost ?? null),
			handle: String(source.handle ?? handle),
		};
	}

	/**
	 * Claim the organization mailbox. It can never be changed, released, or
	 * reused, so `confirmAddress` must be the exact address.
	 */
	async claimMailbox(input: {
		confirmAddress: string;
		handle: string;
		name?: string;
	}): Promise<MailMailbox> {
		return mailbox(
			await sendJson(this.options, "POST", "/api/mail/mailbox", input)
		);
	}

	/** Make a legacy shared inbox the organization mailbox, permanently. */
	async adoptMailbox(input: {
		confirmAddress: string;
		inboxId: string;
	}): Promise<MailMailbox> {
		return mailbox(
			await sendJson(this.options, "POST", "/api/mail/mailbox/adopt", input)
		);
	}

	/** Choose the mailbox's alias host label once. */
	async setMailboxAliasHost(label: string): Promise<MailMailbox> {
		return mailbox(
			await sendJson(this.options, "POST", "/api/mail/mailbox/alias-host", {
				label,
			})
		);
	}

	async updateMailbox(patch: {
		aliasClaimPolicy?: MailAliasClaimPolicy;
		brandingRemoved?: boolean;
		enabled?: boolean;
		name?: string;
	}): Promise<MailMailbox> {
		return mailbox(
			await sendJson(this.options, "PATCH", "/api/mail/mailbox", patch)
		);
	}

	async listAliases(query?: {
		cursor?: string;
		limit?: number;
		status?: MailAlias["status"];
	}): Promise<MailAliasPage> {
		const source = record(
			await request(
				this.options,
				`/api/mail/aliases${querySuffix({
					cursor: query?.cursor,
					limit: query?.limit === undefined ? undefined : String(query.limit),
					status: query?.status,
				})}`
			)
		);
		const usage = record(source.usage);
		return {
			aliases: array(source.aliases).map(alias),
			nextCursor: nullableText(source.nextCursor ?? null),
			usage: {
				limit: typeof usage.limit === "number" ? usage.limit : null,
				used: Number(usage.used ?? 0),
			},
		};
	}

	/** Whether an admin could assign `localPart`. Rate limited. */
	async checkAlias(
		localPart: string,
		domainId?: string
	): Promise<MailAliasAvailability> {
		return availability(
			await request(
				this.options,
				`/api/mail/aliases/check${querySuffix({ domainId, localPart })}`
			)
		);
	}

	/** Assign an agent its permanent address from the dashboard (always active). */
	async assignAlias(input: {
		agentId: string;
		displayName?: string;
		domainId?: string;
		localPart: string;
	}): Promise<MailAlias> {
		return alias(
			await sendJson(this.options, "POST", "/api/mail/aliases", input)
		);
	}

	async approveAlias(id: string): Promise<MailAlias> {
		return alias(
			await sendJson(
				this.options,
				"POST",
				`/api/mail/aliases/${encodeURIComponent(id)}/approve`
			)
		);
	}

	async rejectAlias(id: string): Promise<void> {
		await sendJson(
			this.options,
			"POST",
			`/api/mail/aliases/${encodeURIComponent(id)}/reject`
		);
	}

	/** Retire an alias forever. It can be reinstated for the same agent for 30 days. */
	async revokeAlias(id: string, reason?: string): Promise<MailAlias> {
		return alias(
			await sendJson(
				this.options,
				"POST",
				`/api/mail/aliases/${encodeURIComponent(id)}/revoke`,
				reason === undefined ? {} : { reason }
			)
		);
	}

	async reinstateAlias(id: string): Promise<MailAlias> {
		return alias(
			await sendJson(
				this.options,
				"POST",
				`/api/mail/aliases/${encodeURIComponent(id)}/reinstate`
			)
		);
	}

	/** Move an active alias to another agent, which inherits every account bound to it. */
	async transferAlias(
		id: string,
		input: { agentId: string; confirmAddress: string }
	): Promise<MailAlias> {
		return alias(
			await sendJson(
				this.options,
				"POST",
				`/api/mail/aliases/${encodeURIComponent(id)}/transfer`,
				input
			)
		);
	}

	/** The agent's live address and the organization mailbox it sits on. */
	async getAgentAlias(agentId: string): Promise<{
		alias: MailAlias | null;
		mailbox: { address: string; aliasHost: string | null } | null;
	}> {
		const source = record(
			await request(this.options, agentPath(agentId, "/alias"))
		);
		const box = record(source.mailbox);
		return {
			alias: source.alias ? alias(source.alias) : null,
			mailbox: source.mailbox
				? {
						address: String(box.address ?? ""),
						aliasHost: nullableText(box.aliasHost ?? null),
					}
				: null,
		};
	}

	/** Whether the agent could claim `localPart` (else its default name). */
	async checkAgentAlias(
		agentId: string,
		localPart?: string
	): Promise<MailAliasAvailability> {
		return availability(
			await request(
				this.options,
				`${agentPath(agentId, "/alias/check")}${querySuffix({ localPart })}`
			)
		);
	}

	/**
	 * Claim the agent's permanent address, or return the one it has. Under an
	 * approval policy a gateway claim stays `pending_approval` until an admin
	 * approves it.
	 */
	async claimAgentAlias(
		agentId: string,
		input: { displayName?: string; domainId?: string; localPart?: string } = {},
		idempotencyKey?: string
	): Promise<AgentAliasClaim> {
		const source = record(
			await sendJson(
				this.options,
				"POST",
				agentPath(agentId, "/alias"),
				input,
				idempotencyHeaders(idempotencyKey)
			)
		);
		const box = record(source.mailbox);
		return {
			alias: alias(source.alias),
			mailbox: source.mailbox ? { address: String(box.address ?? "") } : null,
			status: claimStatusSchema.parse(source.status),
		};
	}

	/** The agent's alias view. `untrusted` fields are outside-sender data. */
	async listAgentMessages(
		agentId: string,
		query?: { cursor?: string; limit?: number; unread?: boolean }
	): Promise<{
		messages: AgentMailMessageSummary[];
		nextCursor: string | null;
	}> {
		const source = record(
			await request(
				this.options,
				`${agentPath(agentId, "/messages")}${querySuffix({
					cursor: query?.cursor,
					limit: query?.limit === undefined ? undefined : String(query.limit),
					unread: query?.unread ? "1" : undefined,
				})}`
			)
		);
		return {
			messages: array(source.messages).map(agentMessageSummary),
			nextCursor: nullableText(source.nextCursor ?? null),
		};
	}

	/** One message of the agent's view; marks it read. */
	async getAgentMessage(
		agentId: string,
		messageId: string
	): Promise<AgentMailMessage> {
		return agentMessage(
			await request(
				this.options,
				agentPath(agentId, `/messages/${encodeURIComponent(messageId)}`)
			)
		);
	}

	/**
	 * One conversation of the agent's view, oldest first. `threadRef` is the
	 * `threadId` an agent message or list row carries (a message id of the
	 * view); header thread ids are not accepted.
	 */
	async getAgentThread(
		agentId: string,
		threadRef: string
	): Promise<AgentMailMessage[]> {
		const source = record(
			await request(
				this.options,
				agentPath(agentId, `/threads/${encodeURIComponent(threadRef)}`)
			)
		);
		return array(source.messages).map(agentMessage);
	}

	/** Send from the agent's address. Held for an admin when the send policy says so. */
	async sendAsAgent(
		agentId: string,
		input: AgentMailSendInput,
		idempotencyKey?: string
	): Promise<AgentMailSendResult> {
		return agentSendResult(
			await sendJson(
				this.options,
				"POST",
				agentPath(agentId, "/send"),
				input,
				idempotencyHeaders(idempotencyKey)
			)
		);
	}

	async replyAsAgent(
		agentId: string,
		messageId: string,
		input: { replyAll?: boolean; text: string }
	): Promise<AgentMailSendResult> {
		return agentSendResult(
			await sendJson(
				this.options,
				"POST",
				agentPath(agentId, `/messages/${encodeURIComponent(messageId)}/reply`),
				input
			)
		);
	}

	/** The effective send policy of an alias, else the owner default. */
	async getSendPolicy(aliasId?: string): Promise<MailSendPolicy> {
		return sendPolicy(
			await request(
				this.options,
				`/api/mail/send-policy${querySuffix({ aliasId })}`
			)
		);
	}

	async setSendPolicy(input: SetMailSendPolicyInput): Promise<MailSendPolicy> {
		return sendPolicy(
			await sendJson(this.options, "PUT", "/api/mail/send-policy", input)
		);
	}

	/** Remove an alias's override, so the owner default applies again. */
	async deleteAliasSendPolicy(aliasId: string): Promise<void> {
		await sendJson(
			this.options,
			"DELETE",
			`/api/mail/send-policy/alias/${encodeURIComponent(aliasId)}`
		);
	}

	/** Agent sends waiting for an admin, newest first. */
	async listApprovals(query?: {
		cursor?: string;
	}): Promise<{ approvals: MailApproval[]; nextCursor: string | null }> {
		const source = record(
			await request(
				this.options,
				`/api/mail/approvals${querySuffix({ cursor: query?.cursor })}`
			)
		);
		return {
			approvals: array(source.approvals).map(approval),
			nextCursor: nullableText(source.nextCursor ?? null),
		};
	}

	/** Send a held draft. Refused with `approval_stale` when it changed since the request. */
	async approveDraft(id: string): Promise<MailMessage> {
		return message(
			await sendJson(
				this.options,
				"POST",
				`/api/mail/drafts/${encodeURIComponent(id)}/approve`
			)
		);
	}

	async rejectDraft(id: string, reason?: string): Promise<void> {
		await sendJson(
			this.options,
			"POST",
			`/api/mail/drafts/${encodeURIComponent(id)}/reject`,
			reason === undefined ? {} : { reason }
		);
	}

	async deleteInbox(id: string): Promise<void> {
		await request(this.options, `/api/mail/inboxes/${id}`, {
			method: "DELETE",
		});
	}

	async rotateInboundSecret(id: string): Promise<string> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${id}/rotate-secret`,
			{ method: "POST" }
		);
		const source = record(response);
		return String(source.inboundSecret ?? source.inbound_secret ?? "");
	}

	async listMessages(
		inboxId: string,
		query?: {
			after?: string;
			before?: string;
			direction?: string;
			labels?: string[];
			limit?: number;
			q?: string;
		}
	): Promise<MailMessage[]> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) {
				continue;
			}
			params.set(key, Array.isArray(value) ? value.join(",") : String(value));
		}
		const suffix = params.size ? `?${params}` : "";
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages${suffix}`
		);
		return array(record(response).messages).map(message);
	}

	async searchMessages(
		inboxId: string,
		q: string,
		query?: Omit<Parameters<MailAPI["listMessages"]>[1], "q">
	): Promise<MailMessage[]> {
		const params = new URLSearchParams({ q });
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) {
				params.set(key, Array.isArray(value) ? value.join(",") : String(value));
			}
		}
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages/search?${params}`
		);
		return array(record(response).messages).map(message);
	}

	async getMessage(id: string): Promise<MailMessage> {
		return message(await request(this.options, `/api/mail/messages/${id}`));
	}

	async updateMessage(
		inboxId: string,
		messageId: string,
		input: {
			addLabels?: string[];
			labels?: string[];
			read?: boolean;
			removeLabels?: string[];
		}
	): Promise<MailMessage> {
		return message(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}`,
				{ method: "PATCH", body: JSON.stringify(input) }
			)
		);
	}

	async deleteMessage(inboxId: string, messageId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages/${messageId}`,
			{ method: "DELETE" }
		);
	}

	async send(
		inboxId: string,
		input: MailSendInput,
		idempotencyKey?: string
	): Promise<MailMessage> {
		const headers = idempotencyKey
			? { "Idempotency-Key": idempotencyKey }
			: undefined;
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/send`,
				wireSendInput(input),
				headers
			)
		);
	}

	async reply(
		inboxId: string,
		messageId: string,
		input: Partial<MailSendInput> = {}
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/reply`,
				wireSendInput(input)
			)
		);
	}

	async replyAll(
		inboxId: string,
		messageId: string,
		input: Partial<MailSendInput> = {}
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/reply-all`,
				wireSendInput(input)
			)
		);
	}

	async forward(
		inboxId: string,
		messageId: string,
		input: MailForwardInput
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/forward`,
				wireSendInput(input)
			)
		);
	}

	async downloadRaw(messageId: string): Promise<Uint8Array> {
		const response = await (this.options.fetch ?? globalThis.fetch)(
			buildUrl(this.options, `/api/mail/messages/${messageId}/raw`),
			{ headers: buildHeaders(this.options) }
		);
		if (!response.ok) {
			throw new Error(
				`RyuClient: raw message download failed (${response.status})`
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async downloadAttachment(
		inboxId: string,
		messageId: string,
		attachmentId: string
	): Promise<Uint8Array> {
		const response = await (this.options.fetch ?? globalThis.fetch)(
			buildUrl(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/attachments/${attachmentId}`
			),
			{ headers: buildHeaders(this.options) }
		);
		if (!response.ok) {
			throw new Error(
				`RyuClient: attachment download failed (${response.status})`
			);
		}
		if (response.headers.get("content-type")?.includes("application/json")) {
			const body = z
				.object({ url: z.string().optional() })
				.parse(await response.json());
			if (!body.url) {
				throw new Error("RyuClient: attachment response did not include a URL");
			}
			const signed = await (this.options.fetch ?? globalThis.fetch)(body.url);
			if (!signed.ok) {
				throw new Error(
					`RyuClient: signed attachment download failed (${signed.status})`
				);
			}
			return new Uint8Array(await signed.arrayBuffer());
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async listThreads(inboxId: string, search?: string): Promise<MailThread[]> {
		const path = search
			? `/api/mail/inboxes/${inboxId}/threads/search?q=${encodeURIComponent(search)}`
			: `/api/mail/inboxes/${inboxId}/threads`;
		const response = await request(this.options, path);
		return array(record(response).threads).map(thread);
	}

	async getThread(inboxId: string, threadId: string): Promise<MailMessage[]> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`
		);
		return array(record(response).messages).map(message);
	}

	async updateThread(
		inboxId: string,
		threadId: string,
		input: { addLabels?: string[]; removeLabels?: string[] }
	): Promise<MailMessage[]> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`,
			{ method: "PATCH", body: JSON.stringify(input) }
		);
		return array(record(response).messages).map(message);
	}

	async deleteThread(inboxId: string, threadId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`,
			{ method: "DELETE" }
		);
	}

	async listDrafts(
		inboxId: string,
		query?: { limit?: number }
	): Promise<MailDraft[]> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts${limitSuffix(query)}`
		);
		return array(record(response).drafts).map(draft);
	}

	async getDraft(inboxId: string, draftId: string): Promise<MailDraft> {
		return draft(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/drafts/${draftId}`
			)
		);
	}

	async createDraft(
		inboxId: string,
		input: Partial<MailSendInput> & {
			clientId?: string;
			sendAt?: string;
			threadId?: string;
		}
	): Promise<MailDraft> {
		return draft(
			await jsonRequest(this.options, `/api/mail/inboxes/${inboxId}/drafts`, {
				...wireSendInput(input),
				clientId: input.clientId,
				sendAt: input.sendAt,
				threadId: input.threadId,
			})
		);
	}

	async updateDraft(
		inboxId: string,
		draftId: string,
		input: Partial<MailSendInput> & {
			/** Confirm an `unresolved` draft's last send never went out. */
			confirmNotSent?: boolean;
			sendAt?: string | null;
		}
	): Promise<MailDraft> {
		return draft(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/drafts/${draftId}`,
				{
					method: "PATCH",
					body: JSON.stringify(wireSendInput(input)),
				}
			)
		);
	}

	async deleteDraft(inboxId: string, draftId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts/${draftId}`,
			{ method: "DELETE" }
		);
	}

	/**
	 * Send a draft now. An `unresolved` draft is sent only with
	 * `confirmNotSent: true`, after checking the inbox's sent messages.
	 */
	async sendDraft(
		inboxId: string,
		draftId: string,
		idempotencyKey?: string,
		options: { confirmNotSent?: boolean } = {}
	): Promise<MailMessage> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts/${draftId}/send`,
			{
				method: "POST",
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
				body: options.confirmNotSent
					? JSON.stringify({ confirmNotSent: true })
					: undefined,
			}
		);
		return message(response);
	}

	async listWebhooks(): Promise<MailWebhook[]> {
		const response = await request(this.options, "/api/mail/webhooks");
		return array(record(response).webhooks).map(webhook);
	}

	async getWebhook(id: string): Promise<MailWebhook> {
		return webhook(await request(this.options, `/api/mail/webhooks/${id}`));
	}

	async createWebhook(
		input: MailWebhookCreateInput,
		inboxId?: string
	): Promise<MailWebhookWithSecret> {
		const path = inboxId
			? `/api/mail/inboxes/${inboxId}/webhooks`
			: "/api/mail/webhooks";
		return webhookWithSecret(await jsonRequest(this.options, path, input));
	}

	async updateWebhook(
		id: string,
		input: Partial<MailWebhookCreateInput> & {
			addInboxIds?: string[];
			addPodIds?: string[];
			removeHeaders?: string[];
			removeInboxIds?: string[];
			removePodIds?: string[];
			rotateSecret?: boolean;
		}
	): Promise<MailWebhookWithSecret> {
		return webhookWithSecret(
			await request(this.options, `/api/mail/webhooks/${id}`, {
				method: "PATCH",
				body: JSON.stringify(input),
			})
		);
	}

	/**
	 * Replace a managed webhook's signing secret. The new secret is returned
	 * once and the old one stops verifying immediately; a `legacy` webhook
	 * moves to `signatureScheme: "standard"`.
	 */
	async rotateWebhookSecret(id: string): Promise<MailWebhookWithSecret> {
		return this.updateWebhook(id, { rotateSecret: true });
	}

	async deleteWebhook(id: string): Promise<void> {
		await request(this.options, `/api/mail/webhooks/${id}`, {
			method: "DELETE",
		});
	}

	async listWebhookHeaders(id: string): Promise<string[]> {
		const response = await request(
			this.options,
			`/api/mail/webhooks/${id}/headers`
		);
		const source = record(response);
		return strings(source.headers ?? source.header_names);
	}

	async updateWebhookHeaders(
		id: string,
		headers: Record<string, string> = {},
		removeHeaders: string[] = []
	): Promise<string[]> {
		const response = await request(
			this.options,
			`/api/mail/webhooks/${id}/headers`,
			{
				method: "PATCH",
				body: JSON.stringify({ headers, removeHeaders }),
			}
		);
		const source = record(response);
		return strings(source.headers ?? source.header_names);
	}

	async listWebhookDeliveries(
		id: string,
		query?: { limit?: number }
	): Promise<MailWebhookDelivery[]> {
		const response = await request(
			this.options,
			`/api/mail/webhooks/${id}/deliveries${limitSuffix(query)}`
		);
		return array(record(response).deliveries).map(webhookDelivery);
	}

	async listEvents(
		inboxId?: string,
		eventType?: string,
		query?: { limit?: number }
	): Promise<MailEvent[]> {
		const params = new URLSearchParams();
		if (!inboxId && eventType) {
			params.set("eventType", eventType);
		}
		if (query?.limit !== undefined) {
			params.set("limit", String(query.limit));
		}
		const suffix = params.size ? `?${params}` : "";
		const path = inboxId
			? `/api/mail/inboxes/${inboxId}/events${suffix}`
			: `/api/mail/events${suffix}`;
		const response = await request(this.options, path);
		return array(record(response).events).map(toEvent);
	}

	async listPods(): Promise<MailPod[]> {
		const response = await request(this.options, "/api/mail/pods");
		return array(record(response).pods).map(pod);
	}

	async getPod(id: string): Promise<MailPod> {
		return pod(await request(this.options, `/api/mail/pods/${id}`));
	}

	async deletePod(id: string): Promise<void> {
		await request(this.options, `/api/mail/pods/${id}`, { method: "DELETE" });
	}

	async createPod(input: {
		clientId?: string;
		name: string;
	}): Promise<MailPod> {
		return pod(await jsonRequest(this.options, "/api/mail/pods", input));
	}

	async listDomains(): Promise<MailDomain[]> {
		const response = await request(this.options, "/api/mail/domains");
		return array(record(response).domains).map(domain);
	}

	async getDomain(id: string): Promise<MailDomain> {
		return domain(await request(this.options, `/api/mail/domains/${id}`));
	}

	async updateDomain(
		id: string,
		input: {
			podId?: string | null;
			subdomainsEnabled?: boolean;
			trackingEnabled?: boolean;
		}
	): Promise<MailDomain> {
		return domain(
			await request(this.options, `/api/mail/domains/${id}`, {
				method: "PATCH",
				body: JSON.stringify(input),
			})
		);
	}

	/**
	 * Ask the mail provider whether the domain's DNS records are published and
	 * return the updated domain: `verified`, still `pending` (DNS can take up
	 * to 72 hours), or `failed`. Hosted Agent Inboxes only.
	 */
	async verifyDomain(id: string): Promise<MailDomain> {
		return domain(
			await request(this.options, `/api/mail/domains/${id}/verify`, {
				method: "POST",
			})
		);
	}

	async deleteDomain(id: string): Promise<void> {
		await request(this.options, `/api/mail/domains/${id}`, {
			method: "DELETE",
		});
	}

	async listEntries(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string
	): Promise<MailListEntry[]> {
		const response = await request(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}`
		);
		return array(record(response).entries).map((value) => {
			const source = record(value);
			return {
				createdAt: String(source.createdAt ?? source.created_at ?? ""),
				entry: String(source.entry ?? ""),
				entryType: String(source.entryType ?? source.entry_type ?? "email"),
				id: String(source.id ?? ""),
				reason: nullableText(source.reason ?? null),
			};
		});
	}

	async addEntry(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string,
		input: { entry: string; entryType?: "email" | "domain"; reason?: string }
	): Promise<MailListEntry> {
		const response = await jsonRequest(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}`,
			input
		);
		return listEntry(record(response).entry ?? response);
	}

	async removeEntry(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string,
		entry: string
	): Promise<void> {
		await request(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}/${encodeURIComponent(entry)}`,
			{ method: "DELETE" }
		);
	}

	async createDomain(input: {
		clientId?: string;
		domain: string;
		podId?: string;
		subdomainsEnabled?: boolean;
		trackingEnabled?: boolean;
	}): Promise<MailDomain> {
		return domain(await jsonRequest(this.options, "/api/mail/domains", input));
	}

	/**
	 * Connect to the realtime stream. Close the returned socket when done.
	 *
	 * Credentials never go in the socket URL. Against a standalone Mail server the
	 * token rides in the `Sec-WebSocket-Protocol` header as
	 * `["ryu-mail.v1", "ryu-bearer.<token>"]`, and the server selects only
	 * `ryu-mail.v1`. Through Core (the default), pass a one-use `ticket` from
	 * `POST /api/ws/ticket` (`{ route: "ext", path: "/api/ext/ws/@ryu/mail/ws" }`);
	 * without one, this mints a ticket with the client's normal HTTP credentials,
	 * so the node token and user JWT never ride the upgrade URL (Core rejects
	 * `?token=`/`?jwt=` on this lane).
	 */
	async connectRealtime(
		onEvent: (event: MailEvent) => void,
		filters?: { eventTypes?: string[]; inboxIds?: string[] },
		options: { ticket?: string } = {}
	): Promise<WebSocket> {
		const standalone = this.options.mailRealtime === "standalone";
		const httpUrl = buildUrl(
			this.options,
			standalone ? "/api/mail/ws" : MAIL_CORE_REALTIME_PATH
		);
		const url = httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		const ticket = standalone
			? undefined
			: options.ticket?.trim() || (await this.mintWsTicket());
		const socketUrl = ticket
			? `${url}?${new URLSearchParams({ ticket })}`
			: url;
		const token = standalone ? this.options.token : undefined;
		if (token && !SUBPROTOCOL_TOKEN.test(token)) {
			// Never echo the token: the error text reaches logs and crash reports.
			throw new Error(
				"RyuClient: the Mail token contains characters not allowed in Sec-WebSocket-Protocol; use a hex or URL-safe (base64url without padding) token."
			);
		}
		const protocols = token
			? [MAIL_REALTIME_PROTOCOL, `ryu-bearer.${token}`]
			: undefined;
		return streamMailEvents(
			new WebSocket(socketUrl, protocols),
			onEvent,
			filters
		);
	}

	/**
	 * Hosted Mail only: mint a one-use realtime ticket. It is valid for 30
	 * seconds and opens one socket; {@link connectRealtimeWithTicket} mints one
	 * itself. `url` and `protocols` are what any WebSocket library needs. A
	 * self-hosted Mail server (`mailRealtime: "standalone"`) has no tickets and
	 * Core tunnels use {@link connectRealtime}; this throws for the former.
	 */
	async createRealtimeTicket(): Promise<MailRealtimeTicket> {
		assertHostedRealtime(this.options, "createRealtimeTicket");
		const source = record(
			await request(this.options, "/api/mail/realtime/tickets", {
				method: "POST",
			})
		);
		return {
			expiresAt: String(source.expiresAt ?? source.expires_at ?? ""),
			expiresIn: wireNumber(source.expiresIn ?? source.expires_in ?? 0),
			path: String(source.path ?? MAIL_HOSTED_REALTIME_PATH),
			protocols: strings(source.protocols),
			ticket: String(source.ticket ?? ""),
			url: hostedRealtimeUrl(this.options),
		};
	}

	/**
	 * Hosted Mail only: connect to the realtime stream with a node gateway key,
	 * a `ryu_` API key (`mail:read`) or a session. Mints a ticket with the
	 * client's normal credential (or uses `options.ticket`, a hosted ticket from
	 * {@link createRealtimeTicket}, not a Core `POST /api/ws/ticket` one), then
	 * opens `/api/mail/realtime` offering
	 * `["ryu-mail.v1", "ryu-ticket.<ticket>"]`; neither the key nor the ticket
	 * goes in the URL. The server closes the socket with code 4001 after 15
	 * minutes, or within a minute of the credential losing access: call this
	 * again to reconnect, and replay any gap with `listEvents`.
	 *
	 * Needs a global `WebSocket` (browsers, Bun, Deno, Node 22+) or
	 * `options.WebSocket` (e.g. the `ws` package on older Node); without one it
	 * throws before minting a ticket.
	 */
	async connectRealtimeWithTicket(
		onEvent: (event: MailEvent) => void,
		filters?: { eventTypes?: string[]; inboxIds?: string[] },
		options: { ticket?: string; WebSocket?: MailWebSocketConstructor } = {}
	): Promise<WebSocket> {
		assertHostedRealtime(this.options, "connectRealtimeWithTicket");
		const Socket: MailWebSocketConstructor | undefined =
			options.WebSocket ??
			(typeof WebSocket === "function" ? WebSocket : undefined);
		if (!Socket) {
			throw new Error(
				"RyuClient: this runtime has no global WebSocket (Node before 22). Pass { WebSocket } from the ws package to connectRealtimeWithTicket."
			);
		}
		const given = options.ticket?.trim();
		const minted = given ? undefined : await this.createRealtimeTicket();
		const ticket = given ?? minted?.ticket ?? "";
		if (!SUBPROTOCOL_TOKEN.test(ticket)) {
			// Never echo the ticket: the error text reaches logs and crash reports.
			throw new Error(
				"RyuClient: the Mail realtime ticket is missing or contains characters not allowed in Sec-WebSocket-Protocol."
			);
		}
		const socket = new Socket(minted?.url ?? hostedRealtimeUrl(this.options), [
			MAIL_REALTIME_PROTOCOL,
			`${MAIL_REALTIME_TICKET_PROTOCOL_PREFIX}${ticket}`,
		]);
		// Typed as the DOM WebSocket for existing callers; a `ws` socket offers
		// the same addEventListener / send / close surface at runtime.
		return streamMailEvents(socket as unknown as WebSocket, onEvent, filters);
	}

	/** Mint a fresh one-use ticket for Core's mail extension WebSocket lane. */
	private async mintWsTicket(): Promise<string> {
		const response = await jsonRequest(this.options, "/api/ws/ticket", {
			route: "ext",
			path: MAIL_CORE_REALTIME_PATH,
		});
		const ticket = record(response).ticket;
		if (typeof ticket !== "string" || ticket.trim() === "") {
			throw new Error("RyuClient: Core returned an invalid WebSocket ticket");
		}
		return ticket;
	}
}

/** The ticket methods are hosted-only; a self-hosted client is refused. */
function assertHostedRealtime(options: RyuClientOptions, method: string): void {
	if (options.mailRealtime === "standalone") {
		throw new Error(
			`RyuClient: mail.${method} is for hosted Mail; a self-hosted Mail server authenticates its socket with connectRealtime.`
		);
	}
}

/** Hosted Mail's absolute realtime socket URL (no credential in it). */
function hostedRealtimeUrl(options: RyuClientOptions): string {
	return buildUrl(options, MAIL_HOSTED_REALTIME_PATH)
		.replace(/^http:/, "ws:")
		.replace(/^https:/, "wss:");
}

/** Sends the filter on open and hands each event frame to `onEvent`. */
function streamMailEvents(
	socket: WebSocket,
	onEvent: (event: MailEvent) => void,
	filters?: { eventTypes?: string[]; inboxIds?: string[] }
): WebSocket {
	socket.addEventListener("open", () => {
		if (filters) {
			socket.send(JSON.stringify(filters));
		}
	});
	socket.addEventListener("message", (event) => {
		try {
			const source = record(
				wireJsonSchema.parse(JSON.parse(String(event.data)))
			);
			if (source.type === "event" && source.event) {
				onEvent(toEvent(source.event));
			}
		} catch {
			// Ignore keepalive/invalid frames; replay through listEvents if needed.
		}
	});
	return socket;
}
