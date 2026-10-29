import { z } from "zod";
import {
	isKnownMessagingWebhookEventType,
	messagingErrorBodySchema,
	messagingMessageListSchema,
	messagingMessageReplySchema,
	messagingMessageSchema,
	messagingNumberListSchema,
	messagingNumberQuoteSchema,
	messagingNumberReplySchema,
	messagingOptOutDeletedSchema,
	messagingOptOutListSchema,
	messagingOptOutReplySchema,
	messagingQuoteSchema,
	messagingSettingsReplySchema,
	messagingSettingsUpdateSchema,
	messagingStatusSchema,
	messagingWebhookEnvelopeSchema,
	messagingWebhookEventSchema,
	messagingWebhookSecretReplySchema,
	messagingWhatsAppSenderListSchema,
	messagingWhatsAppTemplateCreatedSchema,
	messagingWhatsAppTemplateListSchema,
} from "./messaging-contracts.ts";
import { isSafeRequestPath } from "./path-id.ts";
import type { RyuFetch } from "./types.ts";
import { wireJsonSchema } from "./wire-json.ts";

// packages/client/src/messaging.ts
//
// Client for the hosted Ryu Messaging API (`/api/messaging` on the Ryu control plane): SMS, MMS,
// voice messages and WhatsApp over AWS End User Messaging, leased phone numbers, the message log,
// the organization's opt-out list, settings, and the signed customer webhook. Every send and
// number purchase holds the organization's credit first and settles at the provider's price, so
// those writes always carry an `Idempotency-Key`.

/** The API version `GET /api/messaging/status` reports. */
export const MESSAGING_API_VERSION = "v1";

// ---------------------------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------------------------

/** A JSON value as it travels on the wire. */
export type MessagingJsonValue =
	| boolean
	| number
	| string
	| null
	| MessagingJsonValue[]
	| { [key: string]: MessagingJsonValue };

export type MessagingChannel = "sms" | "mms" | "voice" | "whatsapp";
export type MessagingDirection = "outbound" | "inbound";
/**
 * `queued` -> `sending` -> `accepted` (AWS returned a message id) -> `delivered` | `failed`.
 * `unresolved` is a send whose outcome is unknown (it may have been sent); `refused` is a send Ryu
 * declined before asking AWS. Inbound messages are `received`.
 */
export type MessagingMessageStatus =
	| "queued"
	| "sending"
	| "accepted"
	| "delivered"
	| "failed"
	| "unresolved"
	| "refused"
	| "received";
export type MessagingBodyType = "text" | "ssml" | "template" | "media";
export type MessagingSmsEncoding = "GSM" | "UCS2";
/** Where a message's charge is: `held` before the final price, then `settled` or `released`. */
export type MessagingChargeState =
	| "none"
	| "held"
	| "settling"
	| "settled"
	| "released"
	| "absorbed";
export type MessagingNumberType =
	| "LONG_CODE"
	| "TOLL_FREE"
	| "TEN_DLC"
	| "SIMULATOR";
export type MessagingNumberCapability = "SMS" | "VOICE" | "MMS";
export type MessagingMessageType = "TRANSACTIONAL" | "PROMOTIONAL";
export type MessagingNumberStatus =
	| "pending"
	| "active"
	| "suspended"
	| "releasing"
	| "released"
	| "failed";
export type MessagingWhatsAppSenderStatus = "active" | "disabled";
export type MessagingMmsContentType =
	| "image/jpeg"
	| "image/png"
	| "image/gif"
	| "video/mp4";

/** One message, outbound or inbound. Money is in micro-USD (1 USD = 1,000,000). */
export interface MessagingMessage {
	/**
	 * The part of the price Ryu absorbed.
	 *
	 * Above the hold, or uncovered.
	 */
	absorbedMicroUsd: number;
	/** The text, voice SSML or caption; null when there is none. */
	body: string | null;
	/**
	 * What `body` holds: `text`, voice `ssml`, a WhatsApp `template`, or `media`.
	 */
	bodyType: MessagingBodyType;
	/** `sms`, `mms`, `voice` or `whatsapp`. */
	channel: MessagingChannel;
	/** Micro-USD (1 USD = 1,000,000). */
	chargedMicroUsd: number;
	/**
	 * Billing state: `none` (nothing charged), `held` (the ceiling is held on
	 * your credit), `settling` (the price is fixed and the debit is being
	 * written), `settled` (debited and the hold released), `released` (the hold
	 * was released with no debit), or `absorbed` (Ryu absorbed the whole charge).
	 */
	chargeState: MessagingChargeState;
	/** When the message was created. */
	createdAt: string;
	/**
	 * `outbound` for a message you sent, `inbound` for one received on your
	 * number or sender.
	 */
	direction: MessagingDirection;
	/**
	 * The SMS encoding the quote used (`GSM` or `UCS2`, which fits fewer
	 * characters per segment); null for other channels.
	 */
	encoding: MessagingSmsEncoding | null;
	/** Why the message failed or was refused, for a person; null otherwise. */
	error: string | null;
	/**
	 * True when the charge settled at the price-list estimate because AWS
	 * reported no final price.
	 */
	estimated: boolean;
	/**
	 * The sender: your number, your WhatsApp sender's number, or the inbound
	 * party (E.164 for phone channels).
	 */
	from: string;
	/** True when the message carries MMS or WhatsApp media. */
	hasMedia: boolean;
	/** Micro-USD (1 USD = 1,000,000). */
	heldMicroUsd: number;
	/** The message id. */
	id: string;
	/**
	 * The remote party's country (ISO 3166-1 alpha-2): the destination outbound,
	 * the origin inbound.
	 */
	isoCountryCode: string | null;
	/** Your own string key-value data, as sent. */
	metadata: Record<string, string>;
	/** Your leased number used for SMS, MMS or voice; null otherwise. */
	numberId: string | null;
	/** The organization that owns the message. */
	organizationId: string;
	/** The settled price; null until it is known. */
	priceMicroUsd: number | null;
	/**
	 * AWS's message id (outbound) or the inbound provider id; null until known.
	 */
	providerMessageId: string | null;
	/** The latest status string AWS reported; null until one arrives. */
	providerStatus: string | null;
	/** AWS's description of `providerStatus`; null until one arrives. */
	providerStatusDescription: string | null;
	/** How many SMS parts the quote counted; 0 for other channels. */
	segments: number;
	/**
	 * `queued` → `sending` → `accepted` → `delivered` | `failed`. `unresolved`:
	 * the outcome is unknown (it may have been sent). `refused`: Ryu or AWS
	 * declined it before sending. Inbound messages are `received`.
	 */
	status: MessagingMessageStatus;
	/** The WhatsApp template's `name` and `language`; null when none was sent. */
	template: { language: string | null; name: string | null } | null;
	/** The recipient (E.164 for phone channels). */
	to: string;
	/**
	 * The time to live sent to AWS, in seconds; null for channels without one.
	 */
	ttlSeconds: number | null;
	/** When the message last changed. */
	updatedAt: string;
	/** Your WhatsApp sender used; null for other channels. */
	whatsappSenderId: string | null;
}

