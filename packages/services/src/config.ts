// packages/services/src/config.ts
//
// Constructor options, the environment variables each service reads, and the
// lazy per-service resolution the facade runs on a namespace's first call.
//
// Honesty rules this module enforces (design D5-D7):
// - Managed Agents defaults to the documented control-plane host; hosted Mail
//   uses it only when a gateway key or a `ryu_` key selects hosted Mail and no
//   URL is given; Box and Notify default to their hosted origins
//   (`https://box.ryuhq.com`, `https://notify.ryuhq.com`), whose keys Ryu
//   provisions; Gateway defaults to the local `http://127.0.0.1:7981`;
//   Connect, Passport and Sites have no default and fail with a
//   RyuConfigurationError that names the env var;
// - the control-plane `RYU_API_KEY` is sent to Managed Agents, Ryu Messaging
//   and, when no Mail gateway key or self-hosted Mail key is set, to hosted
//   Mail on the control-plane origin; never to another service or origin;
// - there are no `RYU_MANAGED_AGENTS_*` names.
// - Ryu Messaging reads the same `ryu_` key, organization and control-plane
//   origin (`RYU_API_KEY`, `RYU_ORGANIZATION_ID`, `RYU_API_URL`) as Managed
//   Agents, with its own `messaging` options first.

import { SERVICE_TITLES } from "./service-titles.ts";

export { SERVICE_TITLES } from "./service-titles.ts";

import type { BoxClientOptions, RyuFetch } from "@ryuhq/client";
import { createEnvReader, type EnvReader, type RyuEnvSource } from "./env.ts";
import {
	RyuConfigurationError,
	type RyuError,
	type RyuService,
} from "./errors.ts";
import type { RyuDeprecation } from "./transport/deprecation.ts";
import {
	isBrowserRuntime,
	type RuntimeGlobals,
} from "./transport/user-agent.ts";

export type { RyuFetch } from "@ryuhq/client";

/** The documented control-plane host. */
export const CONTROL_PLANE_URL = "https://api.ryuhq.com";
/** Hosted Ryu Box (answers `GET /health` with `type: "box.health"`). Keys are provisioned by Ryu. */
export const DEFAULT_BOX_URL = "https://box.ryuhq.com";
/** Hosted Ryu Notify (answers `GET /health` with `service: "ryu-notify"`). Keys are provisioned by Ryu. */
export const DEFAULT_NOTIFY_URL = "https://notify.ryuhq.com";
/** Local Ryu Gateway, matching `DEFAULT_GATEWAY_URL` in packages/sdk/src/model/gateway.ts. */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:7981";
/** Where each service's SDK page lives. */
export const SDK_DOCS_URL = "https://docs.ryuhq.com/docs/standalone/sdk";

/** `"throw"` returns `T` and throws RyuError; `"object"` resolves every call to `{ data, error, meta }`. */
export type RyuResultMode = "throw" | "object";

/** A base URL and key for one service. */
export interface ServiceConnection {
	apiKey?: string;
	baseUrl?: string;
}

/** Fired before every HTTP attempt. */
export interface RyuRequestEvent {
	attempt: number;
	method: string;
	service: RyuService;
	/** Without its query string. */
	url: string;
}

/** Fired after every HTTP attempt that got a response. */
export interface RyuResponseEvent extends RyuRequestEvent {
	durationMs: number;
	requestId: string | null;
	status: number;
}

/** Fired before the shim waits and retries. */
export interface RyuRetryEvent extends RyuRequestEvent {
	/** The failure's code (`timeout`, `connection_error`, a server code, or the status default). */
	code: string;
	delayMs: number;
	/** 0 for a network failure or timeout. */
	status: number;
}

/** Fired once per (method, route) per Ryu instance when a response announces deprecation. */
export interface RyuDeprecationEvent extends RyuDeprecation {
	method: string;
	service: RyuService;
	url: string;
}

/** Observability hooks. They must not throw; a throwing hook is ignored. */
export interface RyuHooks {
	onDeprecation?(event: RyuDeprecationEvent): void;
	onRequest?(event: RyuRequestEvent): void;
	onResponse?(event: RyuResponseEvent): void;
	onRetry?(event: RyuRetryEvent): void;
}

