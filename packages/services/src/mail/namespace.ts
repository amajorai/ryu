// packages/services/src/mail/namespace.ts
//
// `ryu.mail`: `@ryuhq/client`'s MailAPI, hosted or self-hosted, arranged as
// resource namespaces (design §2.4):
//
//   ryu.mail.status()                         service status
//   ryu.mail.send({ from, to, subject, ... })  convenience send (see ./helpers.ts)
//   ryu.mail.connectRealtime(onEvent)          self-host realtime socket
//   ryu.mail.connectRealtimeWithTicket(onEvent) hosted realtime socket (ticket)
//   ryu.mail.createRealtimeTicket()            one-use hosted socket ticket
//   ryu.mail.inboxes.{list,get,create,update,delete,rotateSecret,checkAddress,
//                     changeAddress,getForAgent,ensureForAgent}
//   ryu.mail.messages.{list,search,get,update,delete,iterate,send,reply,
//                      replyAll,forward,downloadRaw,downloadAttachment}
//   ryu.mail.threads.{list,get,update,delete}
//   ryu.mail.drafts.{list,get,create,update,delete,send}
//   ryu.mail.webhooks.{list,get,create,update,delete,rotateSecret}
//   ryu.mail.webhooks.headers.{list,update}  ryu.mail.webhooks.deliveries.list
//   ryu.mail.events.list   ryu.mail.pods.{list,get,create,delete}
//   ryu.mail.domains.{list,get,create,update,delete,verify}
//   ryu.mail.lists.{entries,add,remove}      allow/block list entries
//
// The rule: a call that acts on one kind of resource lives under that
// resource's namespace (`list`/`get`/`create`/`update`/`delete`, plus
// `iterate` where paginated and the resource's own verbs such as `reply` or
// `verify`). Calls that return bytes are named for the action
// (`messages.downloadRaw`, `messages.downloadAttachment`, like Box's
// `files.downloadArchive`), and `lists.entries` reads one allow/block list's
// entries (a plain `lists.list` would read as "list the lists"). Only service-level calls stay at the top level: `status`,
// `connectRealtime`, and `send`, the primary verb, which takes the sender
// address or inbox id as `from` and an optional React body.
// `messages.send(inboxId, input, idempotencyKey?)` is `MailAPI.send` 1:1.
//
// The flat MailAPI names (`listInboxes`, `getMessage`, `sendDraft`, ...) and
// `sendFromInbox` still work and hit the same request; they are deprecated
// aliases of the canonical spelling in {@link MAIL_CANONICAL_METHODS}.
// MailAPI methods added later still come through under their flat names
// until they get a canonical home (a test fails until they do).
//
// Hosted Mail takes the node gateway key as `x-gateway-key` (the shim moves
// the client's Bearer header there) or a control-plane `ryu_` key as
// `x-api-key` with `X-Ryu-Organization`; self-hosted Mail takes a Bearer
// token. With hosted Mail (a `ryu_` or gateway key), `connectRealtime` throws
// instead of opening a socket: the client would put the key in the socket
// URL's query string, on a path the control plane does not serve. Hosted Mail
// uses `connectRealtimeWithTicket`, which mints a one-use ticket with the key
// and offers it as a `Sec-WebSocket-Protocol` value; self-hosted Mail has no
// ticket route, so the two ticket methods throw there.
// Errors are raised by the fetch shim (`throw` mode); send-ledger failures
// that Mail reports only as prose get their machine code from
// `mailErrorCode` (see ./helpers.ts).

import {
	MailAPI,
	type MailMessage,
	type RyuClientOptions,
	type RyuFetch,
} from "@ryuhq/client";
import { type ResolvedServiceConfig, serviceDocsUrl } from "../config.ts";
import { RyuConfigurationError, RyuInvalidRequestError } from "../errors.ts";
import type { Paginated } from "../pagination.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	assertMailIds,
	inboxCacheFor,
	loadReactEmailRender,
	type MailSendOptions,
	type MailSendRequest,
	mailErrorCode,
	type ReactRendererLoader,
	sendMail,
	withOrganizationHeader,
	withRequestOptions,
} from "./helpers.ts";
import { iterateMessages, type MailMessageIterateQuery } from "./iterate.ts";
import { MAIL_ROUTES } from "./routes.ts";

