// packages/services/src/gateway/namespace.ts
//
// `ryu.gateway`: the OpenAI-compatible Ryu Gateway thin client (design §2.4).
//
//   ryu.gateway.health() / auth.status() / models.list()
//   ryu.gateway.chat.completions.create({ model, messages })            -> completion
//   ryu.gateway.chat.completions.create({ model, messages, stream: true }) -> chunks
//   ryu.gateway.chat.completions.stream({ model, messages })            -> chunks
//   ryu.gateway.embeddings.create({ model, input })
//   ryu.gateway.openAICompatible()   -> { baseURL, apiKey }; no network call
//
// Bearer `RYU_GATEWAY_TOKEN` (required unless the Gateway disables auth), default URL `http://127.0.0.1:7981`.
// `create` is overloaded on `stream`, so the interface is written out here
// (design D9), and its object-mode type is declared through SAFE_VIEW: a
// mapped type sees only the last overload, which would hide
// `create({ stream: true })` in object mode.
//
// An upstream provider failure reaches the SDK as `502 provider_error`; the
// Gateway adds the provider's own status as `error.upstream_status`
// (apps/gateway/src/error.rs `upstream_status`). `refineGatewayError` copies
// it to `details.upstreamStatus`, and marks the error `retryable: false` when
// the provider answered a final 4xx (the same request is refused again, and a
// replay could be billed). An upstream 408, 425 or 429 is transient and, like
// an upstream 5xx or none, changes nothing else.

import type { RyuFetch } from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import { type RyuError, withRyuErrorFields } from "../errors.ts";
import type { RyuResult, SAFE_VIEW } from "../result.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	createGatewayClient,
	type GatewayAuthStatus,
	type GatewayChatCompletion,
	type GatewayChatCompletionChunk,
	type GatewayChatCompletionParams,
	type GatewayEmbeddingList,
	type GatewayEmbeddingParams,
	type GatewayHealth,
	type GatewayModelList,
	type GatewayOpenAICompatibleConfig,
} from "./client.ts";
import { GATEWAY_ROUTES } from "./routes.ts";

export type {
	GatewayAuthStatus,
	GatewayChatCompletion,
	GatewayChatCompletionChunk,
	GatewayChatCompletionParams,
	GatewayChatMessage,
	GatewayEmbeddingList,
	GatewayEmbeddingParams,
	GatewayHealth,
	GatewayModel,
	GatewayModelList,
	GatewayOpenAICompatibleConfig,
} from "./client.ts";

/** `ryu.gateway.chat.completions` in object mode: streams stay async iterables. */
export interface SafeGatewayChatCompletions {
	create(
		params: GatewayChatCompletionParams & { stream: true }
	): AsyncGenerator<GatewayChatCompletionChunk>;
	create(
		params: GatewayChatCompletionParams & { stream?: false | null }
	): Promise<RyuResult<GatewayChatCompletion>>;
	stream(
		params: GatewayChatCompletionParams
	): AsyncGenerator<GatewayChatCompletionChunk>;
}

/** `ryu.gateway.chat.completions`. */
export interface GatewayChatCompletions {
	/**
	 * `POST /v1/chat/completions` with `stream: true`: chunks until `[DONE]`.
	 * One attempt; a dropped stream is not resumed.
	 */
	create(
		params: GatewayChatCompletionParams & { stream: true }
	): AsyncGenerator<GatewayChatCompletionChunk>;
	/** `POST /v1/chat/completions`. Never retried on a 5xx; a 429 is retried after its wait. */
	create(
		params: GatewayChatCompletionParams & { stream?: false | null }
	): Promise<GatewayChatCompletion>;
	/** Same as `create({ ...params, stream: true })`; any `stream` value in `params` is replaced. */
	stream(
		params: GatewayChatCompletionParams
	): AsyncGenerator<GatewayChatCompletionChunk>;
	/** Type-only: the object-mode shape (see `Safe`). */
	readonly [SAFE_VIEW]?: SafeGatewayChatCompletions;
}