/** Options for `new Ryu()`. Every field is optional; env fills the rest (see {@link ENV_VARS}). */
export interface RyuOptions<R extends RyuResultMode = RyuResultMode> {
	/**
	 * Control-plane key (`ryu_…`), sent as `x-api-key` to Managed Agents, Ryu
	 * Messaging and, when no Mail gateway key or self-hosted Mail key is set,
	 * to hosted Mail.
	 */
	apiKey?: string;
	/** Add an `Idempotency-Key` to every idempotent-route write that lacks one. Default true. */
	autoIdempotency?: boolean;
	/** Control-plane origin. Default `RYU_API_URL`, then `https://api.ryuhq.com`. */
	baseUrl?: string;
	box?: ServiceConnection & { webSocket?: BoxClientOptions["webSocket"] };
	connect?: ServiceConnection & { managementKey?: string };
	/** Constructing with a key in a browser throws unless this is set. Keys in a page are public. */
	dangerouslyAllowBrowser?: boolean;
	/** Env vars. Default `globalThis.process?.env`; `false` reads none. */
	env?: RyuEnvSource;
	/** HTTP implementation; default `globalThis.fetch`. */
	fetch?: RyuFetch;
	gateway?: ServiceConnection;
	hooks?: RyuHooks;
	mail?: { apiKey?: string; baseUrl?: string; gatewayKey?: string };
	managedAgents?: ServiceConnection & { organizationId?: string };
	/** Retries after the first attempt. Default 2. */
	maxRetries?: number;
	/** The longest server-requested wait the SDK honours before giving up. Default 30 000. */
	maxRetryDelayMs?: number;
	/**
	 * Ryu Messaging on the control plane. Falls back to `baseUrl`, `apiKey` and
	 * `organizationId` (the same `ryu_` key and organization as Managed Agents).
	 */
	messaging?: ServiceConnection & { organizationId?: string };
	notify?: ServiceConnection;
	/** Sent as `X-Ryu-Organization` with the `ryu_` key (Managed Agents, hosted Mail). Default `RYU_ORGANIZATION_ID`. */
	organizationId?: string;
	passport?: ServiceConnection & { runtimeKey?: string };
	/** Default `"throw"`. */
	result?: R;
	sites?: ServiceConnection;
	/** Per attempt, until response headers arrive. Default 60 000. */
	timeoutMs?: number;
	/** Appended to the SDK User-Agent on server runtimes; `false` sends none. */
	userAgent?: string | false;
}

/** What an env var configures. */
export type EnvVarRole =
	| "url"
	| "key"
	| "organization"
	| "gateway-key"
	| "management-key"
	| "runtime-key";

/** One documented environment variable. */
export interface EnvVarRow {
	readonly default: string | null;
	readonly description: string;
	readonly name: string;
	readonly role: EnvVarRole;
	readonly service: RyuService;
}

/** Every environment variable the SDK reads. The SDK docs' env table must equal this. */
export const ENV_VARS: readonly EnvVarRow[] = [
	{
		service: "managedAgents",
		name: "RYU_API_URL",
		role: "url",
		default: CONTROL_PLANE_URL,
		description:
			"Control-plane origin; the client appends /api/v1/managed-agents.",
	},
	{
		service: "managedAgents",
		name: "RYU_API_KEY",
		role: "key",
		default: null,
		description:
			"A ryu_ key, sent as x-api-key to Managed Agents, Messaging and, unless another Mail key takes precedence, hosted Mail. Never sent to another origin.",
	},
	{
		service: "managedAgents",
		name: "RYU_ORGANIZATION_ID",
		role: "organization",
		default: null,
		description:
			"Sent as X-Ryu-Organization with the ryu_ key; required for personal keys.",
	},
	{
		service: "mail",
		name: "RYU_MAIL_URL",
		role: "url",
		default: null,
		description:
			"Mail origin. Required for self-hosted Mail; hosted Mail defaults to the control-plane origin when a gateway key or a ryu_ key selects it.",
	},
	{
		service: "mail",
		name: "RYU_MAIL_GATEWAY_KEY",
		role: "gateway-key",
		default: null,
		description:
			"Hosted Mail node gateway key, sent as x-gateway-key. Minted only through Ryu node enrollment; wins over a ryu_ key.",
	},
	{
		service: "mail",
		name: "RYU_MAIL_API_KEY",
		role: "key",
		default: null,
		description: "Self-hosted Mail bearer token.",
	},
	{
		service: "notify",
		name: "RYU_NOTIFY_URL",
		role: "url",
		default: DEFAULT_NOTIFY_URL,
		description: "Notify origin; set it only when Ryu issued you another URL.",
	},
	{
		service: "notify",
		name: "RYU_NOTIFY_API_KEY",
		role: "key",
		default: null,
		description:
			"Notify tenant bearer token (hosted keys are provisioned by Ryu).",
	},
	{
		service: "box",
		name: "RYU_BOX_URL",
		role: "url",
		default: DEFAULT_BOX_URL,
		description: "Box origin; set it only when Ryu issued you another URL.",
	},
	{
		service: "box",
		name: "RYU_BOX_API_KEY",
		role: "key",
		default: null,
		description:
			"Box tenant bearer token (hosted keys are provisioned by Ryu).",
	},
	{
		service: "gateway",
		name: "RYU_GATEWAY_URL",
		role: "url",
		default: DEFAULT_GATEWAY_URL,
		description: "Gateway origin.",
	},
	{
		service: "gateway",
		name: "RYU_GATEWAY_TOKEN",
		role: "key",
		default: null,
		description:
			"Gateway bearer token; required unless the Gateway runs with require_auth = false.",
	},
	{
		service: "connect",
		name: "RYU_CONNECT_URL",
		role: "url",
		default: null,
		description: "Connect origin (no default).",
	},
	{
		service: "connect",
		name: "RYU_CONNECT_API_KEY",
		role: "key",
		default: null,
		description: "Connect runtime bearer token.",
	},
	{
		service: "connect",
		name: "RYU_CONNECT_MANAGEMENT_KEY",
		role: "management-key",
		default: null,
		description: "Connect management bearer token (reserved).",
	},
	{
		service: "passport",
		name: "RYU_PASSPORT_URL",
		role: "url",
		default: null,
		description: "Passport origin (no default).",
	},
	{
		service: "passport",
		name: "RYU_PASSPORT_API_KEY",
		role: "key",
		default: null,
		description:
			"Passport admin bearer token; optional when RYU_PASSPORT_RUNTIME_KEY is set.",
	},
	{
		service: "passport",
		name: "RYU_PASSPORT_RUNTIME_KEY",
		role: "runtime-key",
		default: null,
		description:
			"Passport runtime bearer token, used on /v1/runtime/* routes and runtime fetches.",
	},
	{
		service: "sites",
		name: "RYU_SITES_URL",
		role: "url",
		default: null,
		description: "Sites management listener origin (no default).",
	},
	{
		service: "sites",
		name: "RYU_SITES_API_KEY",
		role: "key",
		default: null,
		description: "Sites management bearer token.",
	},
	{
		service: "messaging",
		name: "RYU_API_URL",
		role: "url",
		default: CONTROL_PLANE_URL,
		description: "Control-plane origin; the client appends /api/messaging.",
	},
	{
		service: "messaging",
		name: "RYU_API_KEY",
		role: "key",
		default: null,
		description:
			"The same ryu_ key, sent as x-api-key; it needs the messaging:read scope to read and messaging:manage to send, buy numbers or change settings.",
	},
	{
		service: "messaging",
		name: "RYU_ORGANIZATION_ID",
		role: "organization",
		default: null,
		description:
			"Required: the organization every Messaging route names in its path, also sent as X-Ryu-Organization.",
	},
];

