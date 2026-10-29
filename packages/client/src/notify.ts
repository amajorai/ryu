import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import {
	analyticsSchema,
	deliverySchema,
	destinationSchema,
	destinationTestSchema,
	eventListSchema,
	groupSchema,
	notificationEventSchema,
	notifyActivitySchema,
	preferencesSchema,
	silenceSchema,
	topicSchema,
	usageReportSchema,
} from "./notify-contracts.ts";
import { assertSafeRequestPath, encodePathId } from "./path-id.ts";
import { buildHeaders, buildUrl, request as sendRequest } from "./request.ts";
import type { RyuClientOptions, RyuFetch } from "./types.ts";
import { wireJsonRecordSchema, wireJsonSchema } from "./wire-json.ts";

export type NotificationLevel =
	| "info"
	| "success"
	| "warning"
	| "error"
	| "critical";
export type NotificationPriority = 1 | 2 | 3 | 4 | 5;
export type NotificationResponseType = "approval" | "yes_no" | "text";
export type NotificationResponseStatus =
	| "pending"
	| "approved"
	| "denied"
	| "yes"
	| "no"
	| "replied"
	| "expired"
	| "canceled";

export interface NotificationAction {
	label: string;
	url: string;
}

export interface NotificationAttachment {
	contentType: string | null;
	name: string | null;
	url: string;
}

export interface NotificationResponse {
	/**
	 * @deprecated In event reads, history, and stream frames a future Notify
	 * release returns null here, because the URL can carry a capability. Use
	 * `callbackUrlPreview` to display the callback.
	 */
	callbackUrl: string | null;
	/**
	 * The callback URL's origin followed by `/…`, or null without a callback.
	 * Older Notify servers do not send it.
	 */
	callbackUrlPreview?: string | null;
	expiresAt: string | null;
	prompt: string | null;
	respondedAt: string | null;
	status: NotificationResponseStatus;
	type: NotificationResponseType;
	value: string | null;
}

export interface NotifyEventInput {
	/** Up to three link actions, each an absolute HTTPS `url` with a `label`. */
	actions?: NotificationAction[];
	/**
	 * A metadata-only HTTPS attachment reference (an object, or just its URL).
	 * Notify does not fetch it.
	 */
	attachment?: NotificationAttachment | string;
	/** Plain-text description, up to 16 KiB. */
	body?: string;
	/**
	 * A JSON object up to 64 KiB. Keys that look like credentials are redacted
	 * before storage.
	 */
	data?: z.infer<typeof wireJsonRecordSchema>;
	/** Your own identifier for the event, to look it up later. */
	externalId?: string;
	/**
	 * A grouping and filter hint (`GET /v1/groups`, silences). It never merges
	 * events.
	 */
	fingerprint?: string;
	/** An absolute HTTPS icon URL for clients to show. */
	icon?: string;
	/** Severity. Default `info`. */
	level?: NotificationLevel;
	/** When it happened (RFC 3339), normalized to UTC. Defaults to now. */
	occurredAt?: string;
	/** 1 (lowest) to 5 (urgent), as in ntfy. Default 3. */
	priority?: NotificationPriority;
	/** A product or project grouping label. */
	project?: string;
	/**
	 * A recipient label you define; recipient preferences (mute, quiet hours)
	 * apply to it.
	 */
	recipient?: string;
	/** Makes the event interactive: an approval, yes/no or text reply. */
	response?: {
		/** Optional HMAC key for the callback; Notify stores it privately and never returns it. */
		callbackSecret?: string;
		callbackUrl?: string;
		expiresAt?: string;
		prompt?: string;
		type: NotificationResponseType;
	};
	/** Producer label, such as `github-actions` or `box`. Default `app`. */
	source?: string;
	/** Up to sixteen tags for filtering and downstream adapters. */
	tags?: string[];
	/** Human-readable title, up to 256 bytes. */
	title: string;
	/** A topic name; the event then also appears under `/v1/topics/{topic}`. */
	topic?: string;
	/**
	 * Producer event type, such as `deploy.completed`. Default `notification`.
	 */
	type?: string;
	/** Absolute HTTPS click-through URL. */
	url?: string;
}

