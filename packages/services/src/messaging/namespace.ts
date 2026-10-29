// packages/services/src/messaging/namespace.ts
//
// `ryu.messaging`: a 1:1 wrap of `@ryuhq/client`'s Ryu Messaging client
// (`createMessagingClient`) plus `iterate()` on the message log and the
// opt-out list. The client already groups its calls by resource (`sms`,
// `mms`, `voice`, `whatsapp`, `numbers`, `messages`, `optOuts`, `settings`),
// so those are the canonical sub-namespaces and there are no flat aliases.
//
// It runs in `passthrough` error mode, like Managed Agents: the shim hands
// non-2xx responses back untouched, the client raises MessagingError (its
// `code` is the server's `error` token, `details` the rest of the body), and
// the facade converts that to RyuError at the boundary, taking the request id
// and `WWW-Authenticate` from the shim's parse of the same response.
//
// Every send and number purchase carries an `Idempotency-Key`: the client
// generates one per call, `send(input, { idempotencyKey })` passes yours, and
// `.with({ idempotencyKey })` replaces it. The shim keeps that key across its
// retries, and never retries `outcome_unknown` (the send may have gone out)
// or `provider_refused` (AWS refused; the server releases the key, so a retry
// would be a new send, not a replay). `media_upload_failed` is retried: nothing
// was sent, and the retry is a fresh attempt that counts against the send
// limits. `optOuts.remove` (DELETE) is retried as an idempotent method;
// `settings.update` (PUT) is listed as non-replay-safe in the route table, so
// the shim never resends it after a network error, timeout or 5xx (the reply
// that creates the webhook secret is the only one that carries it).
//
// `status()` is credential-free: `GET /api/messaging/status` needs no key, so
// it runs without RYU_API_KEY and RYU_ORGANIZATION_ID (sending neither); every
// other method still fails with the missing-credential RyuConfigurationError.

import {
	createMessagingClient,
	type MessagingAPI,
	type MessagingMessage,
	type MessagingMessagePage,
	type MessagingOptOut,
	type MessagingOptOutPage,
	messagingErrorMessageRecord,
	type RyuFetch,
} from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import { copyRyuError, isRyuError, type RyuError } from "../errors.ts";
import type { Paginated } from "../pagination.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	iterateMessages,
	iterateOptOuts,
	type MessagingMessageIterateQuery,
	type MessagingOptOutIterateQuery,
} from "./iterate.ts";
import { MESSAGING_ROUTES } from "./routes.ts";

/** The public page that explains how Ryu Messaging is turned on for an organization. */
export const MESSAGING_DOCS =
	"https://docs.ryuhq.com/docs/standalone/messaging";

/** `ryu.messaging.messages`: the client's message log plus `iterate()`. */
export interface MessagingMessagesNamespace {
	get: MessagingAPI["messages"]["get"];
	/** Every message, newest first (`cursor` → `nextCursor`). Throws RyuError, also in object mode. */
	iterate(
		query?: MessagingMessageIterateQuery
	): Paginated<MessagingMessage, MessagingMessagePage>;
	list: MessagingAPI["messages"]["list"];
}

/** `ryu.messaging.optOuts`: the client's opt-out list plus `iterate()`. */
export interface MessagingOptOutsNamespace {
	add: MessagingAPI["optOuts"]["add"];
	/** Every opted-out number (`nextToken`). Throws RyuError, also in object mode. */
	iterate(
		query?: MessagingOptOutIterateQuery
	): Paginated<MessagingOptOut, MessagingOptOutPage>;
	list: MessagingAPI["optOuts"]["list"];
	remove: MessagingAPI["optOuts"]["remove"];
}

/**
 * `ryu.messaging`: sends on `sms`, `mms`, `voice` and `whatsapp`, leased
 * `numbers`, the `messages` log, the `optOuts` list, `settings`, and the
 * service-level `quote()` and `status()`.
 */
export interface MessagingNamespace
	extends Pick<
		MessagingAPI,
		| "mms"
		| "numbers"
		| "quote"
		| "settings"
		| "sms"
		| "status"
		| "voice"
		| "whatsapp"
	> {
	readonly messages: MessagingMessagesNamespace;
	readonly optOuts: MessagingOptOutsNamespace;
}

