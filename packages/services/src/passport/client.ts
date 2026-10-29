// packages/services/src/passport/client.ts
//
// The Ryu Passport thin client (apps/passport/src/lib.rs). Two credentials:
//
// - the tenant administration bearer (`RYU_PASSPORT_API_KEY`) on
//   `/v1/capabilities`, `/v1/profiles`, `/v1/connections*` and `/v1/usage`;
// - a profile-scoped runtime grant (`RYU_PASSPORT_RUNTIME_KEY`) on
//   `/v1/runtime/*`, and on `runtime.connections.fetch`, which Passport accepts
//   from either credential.
//
// Auth, timeouts, retries and typed errors come from the service fetch shim.
// Newer Passport builds deduplicate `POST /v1/connections` by
// `Idempotency-Key` (capabilities `features.idempotency_keys`), but an older
// build ignores the header. The client sets no key itself: the shim adds one
// to the create (and may retry it) only after the capabilities read said the
// server honours it (PASSPORT_ROUTES.capabilityIdempotent). Every other POST
// is never retried on a network error or 5xx: `fetch` could repeat an
// upstream call.
// Bodies keep the server's wire casing exactly: snake_case on connection
// records and create/login bodies, camelCase on fetch and usage. Passport
// errors are JSON `{ error, code }` (plus `ok`/`message` on 402
// `insufficient_credits` and 503 `metering_unavailable`), or RFC 9457
// problem+json when `Accept` asks for it. Older builds also sent `{ error }`
// prose, plain text or an empty body; the shim's parser handles every form.

import type { RyuFetch } from "@ryuhq/client";
import { z } from "zod";
import { RyuConfigurationError } from "../errors.ts";
import {
	pathSegment,
	requestJson,
	requireUsageWindow,
} from "../transport/request.ts";

// --- Wire types ---------------------------------------------------------------

/** Durable authentication state of a connection. */
export type PassportConnectionStatus = "AUTHENTICATED" | "NEEDS_AUTH";

/** Transient login-flow state of a connection. */
export type PassportFlowStatus = "IDLE" | "IN_PROGRESS" | "DONE" | "FAILED";

/** One per-domain login. Credential state never appears in a response. */
export interface PassportConnection {
	/** Unix seconds. */
	created_at: number;
	domain: string;
	flow_status: PassportFlowStatus;
	/** `conn_…`. */
	id: string;
	/** Unix seconds of the last health check; 0 when never checked. */
	last_checked: number;
	profile_id: string;
	/** The credential source that captured it (`manual` by default). */
	source: string;
	status: PassportConnectionStatus;
	/** Unix seconds. */
	updated_at: number;
	[field: string]: unknown;
}

/** A profile groups the connections an agent bound to it may use. */
export interface PassportProfile {
	connections: PassportConnection[];
	profile_id: string;
	[field: string]: unknown;
}

/** `GET /v1/capabilities`. */
export interface PassportCapabilities {
	api_version: string;
	features: Record<string, boolean>;
	service: string;
	[field: string]: unknown;
}

/** `GET /v1/profiles`. */
export interface PassportProfileList {
	profiles: PassportProfile[];
	[field: string]: unknown;
}

/** `GET /v1/connections` and `GET /v1/runtime/connections`. */
export interface PassportConnectionList {
	connections: PassportConnection[];
	[field: string]: unknown;
}

/** `GET /v1/connections/{id}`. */
export interface PassportConnectionDetail {
	connection: PassportConnection;
	flow_status: PassportFlowStatus;
	status: PassportConnectionStatus;
	[field: string]: unknown;
}

/** `connections.create()` input, in the server's snake_case. */
export interface PassportCreateConnectionInput {
	/** The domain the login is for, e.g. `github.com`. */
	domain: string;
	profile_id: string;
	/** A credential source id; the operator's registry picks one by domain when omitted. */
	source?: string;
}

/** `POST /v1/connections` (201). */
export interface PassportCreatedConnection {
	connection: PassportConnection;
	[field: string]: unknown;
}

/** `POST /v1/connections/{id}/login`. */
export interface PassportLoginFlow {
	flow_id: string;
	kind: { kind: "hosted"; url: string } | { kind: "manual" };
	[field: string]: unknown;
}