export type {
	MailSendOptions,
	MailSendRequest,
	ReactEmailRender,
	ReactRendererLoader,
} from "./helpers.ts";
export type { MailMessageIterateQuery } from "./iterate.ts";

/**
 * Each canonical `ryu.mail` path and the MailAPI method it calls. The flat
 * name of every entry (and `sendFromInbox` for `messages.send`) is a
 * deprecated alias that makes the same request.
 */
export const MAIL_CANONICAL_METHODS = {
	"inboxes.list": "listInboxes",
	"inboxes.get": "getInbox",
	"inboxes.create": "createInbox",
	"inboxes.update": "updateInbox",
	"inboxes.delete": "deleteInbox",
	"inboxes.rotateSecret": "rotateInboundSecret",
	"inboxes.checkAddress": "checkAddress",
	"inboxes.changeAddress": "changeInboxAddress",
	"inboxes.getForAgent": "getAgentInbox",
	"inboxes.ensureForAgent": "ensureAgentInbox",
	"messages.list": "listMessages",
	"messages.search": "searchMessages",
	"messages.get": "getMessage",
	"messages.update": "updateMessage",
	"messages.delete": "deleteMessage",
	"messages.send": "send",
	"messages.reply": "reply",
	"messages.replyAll": "replyAll",
	"messages.forward": "forward",
	"messages.downloadRaw": "downloadRaw",
	"messages.downloadAttachment": "downloadAttachment",
	"threads.list": "listThreads",
	"threads.get": "getThread",
	"threads.update": "updateThread",
	"threads.delete": "deleteThread",
	"drafts.list": "listDrafts",
	"drafts.get": "getDraft",
	"drafts.create": "createDraft",
	"drafts.update": "updateDraft",
	"drafts.delete": "deleteDraft",
	"drafts.send": "sendDraft",
	"webhooks.list": "listWebhooks",
	"webhooks.get": "getWebhook",
	"webhooks.create": "createWebhook",
	"webhooks.update": "updateWebhook",
	"webhooks.delete": "deleteWebhook",
	"webhooks.rotateSecret": "rotateWebhookSecret",
	"webhooks.headers.list": "listWebhookHeaders",
	"webhooks.headers.update": "updateWebhookHeaders",
	"webhooks.deliveries.list": "listWebhookDeliveries",
	"events.list": "listEvents",
	"pods.list": "listPods",
	"pods.get": "getPod",
	"pods.create": "createPod",
	"pods.delete": "deletePod",
	"domains.list": "listDomains",
	"domains.get": "getDomain",
	"domains.create": "createDomain",
	"domains.update": "updateDomain",
	"domains.delete": "deleteDomain",
	"domains.verify": "verifyDomain",
	"lists.entries": "listEntries",
	"lists.add": "addEntry",
	"lists.remove": "removeEntry",
} as const satisfies Readonly<Record<string, keyof MailAPI>>;

/** MailAPI methods that stay at the top level of `ryu.mail` under their own name. */
export const MAIL_TOP_LEVEL_METHODS = [
	"status",
	"connectRealtime",
	// Hosted mailbox, alias, agent-send, send-policy and approval calls. They have
	// no resource namespace yet, so they keep their flat MailAPI names.
	"getMailbox",
	"checkMailboxHandle",
	"claimMailbox",
	"adoptMailbox",
	"setMailboxAliasHost",
	"updateMailbox",
	"listAliases",
	"checkAlias",
	"assignAlias",
	"approveAlias",
	"rejectAlias",
	"revokeAlias",
	"reinstateAlias",
	"transferAlias",
	"getAgentAlias",
	"checkAgentAlias",
	"claimAgentAlias",
	"listAgentMessages",
	"getAgentMessage",
	"getAgentThread",
	"sendAsAgent",
	"replyAsAgent",
	"getSendPolicy",
	"setSendPolicy",
	"deleteAliasSendPolicy",
	"listApprovals",
	"approveDraft",
	"rejectDraft",
	"connectRealtimeWithTicket",
	"createRealtimeTicket",
] as const satisfies readonly (keyof MailAPI)[];