export interface NotificationEvent {
	/** When the event was acknowledged; null until then. */
	acknowledgedAt: string | null;
	/** Link actions, each a `label` and an HTTPS `url`. */
	actions: NotificationAction[];
	/** When the event was archived; null until then. */
	archivedAt: string | null;
	/** A metadata-only HTTPS attachment reference; null when none. */
	attachment: NotificationAttachment | null;
	/** Plain-text description. */
	body: string;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/**
	 * A JSON object. Keys that look like credentials are redacted before storage.
	 */
	data: z.infer<typeof wireJsonRecordSchema>;
	/** Your own identifier for the event; null when unset. */
	externalId: string | null;
	/** The grouping and filter hint; null when unset. */
	fingerprint: string | null;
	/** An HTTPS icon URL for clients; null when unset. */
	icon: string | null;
	/** The event id. */
	id: string;
	/** Severity: `info`, `success`, `warning`, `error` or `critical`. */
	level: NotificationLevel;
	/** ISO 8601 timestamp. */
	occurredAt: string;
	/** 1 (lowest) to 5 (urgent), as in ntfy. */
	priority: NotificationPriority;
	/** A product or project grouping label; null when unset. */
	project: string | null;
	/** The recipient label it is for; null for the default recipient. */
	recipient: string | null;
	/**
	 * The interactive response: its `type`, `prompt`, `status` (`pending` until
	 * answered, then the answer, `expired` or `canceled`) and `value`; null for a
	 * plain event.
	 */
	response: NotificationResponse | null;
	/** The producer label, such as `github-actions`. */
	source: string;
	/** Tags for filtering and downstream adapters. */
	tags: string[];
	/** Human-readable title. */
	title: string;
	/** The topic it was published to; null for none. */
	topic: string | null;
	/** The producer's event type, such as `deploy.completed`. */
	type: string;
	/** The HTTPS click-through URL; null when unset. */
	url: string | null;
}

export interface NotifyEventList {
	events: NotificationEvent[];
	nextCursor: string | null;
}

export interface NotifyEventListOptions {
	acknowledged?: boolean;
	archived?: boolean;
	before?: string;
	externalId?: string;
	fingerprint?: string;
	level?: NotificationLevel;
	limit?: number;
	priority?: NotificationPriority;
	project?: string;
	recipient?: string;
	since?: string;
	source?: string;
	tag?: string;
	topic?: string;
	until?: string;
}