/** How each service can be reached today. Each SDK quickstart quotes its label verbatim. */
export const AVAILABILITY: Readonly<Record<RyuService, string>> = {
	managedAgents:
		"Preview: off until your organization turns on the Managed Agents feature.",
	mail: "Available: hosted with a Ryu API key that has Mail scopes or a Ryu node gateway key, or self-hosted.",
	notify:
		"Early access: hosted at https://notify.ryuhq.com with keys provisioned by Ryu; the self-hosted service is not yet published.",
	box: "Early access: hosted at https://box.ryuhq.com and enabled per organization by Ryu; the self-hosted service is not yet published.",
	gateway: "Self-hosted: run Ryu Gateway with your own provider keys.",
	connect:
		"Early access: hosted keys are provisioned by Ryu; the self-hosted service is not yet published.",
	passport:
		"Early access: hosted keys are provisioned by Ryu; the self-hosted service is not yet published.",
	// The published amajorai/ryu-sites mirror (0.4.0) runs only as the
	// Core-managed sidecar; drop the release clause with the docs' gate
	// callouts once a release with standalone mode is out.
	sites:
		"Early access: self-hosted process only, and standalone mode needs a ryu-sites release after 0.4.0, which is not published yet; there is no Ryu-hosted offer.",
	messaging:
		"Early access: hosted on the Ryu control plane; Ryu enables it per organization, and the organization must also turn on its Ryu Messaging feature (off by default); there is no self-hosted service.",
};

/** The URL slug of each service's SDK page. */
export const SERVICE_DOC_SLUGS: Readonly<Record<RyuService, string>> = {
	box: "box",
	connect: "connect",
	gateway: "gateway",
	mail: "mail",
	managedAgents: "managed-agents",
	messaging: "messaging",
	notify: "notify",
	passport: "passport",
	sites: "sites",
};

/** How the shim presents a service's key on the wire. */
export type ServiceAuthScheme = "bearer" | "x-api-key" | "x-gateway-key";

/** How strictly {@link resolveServiceConfig} treats missing credentials. */
export interface ConfigResolution {
	/**
	 * `"required"` (the default) throws RyuConfigurationError when a
	 * credential is missing. `"optional"` resolves the URL alone for a call
	 * whose route needs no credential (Messaging `status()`); the facade uses
	 * it only for methods a namespace lists as credential-free. Messaging and
	 * hosted Mail (`status()` on the control-plane origin) honour it; every
	 * other service, and self-hosted Mail, resolves as `"required"`.
	 */
	credentials?: "optional" | "required";
}

/** One service's connection after options, env and defaults are applied. */
export interface ResolvedServiceConfig {
	/**
	 * Null for Gateway without `RYU_GATEWAY_TOKEN`, and for a credential-free
	 * call resolved with `credentials: "optional"` (Messaging and hosted Mail
	 * `status()`).
	 */
	apiKey: string | null;
	auth: ServiceAuthScheme;
	baseUrl: string;
	/**
	 * `"hosted"` or `"self-hosted"` for Mail; null for every other service.
	 * Hosted Mail on a `ryu_` key has `auth: "x-api-key"`.
	 */
	mailMode: "hosted" | "self-hosted" | null;
	/** Connect management key, when set. */
	managementKey: string | null;
	/** Organization sent with the `ryu_` key (Managed Agents, hosted Mail), when set. */
	organizationId: string | null;
	/** Passport runtime key, when set. */
	runtimeKey: string | null;
	service: RyuService;
	/** Box WebSocket constructor override. */
	webSocket?: BoxClientOptions["webSocket"];
}

/** The docs page for `service`. */
export function serviceDocsUrl(service: RyuService): string {
	return `${SDK_DOCS_URL}/${SERVICE_DOC_SLUGS[service]}`;
}