/** `ryu.mail.inboxes`. */
export interface MailInboxesNamespace {
	/** Moves an inbox to a new local part (and optionally domain). */
	changeAddress: MailAPI["changeInboxAddress"];
	/** Checks whether `localPart` is free on a domain before creating an inbox. */
	checkAddress: MailAPI["checkAddress"];
	/** Creates an inbox. */
	create: MailAPI["createInbox"];
	/** Deletes an inbox. */
	delete: MailAPI["deleteInbox"];
	/** Returns the agent's inbox, creating it when it does not exist yet. */
	ensureForAgent: MailAPI["ensureAgentInbox"];
	/** One inbox by id. */
	get: MailAPI["getInbox"];
	/** The inbox that belongs to an agent. */
	getForAgent: MailAPI["getAgentInbox"];
	/** Every inbox this key can see. */
	list: MailAPI["listInboxes"];
	/** Rotates the inbox's inbound webhook secret and returns the new one. */
	rotateSecret: MailAPI["rotateInboundSecret"];
	/** Updates an inbox's name or metadata. */
	update: MailAPI["updateInbox"];
}

/** `ryu.mail.messages`. */
export interface MailMessagesNamespace {
	/** Deletes a message. */
	delete: MailAPI["deleteMessage"];
	/** Downloads one attachment's bytes (a signed storage URL is fetched without credentials). */
	downloadAttachment: MailAPI["downloadAttachment"];
	/** Downloads the message as raw RFC 822 bytes. */
	downloadRaw: MailAPI["downloadRaw"];
	/** Forwards a message. Deduplicated by `Idempotency-Key`. */
	forward: MailAPI["forward"];
	/** One message by id. */
	get: MailAPI["getMessage"];
	/**
	 * Every message in the inbox, newest first, across pages
	 * (`before = last.createdAt`, deduplicated by id). Messages that share the
	 * page-boundary timestamp beyond the page end can be skipped.
	 */
	iterate(
		inboxId: string,
		query?: MailMessageIterateQuery
	): Paginated<MailMessage, MailMessage[]>;
	/** One page of an inbox's messages, newest first. */
	list: MailAPI["listMessages"];
	/** Replies to the sender. Deduplicated by `Idempotency-Key`. */
	reply: MailAPI["reply"];
	/** Replies to every recipient. Deduplicated by `Idempotency-Key`. */
	replyAll: MailAPI["replyAll"];
	/** Searches an inbox's messages. */
	search: MailAPI["searchMessages"];
	/**
	 * Sends from `inboxId` exactly as `MailAPI.send` does. `ryu.mail.send`
	 * is the convenience that takes an address or inbox id as `from`.
	 */
	send: MailAPI["send"];
	/** Changes a message's labels or read state. */
	update: MailAPI["updateMessage"];
}

/** `ryu.mail.threads`. */
export interface MailThreadsNamespace {
	/** Deletes a thread. */
	delete: MailAPI["deleteThread"];
	/** A thread's messages. */
	get: MailAPI["getThread"];
	/** An inbox's threads, optionally filtered by search text. */
	list: MailAPI["listThreads"];
	/** Adds or removes labels on every message of a thread. */
	update: MailAPI["updateThread"];
}