/** The methods of `ryu.gateway`. */
export interface GatewayNamespace {
	readonly auth: {
		/** `GET /v1/auth/status`: is the token accepted, and is it the admin key. */
		status(): Promise<GatewayAuthStatus>;
	};
	readonly chat: { readonly completions: GatewayChatCompletions };
	readonly embeddings: {
		/** `POST /v1/embeddings`. Never retried on a 5xx. */
		create(params: GatewayEmbeddingParams): Promise<GatewayEmbeddingList>;
	};
	/** `GET /health`: liveness and version (more fields for the admin key). */
	health(): Promise<GatewayHealth>;
	readonly models: {
		/** `GET /v1/models`: the models this Gateway can route to. */
		list(): Promise<GatewayModelList>;
	};
	/**
	 * `{ baseURL, apiKey }` for the official `openai` SDK or the AI SDK's
	 * OpenAI-compatible provider. Makes no network call.
	 */
	openAICompatible(): GatewayOpenAICompatibleConfig;
}

/** Builds the Gateway client for one call. Does no I/O. */
export function createGatewayNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): GatewayNamespace {
	const client = createGatewayClient(
		{ apiKey: config.apiKey, baseUrl: config.baseUrl },
		fetch,
		options.signal
	);
	function create(
		params: GatewayChatCompletionParams & { stream: true }
	): AsyncGenerator<GatewayChatCompletionChunk>;
	function create(
		params: GatewayChatCompletionParams & { stream?: false | null }
	): Promise<GatewayChatCompletion>;
	function create(
		params: GatewayChatCompletionParams
	):
		| AsyncGenerator<GatewayChatCompletionChunk>
		| Promise<GatewayChatCompletion> {
		return params.stream === true
			? client.chatCompletionStream(params)
			: client.chatCompletion(params);
	}
	return {
		auth: { status: () => client.authStatus() },
		chat: {
			completions: {
				create,
				stream: (params) => client.chatCompletionStream(params),
			},
		},
		embeddings: { create: (params) => client.embeddings(params) },
		health: () => client.health(),
		models: { list: () => client.listModels() },
		openAICompatible: () => client.openAICompatible(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `error.upstream_status` from a Gateway error body, when it is an HTTP error status. */
export function gatewayUpstreamStatus(body: unknown): number | null {
	const error = isRecord(body) ? body.error : undefined;
	const status = isRecord(error) ? error.upstream_status : undefined;
	return typeof status === "number" &&
		Number.isInteger(status) &&
		status >= 400 &&
		status <= 599
		? status
		: null;
}

/** Upstream 4xx statuses that are transient: the provider may accept the same request later. */
const TRANSIENT_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([
	408, 425, 429,
]);

/**
 * Adds `details.upstreamStatus` from the Gateway's `error.upstream_status`,
 * and makes an upstream 4xx final (`retryable: false`), except the transient
 * 408, 425 and 429. Any other error is returned unchanged.
 */
export function refineGatewayError(error: RyuError, body: unknown): RyuError {
	const upstreamStatus = gatewayUpstreamStatus(body);
	if (upstreamStatus === null) {
		return error;
	}
	const details = {
		...(isRecord(error.details) ? error.details : {}),
		upstreamStatus,
	};
	return withRyuErrorFields(
		error,
		upstreamStatus < 500 && !TRANSIENT_UPSTREAM_STATUSES.has(upstreamStatus)
			? { details, retryable: false }
			: { details }
	);
}

/** How the facade wraps Gateway. */
export const GATEWAY_NAMESPACE: NamespaceDefinition<GatewayNamespace> = {
	create: createGatewayNamespace,
	errors: "throw",
	refineError: refineGatewayError,
	routes: GATEWAY_ROUTES,
	service: "gateway",
	syncMethods: ["openAICompatible"],
};
