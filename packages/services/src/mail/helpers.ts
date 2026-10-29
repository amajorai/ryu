// packages/services/src/mail/helpers.ts
//
// Client-side conveniences on top of `MailAPI` (design §2.4):
//
// - `mail.send(input, options)` takes a sender address or inbox id as `from`.
//   An address is resolved to its inbox through one `listInboxes` call, and
//   the answer is cached for the life of the Ryu instance;
// - `react` bodies are rendered with the optional peer `@react-email/render`,
//   loaded with a dynamic import only when a `react` body is sent;
// - `mailErrorCode()` names the send-ledger failures hosted and self-hosted
//   Mail report only as prose. `MAIL_NAMESPACE` hands it to the transport as
//   `refineErrorCode`, so the error callers see and the retry decision both
//   carry the code.

import type {
	MailAPI,
	MailInbox,
	MailMessage,
	MailSendInput,
	RyuFetch,
} from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import {
	RyuConfigurationError,
	RyuInvalidRequestError,
	RyuNotFoundError,
} from "../errors.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";

/** What `ryu.mail.send()` takes: a `MailSendInput` plus the sender and an optional React body. */
export interface MailSendRequest extends MailSendInput {
	/**
	 * The sending inbox: its address (`agent@acme.example`, or
	 * `Agent <agent@acme.example>`) or its id. An address costs one
	 * `listInboxes` call the first time it is used on a Ryu instance.
	 */
	from: string;
	/**
	 * A React Email element, rendered to `html` with the optional peer
	 * `@react-email/render`. Set `html` or `react`, not both.
	 */
	react?: unknown;
}

/**
 * Per-call options for `ryu.mail.send()`. Use `ryu.mail.with({ timeoutMs })`
 * for a per-call timeout.
 */
export type MailSendOptions = Pick<
	CallOptions,
	"headers" | "idempotencyKey" | "signal"
>;

/** Renders a React Email element to HTML. */
export type ReactEmailRender = (element: unknown) => string | Promise<string>;

/** Loads the React Email renderer; resolves to null when the peer is not installed. */
export type ReactRendererLoader = () => Promise<ReactEmailRender | null>;

/** Imports a module by specifier (injectable in tests). */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/** The optional peer dependency that renders `react` bodies. */
export const REACT_EMAIL_RENDER_MODULE = "@react-email/render";

/**
 * Kept in a variable, with the webpack and Vite ignore comments, so bundlers
 * leave the import alone (and do not warn about an expression import): the
 * peer is optional and loaded only when a `react` body is sent. A bundled or
 * edge build therefore does not include it; render there yourself and send
 * `html`.
 */
const importModule: ModuleImporter = (specifier) =>
	import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);

/**
 * Loads `render` from `@react-email/render`, or null when the module cannot be
 * imported (not installed, or a runtime without dynamic import).
 */
export async function loadReactEmailRender(
	importer: ModuleImporter = importModule
): Promise<ReactEmailRender | null> {
	let loaded: unknown;
	try {
		loaded = await importer(REACT_EMAIL_RENDER_MODULE);
	} catch {
		return null;
	}
	const render =
		typeof loaded === "object" && loaded !== null
			? (loaded as { render?: unknown }).render
			: undefined;
	return typeof render === "function" ? (render as ReactEmailRender) : null;
}

/** Inbox ids by lower-cased address, one map per cache owner. */
const INBOX_CACHES = new WeakMap<object, Map<string, string>>();

/**
 * The address-to-inbox cache for `owner`. The facade passes the Ryu
 * instance's resolved Mail config, which it memoizes per instance, so the
 * cache lives exactly as long as that instance.
 */
export function inboxCacheFor(owner: object): Map<string, string> {
	let cache = INBOX_CACHES.get(owner);
	if (cache === undefined) {
		cache = new Map();
		INBOX_CACHES.set(owner, cache);
	}
	return cache;
}

const ANGLE_ADDRESS = /<([^<>]+)>/u;