/** `ryu.mail.drafts`. */
export interface MailDraftsNamespace {
	/** Creates a draft, optionally scheduled with `sendAt`. */
	create: MailAPI["createDraft"];
	/** Deletes a draft. */
	delete: MailAPI["deleteDraft"];
	/** One draft. */
	get: MailAPI["getDraft"];
	/**
	 * An inbox's drafts. `{ limit }` caps the reply (a positive integer,
	 * `invalid_limit` otherwise; servers clamp it to 200 and default to 50).
	 * The route has no cursor, so there is no `iterate`.
	 */
	list: MailAPI["listDrafts"];
	/** Sends a draft now. Deduplicated by `Idempotency-Key`. */
	send: MailAPI["sendDraft"];
	/** Updates a draft. */
	update: MailAPI["updateDraft"];
}

/** `ryu.mail.webhooks.headers`. */
export interface MailWebhookHeadersNamespace {
	/** The names of the custom headers a webhook sends. */
	list: MailAPI["listWebhookHeaders"];
	/** Sets and removes custom headers on a webhook. */
	update: MailAPI["updateWebhookHeaders"];
}

/** `ryu.mail.webhooks.deliveries`. */
export interface MailWebhookDeliveriesNamespace {
	/**
	 * A webhook's recent delivery attempts, newest first. `{ limit }` caps the
	 * reply (a positive integer, `invalid_limit` otherwise; default 100; hosted
	 * Mail clamps to 200, self-hosted Mail to 1000). The route has no cursor,
	 * so there is no `iterate`.
	 */
	list: MailAPI["listWebhookDeliveries"];
}

/** `ryu.mail.webhooks`. */
export interface MailWebhooksNamespace {
	/** Creates a webhook; the result carries its signing secret once. */
	create: MailAPI["createWebhook"];
	/** Deletes a webhook. */
	delete: MailAPI["deleteWebhook"];
	readonly deliveries: MailWebhookDeliveriesNamespace;
	/** One webhook. */
	get: MailAPI["getWebhook"];
	readonly headers: MailWebhookHeadersNamespace;
	/** Every webhook. */
	list: MailAPI["listWebhooks"];
	/** Rotates a webhook's signing secret and returns the new one. */
	rotateSecret: MailAPI["rotateWebhookSecret"];
	/** Updates a webhook. */
	update: MailAPI["updateWebhook"];
}

/** `ryu.mail.events`. */
export interface MailEventsNamespace {
	/**
	 * Recent Mail events, newest first: one inbox's (`inboxId`), or every
	 * inbox's. `eventType` filters the every-inbox route on hosted Mail only;
	 * self-hosted Mail ignores it, and the inbox route takes no event type.
	 * `{ limit }`, the third argument, caps the reply (hosted Mail: 1-200,
	 * default 50; self-hosted Mail: 1-1000, default 100) and must be a positive
	 * integer (`invalid_limit` otherwise). An empty `inboxId` is refused with
	 * `invalid_id`; pass `undefined` for every inbox. The routes have no
	 * cursor, so there is no `iterate`.
	 */
	list: MailAPI["listEvents"];
}

/** `ryu.mail.pods`. */
export interface MailPodsNamespace {
	/** Creates a pod. */
	create: MailAPI["createPod"];
	/** Deletes a pod. */
	delete: MailAPI["deletePod"];
	/** One pod. */
	get: MailAPI["getPod"];
	/** Every pod. */
	list: MailAPI["listPods"];
}

/** `ryu.mail.domains`. */
export interface MailDomainsNamespace {
	/** Adds a sending domain. */
	create: MailAPI["createDomain"];
	/** Removes a domain. */
	delete: MailAPI["deleteDomain"];
	/** One domain with its DNS records. */
	get: MailAPI["getDomain"];
	/** Every domain. */
	list: MailAPI["listDomains"];
	/** Updates a domain's pod, subdomain or tracking settings. */
	update: MailAPI["updateDomain"];
	/** Re-checks a domain's DNS records. */
	verify: MailAPI["verifyDomain"];
}