/** The `new Ryu()` option that sets each env var, keyed by env var name. */
const ENV_OPTION_NAMES: Readonly<Record<string, string>> = {
	RYU_API_URL: "baseUrl",
	RYU_API_KEY: "apiKey",
	RYU_ORGANIZATION_ID: "organizationId",
	RYU_MAIL_URL: "mail.baseUrl",
	RYU_MAIL_GATEWAY_KEY: "mail.gatewayKey",
	RYU_MAIL_API_KEY: "mail.apiKey",
	RYU_NOTIFY_URL: "notify.baseUrl",
	RYU_NOTIFY_API_KEY: "notify.apiKey",
	RYU_BOX_URL: "box.baseUrl",
	RYU_BOX_API_KEY: "box.apiKey",
	RYU_GATEWAY_URL: "gateway.baseUrl",
	RYU_GATEWAY_TOKEN: "gateway.apiKey",
	RYU_CONNECT_URL: "connect.baseUrl",
	RYU_CONNECT_API_KEY: "connect.apiKey",
	RYU_CONNECT_MANAGEMENT_KEY: "connect.managementKey",
	RYU_PASSPORT_URL: "passport.baseUrl",
	RYU_PASSPORT_API_KEY: "passport.apiKey",
	RYU_PASSPORT_RUNTIME_KEY: "passport.runtimeKey",
	RYU_SITES_URL: "sites.baseUrl",
	RYU_SITES_API_KEY: "sites.apiKey",
};

/** The `new Ryu()` option that sets env var `name`, or the name itself when none does. */
export function constructorOptionFor(name: string): string {
	return ENV_OPTION_NAMES[name] ?? name;
}

/** "Set A and B (or pass a and b to new Ryu())": every listed variable is required. */
function requiredHint(service: RyuService, missing: readonly string[]): string {
	const options = missing.map(constructorOptionFor).join(" and ");
	return `Set ${missing.join(" and ")} (or pass ${options} to new Ryu()). See ${serviceDocsUrl(service)}.`;
}

function configurationError(
	service: RyuService,
	missing: readonly string[],
	message: string,
	hint = requiredHint(service, missing)
): RyuConfigurationError {
	return new RyuConfigurationError({
		service,
		status: 0,
		code: "configuration_error",
		message,
		details: { missing: [...missing] },
		docs: serviceDocsUrl(service),
		hint,
	});
}

/** The env var of `role` for `service`, read from {@link ENV_VARS}. */
function envVarFor(service: RyuService, role: EnvVarRole): string | null {
	return (
		ENV_VARS.find((row) => row.service === service && row.role === role)
			?.name ?? null
	);
}

/** The credential roles a resolved service sends, in the order a hint names them. */
function credentialRolesFor(config: ResolvedServiceConfig): EnvVarRole[] {
	switch (config.service) {
		case "managedAgents":
		case "messaging":
			return ["key", "organization"];
		case "mail":
			if (config.auth === "x-api-key") {
				return ["key", "organization"];
			}
			return [config.mailMode === "self-hosted" ? "key" : "gateway-key"];
		case "passport":
			return config.apiKey === null ? ["runtime-key"] : ["key", "runtime-key"];
		case "connect":
			return config.managementKey === null
				? ["key"]
				: ["key", "management-key"];
		default:
			return ["key"];
	}
}

/** The env vars holding the credentials a resolved service sends (Managed Agents adds the organization). */
export function credentialEnvVarsFor(config: ResolvedServiceConfig): string[] {
	// Hosted Mail on a `ryu_` key reads the control-plane rows.
	const owner: RyuService =
		config.service === "mail" && config.auth === "x-api-key"
			? "managedAgents"
			: config.service;
	const names: string[] = [];
	for (const role of credentialRolesFor(config)) {
		const name = envVarFor(owner, role);
		if (name !== null) {
			names.push(name);
		}
	}
	return names;
}

/** The env var holding `service`'s base URL. */
export function urlEnvVarFor(service: RyuService): string {
	return envVarFor(service, "url") ?? "RYU_API_URL";
}

/** "Check A and B (or a and b)." for env vars and the constructor options that set them. */
function checkSentence(names: readonly string[]): string {
	const options = names.map(constructorOptionFor).join(" and ");
	return `Check ${names.join(" and ")} (or ${options}).`;
}

/**
 * The origin of `url` for a hint: scheme, host and port only, never the path,
 * query, fragment or userinfo (which can hold a pasted credential).
 */