/** A leased phone number. */
export interface MessagingNumber {
	/** What the number can send. */
	capabilities: MessagingNumberCapability[];
	/** When the purchase was requested. */
	createdAt: string;
	/**
	 * When the paid period ends; the next period is charged before then. Null
	 * until active.
	 */
	currentPeriodEndsAt: string | null;
	/** Why the purchase or a renewal failed, for a person; null otherwise. */
	error: string | null;
	/**
	 * When a suspended number is released if still unpaid; null when it is not
	 * suspended.
	 */
	graceEndsAt: string | null;
	/** The number id. */
	id: string;
	/** The number's country (ISO 3166-1 alpha-2). */
	isoCountryCode: string;
	/** Your name for the number; null when unset. */
	label: string | null;
	/** The current lease period, counted from 0; each period is charged once. */
	leasePeriod: number;
	/**
	 * The AWS message type the number was requested for: `TRANSACTIONAL` or
	 * `PROMOTIONAL`.
	 */
	messageType: MessagingMessageType;
	/** Micro-USD (1 USD = 1,000,000). */
	monthlyLeaseMicroUsd: number;
	/** The kind of number, as AWS End User Messaging names it. */
	numberType: MessagingNumberType;
	/** The organization that leases the number. */
	organizationId: string;
	/** E.164; null until AWS confirms the purchase. */
	phoneNumber: string | null;
	/** The 10DLC or toll-free registration; US numbers of those types cannot send without one. */
	registrationId: string | null;
	/** When the number was released; null until then. */
	releasedAt: string | null;
	/**
	 * `pending` until AWS confirms the purchase, `active` while leased and paid
	 * for the current period, `suspended` when a renewal could not be paid
	 * (outbound is refused, inbound is still stored until `graceEndsAt`),
	 * `releasing` while it is given back, `released` once given back, `failed`
	 * when the purchase produced no number.
	 */
	status: MessagingNumberStatus;
	/** When the number was suspended; null when it is not. */
	suspendedAt: string | null;
	/** Whether inbound SMS to the number is received and stored. */
	twoWayEnabled: boolean;
	/** When the number last changed. */
	updatedAt: string;
}

/** A WhatsApp number a Ryu operator assigned to the organization. */
export interface MessagingWhatsAppSender {
	/** When the sender was assigned. */
	createdAt: string;
	/** True when the WhatsApp Business Account is the organization's alone; only then may it manage templates. */
	dedicatedWaba: boolean;
	/** The sender's phone number as WhatsApp displays it. */
	displayPhoneNumber: string;
	/** The sender id. */
	id: string;
	/** Your name for the sender; null when unset. */
	label: string | null;
	/** The organization the sender is assigned to. */
	organizationId: string;
	/** `active` senders can send; `disabled` ones cannot. */
	status: MessagingWhatsAppSenderStatus;
	/** When the sender last changed. */
	updatedAt: string;
	/** The WhatsApp Business Account the number belongs to. */
	wabaId: string;
}

export interface MessagingWhatsAppTemplate {
	category: string | null;
	language: string | null;
	metaTemplateId: string | null;
	name: string | null;
	qualityScore: string | null;
	status: string | null;
}

export interface MessagingWhatsAppTemplatePage {
	/** Pass as `nextToken` for the next page; null on the last page. */
	nextToken: string | null;
	/**
	 * The WhatsApp Business Account's message templates, with Meta's id, review
	 * status, language, category and quality score.
	 */
	templates: MessagingWhatsAppTemplate[];
}

export interface MessagingWhatsAppTemplateCreated {
	category: string | null;
	metaTemplateId: string | null;
	status: string | null;
}

export interface MessagingOptOut {
	/** True when the recipient opted out themselves (a STOP keyword). */
	endUserOptedOut: boolean;
	optedOutAt: string | null;
	phoneNumber: string;
}