/**
 * What a Mail resource id may contain. Ids go into request paths unencoded
 * (`/api/mail/inboxes/${id}/send`), so `/`, `?`, `#`, `%` and dot segments
 * are refused: they would address a different route.
 */
export const MAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * The positions of the id arguments of each MailAPI method that puts ids into
 * its path unencoded. `ryu.mail` checks them against {@link MAIL_ID_PATTERN}
 * before any request, so a user-supplied id cannot add `../` segments, a
 * `?query` or a `#fragment` and steer the call to another Mail route under
 * the same key.
 */
export const MAIL_ID_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
	addEntry: [0, 1, 2, 3],
	changeInboxAddress: [0],
	createDraft: [0],
	createWebhook: [1],
	deleteDomain: [0],
	deleteDraft: [0, 1],
	deleteInbox: [0],
	deleteMessage: [0, 1],
	deletePod: [0],
	deleteThread: [0, 1],
	deleteWebhook: [0],
	downloadAttachment: [0, 1, 2],
	downloadRaw: [0],
	forward: [0, 1],
	getDomain: [0],
	getDraft: [0, 1],
	getInbox: [0],
	getMessage: [0],
	getPod: [0],
	getThread: [0, 1],
	getWebhook: [0],
	listDrafts: [0],
	listEntries: [0, 1, 2, 3],
	listEvents: [0],
	listMessages: [0],
	listThreads: [0],
	listWebhookDeliveries: [0],
	listWebhookHeaders: [0],
	removeEntry: [0, 1, 2, 3],
	reply: [0, 1],
	replyAll: [0, 1],
	rotateInboundSecret: [0],
	rotateWebhookSecret: [0],
	searchMessages: [0],
	send: [0],
	sendDraft: [0, 1],
	updateDomain: [0],
	updateDraft: [0, 1],
	updateInbox: [0],
	updateMessage: [0, 1],
	updateThread: [0, 1],
	updateWebhook: [0],
	updateWebhookHeaders: [0],
	verifyDomain: [0],
};

/**
 * Throws RyuInvalidRequestError (`invalid_id`) when an id argument of
 * `method` is not letters, digits, `_` and `-`. Absent optional ids pass.
 * `label` is how the message names the call (`messages.get` for the
 * canonical spelling); it defaults to the MailAPI method name.
 */
export function assertMailIds(
	method: string,
	args: readonly unknown[],
	label: string = method
): void {
	for (const position of MAIL_ID_ARGUMENTS[method] ?? []) {
		const value = args[position];
		if (value === undefined) {
			continue;
		}
		if (typeof value !== "string" || !MAIL_ID_PATTERN.test(value)) {
			throw new RyuInvalidRequestError({
				service: "mail",
				status: 0,
				code: "invalid_id",
				message: `Ryu mail.${label}: argument ${position + 1} is not a Mail id (1-128 letters, digits, \`_\` and \`-\`).`,
				retryable: false,
			});
		}
	}
}

/** The bare address in `from` (lower-cased), or null when `from` is an inbox id. */
export function senderAddress(from: string): string | null {
	const trimmed = from.trim();
	const address = ANGLE_ADDRESS.exec(trimmed)?.[1] ?? trimmed;
	return address.includes("@") ? address.trim().toLowerCase() : null;
}

function rememberInboxes(
	cache: Map<string, string>,
	inboxes: readonly MailInbox[]
): void {
	for (const inbox of inboxes) {
		if (inbox.address && inbox.id) {
			cache.set(inbox.address.toLowerCase(), inbox.id);
		}
	}
}

/**
 * The inbox id for `from`. An id is returned as is; an address is looked up
 * in `cache`, and on a miss every inbox the key can see is listed once and
 * cached. Throws RyuNotFoundError (`inbox_not_found`) when no inbox has it.
 */