/** `ryu.mail.lists`: allow and block list entries. */
export interface MailListsNamespace {
	/** Adds an entry to a list. */
	add: MailAPI["addEntry"];
	/** The entries of one list (`scope`, `scopeId`, `direction`, `listType`). */
	entries: MailAPI["listEntries"];
	/** Removes an entry from a list. */
	remove: MailAPI["removeEntry"];
}

/**
 * The flat MailAPI names, kept as deprecated aliases of the canonical
 * resource methods. Each one makes the same request as its canonical form.
 */
export interface MailFlatAliases {
	/** @deprecated Use `ryu.mail.lists.add`. */
	addEntry: MailAPI["addEntry"];
	/** @deprecated Use `ryu.mail.inboxes.changeAddress`. */
	changeInboxAddress: MailAPI["changeInboxAddress"];
	/** @deprecated Use `ryu.mail.inboxes.checkAddress`. */
	checkAddress: MailAPI["checkAddress"];
	/** @deprecated Use `ryu.mail.domains.create`. */
	createDomain: MailAPI["createDomain"];
	/** @deprecated Use `ryu.mail.drafts.create`. */
	createDraft: MailAPI["createDraft"];
	/** @deprecated Use `ryu.mail.inboxes.create`. */
	createInbox: MailAPI["createInbox"];
	/** @deprecated Use `ryu.mail.pods.create`. */
	createPod: MailAPI["createPod"];
	/** @deprecated Use `ryu.mail.webhooks.create`. */
	createWebhook: MailAPI["createWebhook"];
	/** @deprecated Use `ryu.mail.domains.delete`. */
	deleteDomain: MailAPI["deleteDomain"];
	/** @deprecated Use `ryu.mail.drafts.delete`. */
	deleteDraft: MailAPI["deleteDraft"];
	/** @deprecated Use `ryu.mail.inboxes.delete`. */
	deleteInbox: MailAPI["deleteInbox"];
	/** @deprecated Use `ryu.mail.messages.delete`. */
	deleteMessage: MailAPI["deleteMessage"];
	/** @deprecated Use `ryu.mail.pods.delete`. */
	deletePod: MailAPI["deletePod"];
	/** @deprecated Use `ryu.mail.threads.delete`. */
	deleteThread: MailAPI["deleteThread"];
	/** @deprecated Use `ryu.mail.webhooks.delete`. */
	deleteWebhook: MailAPI["deleteWebhook"];
	/** @deprecated Use `ryu.mail.messages.downloadAttachment`. */
	downloadAttachment: MailAPI["downloadAttachment"];
	/** @deprecated Use `ryu.mail.messages.downloadRaw`. */
	downloadRaw: MailAPI["downloadRaw"];
	/** @deprecated Use `ryu.mail.inboxes.ensureForAgent`. */
	ensureAgentInbox: MailAPI["ensureAgentInbox"];
	/** @deprecated Use `ryu.mail.messages.forward`. */
	forward: MailAPI["forward"];
	/** @deprecated Use `ryu.mail.inboxes.getForAgent`. */
	getAgentInbox: MailAPI["getAgentInbox"];
	/** @deprecated Use `ryu.mail.domains.get`. */
	getDomain: MailAPI["getDomain"];
	/** @deprecated Use `ryu.mail.drafts.get`. */
	getDraft: MailAPI["getDraft"];
	/** @deprecated Use `ryu.mail.inboxes.get`. */
	getInbox: MailAPI["getInbox"];
	/** @deprecated Use `ryu.mail.messages.get`. */
	getMessage: MailAPI["getMessage"];
	/** @deprecated Use `ryu.mail.pods.get`. */
	getPod: MailAPI["getPod"];
	/** @deprecated Use `ryu.mail.threads.get`. */
	getThread: MailAPI["getThread"];
	/** @deprecated Use `ryu.mail.webhooks.get`. */
	getWebhook: MailAPI["getWebhook"];
	/** @deprecated Use `ryu.mail.domains.list`. */
	listDomains: MailAPI["listDomains"];
	/** @deprecated Use `ryu.mail.drafts.list`. */
	listDrafts: MailAPI["listDrafts"];
	/** @deprecated Use `ryu.mail.lists.entries`. */
	listEntries: MailAPI["listEntries"];
	/** @deprecated Use `ryu.mail.events.list`. */
	listEvents: MailAPI["listEvents"];
	/** @deprecated Use `ryu.mail.inboxes.list`. */
	listInboxes: MailAPI["listInboxes"];
	/** @deprecated Use `ryu.mail.messages.list` (or `messages.iterate` for every page). */
	listMessages: MailAPI["listMessages"];
	/** @deprecated Use `ryu.mail.pods.list`. */
	listPods: MailAPI["listPods"];
	/** @deprecated Use `ryu.mail.threads.list`. */
	listThreads: MailAPI["listThreads"];
	/** @deprecated Use `ryu.mail.webhooks.deliveries.list`. */
	listWebhookDeliveries: MailAPI["listWebhookDeliveries"];
	/** @deprecated Use `ryu.mail.webhooks.headers.list`. */
	listWebhookHeaders: MailAPI["listWebhookHeaders"];
	/** @deprecated Use `ryu.mail.webhooks.list`. */
	listWebhooks: MailAPI["listWebhooks"];
	/** @deprecated Use `ryu.mail.lists.remove`. */
	removeEntry: MailAPI["removeEntry"];
	/** @deprecated Use `ryu.mail.messages.reply`. */
	reply: MailAPI["reply"];
	/** @deprecated Use `ryu.mail.messages.replyAll`. */
	replyAll: MailAPI["replyAll"];
	/** @deprecated Use `ryu.mail.inboxes.rotateSecret`. */
	rotateInboundSecret: MailAPI["rotateInboundSecret"];
	/** @deprecated Use `ryu.mail.webhooks.rotateSecret`. */
	rotateWebhookSecret: MailAPI["rotateWebhookSecret"];
	/** @deprecated Use `ryu.mail.messages.search`. */
	searchMessages: MailAPI["searchMessages"];
	/** @deprecated Use `ryu.mail.drafts.send`. */
	sendDraft: MailAPI["sendDraft"];
	/** @deprecated Use `ryu.mail.messages.send` (or `ryu.mail.send` with `from`). */
	sendFromInbox: MailAPI["send"];
	/** @deprecated Use `ryu.mail.domains.update`. */
	updateDomain: MailAPI["updateDomain"];
	/** @deprecated Use `ryu.mail.drafts.update`. */
	updateDraft: MailAPI["updateDraft"];
	/** @deprecated Use `ryu.mail.inboxes.update`. */
	updateInbox: MailAPI["updateInbox"];
	/** @deprecated Use `ryu.mail.messages.update`. */
	updateMessage: MailAPI["updateMessage"];
	/** @deprecated Use `ryu.mail.threads.update`. */
	updateThread: MailAPI["updateThread"];
	/** @deprecated Use `ryu.mail.webhooks.update`. */
	updateWebhook: MailAPI["updateWebhook"];
	/** @deprecated Use `ryu.mail.webhooks.headers.update`. */
	updateWebhookHeaders: MailAPI["updateWebhookHeaders"];
	/** @deprecated Use `ryu.mail.domains.verify`. */
	verifyDomain: MailAPI["verifyDomain"];
}