export interface MessagingOptOutPage {
	/** Pass as `nextToken` for the next page; null on the last page. */
	nextToken: string | null;
	/**
	 * Opted-out phone numbers, when each opted out, and whether the recipient did
	 * it themselves.
	 */
	optOuts: MessagingOptOut[];
}

export interface MessagingSettings {
	/**
	 * Extra destination countries (ISO 3166-1 alpha-2) beyond the organization's
	 * own.
	 */
	allowedCountries: string[];
	/**
	 * The organization's own daily cap; null uses the default.
	 *
	 * Null uses `defaultDailySendLimit`.
	 */
	dailySendLimit: number | null;
	/** The daily send cap that applies when `dailySendLimit` is null. */
	defaultDailySendLimit: number;
	/** The organization the settings belong to. */
	organizationId: string;
	/**
	 * Whether a webhook signing secret exists. The secret itself is never
	 * returned here.
	 */
	webhookSecretSet: boolean;
	/** The URL message events are POSTed to; null when none is set. */
	webhookUrl: string | null;
}

/** The reply of `settings.update`. `webhookSecret` is present only when the first webhook URL minted it. */
export interface MessagingSettingsUpdate {
	/** The settings after the update. */
	settings: MessagingSettings;
	/**
	 * The new `whsec_` signing secret, present only when this update set the
	 * first webhook URL. It is not shown again.
	 */
	webhookSecret?: string;
}

/** The reply of `settings.rotateWebhookSecret`. The new secret is shown only here. */
export interface MessagingWebhookSecretRotation {
	/** The settings after the rotation. */
	settings: MessagingSettings;
	/** The new `whsec_` signing secret. The old one stops verifying at once. */
	webhookSecret: string;
}

export interface MessagingStatus {
	/** The Messaging API version. */
	apiVersion: string;
	/** Whether each channel can be used on this server. */
	channels: { mms: boolean; sms: boolean; voice: boolean; whatsapp: boolean };
	/** Whether Messaging is configured on this server at all. */
	configured: boolean;
}

export interface MessagingCredit {
	/**
	 * Credits minus open holds, in micro-USD (a sum of buckets, not always
	 * whole).
	 */
	availableMicroUsd: number;
	/**
	 * Credit held by open holds, in micro-USD; `availableMicroUsd` already
	 * excludes it.
	 */
	heldMicroUsd: number;
}

export interface MessagingSmsQuote {
	ceilingMicroUsd: number;
	encoding: MessagingSmsEncoding | null;
	isoCountryCode: string;
	segments: number;
}

export interface MessagingVoiceQuote {
	ceilingMicroUsd: number;
	estimatedMinutes: number;
	isoCountryCode: string;
	perMinuteMicroUsd: number;
}

export interface MessagingWhatsAppQuote {
	awsFeeMicroUsd: number;
	ceilingMicroUsd: number;
	isoCountryCode: string;
}

/** The hold a send would place: the most it can cost, not the final price. */
export type MessagingQuote =
	| { channel: "mms"; credit: MessagingCredit; quote: MessagingSmsQuote }
	| { channel: "sms"; credit: MessagingCredit; quote: MessagingSmsQuote }
	| { channel: "voice"; credit: MessagingCredit; quote: MessagingVoiceQuote }
	| {
			channel: "whatsapp";
			credit: MessagingCredit;
			quote: MessagingWhatsAppQuote;
	  };

export interface MessagingNumberQuote {
	/** The organization's credit. */
	credit: MessagingCredit;
	/** The country quoted. */
	isoCountryCode: string;
	/** The number type quoted. */
	numberType: MessagingNumberType;
	/**
	 * `setupFeeMicroUsd` and `monthlyLeaseMicroUsd`, and `ceilingMicroUsd`, the
	 * hold a purchase places; all in micro-USD.
	 */
	quote: {
		ceilingMicroUsd: number;
		monthlyLeaseMicroUsd: number;
		setupFeeMicroUsd: number;
	};
}