export interface NotifyActivity {
	/** An accent color or style name for clients; null when unset. */
	accent: string | null;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/**
	 * A JSON object. Keys that look like credentials are redacted before storage.
	 */
	data: z.infer<typeof wireJsonRecordSchema>;
	/**
	 * When the activity ended (its status became `success`, `error`, `canceled`
	 * or `ended`); null while it runs.
	 */
	endedAt: string | null;
	/** When clients may stop showing the activity; null for no expiry. */
	expiresAt: string | null;
	/** The activity id (`act_…`). */
	id: string;
	/** Percent complete, 0 to 100; null when unknown. */
	progress: number | null;
	/** The recipient label it is for; null for none. */
	recipient: string | null;
	/**
	 * Starts at 0 and increases by one per update; send it back as `sequence` so
	 * a stale update is refused with 409.
	 */
	sequence: number;
	/**
	 * A short status of your choosing, `running` by default; `success`, `error`,
	 * `canceled` and `ended` end the activity.
	 */
	status: string;
	/** A symbol or icon name for clients; null when unset. */
	symbol: string | null;
	/** What is in progress. */
	title: string;
	/** The topic whose streams carry the activity; null for none. */
	topic: string | null;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface NotifyActivityInput {
	/** An accent color or style name for clients, up to 40 characters. */
	accent?: string | null;
	/** A bounded JSON object, redacted before storage. */
	data?: z.infer<typeof wireJsonRecordSchema>;
	/** When clients may stop showing the activity (RFC 3339). */
	expiresAt?: string | null;
	/** Percent complete, 0-100, or null when unknown. */
	progress?: number | null;
	/** A recipient label you define. */
	recipient?: string | null;
	/**
	 * A short status of your choosing, up to 80 characters. Default `running`.
	 */
	status?: string;
	/** A symbol or icon name for clients, up to 40 characters. */
	symbol?: string | null;
	/** What is in progress. */
	title: string;
	/** A topic name; topic streams carry the activity. */
	topic?: string | null;
}

export interface NotifyDestination {
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** Whether new events are delivered. */
	enabled: boolean;
	/** Deliver only events of these types; empty or `*` for every event. */
	eventTypes: string[];
	/** Whether deliveries are signed. The secret is never returned. */
	hasSecret: boolean;
	/** Custom header names; values are write-only. */
	headerNames: string[];
	/** The destination id. */
	id: string;
	/**
	 * `webhook` (JSON POST), `ntfy` (an ntfy topic URL) or `buzzkit` (an HTTP
	 * bridge).
	 */
	kind: "webhook" | "ntfy" | "buzzkit";
	/** When a delivery last succeeded; null before the first. */
	lastDeliveryAt: string | null;
	/** Why the last attempt failed; null otherwise. */
	lastError: string | null;
	/** A name to recognize the destination by. */
	name: string;
	/** ISO 8601 timestamp. */
	updatedAt: string;
	/** The URL is never returned in full. */
	urlPreview: string;
}

export interface NotifyDestinationInput {
	/** Whether new events are delivered. Default true. */
	enabled?: boolean;
	/**
	 * Deliver only events of these types; omit it, or include `*`, for every
	 * event.
	 */
	eventTypes?: string[];
	/**
	 * Custom request headers. `Host`, `Content-Length`, `X-Ryu-Notify-*`,
	 * `webhook-id`, `webhook-timestamp` and `webhook-signature` are reserved.
	 */
	headers?: Record<string, string>;
	/**
	 * `webhook` (JSON POST), `ntfy` (an ntfy topic URL) or `buzzkit` (an HTTP
	 * bridge).
	 */
	kind: "webhook" | "ntfy" | "buzzkit";
	/** A name to recognize the destination by. */
	name: string;
	/**
	 * Signs webhook deliveries: `X-Ryu-Notify-Signature` (`sha256=` hex HMAC of
	 * the body) and the Standard Webhooks `webhook-id`, `webhook-timestamp` and
	 * `webhook-signature` (`v1,` base64 HMAC of `<id>.<timestamp>.<body>`). The
	 * HMAC key is this secret's UTF-8 bytes, so a Standard Webhooks library needs
	 * `whsec_` plus the base64 of the secret.
	 */
	secret?: string | null;
	/** HTTPS only. Never returned in full; reads show `urlPreview`. */
	url: string;
}

export interface NotifyDestinationPatch {
	/** Whether new events are delivered. Default true. */
	enabled?: boolean;
	/**
	 * Deliver only events of these types; omit it, or include `*`, for every
	 * event.
	 */
	eventTypes?: string[];
	/**
	 * Custom request headers. `Host`, `Content-Length`, `X-Ryu-Notify-*`,
	 * `webhook-id`, `webhook-timestamp` and `webhook-signature` are reserved.
	 */
	headers?: Record<string, string>;
	/** A name to recognize the destination by. */
	name?: string;
	/**
	 * Signs webhook deliveries: `X-Ryu-Notify-Signature` (`sha256=` hex HMAC of
	 * the body) and the Standard Webhooks `webhook-id`, `webhook-timestamp` and
	 * `webhook-signature` (`v1,` base64 HMAC of `<id>.<timestamp>.<body>`). The
	 * HMAC key is this secret's UTF-8 bytes, so a Standard Webhooks library needs
	 * `whsec_` plus the base64 of the secret.
	 */
	secret?: string | null;
	/** HTTPS only. Never returned in full; reads show `urlPreview`. */
	url?: string;
}

export interface NotifyDelivery {
	/** How many attempts were made. */
	attempts: number;
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** When an attempt succeeded; null until then. */
	deliveredAt: string | null;
	/** The destination delivered to. */
	destinationId: string;
	/** The event delivered. */
	eventId: string;
	/** The delivery id. */
	id: string;
	/**
	 * Why the last attempt failed or the delivery was suppressed; null otherwise.
	 */
	lastError: string | null;
	/** When the next attempt is due; null when none is scheduled. */
	nextAttemptAt: string | null;
	/** The destination's HTTP status on the last attempt; null before one. */
	responseStatus: number | null;
	/**
	 * `pending` (waiting for an attempt), `sending`, `succeeded`, `failed` (no
	 * attempts left), or `suppressed` (not sent: the destination is disabled or
	 * filters the event out, a silence matches, or the recipient is muted).
	 * Failed and suppressed deliveries can be retried.
	 */
	status: "pending" | "sending" | "succeeded" | "failed" | "suppressed";
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface NotifyPreferences {
	/** Whether destination deliveries are suppressed for the recipient. */
	muted: boolean;
	/** A daily window without deliveries; null when none is set. */
	quietHours: {
		end: string;
		start: string;
		timezone: string;
	} | null;
	/** The recipient these preferences are for; null for the default. */
	recipient: string | null;
	/** ISO 8601 timestamp. */
	updatedAt: string;
}

export interface NotifySilence {
	/** ISO 8601 timestamp. */
	createdAt: string;
	/** ISO 8601 timestamp. */
	expiresAt: string;
	/** Silences events with this fingerprint; null for any. */
	fingerprint: string | null;
	/** The silence id. */
	id: string;
	/** Silences events in this project; null for any. */
	project: string | null;
	/** Silences events from this source; null for any. */
	source: string | null;
	/** Silences events on this topic; null for any. */
	topic: string | null;
}

export interface NotifySilenceInput {
	/** A future RFC 3339 timestamp. */
	expiresAt: string;
	/** Silence events with this fingerprint. */
	fingerprint?: string;
	/** Silence events in this project. */
	project?: string;
	/** Silence events from this source. */
	source?: string;
	/** Silence events on this topic. */
	topic?: string;
}

export interface NotifyGroup {
	count: number;
	fingerprint: string;
	latest: NotificationEvent;
	unacknowledged: number;
}

export interface NotifyAnalytics {
	acknowledged: number;
	byLevel: Record<string, number>;
	bySource: Record<string, number>;
	byTopic: Record<string, number>;
	total: number;
}

/** Accepted events in whole UTC hours `[from, to)`, as clipped by the server. */
export interface NotifyUsageReport {
	from: string;
	meters: { events: number };
	to: string;
}

export interface NotifyClientOptions {
	apiKey: string;
	baseUrl: string;
	fetch?: RyuFetch;
}

export interface NotifyStreamOptions {
	recipient?: string;
	source?: string;
	topic?: string;
}

export type NotifyStreamItem =
	| { event: NotificationEvent; id: string; type: "notification" }
	| { activity: NotifyActivity; id: string; type: "activity" };

interface NotifyQueryOptions
	extends NotifyEventListOptions,
		NotifyStreamOptions {
	destinationId?: string;
	eventId?: string;
	status?: NotifyDelivery["status"];
}
type NotifyRequestBody =
	| NotifyEventInput
	| Partial<NotifyActivityInput>
	| NotifyDestinationInput
	| NotifyDestinationPatch
	| NotifySilenceInput
	| NotifyAnswer
	| NotifyPreferencePatch
	| NotifySequence;
interface NotifyAnswer {
	status: "approved" | "denied" | "yes" | "no" | "replied";
	value?: string;
}
interface NotifyPreferencePatch {
	muted?: boolean;
	quietHours?: NotifyPreferences["quietHours"];
	recipient?: string | null;
}
interface NotifySequence {
	sequence?: number;
}
type NotifyHeaders = Extract<HeadersInit, Record<string, string>>;

/** A character `Headers` refuses in a value: outside Latin-1. */
const OUTSIDE_LATIN_1 = /[\u0100-\u{10ffff}]/u;
/** A non-ASCII character, escaped as `\uXXXX` in the Actions JSON. */
const NON_ASCII = /[\u0080-\u{10ffff}]/gu;

/** A lone UTF-16 surrogate, which UTF-8 cannot encode. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * A topic header value `Headers` accepts: text outside Latin-1, or text that
 * contains `=?` (which Notify would otherwise read as an RFC 2047 encoded
 * word), becomes one UTF-8 encoded word (`=?UTF-8?B?...?=`). Notify decodes it
 * exactly once, so the text round-trips as given. Other Latin-1 text is sent
 * as before. Text with CR, LF or NUL, or with a lone surrogate, is sent
 * unchanged so `Headers` still refuses it (`ryu_sdk.services` refuses the same
 * values as `invalid_request_header`).
 */
function notifyHeaderText(value: string): string {
	if (
		!(OUTSIDE_LATIN_1.test(value) || value.includes("=?")) ||
		/[\r\n]/u.test(value) ||
		value.includes("\0") ||
		LONE_SURROGATE.test(value)
	) {
		return value;
	}
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) {
		binary += String.fromCharCode(byte);
	}
	return `=?UTF-8?B?${btoa(binary)}?=`;
}

/** `JSON.stringify` with every non-ASCII character escaped, so it is a valid header value. */
function asciiJson(value: unknown): string {
	return JSON.stringify(value).replace(NON_ASCII, (char) => {
		let escaped = "";
		for (let index = 0; index < char.length; index += 1) {
			escaped += `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`;
		}
		return escaped;
	});
}

/** Encodes one path id, refusing `""`, `"."` and `".."` before any request. */
function pathId(value: string): string {
	return encodePathId("Notify", value);
}

function query(options: NotifyQueryOptions): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined && value !== null) {
			params.set(key, String(value));
		}
	}
	return params.size ? `?${params}` : "";
}