/**
 * The methods of `ryu.mail`: the resource namespaces, the top-level
 * `status`, `connectRealtime`, `connectRealtimeWithTicket`, `createRealtimeTicket`
 * and `send` (the convenience below), and the deprecated flat aliases. A
 * MailAPI method without a canonical home yet is inherited under its own name.
 */
export interface MailNamespace
	extends Omit<MailAPI, "send" | keyof MailFlatAliases>,
		MailFlatAliases {
	readonly domains: MailDomainsNamespace;
	readonly drafts: MailDraftsNamespace;
	readonly events: MailEventsNamespace;
	readonly inboxes: MailInboxesNamespace;
	readonly lists: MailListsNamespace;
	readonly messages: MailMessagesNamespace;
	readonly pods: MailPodsNamespace;
	/**
	 * Sends from the inbox named by `from` (an address or an inbox id). An
	 * address is resolved with one `inboxes.list` call, then cached for this
	 * Ryu instance. A `react` body is rendered with `@react-email/render`.
	 */
	send(input: MailSendRequest, options?: MailSendOptions): Promise<MailMessage>;
	readonly threads: MailThreadsNamespace;
	readonly webhooks: MailWebhooksNamespace;
}

/** Test seams for {@link createMailNamespace}. */
export interface MailNamespaceDeps {
	/** Where the address-to-inbox cache lives. Default: the resolved config (one per Ryu instance). */
	cacheOwner?: object;
	/** Loads `@react-email/render`. */
	loadRenderer?: ReactRendererLoader;
}