/**
 * `connections.importState()` input: credential state captured outside
 * Passport, for a connection whose login flow is `manual`.
 */
export interface PassportImportStateInput {
	/**
	 * The captured state as one string, at most 512 KiB, for example a cookie
	 * header such as `session=abc123`. Passport seals it and never returns it.
	 */
	state: string;
}

/** `DELETE /v1/connections/{id}`. */
export interface PassportDeletedConnection {
	deleted: boolean;
	id: string;
	[field: string]: unknown;
}

/** HTTP methods a fetch may use. Administration bearers may only `GET`; runtime grants list theirs. */
export type PassportFetchMethod =
	| "GET"
	| "HEAD"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE"
	| "OPTIONS";

/** One part of a structured credential header. */
export type PassportHeaderPart =
	| { literal: string }
	| { sensitive: string }
	| { vault: string };

/** `connections.fetch()` input, in the server's camelCase. */
export interface PassportFetchInput {
	/** A JSON body, for methods the credential is granted. */
	body?: unknown;
	/** Headers whose values may name `vault:<domain>` to splice in the stored credential. */
	credentialHeaders?: Record<string, string>;
	/** Plain request headers. */
	headers?: Record<string, string>;
	/** Structured credential headers (literal, sensitive and vault parts). */
	headerTemplates?: Record<string, PassportHeaderPart[]>;
	/** Truncate `content` to this many characters (server default 20 000). */
	maxContentChars?: number;
	/** Default `GET`. */
	method?: PassportFetchMethod;
	/** HTTPS on the connection's exact domain and port 443. */
	url: string;
}

/** `POST /v1/connections/{id}/fetch`: the upstream answer, redacted. */
export interface PassportFetchResult {
	/** Whether a credential was attached, not whether the provider accepted it. */
	authenticated: boolean;
	/** The upstream body as text, with credential values redacted. */
	content: string;
	/** The upstream HTTP status. */
	status: number;
	truncated: boolean;
	/** Upstream `WWW-Authenticate` payment challenges on a 402. */
	wwwAuthenticate?: string[];
	[field: string]: unknown;
}

/** `usage()` window: both bounds required, whole UTC hours, at most 31 days apart. */
export interface PassportUsageQuery {
	/** Window start, included: an RFC 3339 UTC time on a whole hour, e.g. `2026-10-12T00:00:00Z`. */
	from: string;
	/** Window end, excluded: an RFC 3339 UTC time on a whole hour, after `from`. */
	to: string;
}

/** `GET /v1/usage`. */
export interface PassportUsageReport {
	from: string;
	meters: { connectionSeconds: number; fetches: number };
	ok: boolean;
	to: string;
	type: string;
	[field: string]: unknown;
}

// --- Decoders -----------------------------------------------------------------

/** Validates one connection record. */
export const passportConnectionSchema = z.looseObject({
	created_at: z.number(),
	domain: z.string(),
	flow_status: z.enum(["IDLE", "IN_PROGRESS", "DONE", "FAILED"]),
	id: z.string(),
	last_checked: z.number(),
	profile_id: z.string(),
	source: z.string(),
	status: z.enum(["AUTHENTICATED", "NEEDS_AUTH"]),
	updated_at: z.number(),
});

/** Validates `GET /v1/capabilities`. */
export const passportCapabilitiesSchema = z.looseObject({
	api_version: z.string(),
	features: z.record(z.string(), z.boolean()),
	service: z.string(),
});

/** Validates `GET /v1/profiles`. */
export const passportProfileListSchema = z.looseObject({
	profiles: z.array(
		z.looseObject({
			connections: z.array(passportConnectionSchema),
			profile_id: z.string(),
		})
	),
});

/** Validates `GET /v1/connections` and `GET /v1/runtime/connections`. */
export const passportConnectionListSchema = z.looseObject({
	connections: z.array(passportConnectionSchema),
});

/** Validates `GET /v1/connections/{id}`. */
export const passportConnectionDetailSchema = z.looseObject({
	connection: passportConnectionSchema,
	flow_status: passportConnectionSchema.shape.flow_status,
	status: passportConnectionSchema.shape.status,
});

/** Validates `POST /v1/connections`. */
export const passportCreatedConnectionSchema = z.looseObject({
	connection: passportConnectionSchema,
});