export async function resolveInboxId(
	api: Pick<MailAPI, "listInboxes">,
	from: string,
	cache: Map<string, string>
): Promise<string> {
	if (typeof from !== "string" || from.trim() === "") {
		throw new RyuInvalidRequestError({
			service: "mail",
			status: 0,
			code: "invalid_from",
			message: "Ryu mail.send: `from` must be a sender address or an inbox id.",
			retryable: false,
		});
	}
	const address = senderAddress(from);
	if (address === null) {
		const id = from.trim();
		if (!MAIL_ID_PATTERN.test(id)) {
			throw new RyuInvalidRequestError({
				service: "mail",
				status: 0,
				code: "invalid_from",
				message:
					"Ryu mail.send: `from` is neither an address nor an inbox id (letters, digits, `_` and `-`).",
				retryable: false,
			});
		}
		return id;
	}
	const cached = cache.get(address);
	if (cached !== undefined) {
		return cached;
	}
	rememberInboxes(cache, await api.listInboxes());
	const found = cache.get(address);
	if (found === undefined) {
		throw new RyuNotFoundError({
			service: "mail",
			status: 0,
			code: "inbox_not_found",
			message: `Ryu mail.send: no inbox this key can see has the address ${address}.`,
			details: { from: address },
			hint: "Create the inbox first, or pass its id as `from`.",
			retryable: false,
		});
	}
	return found;
}

/** What {@link sendMail} needs besides the request. */
export interface SendMailDeps {
	/** Address-to-inbox cache shared by the Ryu instance. */
	cache: Map<string, string>;
	/** Builds a Mail client whose requests carry the call's signal and headers. */
	client(options: MailSendOptions): MailAPI;
	loadRenderer: ReactRendererLoader;
}

async function renderReact(
	element: unknown,
	loadRenderer: ReactRendererLoader
): Promise<string> {
	const render = await loadRenderer();
	if (render === null) {
		throw new RyuConfigurationError({
			service: "mail",
			status: 0,
			code: "react_renderer_missing",
			message: `Ryu mail.send: a react body needs the optional peer ${REACT_EMAIL_RENDER_MODULE}. Install it, or send html or text instead.`,
			hint: `Add ${REACT_EMAIL_RENDER_MODULE} to your dependencies. On an edge or bundled runtime, where the SDK cannot load it, call its render() yourself and pass the result as html.`,
		});
	}
	return await render(element);
}

/**
 * `ryu.mail.send()`: resolves `from`, renders a `react` body, then sends
 * through `MailAPI.send` with `options.idempotencyKey` (or the facade's
 * automatic key) reused on every retry.
 */
export async function sendMail(
	request: MailSendRequest,
	options: MailSendOptions,
	deps: SendMailDeps
): Promise<MailMessage> {
	const { from, react, ...input } = request;
	if (react !== undefined && input.html !== undefined) {
		throw new RyuInvalidRequestError({
			service: "mail",
			status: 0,
			code: "conflicting_content",
			message: "Ryu mail.send: set html or react, not both.",
			retryable: false,
		});
	}
	const api = deps.client(options);
	const inboxId = await resolveInboxId(api, from, deps.cache);
	const body: MailSendInput =
		react === undefined
			? input
			: { ...input, html: await renderReact(react, deps.loadRenderer) };
	return await api.send(inboxId, body, options.idempotencyKey);
}

/**
 * A fetch that adds the call's `signal` and `headers` to every request the
 * client makes, ahead of the facade's service fetch (which still applies
 * auth, retries and errors).
 */