export interface MessagingMessagePage {
	/** Messages, newest first. */
	messages: MessagingMessage[];
	/** Pass as `cursor` for the next (older) page; null on the last page. */
	nextCursor: string | null;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export type MessagingQuoteInput =
	| { body: string; channel: "sms"; to: string }
	| { body?: string; channel: "mms"; to: string }
	| {
			body: string;
			bodyType?: "ssml" | "text";
			channel: "voice";
			to: string;
	  }
	| { channel: "whatsapp"; mode?: "template" | "text"; to: string };

export interface MessagingNumberQuoteInput {
	/** ISO 3166-1 alpha-2, for example `US`. */
	country: string;
	type: MessagingNumberType;
}

export interface BuyMessagingNumberInput {
	/** What the number must be able to send. */
	capabilities: MessagingNumberCapability[];
	/** ISO 3166-1 alpha-2. */
	isoCountryCode: string;
	/** A name to recognize the number by. */
	label?: string | null;
	/** The number's default message type for SMS sends. */
	messageType?: MessagingMessageType;
	/** The kind of number to lease, as AWS End User Messaging names it. */
	numberType: MessagingNumberType;
}

export interface MessagingNumberListQuery {
	/** `held` (the default) lists the numbers the organization holds; `all` adds history. */
	status?: "all" | "held";
}

export interface UpdateMessagingNumberInput {
	/** The new label, or null to clear it. */
	label: string | null;
}

interface MessagingSendFields {
	/**
	 * Up to 16 entries (keys up to 64 characters, values up to 512); returned on
	 * the message and its webhooks.
	 */
	metadata?: Record<string, string>;
	/** An E.164 phone number. */
	to: string;
}

export interface SendMessagingSmsInput extends MessagingSendFields {
	/** The text, 1 to 1,600 characters and not only whitespace. */
	body: string;
	/** The id of one of the organization's numbers with the SMS capability. */
	from: string;
	/** Defaults to the number's message type. */
	messageType?: MessagingMessageType;
	/**
	 * How long AWS keeps trying to deliver, in seconds.
	 *
	 * 5 to 259200 seconds.
	 */
	ttlSeconds?: number;
}

export interface SendMessagingMmsInput extends MessagingSendFields {
	/** Optional text sent with the media. */
	body?: string;
	/** The id of one of the organization's numbers with the MMS capability. */
	from: string;
	/**
	 * One image or video; the whole MMS body is at most 1 MiB.
	 *
	 * The media as base64; at most 600 KiB decoded.
	 */
	media: { base64: string; contentType: MessagingMmsContentType };
	/** How long AWS keeps trying to deliver, in seconds. */
	ttlSeconds?: number;
}

interface SendMessagingVoiceFields extends MessagingSendFields {
	/** The id of one of the organization's numbers with the VOICE capability. */
	from: string;
	/** How long AWS keeps trying to deliver, in seconds. */
	ttlSeconds?: number;
	/** An Amazon Polly voice id, for example `JOANNA`. */
	voiceId?: string;
}

/** Exactly one of `text` or `ssml`. */
export type SendMessagingVoiceInput =
	| (SendMessagingVoiceFields & { ssml?: never; text: string })
	| (SendMessagingVoiceFields & { ssml: string; text?: never });

export interface MessagingWhatsAppTemplateInput {
	components?: MessagingJsonValue[];
	language: string;
	name: string;
}

interface SendMessagingWhatsAppFields extends MessagingSendFields {
	/** A WhatsApp sender Ryu assigned to the organization. */
	senderId: string;
}

/**
 * Exactly one of `template` or `text`. Free-form `text` is accepted only within 24 hours of the
 * contact's last message; outside that window send a template.
 */
export type SendMessagingWhatsAppInput =
	| (SendMessagingWhatsAppFields & {
			previewUrl?: never;
			template: MessagingWhatsAppTemplateInput;
			text?: never;
	  })
	| (SendMessagingWhatsAppFields & {
			previewUrl?: boolean;
			template?: never;
			text: string;
	  });

export interface MessagingMessageListQuery {
	channel?: MessagingChannel;
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	direction?: MessagingDirection;
	/** 1 to 200; default 50. */
	limit?: number;
	status?: MessagingMessageStatus;
}

export interface MessagingTokenPageQuery {
	/** The `nextToken` of the previous page. */
	nextToken?: string;
}

export interface UpdateMessagingSettingsInput {
	/**
	 * Destination countries beyond those of the organization's own numbers and
	 * WhatsApp senders.
	 *
	 * ISO 3166-1 alpha-2 codes.
	 */
	allowedCountries?: string[];
	/**
	 * null restores the default.
	 *
	 * 0 to 100000.
	 */
	dailySendLimit?: number | null;
	/** A public HTTPS URL; null removes the webhook. */
	webhookUrl?: string | null;
}

export interface MessagingWriteOptions {
	/**
	 * Up to 255 characters. Generated when omitted, so pass your own key to retry a send or
	 * purchase safely: the same key and body replay the first result instead of charging twice.
	 */
	idempotencyKey?: string;
}

export interface MessagingClientOptions {
	/** Sent as `x-api-key`; keys never go in URLs. */
	apiKey: string;
	/** Control-plane origin, for example `https://api.ryuhq.com`. The client appends `/api/messaging`. */
	baseUrl: string;
	fetch?: RyuFetch;
	/** The organization whose numbers and credit the client uses. Also sent as `X-Ryu-Organization`. */
	organizationId: string;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** `code` of a {@link MessagingError} built from a reply that did not carry the error body. */
export const MESSAGING_UNKNOWN_ERROR_CODE = "unknown_error";

/**
 * `code` of a {@link MessagingError} for a redirect reply. The client never follows a redirect,
 * because fetch would resend `x-api-key` to the new origin.
 */
export const MESSAGING_REDIRECT_ERROR_CODE = "redirect_refused";

export interface MessagingErrorInit {
	code: string;
	details: Record<string, unknown>;
	message: string;
	retryAfterSeconds: number | null;
	status: number;
}

/**
 * A non-2xx reply. `code` is the server's stable `error` code (`insufficient_credits`,
 * `outcome_unknown`, `price_changed`, `recipient_opted_out`, ...); `details` holds the other
 * fields of the reply, for example `availableMicroUsd` and `requiredMicroUsd` on a 402. A send's
 * `outcome_unknown` or `provider_refused` (502) carries the stored message as
 * `details.messageRecord` (read it with {@link messagingErrorMessageRecord}). A number purchase's
 * `outcome_unknown` is finished by retrying with the same idempotency key.
 */
export class MessagingError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;
	/** `Retry-After`, in seconds, when the reply carried it. */
	readonly retryAfterSeconds: number | null;
	readonly status: number;