/** Validates `POST /v1/connections/{id}/login`. */
export const passportLoginFlowSchema = z.looseObject({
	flow_id: z.string(),
	kind: z.union([
		z.looseObject({ kind: z.literal("hosted"), url: z.string() }),
		z.looseObject({ kind: z.literal("manual") }),
	]),
});

/** Validates `DELETE /v1/connections/{id}`. */
export const passportDeletedConnectionSchema = z.looseObject({
	deleted: z.boolean(),
	id: z.string(),
});

/** Validates `POST /v1/connections/{id}/fetch`. */
export const passportFetchResultSchema = z.looseObject({
	authenticated: z.boolean(),
	content: z.string(),
	status: z.number(),
	truncated: z.boolean(),
	wwwAuthenticate: z.array(z.string()).optional(),
});

/** Validates `GET /v1/usage`. */
export const passportUsageReportSchema = z.looseObject({
	from: z.string(),
	meters: z.looseObject({
		connectionSeconds: z.number(),
		fetches: z.number(),
	}),
	ok: z.boolean(),
	to: z.string(),
	type: z.string(),
});

// --- Client -------------------------------------------------------------------

/** The Passport connection one call uses. */
export interface PassportClientConfig {
	/** The tenant administration bearer; null when only a runtime grant is configured. */
	apiKey: string | null;
	baseUrl: string;
	/** The runtime grant token, when configured. */
	runtimeKey: string | null;
}

/** Path prefix of the routes that take the runtime grant. */
export const PASSPORT_RUNTIME_PREFIX = "/v1/runtime/";

/** The Passport calls; each makes exactly one request. */
export interface PassportClient {
	capabilities(): Promise<PassportCapabilities>;
	createConnection(
		input: PassportCreateConnectionInput
	): Promise<PassportCreatedConnection>;
	deleteConnection(id: string): Promise<PassportDeletedConnection>;
	fetchConnection(
		id: string,
		input: PassportFetchInput,
		credential: "admin" | "runtime"
	): Promise<PassportFetchResult>;
	getConnection(id: string): Promise<PassportConnectionDetail>;
	importState(
		id: string,
		input: PassportImportStateInput
	): Promise<PassportConnectionDetail>;
	listConnections(): Promise<PassportConnectionList>;
	listProfiles(): Promise<PassportProfileList>;
	listRuntimeConnections(): Promise<PassportConnectionList>;
	login(id: string): Promise<PassportLoginFlow>;
	usage(query: PassportUsageQuery): Promise<PassportUsageReport>;
}

/** The RyuConfigurationError for an administration call without the administration key. */
export function missingAdminKey(): RyuConfigurationError {
	return new RyuConfigurationError({
		service: "passport",
		status: 0,
		code: "configuration_error",
		message:
			"Ryu Passport administration routes need the tenant administration token: set RYU_PASSPORT_API_KEY or pass passport.apiKey. A runtime grant only reaches ryu.passport.runtime.",
		details: { missing: ["RYU_PASSPORT_API_KEY"] },
		hint: "Agents should call ryu.passport.runtime.connections with RYU_PASSPORT_RUNTIME_KEY instead of holding the administration token.",
	});
}

/** The RyuConfigurationError for a runtime call without a runtime key. */
export function missingRuntimeKey(): RyuConfigurationError {
	return new RyuConfigurationError({
		service: "passport",
		status: 0,
		code: "configuration_error",
		message:
			"Ryu Passport runtime routes need a runtime grant token: set RYU_PASSPORT_RUNTIME_KEY or pass passport.runtimeKey. The administration key is not accepted there.",
		details: { missing: ["RYU_PASSPORT_RUNTIME_KEY"] },
		hint: "Set RYU_PASSPORT_RUNTIME_KEY to a token from the operator's RYU_PASSPORT_RUNTIME_GRANTS.",
	});
}

function connectionPath(id: string, action = ""): string {
	return `/v1/connections/${pathSegment("passport", id, "the connection id")}${action ? `/${action}` : ""}`;
}

/**
 * Only what the capability probe needs from `GET /v1/capabilities`: an object
 * `features`. Feature values are not checked, so a future non-boolean flag
 * never breaks the probe (the full schema is for `capabilities()`).
 */