export function withRequestOptions(
	fetch: RyuFetch,
	options: Pick<CallOptions, "headers" | "signal">
): RyuFetch {
	if (options.signal === undefined && options.headers === undefined) {
		return fetch;
	}
	return (input, init) => {
		const headers = new Headers(init?.headers);
		for (const [name, value] of Object.entries(options.headers ?? {})) {
			headers.set(name, value);
		}
		return fetch(input, {
			...init,
			headers,
			signal: init?.signal ?? options.signal,
		});
	};
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function requestUrl(input: Parameters<RyuFetch>[0]): string {
	if (typeof Request !== "undefined" && input instanceof Request) {
		return input.url;
	}
	return input instanceof URL ? input.href : String(input);
}

/**
 * Adds `X-Ryu-Organization` to requests on Mail's own origin when hosted Mail
 * is reached with a `ryu_` key (`auth: "x-api-key"`) and an organization is
 * set, as Managed Agents does. A personal key needs it; an organization key
 * acts in its own organization. Never sent to another origin (a signed
 * attachment URL) or with a gateway or self-hosted key.
 */
export function withOrganizationHeader(
	fetch: RyuFetch,
	config: Pick<ResolvedServiceConfig, "auth" | "baseUrl" | "organizationId">
): RyuFetch {
	const organizationId = config.organizationId;
	const origin = originOf(config.baseUrl);
	if (config.auth !== "x-api-key" || !organizationId || origin === null) {
		return fetch;
	}
	return (input, init) => {
		if (originOf(requestUrl(input)) !== origin) {
			return fetch(input, init);
		}
		const headers = new Headers(
			init?.headers ??
				(typeof Request !== "undefined" && input instanceof Request
					? input.headers
					: undefined)
		);
		headers.set("x-ryu-organization", organizationId);
		return fetch(input, { ...init, headers });
	};
}

/** One conflict hosted or self-hosted Mail reports only as a message. */
export interface MailMessageCode {
	readonly code: string;
	readonly message: string;
	readonly status: number;
}

/**
 * Messages Mail sends without a machine code, and the code the SDK gives
 * them. Hosted Mail's text/plain HTTPException becomes a problem+json body
 * whose `detail` is the message (code `conflict` or `bad_gateway` by status);
 * its keyed-send 502 and self-hosted Mail answer `{error}`. The strings are
 * copied from packages/api/src/routers/mail.ts (`SEND_KEY_*`,
 * `SEND_OUTCOME_UNKNOWN`, `DRAFT_SEND_UNRESOLVED`) and
 * apps-store/mail/backend/src/api.rs; test/conformance/mail.test.ts keeps
 * them in lockstep.
 */
export const MAIL_MESSAGE_CODES: readonly MailMessageCode[] = [
	{
		status: 409,
		code: "idempotency_in_progress",
		message:
			"a request with this Idempotency-Key is still in progress; retry shortly",
	},
	{
		status: 409,
		code: "outcome_unknown",
		message:
			"the outcome of an earlier request with this Idempotency-Key is unknown and it may have been sent; check this inbox's sent messages before sending it again with a new Idempotency-Key",
	},
	{
		status: 409,
		code: "idempotency_key_reused",
		message: "Idempotency-Key was already used with a different request",
	},
	{
		status: 502,
		code: "outcome_unknown",
		message:
			"the mail provider did not confirm this send, so it may have been sent; check this inbox's sent messages before sending it again",
	},
	{
		status: 409,
		code: "outcome_unknown",
		message:
			"this draft's last send ended without a definite answer from the mail provider, so it may have been sent; check this inbox's sent messages, then send or edit it with `confirmNotSent: true` only if it is not there",
	},
	{
		status: 409,
		code: "idempotency_key_reused",
		message: "idempotency key was reused with a different inbox or request",
	},
	{
		status: 409,
		code: "outcome_unknown",
		message:
			"mail send outcome is unresolved; reconcile this request before sending again",
	},
	{
		status: 500,
		code: "outcome_unknown",
		message:
			"Mail transport acknowledged the message but its replay record could not be saved; reconcile this request before retrying",
	},
];

/**
 * The machine code for a Mail error that carries only a message, or null.
 * `idempotency_in_progress` is retryable; `outcome_unknown` is in
 * NON_RETRYABLE_CODES, because the message may already have been sent, so
 * neither the transport nor a caller should send it again.
 */
export function mailErrorCode(status: number, message: string): string | null {
	const text = message.trim();
	return (
		MAIL_MESSAGE_CODES.find(
			(entry) => entry.status === status && entry.message === text
		)?.code ?? null
	);
}
