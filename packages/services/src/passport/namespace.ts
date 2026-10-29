// packages/services/src/passport/namespace.ts
//
// `ryu.passport`: the Ryu Passport thin client (design §2.4).
//
//   ryu.passport.capabilities()
//   ryu.passport.profiles.list()
//   ryu.passport.connections.list() / get(id) / create({ profile_id, domain }) / delete(id)
//   ryu.passport.connections.login(id) / importState(id, { state }) / fetch(id, { url })
//   ryu.passport.runtime.connections.list() / fetch(id, { url }) / hasRuntimeGrant()   (runtime grant)
//   ryu.passport.usage({ from, to })
//
// Bearer `RYU_PASSPORT_API_KEY` (administration) and `RYU_PASSPORT_RUNTIME_KEY`
// (runtime grant), no default URL. Either key alone is enough to configure the
// service: a call that needs the missing one fails with a RyuConfigurationError
// naming it, before any request. Wire casing is kept exactly as Passport sends
// it. No POST is retried on a network error or 5xx, except `connections.create`
// on a Passport that advertises `features.idempotency_keys`: the SDK reads
// `GET /v1/capabilities` (cached per Ryu instance and base URL for five
// minutes), and only then generates an `Idempotency-Key` for the create and
// retries it with the same key. A key the caller supplies is always sent.

import type { RyuFetch } from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import { RyuInvalidRequestError } from "../errors.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	createPassportClient,
	PASSPORT_RUNTIME_PREFIX,
	type PassportCapabilities,
	type PassportConnectionDetail,
	type PassportConnectionList,
	type PassportCreateConnectionInput,
	type PassportCreatedConnection,
	type PassportDeletedConnection,
	type PassportFetchInput,
	type PassportFetchResult,
	type PassportImportStateInput,
	type PassportLoginFlow,
	type PassportProfileList,
	type PassportUsageQuery,
	type PassportUsageReport,
	readPassportFeatures,
} from "./client.ts";
import { PASSPORT_ROUTES } from "./routes.ts";

export type {
	PassportCapabilities,
	PassportConnection,
	PassportConnectionDetail,
	PassportConnectionList,
	PassportConnectionStatus,
	PassportCreateConnectionInput,
	PassportCreatedConnection,
	PassportDeletedConnection,
	PassportFetchInput,
	PassportFetchMethod,
	PassportFetchResult,
	PassportFlowStatus,
	PassportHeaderPart,
	PassportImportStateInput,
	PassportLoginFlow,
	PassportProfile,
	PassportProfileList,
	PassportUsageQuery,
	PassportUsageReport,
} from "./client.ts";

/** `ryu.passport.connections`: administration-key calls. */
export interface PassportConnectionsNamespace {
	/**
	 * `POST /v1/connections`: a new `NEEDS_AUTH` connection.
	 *
	 * Before a create, the SDK reads `GET /v1/capabilities` (an extra request
	 * your hooks do not see, cached per Ryu instance and base URL for five
	 * minutes, with its own 5-second timeout). When it lists
	 * `features.idempotency_keys: true`, the create carries an
	 * `Idempotency-Key` (yours from `.with({ idempotencyKey })`, or a UUID) and
	 * is retried with that key on a network error, timeout or 5xx. Otherwise
	 * (an older Passport, or the capabilities read failed) the SDK adds no key
	 * of its own and never retries those failures. A key you bind is still
	 * sent: a Passport that supports keys deduplicates your own retry with the
	 * same key, and an older one ignores it, so before retrying against an
	 * older Passport list the profile's connections and reuse one for the
	 * same domain.
	 */
	create(
		input: PassportCreateConnectionInput
	): Promise<PassportCreatedConnection>;
	/**
	 * `DELETE /v1/connections/{id}`: removes the connection and its sealed state.
	 *
	 * Retried on a network error, timeout or 5xx like a read. When the first
	 * attempt deleted the connection but its response was lost, the retry
	 * answers `404 not_found`: treat a 404 from `delete()` as "already gone".
	 */
	delete(id: string): Promise<PassportDeletedConnection>;
	/**
	 * `POST /v1/connections/{id}/fetch` with the administration key, which
	 * Passport allows to `GET` only. Agents should use
	 * `runtime.connections.fetch()` with a runtime grant. Never retried on a
	 * network error or 5xx: the upstream call may already have happened.
	 */
	fetch(id: string, input: PassportFetchInput): Promise<PassportFetchResult>;
	/** `GET /v1/connections/{id}`: status and flow metadata. */
	get(id: string): Promise<PassportConnectionDetail>;
	/**
	 * `POST /v1/connections/{id}/import`: seals credential state you captured
	 * yourself (at most 512 KiB, for example a cookie header) and marks the
	 * connection `AUTHENTICATED`. This completes a login whose
	 * `login()` flow kind is `manual`; until then a fetch answers
	 * `409 conflict`. The response carries status metadata only: Passport never
	 * returns the state. Never retried on a network error or 5xx. A missing or
	 * non-string `state` is refused with `invalid_request` before any request.
	 */
	importState(
		id: string,
		input: PassportImportStateInput
	): Promise<PassportConnectionDetail>;
	/** `GET /v1/connections`: every connection in the tenant, status only. */
	list(): Promise<PassportConnectionList>;
	/**
	 * `POST /v1/connections/{id}/login`: starts the configured login source.
	 * A `hosted` flow returns a URL to open; a `manual` flow is completed with
	 * {@link importState}.
	 */
	login(id: string): Promise<PassportLoginFlow>;
}