const passportFeaturesSchema = z.looseObject({ features: z.looseObject({}) });

/**
 * Reads Passport's `features` for capability-gated routes, with the
 * administration key. Does not validate the rest of the response.
 */
export function readPassportFeatures(
	config: PassportClientConfig,
	fetch: RyuFetch
): Promise<Readonly<Record<string, unknown>>> {
	if (!config.apiKey) {
		return Promise.reject(missingAdminKey());
	}
	return requestJson(fetch, config.baseUrl, {
		decode: (value) => passportFeaturesSchema.parse(value).features,
		headers: { authorization: `Bearer ${config.apiKey}` },
		method: "GET",
		path: "/v1/capabilities",
	});
}

/** Builds the Passport client over `fetch` (the call's service-scoped fetch). Does no I/O. */
export function createPassportClient(
	config: PassportClientConfig,
	fetch: RyuFetch,
	signal?: AbortSignal
): PassportClient {
	const admin = (): Record<string, string> => {
		if (!config.apiKey) {
			throw missingAdminKey();
		}
		return { authorization: `Bearer ${config.apiKey}` };
	};
	const runtime = (): Record<string, string> => {
		if (!config.runtimeKey) {
			throw missingRuntimeKey();
		}
		return { authorization: `Bearer ${config.runtimeKey}` };
	};
	const get = <T>(path: string, decode: (value: unknown) => T) =>
		requestJson(fetch, config.baseUrl, {
			decode,
			headers: admin(),
			method: "GET",
			path,
			signal,
		});
	return {
		capabilities: () =>
			get(
				"/v1/capabilities",
				(value) =>
					passportCapabilitiesSchema.parse(value) as PassportCapabilities
			),
		createConnection: (input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					domain: input.domain,
					profile_id: input.profile_id,
					source: input.source,
				},
				decode: (value) =>
					passportCreatedConnectionSchema.parse(
						value
					) as PassportCreatedConnection,
				headers: admin(),
				method: "POST",
				path: "/v1/connections",
				signal,
			}),
		deleteConnection: (id) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					passportDeletedConnectionSchema.parse(
						value
					) as PassportDeletedConnection,
				headers: admin(),
				method: "DELETE",
				path: connectionPath(id),
				signal,
			}),
		fetchConnection: (id, input, credential) => {
			const headers = credential === "runtime" ? runtime() : admin();
			return requestJson(fetch, config.baseUrl, {
				body: input,
				decode: (value) =>
					passportFetchResultSchema.parse(value) as PassportFetchResult,
				headers,
				method: "POST",
				path: connectionPath(id, "fetch"),
				signal,
			});
		},
		getConnection: (id) =>
			get(
				connectionPath(id),
				(value) =>
					passportConnectionDetailSchema.parse(
						value
					) as PassportConnectionDetail
			),
		importState: (id, input) =>
			requestJson(fetch, config.baseUrl, {
				body: { state: input.state },
				decode: (value) =>
					passportConnectionDetailSchema.parse(
						value
					) as PassportConnectionDetail,
				headers: admin(),
				method: "POST",
				path: connectionPath(id, "import"),
				signal,
			}),
		listConnections: () =>
			get(
				"/v1/connections",
				(value) =>
					passportConnectionListSchema.parse(value) as PassportConnectionList
			),
		listProfiles: () =>
			get(
				"/v1/profiles",
				(value) => passportProfileListSchema.parse(value) as PassportProfileList
			),
		listRuntimeConnections: () =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					passportConnectionListSchema.parse(value) as PassportConnectionList,
				headers: runtime(),
				method: "GET",
				path: `${PASSPORT_RUNTIME_PREFIX}connections`,
				signal,
			}),
		login: (id) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					passportLoginFlowSchema.parse(value) as PassportLoginFlow,
				headers: admin(),
				method: "POST",
				path: connectionPath(id, "login"),
				signal,
			}),
		usage: (query) => {
			const window = requireUsageWindow("passport", query);
			return requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					passportUsageReportSchema.parse(value) as PassportUsageReport,
				headers: admin(),
				method: "GET",
				path: "/v1/usage",
				query: { from: window.from, to: window.to },
				signal,
			});
		},
	};
}