export function hintOrigin(url: string | null | undefined): string | null {
	if (url === undefined || url === null || url === "") {
		return null;
	}
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/**
 * The hint for a request that never got a response (`connection_error`) or
 * got none in time (`timeout`): the target origin, the URL env var to check,
 * and the doctor command. Null for any other code.
 */
export function transportFailureHint(
	service: RyuService,
	code: string,
	url: string | null | undefined
): string | null {
	if (code !== "connection_error" && code !== "timeout") {
		return null;
	}
	const title = SERVICE_TITLES[service];
	const target = hintOrigin(url) ?? "the configured URL";
	const urlEnv = urlEnvVarFor(service);
	const what =
		code === "timeout"
			? `${title} at ${target} did not respond in time (raise timeoutMs if the call is slow).`
			: `Could not reach ${title} at ${target}.`;
	return `${what} ${checkSentence([urlEnv])} Run \`ryu-services doctor --check\` to test the connection.`;
}

/**
 * Services whose 403 is not about the key's scopes, so the generic 403 hint
 * would point at the wrong fix: Managed Agents' `ryu_` key is account-wide,
 * and a Connect runtime key carries no scopes (its 403s are tenant grants,
 * which knownServerHint explains).
 */
const NO_DEFAULT_403_HINT: ReadonlySet<RyuService> = new Set([
	"connect",
	"managedAgents",
]);

/**
 * A default hint for an error that names no hint of its own: the key env
 * var(s) to check after a 401 (or a 403 on a service whose key carries
 * scopes, which excludes Managed Agents and Connect), and the target
 * origin and URL env var after a connection failure or timeout. Never
 * contains a key, a path or a query. Null for every other error.
 */
export function defaultErrorHint(
	error: Pick<RyuError, "code" | "status"> & { url?: string | null },
	config: ResolvedServiceConfig
): string | null {
	const title = SERVICE_TITLES[config.service];
	const keyEnvs = credentialEnvVarsFor(config);
	const sentNoKey =
		config.apiKey === null && credentialRolesFor(config).includes("key");
	if ((error.status === 401 || error.status === 403) && sentNoKey) {
		const names = keyEnvs.join(" and ");
		const options = keyEnvs.map(constructorOptionFor).join(" and ");
		return `${title} requires a credential and none was sent. Set ${names} (or ${options}).`;
	}
	if (error.status === 401 && keyEnvs.length > 0) {
		return `${title} did not accept the credentials. ${checkSentence(keyEnvs)}`;
	}
	if (
		error.status === 403 &&
		!NO_DEFAULT_403_HINT.has(config.service) &&
		keyEnvs.length > 0
	) {
		return `${title} accepted the key but it may not do this; check its scopes and tenant. ${checkSentence(keyEnvs)}`;
	}
	if (error.status === 0) {
		// Use the error's URL only on the service's own origin: a request to
		// another origin says nothing about RYU_<SVC>_URL.
		const serviceOrigin = hintOrigin(config.baseUrl);
		const url =
			serviceOrigin !== null && hintOrigin(error.url) === serviceOrigin
				? error.url
				: config.baseUrl;
		return transportFailureHint(config.service, error.code, url);
	}
	return null;
}

/**
 * A redacted description of a URL value that failed to parse. Never the value
 * itself, which may hold a pasted token: only its scheme, when it has one, and
 * its length.
 */
function describeInvalidUrl(url: string): string {
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
	return scheme === undefined
		? `invalid value, ${url.length} chars`
		: `invalid ${scheme}: value, ${url.length} chars`;
}

/**
 * The hint for a URL value written without its scheme, such as
 * `127.0.0.1:8021`, `localhost:8021` or `api.example.com/v1`: the part before
 * the first `/` looks like a host (`host:port`, a dotted host, `localhost` or
 * `[ipv6]`, with an optional port). A value that already names a scheme
 * (`http:/x`, `mailto:x`), a bare word (`nope`) or one with whitespace gets no
 * hint. Never echoes the value. Matches the Python `_invalid_url_hint`.
 */
const MISSING_URL_SCHEME_HINT =
	"Add the scheme, for example http://127.0.0.1:8021 or https://api.example.com.";

const SCHEMELESS_AUTHORITY =
	/^(?:\[[^\]\s]*\](?::[0-9]+)?|[^:/\s]+:[0-9]+|[^:/\s]+\.[^:/\s]+|localhost)$/i;

function invalidUrlHint(url: string): string | null {
	if (/\s/.test(url)) {
		return null;
	}
	const slash = url.indexOf("/");
	const authority = slash === -1 ? url : url.slice(0, slash);
	return SCHEMELESS_AUTHORITY.test(authority) ? MISSING_URL_SCHEME_HINT : null;
}

/**
 * `scheme://host[:port]` of an absolute http(s) URL, or null (matches the
 * Python `origin_of`). The raw value must spell `http://` or `https://`: WHATWG
 * parsing would otherwise repair `http:host` or `http:/host` into a URL that
 * Python's `urlsplit` rejects.
 */
function originOf(url: string): string | null {
	if (!/^https?:\/\//i.test(url)) {
		return null;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? parsed.origin
			: null;
	} catch {
		return null;
	}
}

function checkedUrl(service: RyuService, url: string, envName: string): string {
	if (originOf(url) === null) {
		throw new RyuConfigurationError({
			service,
			status: 0,
			code: "invalid_url",
			message: `${SERVICE_TITLES[service]}: ${envName} is not an absolute URL (${describeInvalidUrl(url)}).`,
			details: { invalid: [envName] },
			docs: serviceDocsUrl(service),
			hint: invalidUrlHint(url),
		});
	}
	return url;
}

/**
 * A constructor option as a value, or undefined when it is unset, empty or
 * whitespace, matching how env values are read, so `apiKey: ""` still raises
 * the missing-key RyuConfigurationError instead of sending an empty credential.
 */