function clientOptions(
	config: ResolvedServiceConfig,
	fetch: RyuFetch
): RyuClientOptions {
	return {
		baseUrl: config.baseUrl,
		fetch: withOrganizationHeader(fetch, config),
		mailRealtime: config.mailMode === "self-hosted" ? "standalone" : "core",
		token: config.apiKey ?? undefined,
	};
}

type MailMethod = (...args: unknown[]) => unknown;

/** Sets `value` at the dotted `path` of `tree`, creating plain objects on the way. */
function setPath(
	tree: Record<string, unknown>,
	path: string,
	value: unknown
): void {
	const keys = path.split(".");
	const last = keys.pop() ?? path;
	let node = tree;
	for (const key of keys) {
		node[key] ??= {};
		node = node[key] as Record<string, unknown>;
	}
	node[last] = value;
}

/** Position of the `{ limit }` argument of the Mail list methods that take one. */
const MAIL_LIMIT_ARGUMENT: Readonly<Record<string, number>> = {
	listDrafts: 1,
	listEvents: 2,
	listWebhookDeliveries: 1,
};

/**
 * Rejects a `limit` that is not a positive integer before any request.
 * Hosted Mail reads a bad limit as its default and self-hosted Mail answers
 * 400, so the SDK refuses it the same way on every backend.
 */
export function assertMailListLimit(
	method: string,
	args: readonly unknown[],
	label: string = method
): void {
	const position = MAIL_LIMIT_ARGUMENT[method];
	if (position === undefined) {
		return;
	}
	const query = args[position];
	if (query === undefined || query === null || typeof query !== "object") {
		return;
	}
	const limit: unknown = Reflect.get(query, "limit");
	if (limit === undefined) {
		return;
	}
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
		throw new RyuInvalidRequestError({
			service: "mail",
			status: 0,
			code: "invalid_limit",
			message: `Ryu mail.${label}: limit must be a positive integer.`,
			retryable: false,
		});
	}
}

/**
 * Builds `ryu.mail` for one call. Does no I/O. Canonical methods and their
 * flat aliases call the same method of a client bound to this call's fetch.
 */