function unwrap<T>(
	value: z.infer<typeof wireJsonSchema> | undefined,
	key: string,
	schema: z.ZodType<T>
): T {
	const source = wireJsonRecordSchema.parse(value);
	return schema.parse(source[key]);
}
/**
 * `request` with the whole path checked first, so every Notify path refuses an
 * empty or dot segment (not only `pathId` segments) and rejects before fetch.
 */
function request<T>(
	options: RyuClientOptions,
	path: string,
	init: RequestInit | undefined,
	decode: z.ZodType<T>["parse"]
): Promise<T>;
function request(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit
): Promise<z.core.util.JSONType | undefined>;
async function request<T>(
	options: RyuClientOptions,
	path: string,
	init?: RequestInit,
	decode?: z.ZodType<T>["parse"]
) {
	assertSafeRequestPath("Notify", path);
	return decode
		? await sendRequest(options, path, init, decode)
		: await sendRequest(options, path, init);
}

/** @internal Test seam for the checked wrapper; not re-exported from the package root. */
export { request as notifyRequest };

async function jsonRequest(
	options: NotifyClientOptions,
	path: string,
	body: NotifyRequestBody,
	extraHeaders?: Record<string, string>
) {
	return request(
		{ baseUrl: options.baseUrl, fetch: options.fetch, token: options.apiKey },
		path,
		{ body: JSON.stringify(body), headers: extraHeaders, method: "POST" }
	);
}