/** The canonical `ryu.messaging.<resource>.<method>` paths, for docs and tool checks. */
export const MESSAGING_CANONICAL_METHODS: readonly string[] = [
	"status",
	"quote",
	"sms.send",
	"mms.send",
	"voice.send",
	"whatsapp.send",
	"whatsapp.senders",
	"whatsapp.templates.list",
	"whatsapp.templates.create",
	"numbers.list",
	"numbers.quote",
	"numbers.buy",
	"numbers.update",
	"numbers.release",
	"messages.list",
	"messages.get",
	"messages.iterate",
	"optOuts.list",
	"optOuts.add",
	"optOuts.remove",
	"optOuts.iterate",
	"settings.get",
	"settings.update",
	"settings.rotateWebhookSecret",
];

const AVAILABILITY_MESSAGE = "not available for this organization";

/** The hint for an error that means Messaging is not turned on, or null. */
export function messagingAvailabilityHint(
	error: Pick<RyuError, "code" | "message" | "status">
): string | null {
	if (error.code === "feature_disabled") {
		return `The organization's Ryu Messaging feature is off; an organization owner or admin turns it on. See ${MESSAGING_DOCS}`;
	}
	if (
		error.status === 404 &&
		error.code === "not_found" &&
		error.message.includes(AVAILABILITY_MESSAGE)
	) {
		return `Ryu Messaging is in early access, and Ryu enables it for each organization. See ${MESSAGING_DOCS}`;
	}
	return null;
}

/**
 * Adds the early-access hint and docs link to a Messaging "not turned on"
 * error (`404 not_found` from the rollout gate, `403 feature_disabled`);
 * returns any other error unchanged.
 */
export function decorateMessagingError(error: RyuError): RyuError {
	if (error.service !== "messaging" || error.hint !== null) {
		return error;
	}
	const hint = messagingAvailabilityHint(error);
	return hint === null
		? error
		: copyRyuError(error, { docs: MESSAGING_DOCS, hint });
}

/**
 * The stored message a send's `502 outcome_unknown` or `502 provider_refused`
 * carries, or null. Follow it with `ryu.messaging.messages.get(id)` before
 * sending again with a new idempotency key.
 */
export function messagingErrorRecord(error: unknown): MessagingMessage | null {
	if (!isRyuError(error) || error.service !== "messaging") {
		return null;
	}
	const cause: unknown = error.cause;
	if (cause instanceof Error && cause.name === "MessagingError") {
		return messagingErrorMessageRecord(
			cause as Parameters<typeof messagingErrorMessageRecord>[0]
		);
	}
	return null;
}

function defineMethod(target: object, name: string, value: unknown): void {
	Object.defineProperty(target, name, {
		configurable: true,
		value,
		writable: true,
	});
}

/**
 * A fetch that drops the empty `X-Ryu-Organization` header the client sets
 * when a credential-free call (`status()`) runs without an organization.
 * The shim already drops the empty `x-api-key`.
 */
function withoutEmptyOrganization(fetch: RyuFetch): RyuFetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		if (headers.get("x-ryu-organization") === "") {
			headers.delete("x-ryu-organization");
		}
		return fetch(input, { ...init, headers });
	};
}

/** Builds the Messaging client for one call. Does no I/O. */
export function createMessagingNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch
): MessagingNamespace {
	const client: MessagingAPI = createMessagingClient({
		apiKey: config.apiKey ?? "",
		baseUrl: config.baseUrl,
		fetch:
			config.organizationId === null ? withoutEmptyOrganization(fetch) : fetch,
		organizationId: config.organizationId ?? "",
	});
	defineMethod(
		client.messages,
		"iterate",
		(query?: MessagingMessageIterateQuery) => iterateMessages(client, query)
	);
	defineMethod(
		client.optOuts,
		"iterate",
		(query?: MessagingOptOutIterateQuery) => iterateOptOuts(client, query)
	);
	return client as unknown as MessagingNamespace;
}

/** How the facade wraps Ryu Messaging. */
export const MESSAGING_NAMESPACE: NamespaceDefinition<MessagingNamespace> = {
	create: createMessagingNamespace,
	// `GET /api/messaging/status` is unauthenticated.
	credentialFreeMethods: ["status"],
	decorateError: decorateMessagingError,
	errors: "passthrough",
	routes: MESSAGING_ROUTES,
	service: "messaging",
};