function optionValue(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** The configured control-plane origin: `baseUrl`, then `RYU_API_URL`, then the documented host. */
export function controlPlaneUrl(options: RyuOptions, env: EnvReader): string {
	return (
		optionValue(options.baseUrl) ?? env("RYU_API_URL") ?? CONTROL_PLANE_URL
	);
}

interface BearerSpec {
	defaultUrl: string | null;
	keyEnv: string;
	keyOptional?: boolean;
	urlEnv: string;
}

const BEARER_SPECS: Readonly<
	Record<
		"notify" | "box" | "gateway" | "connect" | "passport" | "sites",
		BearerSpec
	>
> = {
	notify: {
		urlEnv: "RYU_NOTIFY_URL",
		keyEnv: "RYU_NOTIFY_API_KEY",
		defaultUrl: DEFAULT_NOTIFY_URL,
	},
	box: {
		urlEnv: "RYU_BOX_URL",
		keyEnv: "RYU_BOX_API_KEY",
		defaultUrl: DEFAULT_BOX_URL,
	},
	gateway: {
		urlEnv: "RYU_GATEWAY_URL",
		keyEnv: "RYU_GATEWAY_TOKEN",
		defaultUrl: DEFAULT_GATEWAY_URL,
		keyOptional: true,
	},
	connect: {
		urlEnv: "RYU_CONNECT_URL",
		keyEnv: "RYU_CONNECT_API_KEY",
		defaultUrl: null,
	},
	passport: {
		urlEnv: "RYU_PASSPORT_URL",
		keyEnv: "RYU_PASSPORT_API_KEY",
		defaultUrl: null,
	},
	sites: {
		urlEnv: "RYU_SITES_URL",
		keyEnv: "RYU_SITES_API_KEY",
		defaultUrl: null,
	},
};

function emptyConfig(
	service: RyuService,
	baseUrl: string,
	apiKey: string | null,
	auth: ServiceAuthScheme
): ResolvedServiceConfig {
	return {
		service,
		baseUrl,
		apiKey,
		auth,
		mailMode: null,
		managementKey: null,
		organizationId: null,
		runtimeKey: null,
	};
}

/** The organization sent with the control-plane `ryu_` key. */
function controlPlaneOrganization(
	options: RyuOptions,
	env: EnvReader,
	scoped?: string
): string | null {
	return (
		optionValue(scoped) ??
		optionValue(options.organizationId) ??
		env("RYU_ORGANIZATION_ID") ??
		null
	);
}

function resolveManagedAgents(
	options: RyuOptions,
	env: EnvReader
): ResolvedServiceConfig {
	const scoped = options.managedAgents ?? {};
	const baseUrl = optionValue(scoped.baseUrl) ?? controlPlaneUrl(options, env);
	const apiKey =
		optionValue(scoped.apiKey) ??
		optionValue(options.apiKey) ??
		env("RYU_API_KEY");
	if (!apiKey) {
		throw configurationError(
			"managedAgents",
			["RYU_API_KEY"],
			"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass apiKey."
		);
	}
	return {
		...emptyConfig(
			"managedAgents",
			checkedUrl("managedAgents", baseUrl, "RYU_API_URL"),
			apiKey,
			"x-api-key"
		),
		organizationId: controlPlaneOrganization(
			options,
			env,
			scoped.organizationId
		),
	};
}

/** One Mail credential the resolver can pick. */
interface MailCredential {
	key: string;
	kind: "gateway" | "self-hosted" | "api-key";
}

/**
 * Hosted or self-hosted Mail. Credential precedence: a key passed as an option
 * (`mail.gatewayKey`, `mail.apiKey`, `apiKey`) wins over every env var; within
 * options, and then within env vars, the node gateway key comes first, then
 * the self-hosted bearer, then the control-plane `ryu_` key. The `ryu_` key is
 * used only on the control-plane origin, so a self-hosted `RYU_MAIL_URL` never
 * receives it, and `managedAgents.apiKey` never selects hosted Mail.
 */
function resolveMail(
	options: RyuOptions,
	env: EnvReader,
	resolution: ConfigResolution = {}
): ResolvedServiceConfig {
	const scoped = options.mail ?? {};
	const url = optionValue(scoped.baseUrl) ?? env("RYU_MAIL_URL");
	const controlPlane = controlPlaneUrl(options, env);
	const urlIsControlPlane =
		url !== undefined && originOf(url) === originOf(controlPlane);
	// Explicit options first, then the environment; within each source the
	// gateway key, then the self-hosted bearer, then the `ryu_` key.
	const candidates: MailCredential[] = [
		{ kind: "gateway", key: optionValue(scoped.gatewayKey) },
		{ kind: "self-hosted", key: optionValue(scoped.apiKey) },
		{ kind: "api-key", key: optionValue(options.apiKey) },
		{ kind: "gateway", key: env("RYU_MAIL_GATEWAY_KEY") },
		{ kind: "self-hosted", key: env("RYU_MAIL_API_KEY") },
		{ kind: "api-key", key: env("RYU_API_KEY") },
	].filter((candidate): candidate is MailCredential => Boolean(candidate.key));
	const hasSelfHostedKey = candidates.some(
		(candidate) => candidate.kind === "self-hosted"
	);
	const chosen = candidates.find((candidate) => {
		switch (candidate.kind) {
			case "gateway":
				// A self-hosted URL with its bearer is self-hosted Mail.
				return !(url !== undefined && !urlIsControlPlane && hasSelfHostedKey);
			case "self-hosted":
				return true;
			default:
				// The `ryu_` key is sent only to the control-plane origin.
				return url === undefined || urlIsControlPlane;
		}
	});
	if (chosen?.kind === "self-hosted") {
		if (url === undefined) {
			throw configurationError(
				"mail",
				["RYU_MAIL_URL"],
				"Self-hosted Ryu Mail has no default URL: set RYU_MAIL_URL (or mail.baseUrl) to your Mail server."
			);
		}
		return {
			...emptyConfig(
				"mail",
				checkedUrl("mail", url, "RYU_MAIL_URL"),
				chosen.key,
				"bearer"
			),
			mailMode: "self-hosted",
		};
	}
	if (chosen?.kind === "gateway") {
		return {
			...emptyConfig(
				"mail",
				checkedUrl("mail", url ?? controlPlane, "RYU_MAIL_URL"),
				chosen.key,
				"x-gateway-key"
			),
			mailMode: "hosted",
		};
	}
	if (chosen?.kind === "api-key") {
		return {
			...emptyConfig(
				"mail",
				url === undefined
					? checkedUrl("mail", controlPlane, "RYU_API_URL")
					: checkedUrl("mail", url, "RYU_MAIL_URL"),
				chosen.key,
				"x-api-key"
			),
			mailMode: "hosted",
			organizationId: controlPlaneOrganization(options, env),
		};
	}
	if (
		resolution.credentials === "optional" &&
		(url === undefined || urlIsControlPlane)
	) {
		// A credential-free call (hosted `GET /api/mail/status`) with no Mail
		// key: the control-plane origin, sending no key and no organization.
		// Self-hosted Mail guards its status route, so it still needs a bearer.
		return {
			...emptyConfig(
				"mail",
				url === undefined
					? checkedUrl("mail", controlPlane, "RYU_API_URL")
					: checkedUrl("mail", url, "RYU_MAIL_URL"),
				null,
				"x-api-key"
			),
			mailMode: "hosted",
		};
	}
	if (urlIsControlPlane) {
		// RYU_MAIL_URL names the control-plane origin: that is hosted Mail, which
		// takes the `ryu_` key or a node gateway key, never a self-hosted bearer.
		throw configurationError(
			"mail",
			["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY"],
			"Hosted Ryu Mail needs a key: RYU_API_KEY (a ryu_ key with Mail scopes) or RYU_MAIL_GATEWAY_KEY (a node gateway key). RYU_MAIL_URL is the control-plane origin, so RYU_MAIL_API_KEY does not apply.",
			`Set RYU_API_KEY (or pass apiKey) to a ryu_ key with Mail scopes, or RYU_MAIL_GATEWAY_KEY (or mail.gatewayKey) for a node gateway key. See ${serviceDocsUrl("mail")}.`
		);
	}
	if (url !== undefined) {
		// A self-hosted URL without its bearer: the `ryu_` key never goes there.
		throw configurationError(
			"mail",
			["RYU_MAIL_API_KEY"],
			"Self-hosted Ryu Mail needs its bearer token: set RYU_MAIL_API_KEY (or mail.apiKey). The ryu_ key is sent only to hosted Mail on the control-plane origin."
		);
	}
	throw configurationError(
		"mail",
		["RYU_API_KEY", "RYU_MAIL_GATEWAY_KEY", "RYU_MAIL_API_KEY"],
		"Ryu Mail needs a key: RYU_API_KEY (a ryu_ key with Mail scopes) or RYU_MAIL_GATEWAY_KEY (a node gateway key) for hosted Mail, or RYU_MAIL_URL and RYU_MAIL_API_KEY for a self-hosted server.",
		`Set RYU_API_KEY (or pass apiKey) to a ryu_ key with Mail scopes for hosted Mail, or RYU_MAIL_GATEWAY_KEY (or mail.gatewayKey) for a node gateway key, or RYU_MAIL_URL and RYU_MAIL_API_KEY (or mail.baseUrl and mail.apiKey) for a self-hosted server. See ${serviceDocsUrl("mail")}.`
	);
}

/**
 * Ryu Messaging on the control plane: the same `ryu_` key and organization as
 * Managed Agents, with the `messaging` options first. The organization is
 * required, because every Messaging route names it in the path.
 */
function resolveMessaging(
	options: RyuOptions,
	env: EnvReader,
	resolution: ConfigResolution = {}
): ResolvedServiceConfig {
	const scoped = options.messaging ?? {};
	const baseUrl = optionValue(scoped.baseUrl) ?? controlPlaneUrl(options, env);
	const apiKey =
		optionValue(scoped.apiKey) ??
		optionValue(options.apiKey) ??
		env("RYU_API_KEY");
	const organizationId =
		optionValue(scoped.organizationId) ??
		optionValue(options.organizationId) ??
		env("RYU_ORGANIZATION_ID");
	const missing: string[] = [];
	if (!apiKey) {
		missing.push("RYU_API_KEY");
	}
	if (!organizationId) {
		missing.push("RYU_ORGANIZATION_ID");
	}
	const complete = Boolean(apiKey && organizationId);
	if (!complete && resolution.credentials !== "optional") {
		throw configurationError(
			"messaging",
			missing,
			`Ryu Messaging needs a ryu_ key and the organization it acts for: set ${missing.join(" and ")}.`
		);
	}
	return {
		...emptyConfig(
			"messaging",
			checkedUrl("messaging", baseUrl, "RYU_API_URL"),
			// A credential-free call without the full pair sends neither.
			complete ? (apiKey ?? null) : null,
			"x-api-key"
		),
		organizationId: complete ? (organizationId ?? null) : null,
	};
}

function resolveBearer(
	service: keyof typeof BEARER_SPECS,
	connection: ServiceConnection,
	env: EnvReader,
	overrides: { keyOptional?: boolean } = {}
): ResolvedServiceConfig {
	const spec = BEARER_SPECS[service];
	const url =
		optionValue(connection.baseUrl) ?? env(spec.urlEnv) ?? spec.defaultUrl;
	const apiKey = optionValue(connection.apiKey) ?? env(spec.keyEnv) ?? null;
	const missing: string[] = [];
	if (url === null) {
		missing.push(spec.urlEnv);
	}
	if (apiKey === null && !(spec.keyOptional || overrides.keyOptional)) {
		missing.push(spec.keyEnv);
	}
	if (url === null || missing.length > 0) {
		throw configurationError(
			service,
			missing,
			`${SERVICE_TITLES[service]} is not configured: set ${missing.join(" and ")}.${
				url === null ? " It has no default URL." : ""
			}`
		);
	}
	return emptyConfig(
		service,
		checkedUrl(service, url, spec.urlEnv),
		apiKey,
		"bearer"
	);
}

/**
 * Resolves one service's connection: constructor option, then the service's
 * env var, then the default. Throws RyuConfigurationError (`details.missing`
 * names the env vars) when a required value is absent.
 */
export function resolveServiceConfig(
	service: RyuService,
	options: RyuOptions,
	env: EnvReader,
	resolution: ConfigResolution = {}
): ResolvedServiceConfig {
	switch (service) {
		case "managedAgents":
			return resolveManagedAgents(options, env);
		case "messaging":
			return resolveMessaging(options, env, resolution);
		case "mail":
			return resolveMail(options, env, resolution);
		case "box":
			return {
				...resolveBearer("box", options.box ?? {}, env),
				webSocket: options.box?.webSocket,
			};
		case "connect":
			return {
				...resolveBearer("connect", options.connect ?? {}, env),
				managementKey:
					optionValue(options.connect?.managementKey) ??
					env("RYU_CONNECT_MANAGEMENT_KEY") ??
					null,
			};
		case "passport": {
			// A runtime-only agent needs no admin key; admin calls then fail
			// with a RyuConfigurationError naming RYU_PASSPORT_API_KEY.
			const runtimeKey =
				optionValue(options.passport?.runtimeKey) ??
				env("RYU_PASSPORT_RUNTIME_KEY") ??
				null;
			return {
				...resolveBearer("passport", options.passport ?? {}, env, {
					keyOptional: runtimeKey !== null,
				}),
				runtimeKey,
			};
		}
		case "notify":
		case "gateway":
		case "sites":
			return resolveBearer(service, options[service] ?? {}, env);
		default:
			throw new RyuConfigurationError({
				service,
				status: 0,
				message: `Unknown Ryu service ${JSON.stringify(service)}.`,
			});
	}
}

/** Env var roles that hold a secret. */
const SECRET_ROLES: ReadonlySet<EnvVarRole> = new Set([
	"key",
	"gateway-key",
	"management-key",
	"runtime-key",
]);

/**
 * The first service whose key is in an `env` object passed to the constructor
 * (Hono's `c.env`, an inlined config), or null. `process.env` is not read:
 * only an object the caller handed over can have been bundled into a page.
 */
function serviceWithKeyInEnvOption(options: RyuOptions): RyuService | null {
	if (typeof options.env !== "object" || options.env === null) {
		return null;
	}
	const read = createEnvReader(options.env);
	return (
		ENV_VARS.find(
			(row) => SECRET_ROLES.has(row.role) && read(row.name) !== undefined
		)?.service ?? null
	);
}

/** The first service whose key was passed as a constructor option, or null. */
function serviceWithExplicitKey(options: RyuOptions): RyuService | null {
	const keys: [RyuService, string | undefined][] = [
		["managedAgents", options.apiKey],
		["managedAgents", options.managedAgents?.apiKey],
		["messaging", options.messaging?.apiKey],
		["mail", options.mail?.apiKey],
		["mail", options.mail?.gatewayKey],
		["notify", options.notify?.apiKey],
		["box", options.box?.apiKey],
		["gateway", options.gateway?.apiKey],
		["connect", options.connect?.apiKey],
		["connect", options.connect?.managementKey],
		["passport", options.passport?.apiKey],
		["passport", options.passport?.runtimeKey],
		["sites", options.sites?.apiKey],
	];
	return (
		keys.find(([, key]) => typeof key === "string" && key !== "")?.[0] ?? null
	);
}

/**
 * Throws when a key is passed in a browser page without
 * `dangerouslyAllowBrowser`: anything shipped to a page is readable by its
 * visitors, so keys belong on a server.
 */
export function assertBrowserSafe(
	options: RyuOptions,
	globals: RuntimeGlobals = globalThis as RuntimeGlobals
): void {
	if (options.dangerouslyAllowBrowser === true || !isBrowserRuntime(globals)) {
		return;
	}
	const service =
		serviceWithExplicitKey(options) ?? serviceWithKeyInEnvOption(options);
	if (service !== null) {
		throw new RyuConfigurationError({
			service,
			status: 0,
			code: "browser_key_exposure",
			message:
				"Ryu: refusing to use an API key in a browser, where every visitor can read it. Call Ryu from your server, or pass dangerouslyAllowBrowser: true if the key is meant to be public.",
			docs: SDK_DOCS_URL,
		});
	}
}