/** `ryu.passport.runtime.connections`: runtime-grant calls (`RYU_PASSPORT_RUNTIME_KEY`). */
export interface PassportRuntimeConnectionsNamespace {
	/**
	 * `POST /v1/connections/{id}/fetch` with the runtime grant: the methods it
	 * may use are the grant's `allowedMethods`, and a connection outside its
	 * profiles answers 404. Never retried on a network error or 5xx.
	 */
	fetch(id: string, input: PassportFetchInput): Promise<PassportFetchResult>;
	/**
	 * Resolves whether a runtime grant token is configured
	 * (`RYU_PASSPORT_RUNTIME_KEY` or `passport.runtimeKey`). Makes no network
	 * call and never reveals the key. Rejects with a RyuConfigurationError (or,
	 * in object mode, resolves to its error result) when Passport itself is not
	 * configured, for example without `RYU_PASSPORT_URL`, so it is never
	 * truthy when nothing works. Asynchronous, unlike the synchronous
	 * `ryu.isConfigured(service)` config check.
	 */
	hasRuntimeGrant(): Promise<boolean>;
	/** @deprecated Use {@link hasRuntimeGrant}; the name clashed with the synchronous `ryu.isConfigured(service)`. */
	isConfigured(): Promise<boolean>;
	/** `GET /v1/runtime/connections`: the grant's profiles' connections. */
	list(): Promise<PassportConnectionList>;
}

/** The methods of `ryu.passport`. */
export interface PassportNamespace {
	/** `GET /v1/capabilities`: the contract summary. */
	capabilities(): Promise<PassportCapabilities>;
	readonly connections: PassportConnectionsNamespace;
	readonly profiles: {
		/** `GET /v1/profiles`: profiles with their status-only connections. */
		list(): Promise<PassportProfileList>;
	};
	readonly runtime: {
		readonly connections: PassportRuntimeConnectionsNamespace;
	};
	/** `GET /v1/usage`: connection-seconds and fetches for a window of whole UTC hours, up to 31 days. */
	usage(query: PassportUsageQuery): Promise<PassportUsageReport>;
}

/**
 * Refuses a missing or non-string `state` before any request, as Python's
 * `import_state` does (`invalid_request`, `details.missing` / `details.invalid`).
 */
function assertImportStateInput(input: unknown): void {
	const state: unknown =
		input !== null && typeof input === "object"
			? Reflect.get(input, "state")
			: undefined;
	if (typeof state === "string") {
		return;
	}
	throw new RyuInvalidRequestError({
		service: "passport",
		status: 0,
		code: "invalid_request",
		message:
			"Ryu Passport connections.importState: pass { state }, the captured credential state as one string.",
		details:
			state === undefined || state === null
				? { missing: ["state"] }
				: { invalid: ["state"] },
		retryable: false,
	});
}

export function createPassportNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): PassportNamespace {
	const client = createPassportClient(
		{
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			runtimeKey: config.runtimeKey,
		},
		fetch,
		options.signal
	);
	return {
		capabilities: () => client.capabilities(),
		connections: {
			create: (input) => client.createConnection(input),
			delete: (id) => client.deleteConnection(id),
			fetch: (id, input) => client.fetchConnection(id, input, "admin"),
			get: (id) => client.getConnection(id),
			importState: async (id, input) => {
				assertImportStateInput(input);
				return await client.importState(id, input);
			},
			list: () => client.listConnections(),
			login: (id) => client.login(id),
		},
		profiles: { list: () => client.listProfiles() },
		runtime: {
			connections: {
				fetch: (id, input) => client.fetchConnection(id, input, "runtime"),
				hasRuntimeGrant: () => Promise.resolve(Boolean(config.runtimeKey)),
				isConfigured: () => Promise.resolve(Boolean(config.runtimeKey)),
				list: () => client.listRuntimeConnections(),
			},
		},
		usage: (query) => client.usage(query),
	};
}

/**
 * Reads Passport's feature flags for capability-gated routes. Parses only
 * `features`, so a new non-boolean flag cannot turn keyed creates off.
 */
function probePassportCapabilities(
	config: ResolvedServiceConfig,
	fetch: RyuFetch
): Promise<Readonly<Record<string, unknown>>> {
	return readPassportFeatures(
		{
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			runtimeKey: config.runtimeKey,
		},
		fetch
	);
}

/** How the facade wraps Passport. */
export const PASSPORT_NAMESPACE: NamespaceDefinition<PassportNamespace> = {
	create: createPassportNamespace,
	errors: "throw",
	probeCapabilities: probePassportCapabilities,
	routes: PASSPORT_ROUTES,
	// The shim presents the runtime grant on every `/v1/runtime/*` request,
	// whatever header the client set, so the administration key never reaches
	// a runtime route.
	selectKey: (config) =>
		config.runtimeKey
			? ({ path }) =>
					path?.startsWith(PASSPORT_RUNTIME_PREFIX)
						? config.runtimeKey
						: undefined
			: undefined,
	service: "passport",
};