	constructor(init: MessagingErrorInit) {
		super(init.message);
		this.name = "MessagingError";
		this.code = init.code;
		this.details = init.details;
		this.retryAfterSeconds = init.retryAfterSeconds;
		this.status = init.status;
	}
}

/**
 * The stored message a send's `outcome_unknown` or `provider_refused` reply carries, or null.
 * Follow it with `messages.get(id)` before sending again with a new idempotency key.
 */
export function messagingErrorMessageRecord(
	error: MessagingError
): MessagingMessage | null {
	const parsed = messagingMessageSchema.safeParse(error.details.messageRecord);
	return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

const MESSAGING_PATH = "/api/messaging";
const TRAILING_SLASHES = /\/+$/u;
const DIGITS = /^\d+$/u;
const ERROR_TEXT_CHARS = 512;

type QueryValue = number | string | undefined;

function buildQuery(params: Record<string, QueryValue>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

/**
 * Encodes one path id, refusing `""`, `"."` and `".."` before any request:
 * those would resolve onto another route (`/numbers/..` is `/orgs/{org}`).
 */
function segment(value: string): string {
	if (value === "" || value === "." || value === "..") {
		throw invalidIdError();
	}
	return encodeURIComponent(value);
}

/** The refusal for an empty or dot path id, raised before any request. */
function invalidIdError(): MessagingError {
	return new MessagingError({
		code: "invalid_id",
		details: {},
		message: `Ryu Messaging: a path id must be a non-empty id other than "." or "..".`,
		retryAfterSeconds: null,
		status: 0,
	});
}

function parseJsonText(text: string): unknown {
	try {
		return wireJsonSchema.parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function parseRetryAfter(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (DIGITS.test(trimmed)) {
		return Number(trimmed);
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) {
		return null;
	}
	return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function errorFromResponse(
	response: Response,
	method: string,
	path: string
): Promise<MessagingError> {
	const text = await response.text().catch(() => "");
	const retryAfterSeconds = parseRetryAfter(
		response.headers.get("Retry-After")
	);
	const parsed = messagingErrorBodySchema.safeParse(parseJsonText(text));
	if (parsed.success) {
		const { error, message, ...details } = parsed.data;
		return new MessagingError({
			code: error,
			details,
			message,
			retryAfterSeconds,
			status: response.status,
		});
	}
	const excerpt = text.trim().slice(0, ERROR_TEXT_CHARS);
	return new MessagingError({
		code: MESSAGING_UNKNOWN_ERROR_CODE,
		details: {},
		message: `Ryu Messaging: ${method} ${path} failed (${response.status})${excerpt ? `: ${excerpt}` : ""}`,
		retryAfterSeconds,
		status: response.status,
	});
}

function isRedirect(response: Response): boolean {
	return (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	);
}

/** The origin of a `Location` header, never its path or query. */
function redirectOrigin(location: string | null, url: string): string | null {
	if (location === null) {
		return null;
	}
	try {
		return new URL(location, url).origin;
	} catch {
		return null;
	}
}

/**
 * A fresh idempotency key. Some runtimes omit Web Crypto, so fall back to a random string: the
 * key only has to be unique per request, not secret.
 */
function newIdempotencyKey(): string {
	const randomUUID = z
		.function({ input: [], output: z.string() })
		.safeParse(globalThis.crypto?.randomUUID);
	if (randomUUID.success) {
		return randomUUID.data.call(globalThis.crypto);
	}
	const random = () => Math.random().toString(36).slice(2, 12);
	return `${Date.now().toString(36)}-${random()}${random()}`;
}

interface JsonInit {
	body?: object;
	idempotencyKey?: string;
}

/** Shared HTTP layer: base URL, `x-api-key`, the organization and the error body. */
export class MessagingTransport {
	readonly organizationPath: string;
	private readonly options: MessagingClientOptions;

	constructor(options: MessagingClientOptions) {
		this.options = options;
		// Not `segment` here: credential-free `status()` builds a client without an
		// organization. `json` refuses an empty or dot id on org-scoped paths.
		this.organizationPath = `/orgs/${encodeURIComponent(options.organizationId)}`;
	}

	/** Sends a request and validates the JSON reply with `schema`. */
	async json<T>(
		method: string,
		path: string,
		schema: z.ZodType<T>,
		init: JsonInit = {}
	): Promise<T> {
		// Checked here, not in the constructor: credential-free `status()` builds a
		// client without an organization, and only org-scoped paths need one.
		if (path.startsWith(this.organizationPath)) {
			segment(this.options.organizationId);
		}
		// The whole path too, as Mail, Box and Notify do: an empty organization
		// id leaves `/orgs//…`, and no segment may resolve onto another route.
		if (!isSafeRequestPath(path)) {
			throw invalidIdError();
		}
		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Ryu-Organization": this.options.organizationId,
			"x-api-key": this.options.apiKey,
		};
		if (init.body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		if (init.idempotencyKey !== undefined) {
			headers["Idempotency-Key"] = init.idempotencyKey;
		}
		const base = this.options.baseUrl.replace(TRAILING_SLASHES, "");
		const url = `${base}${MESSAGING_PATH}${path}`;
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		// Never follow a redirect: fetch resends custom headers, so following would hand
		// `x-api-key` to whatever origin `Location` names.
		const response = await fetchImpl(url, {
			body: init.body === undefined ? null : JSON.stringify(init.body),
			headers,
			method,
			redirect: "manual",
		});
		if (isRedirect(response)) {
			await response.body?.cancel().catch(() => undefined);
			throw new MessagingError({
				code: MESSAGING_REDIRECT_ERROR_CODE,
				details: {
					location: redirectOrigin(response.headers.get("Location"), url),
				},
				message: `Ryu Messaging: ${method} ${path} was redirected (${response.status}); the client does not follow redirects, so check baseUrl`,
				retryAfterSeconds: null,
				status: response.status,
			});
		}
		if (!response.ok) {
			throw await errorFromResponse(response, method, path);
		}
		const text = await response.text();
		return schema.parse(
			text ? wireJsonSchema.parse(JSON.parse(text)) : undefined
		);
	}

	/** A path under `/orgs/{organizationId}`. */
	org(path: string): string {
		return `${this.organizationPath}${path}`;
	}
}

function writeInit(body: object, options: MessagingWriteOptions): JsonInit {
	return {
		body,
		idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
	};
}

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

/** Leased phone numbers. A purchase charges the first month up front. */
export class MessagingNumbersAPI {
	private readonly transport: MessagingTransport;

	constructor(transport: MessagingTransport) {
		this.transport = transport;
	}

	/**
	 * The numbers the organization holds (`pending` through `releasing`), newest first.
	 * `{ status: "all" }` adds released and failed numbers (at most 200 in all).
	 */
	async list(query: MessagingNumberListQuery = {}): Promise<MessagingNumber[]> {
		const reply = await this.transport.json(
			"GET",
			this.transport.org(`/numbers${buildQuery({ status: query.status })}`),
			messagingNumberListSchema
		);
		return reply.numbers;
	}

	/** The first month's charge for a country and number type, and the organization's credit. */
	quote(input: MessagingNumberQuoteInput): Promise<MessagingNumberQuote> {
		return this.transport.json(
			"GET",
			this.transport.org(
				`/numbers/quote${buildQuery({ country: input.country, type: input.type })}`
			),
			messagingNumberQuoteSchema
		);
	}

	/**
	 * Lease a number. A `price_changed` refusal (409) means AWS quoted more than Ryu's price table;
	 * the number was given back and nothing was charged.
	 */
	async buy(
		input: BuyMessagingNumberInput,
		options: MessagingWriteOptions = {}
	): Promise<MessagingNumber> {
		const reply = await this.transport.json(
			"POST",
			this.transport.org("/numbers"),
			messagingNumberReplySchema,
			writeInit(input, options)
		);
		return reply.number;
	}

	async update(
		id: string,
		input: UpdateMessagingNumberInput
	): Promise<MessagingNumber> {
		const reply = await this.transport.json(
			"PATCH",
			this.transport.org(`/numbers/${segment(id)}`),
			messagingNumberReplySchema,
			{ body: input }
		);
		return reply.number;
	}

	/** Give the number back to AWS. Releasing a released number returns it unchanged. */
	async release(id: string): Promise<MessagingNumber> {
		const reply = await this.transport.json(
			"DELETE",
			this.transport.org(`/numbers/${segment(id)}`),
			messagingNumberReplySchema
		);
		return reply.number;
	}
}

/** Sends on one channel; each returns the stored message once AWS accepted it. */
export class MessagingSendAPI<Input extends object> {
	protected readonly transport: MessagingTransport;
	private readonly path: string;

	constructor(transport: MessagingTransport, path: string) {
		this.transport = transport;
		this.path = path;
	}

	/**
	 * Hold the quoted ceiling, send, and return the message (`accepted`). An `outcome_unknown`
	 * refusal (502) means it may have been sent: check `messages.list` before sending it again.
	 */
	async send(
		input: Input,
		options: MessagingWriteOptions = {}
	): Promise<MessagingMessage> {
		const reply = await this.transport.json(
			"POST",
			this.transport.org(this.path),
			messagingMessageReplySchema,
			writeInit(input, options)
		);
		return reply.message;
	}
}

/** Templates of a sender with its own WhatsApp Business Account. */
export class MessagingWhatsAppTemplatesAPI {
	private readonly transport: MessagingTransport;

	constructor(transport: MessagingTransport) {
		this.transport = transport;
	}

	async list(
		senderId: string,
		query: MessagingTokenPageQuery = {}
	): Promise<MessagingWhatsAppTemplatePage> {
		return this.transport.json(
			"GET",
			this.transport.org(
				`/whatsapp/senders/${segment(senderId)}/templates${buildQuery({ nextToken: query.nextToken })}`
			),
			messagingWhatsAppTemplateListSchema
		);
	}

	/** Submit Meta's template definition JSON for review. */
	async create(
		senderId: string,
		definition: Record<string, MessagingJsonValue>
	): Promise<MessagingWhatsAppTemplateCreated> {
		const reply = await this.transport.json(
			"POST",
			this.transport.org(`/whatsapp/senders/${segment(senderId)}/templates`),
			messagingWhatsAppTemplateCreatedSchema,
			{ body: { definition } }
		);
		return reply.template;
	}
}

export class MessagingWhatsAppAPI extends MessagingSendAPI<SendMessagingWhatsAppInput> {
	readonly templates: MessagingWhatsAppTemplatesAPI;

	constructor(transport: MessagingTransport) {
		super(transport, "/whatsapp");
		this.templates = new MessagingWhatsAppTemplatesAPI(transport);
	}

	/** The WhatsApp numbers assigned to the organization. */
	async senders(): Promise<MessagingWhatsAppSender[]> {
		const reply = await this.transport.json(
			"GET",
			this.transport.org("/whatsapp/senders"),
			messagingWhatsAppSenderListSchema
		);
		return reply.senders;
	}
}

/** The message log, newest first. */
export class MessagingMessagesAPI {
	private readonly transport: MessagingTransport;

	constructor(transport: MessagingTransport) {
		this.transport = transport;
	}

	list(query: MessagingMessageListQuery = {}): Promise<MessagingMessagePage> {
		return this.transport.json(
			"GET",
			this.transport.org(
				`/messages${buildQuery({
					channel: query.channel,
					cursor: query.cursor,
					direction: query.direction,
					limit: query.limit,
					status: query.status,
				})}`
			),
			messagingMessageListSchema
		);
	}

	async get(id: string): Promise<MessagingMessage> {
		const reply = await this.transport.json(
			"GET",
			this.transport.org(`/messages/${segment(id)}`),
			messagingMessageReplySchema
		);
		return reply.message;
	}
}

/** The organization's opt-out list. Sends to a listed number are refused. */
export class MessagingOptOutsAPI {
	private readonly transport: MessagingTransport;

	constructor(transport: MessagingTransport) {
		this.transport = transport;
	}

	list(query: MessagingTokenPageQuery = {}): Promise<MessagingOptOutPage> {
		return this.transport.json(
			"GET",
			this.transport.org(
				`/opt-outs${buildQuery({ nextToken: query.nextToken })}`
			),
			messagingOptOutListSchema
		);
	}

	async add(phoneNumber: string): Promise<{ phoneNumber: string }> {
		const reply = await this.transport.json(
			"POST",
			this.transport.org("/opt-outs"),
			messagingOptOutReplySchema,
			{ body: { phoneNumber } }
		);
		return reply.optOut;
	}

	/** Remove a number; removing a number that is not listed succeeds. */
	async remove(phoneNumber: string): Promise<void> {
		await this.transport.json(
			"DELETE",
			this.transport.org(`/opt-outs/${segment(phoneNumber)}`),
			messagingOptOutDeletedSchema
		);
	}
}

export class MessagingSettingsAPI {
	private readonly transport: MessagingTransport;

	constructor(transport: MessagingTransport) {
		this.transport = transport;
	}

	async get(): Promise<MessagingSettings> {
		const reply = await this.transport.json(
			"GET",
			this.transport.org("/settings"),
			messagingSettingsReplySchema
		);
		return reply.settings;
	}

	/** Setting the first webhook URL mints the signing secret, returned only in this reply. */
	update(
		input: UpdateMessagingSettingsInput
	): Promise<MessagingSettingsUpdate> {
		return this.transport.json(
			"PUT",
			this.transport.org("/settings"),
			messagingSettingsUpdateSchema,
			{ body: input }
		);
	}

	/** Replace the webhook signing secret; the old one stops verifying immediately. */
	rotateWebhookSecret(): Promise<MessagingWebhookSecretRotation> {
		return this.transport.json(
			"POST",
			this.transport.org("/settings/webhook-secret/rotate"),
			messagingWebhookSecretReplySchema
		);
	}
}

/** The Ryu Messaging API. Create one with {@link createMessagingClient}. */
export class MessagingAPI {
	readonly messages: MessagingMessagesAPI;
	readonly mms: MessagingSendAPI<SendMessagingMmsInput>;
	readonly numbers: MessagingNumbersAPI;
	readonly optOuts: MessagingOptOutsAPI;
	readonly settings: MessagingSettingsAPI;
	readonly sms: MessagingSendAPI<SendMessagingSmsInput>;
	readonly voice: MessagingSendAPI<SendMessagingVoiceInput>;
	readonly whatsapp: MessagingWhatsAppAPI;
	private readonly transport: MessagingTransport;

	constructor(options: MessagingClientOptions) {
		const transport = new MessagingTransport(options);
		this.transport = transport;
		this.messages = new MessagingMessagesAPI(transport);
		this.mms = new MessagingSendAPI(transport, "/mms");
		this.numbers = new MessagingNumbersAPI(transport);
		this.optOuts = new MessagingOptOutsAPI(transport);
		this.settings = new MessagingSettingsAPI(transport);
		this.sms = new MessagingSendAPI(transport, "/sms");
		this.voice = new MessagingSendAPI(transport, "/voice");
		this.whatsapp = new MessagingWhatsAppAPI(transport);
	}

	/** Whether the service is configured and which channels it can send on. Needs no permission. */
	status(): Promise<MessagingStatus> {
		return this.transport.json("GET", "/status", messagingStatusSchema);
	}

	/** The hold a send would place, and the organization's available credit, without sending. */
	quote(input: MessagingQuoteInput): Promise<MessagingQuote> {
		const params: Record<string, QueryValue> = { ...input };
		return this.transport.json(
			"GET",
			this.transport.org(`/quote${buildQuery(params)}`),
			messagingQuoteSchema
		);
	}
}

export function createMessagingClient(
	options: MessagingClientOptions
): MessagingAPI {
	return new MessagingAPI(options);
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export type MessagingWebhookEventType =
	| "message.received"
	| "message.delivered"
	| "message.failed"
	| "number.suspended"
	| "number.released";

interface MessagingWebhookEnvelope {
	/** Deterministic per provider event; deduplicate on it (it equals the `webhook-id` header). */
	event_id: string;
	type: "event";
}

/** A verified delivery of a type this client knows. */
export type MessagingWebhookEvent =
	| (MessagingWebhookEnvelope & {
			data: { message: MessagingMessage };
			event_type: "message.delivered" | "message.failed" | "message.received";
	  })
	| (MessagingWebhookEnvelope & {
			data: { number: MessagingNumber };
			event_type: "number.released" | "number.suspended";
	  });

/** A verified delivery whose type is newer than this client. Acknowledge it and ignore it. */
export interface MessagingUnknownWebhookEvent extends MessagingWebhookEnvelope {
	data: Record<string, MessagingJsonValue>;
	event_type: string;
}

/** Why {@link verifyMessagingWebhook} refused a delivery. */
export type MessagingWebhookVerificationReason =
	| "invalid_payload"
	| "invalid_secret"
	| "invalid_signature"
	| "missing_headers"
	| "timestamp_out_of_range";

export class MessagingWebhookVerificationError extends Error {
	readonly reason: MessagingWebhookVerificationReason;

	constructor(reason: MessagingWebhookVerificationReason, message: string) {
		super(message);
		this.name = "MessagingWebhookVerificationError";
		this.reason = reason;
	}
}

/** Request headers as `Headers` or a Node-style record (`IncomingHttpHeaders`). */
export type MessagingWebhookHeaders =
	| Headers
	| Readonly<Record<string, readonly string[] | string | undefined>>;

export interface VerifyMessagingWebhookOptions {
	/** The time to check the timestamp against. Default: now. */
	now?: Date;
	/** How far `webhook-timestamp` may be from `now`. Default 300 seconds. */
	toleranceSeconds?: number;
}

const WEBHOOK_SECRET_PREFIX = "whsec_";
const STRICT_BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DEFAULT_TOLERANCE_SECONDS = 300;

function headerValue(
	headers: MessagingWebhookHeaders,
	name: string
): string | null {
	if (headers instanceof Headers) {
		return headers.get(name);
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) {
			const first = typeof value === "string" ? value : value?.[0];
			return first ?? null;
		}
	}
	return null;
}

function signedHeader(
	headers: MessagingWebhookHeaders,
	suffix: string
): string | null {
	return (
		headerValue(headers, `webhook-${suffix}`) ??
		headerValue(headers, `svix-${suffix}`)
	);
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> | null {
	if (!(value && STRICT_BASE64.test(value))) {
		return null;
	}
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function requireSubtle(): SubtleCrypto {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new MessagingWebhookVerificationError(
			"invalid_secret",
			"Web Crypto (crypto.subtle) is not available in this runtime"
		);
	}
	return subtle;
}

/**
 * Verify a Ryu Messaging webhook delivery ([Standard Webhooks](https://www.standardwebhooks.com/):
 * HMAC-SHA256 over `id.timestamp.body`, keyed by the base64 part of the `whsec_` secret) and
 * return its event. Pass the raw request body exactly as received; a re-serialized body does not
 * verify. Accepts the `webhook-*` headers and their `svix-*` copies. Throws
 * {@link MessagingWebhookVerificationError} when the delivery is not authentic or is too old.
 */
export async function verifyMessagingWebhook(
	secret: string,
	headers: MessagingWebhookHeaders,
	body: string | Uint8Array,
	options: VerifyMessagingWebhookOptions = {}
): Promise<MessagingUnknownWebhookEvent | MessagingWebhookEvent> {
	const id = signedHeader(headers, "id");
	const timestamp = signedHeader(headers, "timestamp");
	const signature = signedHeader(headers, "signature");
	if (!(id && timestamp && signature)) {
		throw new MessagingWebhookVerificationError(
			"missing_headers",
			"the webhook-id, webhook-timestamp and webhook-signature headers are required"
		);
	}
	const key = base64Bytes(
		secret.startsWith(WEBHOOK_SECRET_PREFIX)
			? secret.slice(WEBHOOK_SECRET_PREFIX.length)
			: secret
	);
	if (!key) {
		throw new MessagingWebhookVerificationError(
			"invalid_secret",
			"the webhook secret must be whsec_ followed by base64"
		);
	}
	const seconds = DIGITS.test(timestamp) ? Number(timestamp) : Number.NaN;
	const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
	const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	if (!Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > tolerance) {
		throw new MessagingWebhookVerificationError(
			"timestamp_out_of_range",
			"the webhook timestamp is outside the allowed tolerance"
		);
	}
	const text = typeof body === "string" ? body : new TextDecoder().decode(body);
	const subtle = requireSubtle();
	const hmac = await subtle.importKey(
		"raw",
		key,
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["verify"]
	);
	const signed = new TextEncoder().encode(`${id}.${timestamp}.${text}`);
	let verified = false;
	for (const candidate of signature.split(" ")) {
		const [version, encoded] = candidate.split(",", 2);
		const bytes = version === "v1" && encoded ? base64Bytes(encoded) : null;
		if (bytes && (await subtle.verify("HMAC", hmac, bytes, signed))) {
			verified = true;
			break;
		}
	}
	if (!verified) {
		throw new MessagingWebhookVerificationError(
			"invalid_signature",
			"no webhook signature matches this secret and body"
		);
	}
	const payload = parseJsonText(text);
	const envelope = messagingWebhookEnvelopeSchema.safeParse(payload);
	if (!envelope.success) {
		throw new MessagingWebhookVerificationError(
			"invalid_payload",
			"the webhook body is not a Ryu Messaging event"
		);
	}
	if (!isKnownMessagingWebhookEventType(envelope.data.event_type)) {
		return envelope.data;
	}
	const event = messagingWebhookEventSchema.safeParse(payload);
	if (!event.success) {
		throw new MessagingWebhookVerificationError(
			"invalid_payload",
			`the ${envelope.data.event_type} event does not match its contract`
		);
	}
	return event.data;
}

/** Whether a verified event is a type this client knows (and so carries a typed `data`). */
export function isKnownMessagingWebhookEvent(
	event: MessagingUnknownWebhookEvent | MessagingWebhookEvent
): event is MessagingWebhookEvent {
	return isKnownMessagingWebhookEventType(event.event_type);
}