export class NotifyAPI {
	private readonly options: NotifyClientOptions;

	constructor(options: NotifyClientOptions) {
		this.options = options;
	}

	async publish(
		input: NotifyEventInput,
		idempotencyKey?: string
	): Promise<NotificationEvent> {
		const response = await jsonRequest(
			this.options,
			"/v1/events",
			input,
			idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
		);
		return unwrap(response, "event", notificationEventSchema);
	}

	async publishTopic(
		topic: string,
		message: string,
		options?: {
			actions?: NotificationAction[];
			click?: string;
			priority?: NotificationPriority;
			tags?: string[];
			title?: string;
		},
		idempotencyKey?: string
	): Promise<NotificationEvent> {
		const headers: NotifyHeaders = {
			"content-type": "text/plain; charset=utf-8",
		};
		if (options?.title) {
			headers.Title = notifyHeaderText(options.title);
		}
		if (options?.priority) {
			headers.Priority = String(options.priority);
		}
		if (options?.tags?.length) {
			headers.Tags = notifyHeaderText(options.tags.join(","));
		}
		if (options?.click) {
			headers.Click = notifyHeaderText(options.click);
		}
		if (options?.actions?.length) {
			headers.Actions = asciiJson(options.actions);
		}
		if (idempotencyKey) {
			headers["Idempotency-Key"] = idempotencyKey;
		}
		const response = await request(
			{
				baseUrl: this.options.baseUrl,
				fetch: this.options.fetch,
				token: this.options.apiKey,
			},
			`/v1/topics/${pathId(topic)}`,
			{ body: message, headers, method: "POST" }
		);
		return unwrap(response, "event", notificationEventSchema);
	}

	async listEvents(
		options: NotifyEventListOptions = {}
	): Promise<NotifyEventList> {
		return request(
			this.requestOptions(),
			`/v1/events${query(options)}`,
			undefined,
			eventListSchema.parse
		);
	}

	async getEvent(id: string): Promise<NotificationEvent> {
		return unwrap(
			await request(this.requestOptions(), `/v1/events/${pathId(id)}`),
			"event",
			notificationEventSchema
		);
	}