export function createMailNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	_options: CallOptions = {},
	deps: MailNamespaceDeps = {}
): MailNamespace {
	const api = new MailAPI(clientOptions(config, fetch));
	const cache = inboxCacheFor(deps.cacheOwner ?? config);
	const loadRenderer = deps.loadRenderer ?? (() => loadReactEmailRender());
	// Every MailAPI method that puts ids into its path checks them first;
	// `label` names the spelling the caller used in the error message.
	const call =
		(method: string, label: string): MailMethod =>
		(...args) => {
			assertMailIds(method, args, label);
			assertMailListLimit(method, args, label);
			return (Reflect.get(api, method) as MailMethod).apply(api, args);
		};
	const tree: Record<string, unknown> = {};
	for (const [path, method] of Object.entries(MAIL_CANONICAL_METHODS)) {
		setPath(tree, path, call(method, path));
		tree[method === "send" ? "sendFromInbox" : method] = call(method, method);
	}
	setPath(
		tree,
		"messages.iterate",
		(inboxId: string, query?: MailMessageIterateQuery) => {
			assertMailIds("listMessages", [inboxId], "messages.iterate");
			return iterateMessages(api, inboxId, query);
		}
	);
	tree.send = (input: MailSendRequest, options: MailSendOptions = {}) =>
		sendMail(input, options, {
			cache,
			client: (callOptions) =>
				new MailAPI(
					clientOptions(config, withRequestOptions(fetch, callOptions))
				),
			loadRenderer,
		});
	// Hosted Mail has no realtime socket, with a ryu_ key or a node gateway key
	// (rgw_): fail before any socket opens or any key reaches a URL.
	if (config.auth === "x-api-key" || config.mailMode === "hosted") {
		tree.connectRealtime = (): never => {
			throw new RyuConfigurationError({
				service: "mail",
				status: 0,
				code: "realtime_unavailable",
				message:
					"Ryu mail.connectRealtime: hosted Mail (an rgw_ or ryu_ key) opens its realtime socket with a one-use ticket. Use ryu.mail.connectRealtimeWithTicket instead.",
				hint: `await ryu.mail.connectRealtimeWithTicket(onEvent) mints the ticket with your key. Polling ryu.mail.events.list and Mail webhooks also work. See ${serviceDocsUrl("mail")}.`,
			});
		};
		// Refuse before minting when no socket can open (Node before 22 has no
		// global WebSocket), so no ticket slot is spent for nothing.
		tree.connectRealtimeWithTicket = (
			...args: Parameters<MailAPI["connectRealtimeWithTicket"]>
		): ReturnType<MailAPI["connectRealtimeWithTicket"]> => {
			if (!(args[2]?.WebSocket || typeof WebSocket === "function")) {
				return Promise.reject(
					new RyuConfigurationError({
						service: "mail",
						status: 0,
						code: "realtime_websocket_unavailable",
						message:
							"Ryu mail.connectRealtimeWithTicket: this runtime has no global WebSocket (Node before 22).",
						hint: `Pass { WebSocket } from the ws package as the third argument, or open the socket yourself from ryu.mail.createRealtimeTicket() (its url and protocols). See ${serviceDocsUrl("mail")}.`,
					})
				);
			}
			return api.connectRealtimeWithTicket(...args);
		};
	} else {
		const ticketUnavailable = (method: string) => (): Promise<never> =>
			Promise.reject(
				new RyuConfigurationError({
					service: "mail",
					status: 0,
					code: "realtime_ticket_unavailable",
					message: `Ryu mail.${method}: realtime tickets are a hosted Mail feature; self-hosted Mail authenticates the socket with its token.`,
					hint: `Use ryu.mail.connectRealtime(onEvent) with a self-hosted Mail server. See ${serviceDocsUrl("mail")}.`,
				})
			);
		tree.connectRealtimeWithTicket = ticketUnavailable(
			"connectRealtimeWithTicket"
		);
		tree.createRealtimeTicket = ticketUnavailable("createRealtimeTicket");
	}
	// MailAPI methods without a canonical home (`status`, `connectRealtime`,
	// and any the client adds later) are inherited, so they run with `this`
	// bound to a MailAPI-shaped object and keep reading its options.
	return Object.assign(
		Object.create(api) as MailAPI,
		tree
	) as unknown as MailNamespace;
}

/** How the facade wraps Mail. */
export const MAIL_NAMESPACE: NamespaceDefinition<MailNamespace> = {
	create: (config, fetch, options) =>
		createMailNamespace(config, fetch, options),
	// Hosted `GET /api/mail/status` is unauthenticated; without a Mail key
	// `status()` runs on the control-plane origin and sends none. Self-hosted
	// Mail guards that route, so a self-hosted URL still needs its bearer.
	credentialFreeMethods: ["status"],
	errors: "throw",
	refineErrorCode: mailErrorCode,
	routes: MAIL_ROUTES,
	service: "mail",
};