	async acknowledge(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(this.options, `/v1/events/${pathId(id)}/ack`, {}),
			"event",
			notificationEventSchema
		);
	}

	async archive(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(this.options, `/v1/events/${pathId(id)}/archive`, {}),
			"event",
			notificationEventSchema
		);
	}

	async unarchive(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(this.options, `/v1/events/${pathId(id)}/unarchive`, {}),
			"event",
			notificationEventSchema
		);
	}

	async respond(
		id: string,
		answer: {
			status: "approved" | "denied" | "yes" | "no" | "replied";
			value?: string;
		}
	): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${pathId(id)}/respond`,
				answer
			),
			"event",
			notificationEventSchema
		);
	}

	async cancelResponse(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(this.options, `/v1/events/${pathId(id)}/cancel`, {}),
			"event",
			notificationEventSchema
		);
	}

	async *stream(
		options: NotifyStreamOptions = {}
	): AsyncGenerator<NotifyStreamItem> {
		const response = await this.fetch(`/v1/events/stream${query(options)}`, {
			headers: { Accept: "text/event-stream" },
			method: "GET",
		});
		if (!response.body) {
			throw new Error("Ryu Notify returned an empty event stream.");
		}
		// Bounded incremental framing: an event that never ends is refused at
		// the frame limit instead of growing this process's memory.
		const reader = response.body.getReader();
		const decoder = new SseFrameDecoder();
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) {
					decoder.finish();
					break;
				}
				for (const frame of decoder.push(chunk.value)) {
					const data = frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) {
						continue;
					}
					const type = frame.match(/^event:\s*(\w+)/mu)?.[1];
					const id = frame.match(/^id:\s*(.+)$/mu)?.[1]?.trim() ?? "";
					const payload = wireJsonSchema.parse(JSON.parse(data));
					if (type === "activity") {
						yield {
							activity: notifyActivitySchema.parse(payload),
							id,
							type: "activity",
						};
					} else {
						yield {
							event: notificationEventSchema.parse(payload),
							id,
							type: "notification",
						};
					}
				}
			}
		} finally {
			decoder.finish();
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}

	async createActivity(
		input: NotifyActivityInput,
		idempotencyKey: string
	): Promise<NotifyActivity> {
		return unwrap(
			await jsonRequest(this.options, "/v1/activities", input, {
				"Idempotency-Key": idempotencyKey,
			}),
			"activity",
			notifyActivitySchema
		);
	}

	async listActivities(
		options: { limit?: number; recipient?: string; topic?: string } = {}
	): Promise<NotifyActivity[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/activities${query(options)}`),
			"activities",
			z.array(notifyActivitySchema)
		);
	}

	async getActivity(id: string): Promise<NotifyActivity> {
		return unwrap(
			await request(this.requestOptions(), `/v1/activities/${pathId(id)}`),
			"activity",
			notifyActivitySchema
		);
	}

	async updateActivity(
		id: string,
		input: Partial<NotifyActivityInput>,
		sequence?: number
	): Promise<NotifyActivity> {
		const body: Partial<NotifyActivityInput> & { sequence?: number } = {
			...input,
		};
		if (sequence !== undefined) {
			body.sequence = sequence;
		}
		return unwrap(
			await request(this.requestOptions(), `/v1/activities/${pathId(id)}`, {
				body: JSON.stringify(body),
				method: "PATCH",
			}),
			"activity",
			notifyActivitySchema
		);
	}

	async endActivity(id: string, sequence?: number): Promise<NotifyActivity> {
		const body: NotifySequence = {};
		if (sequence !== undefined) {
			body.sequence = sequence;
		}
		return unwrap(
			await jsonRequest(this.options, `/v1/activities/${pathId(id)}/end`, body),
			"activity",
			notifyActivitySchema
		);
	}

	async listDestinations(): Promise<NotifyDestination[]> {
		return unwrap(
			await request(this.requestOptions(), "/v1/destinations"),
			"destinations",
			z.array(destinationSchema)
		);
	}

	async createDestination(
		input: NotifyDestinationInput
	): Promise<NotifyDestination> {
		return unwrap(
			await jsonRequest(this.options, "/v1/destinations", input),
			"destination",
			destinationSchema
		);
	}

	async updateDestination(
		id: string,
		input: NotifyDestinationPatch
	): Promise<NotifyDestination> {
		return unwrap(
			await request(this.requestOptions(), `/v1/destinations/${pathId(id)}`, {
				body: JSON.stringify(input),
				method: "PATCH",
			}),
			"destination",
			destinationSchema
		);
	}

	async deleteDestination(id: string): Promise<void> {
		await request(this.requestOptions(), `/v1/destinations/${pathId(id)}`, {
			method: "DELETE",
		});
	}

	async testDestination(id: string): Promise<{ status: number }> {
		return request(
			this.requestOptions(),
			`/v1/destinations/${pathId(id)}/test`,
			{ body: "{}", method: "POST" },
			destinationTestSchema.parse
		);
	}

	async listDeliveries(
		options: {
			destinationId?: string;
			eventId?: string;
			limit?: number;
			status?: NotifyDelivery["status"];
		} = {}
	): Promise<NotifyDelivery[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/deliveries${query(options)}`),
			"deliveries",
			z.array(deliverySchema)
		);
	}

	async retryDelivery(id: string): Promise<NotifyDelivery> {
		return unwrap(
			await jsonRequest(this.options, `/v1/deliveries/${pathId(id)}/retry`, {}),
			"delivery",
			deliverySchema
		);
	}

	async getPreferences(recipient?: string): Promise<NotifyPreferences> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/preferences${query({ recipient })}`
			),
			"preferences",
			preferencesSchema
		);
	}

	/** Change only the given preference fields; omitted fields keep their stored values. */
	async updatePreferences(input: {
		muted?: boolean;
		quietHours?: NotifyPreferences["quietHours"];
		recipient?: string | null;
	}): Promise<NotifyPreferences> {
		return unwrap(
			await request(this.requestOptions(), "/v1/preferences", {
				body: JSON.stringify(input),
				method: "PATCH",
			}),
			"preferences",
			preferencesSchema
		);
	}

	async listSilences(): Promise<NotifySilence[]> {
		return unwrap(
			await request(this.requestOptions(), "/v1/silences"),
			"silences",
			z.array(silenceSchema)
		);
	}

	async createSilence(input: NotifySilenceInput): Promise<NotifySilence> {
		return unwrap(
			await jsonRequest(this.options, "/v1/silences", input),
			"silence",
			silenceSchema
		);
	}

	async deleteSilence(id: string): Promise<void> {
		await request(this.requestOptions(), `/v1/silences/${pathId(id)}`, {
			method: "DELETE",
		});
	}

	async listTopics(
		limit?: number
	): Promise<Array<{ count: number; topic: string }>> {
		return unwrap(
			await request(this.requestOptions(), `/v1/topics${query({ limit })}`),
			"topics",
			z.array(topicSchema)
		);
	}

	async listGroups(limit?: number): Promise<NotifyGroup[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/groups${query({ limit })}`),
			"groups",
			z.array(groupSchema)
		);
	}

	async analytics(): Promise<NotifyAnalytics> {
		return unwrap(
			await request(this.requestOptions(), "/v1/analytics"),
			"analytics",
			analyticsSchema
		);
	}

	/**
	 * Accepted events for this tenant in `[from, to)`. Both bounds must be whole
	 * UTC hours, at most 31 days apart.
	 */
	async usage(window: {
		from: Date | string;
		to: Date | string;
	}): Promise<NotifyUsageReport> {
		const params = new URLSearchParams({
			from:
				window.from instanceof Date ? window.from.toISOString() : window.from,
			to: window.to instanceof Date ? window.to.toISOString() : window.to,
		});
		return request(
			this.requestOptions(),
			`/v1/usage?${params}`,
			undefined,
			usageReportSchema.parse
		);
	}

	private requestOptions(): RyuClientOptions {
		return {
			baseUrl: this.options.baseUrl,
			fetch: this.options.fetch,
			token: this.options.apiKey,
		};
	}

	private async fetch(path: string, init: RequestInit): Promise<Response> {
		assertSafeRequestPath("Notify", path);
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		const headers = new Headers(init.headers);
		for (const [key, value] of Object.entries(
			buildHeaders(this.requestOptions())
		)) {
			headers.set(key, value);
		}
		const response = await fetchImpl(buildUrl(this.requestOptions(), path), {
			...init,
			headers,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(
				`Ryu Notify: ${path} failed (${response.status}): ${text}`
			);
		}
		return response;
	}
}

export function createNotifyClient(options: NotifyClientOptions): NotifyAPI {
	return new NotifyAPI(options);
}
