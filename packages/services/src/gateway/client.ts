// packages/services/src/gateway/client.ts
//
// The OpenAI-compatible Ryu Gateway thin client. It builds requests and
// decodes replies; auth, timeouts, retries and typed errors come from the
// service fetch shim it runs over (design §4):
//
// - Gateway lists no idempotent routes, so a POST (chat, embeddings) is never
//   retried on a network error or 5xx: an upstream 4xx arrives as
//   `502 provider_error`, and replaying it could bill the provider twice
//   (`refineGatewayError` in namespace.ts exposes `error.upstream_status` as
//   `details.upstreamStatus` and makes an upstream 4xx final for every method);
// - only `429 provider_rate_limited` carrying `Retry-After` (or the body's
//   `error.retry_after`) is retried, after that wait: the provider refused the
//   request without running it. The Gateway's own `429 rate_limit_exceeded`
//   carries no wait hint, so the shim never retries it;
// - a streamed completion is one attempt (`Accept: text/event-stream`), read
//   with `readServerSentEvents` from `@ryuhq/client` and ended on `[DONE]`.
//
// Response shapes follow the OpenAI wire format the Gateway serves. Decoders
// check the fields the SDK relies on and keep every other field.

import { type RyuFetch, readServerSentEvents } from "@ryuhq/client";
import { z } from "zod";
import { createRyuError } from "../errors.ts";
import { requestJson, requestRaw } from "../transport/request.ts";

// --- Wire types ---------------------------------------------------------------

/** One chat message. Extra OpenAI fields (`name`, `tool_calls`, …) pass through. */
export interface GatewayChatMessage {
	/** Text, a list of content parts, or null (an assistant tool call). */
	content?: string | readonly Record<string, unknown>[] | null;
	role: "system" | "developer" | "user" | "assistant" | "tool" | (string & {});
	[field: string]: unknown;
}

/** `POST /v1/chat/completions` body. Any other OpenAI parameter passes through. */
export interface GatewayChatCompletionParams {
	max_tokens?: number;
	messages: readonly GatewayChatMessage[];
	/** A Gateway model id, e.g. `openai/gpt-4o-mini`; list them with `models.list()`. */
	model: string;
	/** `true` streams chunks; use `chat.completions.stream()` or the streaming overload. */
	stream?: boolean | null;
	temperature?: number;
	tools?: readonly Record<string, unknown>[];
	[parameter: string]: unknown;
}

/** Token counts, when the provider reports them. */
export interface GatewayUsage {
	completion_tokens?: number;
	prompt_tokens?: number;
	total_tokens?: number;
	[field: string]: unknown;
}

/** One choice of a non-streamed completion. */
export interface GatewayChatChoice {
	finish_reason?: string | null;
	index?: number;
	message: GatewayChatMessage;
	[field: string]: unknown;
}

/** A non-streamed chat completion. */
export interface GatewayChatCompletion {
	choices: GatewayChatChoice[];
	created?: number;
	id?: string;
	model?: string;
	object?: string;
	usage?: GatewayUsage | null;
	[field: string]: unknown;
}

/** One choice delta of a streamed chunk. */
export interface GatewayChatChunkChoice {
	delta: Partial<GatewayChatMessage>;
	finish_reason?: string | null;
	index?: number;
	[field: string]: unknown;
}

/** One `chat.completion.chunk` of a stream. A final usage-only chunk has no choices. */
export interface GatewayChatCompletionChunk {
	choices: GatewayChatChunkChoice[];
	created?: number;
	id?: string;
	model?: string;
	object?: string;
	usage?: GatewayUsage | null;
	[field: string]: unknown;
}

/** One model the Gateway can route to. */
export interface GatewayModel {
	created?: number;
	id: string;
	object?: string;
	owned_by?: string;
	[field: string]: unknown;
}

/** `GET /v1/models`. */
export interface GatewayModelList {
	data: GatewayModel[];
	object?: string;
	[field: string]: unknown;
}

/** `POST /v1/embeddings` body. Any other OpenAI parameter passes through. */
export interface GatewayEmbeddingParams {
	dimensions?: number;
	encoding_format?: "float" | "base64";
	input: string | readonly string[] | readonly number[] | readonly number[][];
	model: string;
	[parameter: string]: unknown;
}

/** One embedding vector (or base64 string with `encoding_format: "base64"`). */
export interface GatewayEmbedding {
	embedding: number[] | string;
	index?: number;
	object?: string;
	[field: string]: unknown;
}

/** `POST /v1/embeddings` reply. */
export interface GatewayEmbeddingList {
	data: GatewayEmbedding[];
	model?: string;
	object?: string;
	usage?: GatewayUsage | null;
	[field: string]: unknown;
}

/** `GET /health`. The admin key also sees providers, auth and policy version. */
export interface GatewayHealth {
	auth_required?: boolean;
	policy_version?: string | null;
	providers?: string[];
	status: string;
	version: string;
	[field: string]: unknown;
}

/** `GET /v1/auth/status`: whether the token is accepted, and its role. */
export interface GatewayAuthStatus {
	/** True for the administrator key. */
	admin: boolean;
	/** True when the Gateway requires a key at all. */
	authenticated: boolean;
	trustedForwarder: boolean;
	[field: string]: unknown;
}

/** Settings for the official `openai` SDK or the AI SDK's OpenAI-compatible provider. */
export interface GatewayOpenAICompatibleConfig {
	/** `RYU_GATEWAY_TOKEN`, or `""` when none is configured. */
	apiKey: string;
	/** The Gateway base URL plus `/v1`. */
	baseURL: string;
}

// --- Decoders -----------------------------------------------------------------

const usageSchema = z
	.looseObject({
		completion_tokens: z.number().optional(),
		prompt_tokens: z.number().optional(),
		total_tokens: z.number().optional(),
	})
	.nullable()
	.optional();

const messageSchema = z.looseObject({
	content: z
		.union([z.string(), z.array(z.record(z.string(), z.unknown()))])
		.nullable()
		.optional(),
	role: z.string(),
});

const completionMeta = {
	created: z.number().optional(),
	id: z.string().optional(),
	model: z.string().optional(),
	object: z.string().optional(),
	usage: usageSchema,
};

/** Validates a `chat.completion` body. */
export const gatewayChatCompletionSchema = z.looseObject({
	...completionMeta,
	choices: z.array(
		z.looseObject({
			finish_reason: z.string().nullable().optional(),
			index: z.number().optional(),
			message: messageSchema,
		})
	),
});

/** Validates one `chat.completion.chunk`. */
export const gatewayChatCompletionChunkSchema = z.looseObject({
	...completionMeta,
	choices: z
		.array(
			z.looseObject({
				delta: messageSchema.partial(),
				finish_reason: z.string().nullable().optional(),
				index: z.number().optional(),
			})
		)
		.default([]),
});

/** Validates a `GET /v1/models` body. */
export const gatewayModelListSchema = z.looseObject({
	data: z.array(
		z.looseObject({
			created: z.number().optional(),
			id: z.string(),
			object: z.string().optional(),
			owned_by: z.string().optional(),
		})
	),
	object: z.string().optional(),
});

/** Validates a `POST /v1/embeddings` body. */
export const gatewayEmbeddingListSchema = z.looseObject({
	data: z.array(
		z.looseObject({
			embedding: z.union([z.array(z.number()), z.string()]),
			index: z.number().optional(),
			object: z.string().optional(),
		})
	),
	model: z.string().optional(),
	object: z.string().optional(),
	usage: usageSchema,
});

/** Validates a `GET /health` body. */
export const gatewayHealthSchema = z.looseObject({
	auth_required: z.boolean().optional(),
	policy_version: z.string().nullable().optional(),
	providers: z.array(z.string()).optional(),
	status: z.string(),
	version: z.string(),
});

/** Validates a `GET /v1/auth/status` body. */
export const gatewayAuthStatusSchema = z.looseObject({
	admin: z.boolean(),
	authenticated: z.boolean(),
	trustedForwarder: z.boolean(),
});

// --- SSE ----------------------------------------------------------------------

const FRAME_SEPARATOR = /\r?\n\r?\n/u;
const LINE_SEPARATOR = /\r?\n/u;
const DONE = "[DONE]";

/** The joined `data:` lines of one SSE frame, or null when it has none. */
function frameData(frame: string): string | null {
	const lines = frame
		.split(LINE_SEPARATOR)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart());
	return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * The SSE body up to (not including) the `data: [DONE]` frame. The OpenAI
 * wire format ends a stream with that sentinel, which is not JSON, so it must
 * not reach `readServerSentEvents` (which JSON-parses every frame). Reading
 * stops there and the rest of the body is cancelled.
 */
export function untilDone(
	body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (true) {
				const chunk = await reader.read();
				buffer += decoder.decode(chunk.value, { stream: !chunk.done });
				const frames = buffer.split(FRAME_SEPARATOR);
				buffer = chunk.done ? "" : (frames.pop() ?? "");
				let emitted = false;
				for (const frame of frames) {
					if (frameData(frame) === DONE) {
						controller.close();
						await reader.cancel().catch(() => undefined);
						return;
					}
					if (frame.trim() !== "") {
						controller.enqueue(encoder.encode(`${frame}\n\n`));
						emitted = true;
					}
				}
				if (chunk.done) {
					controller.close();
					return;
				}
				if (emitted) {
					return;
				}
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => undefined);
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raises the error a provider reported inside a stream (`data: {"error": {...}}`). */
function throwStreamError(error: Record<string, unknown>): never {
	const code =
		(typeof error.code === "string" && error.code) ||
		(typeof error.type === "string" && error.type) ||
		"stream_error";
	throw createRyuError({
		service: "gateway",
		status: 0,
		code,
		envelope: "openai",
		message:
			typeof error.message === "string"
				? error.message
				: "The Gateway reported an error inside the stream.",
		retryable: false,
	});
}

// --- Client -------------------------------------------------------------------

/** The Gateway connection one call uses. */
export interface GatewayClientConfig {
	/** `RYU_GATEWAY_TOKEN`, or null when the Gateway is used without one. */
	apiKey: string | null;
	baseUrl: string;
}

const TRAILING_SLASHES = /\/+$/u;

function authHeaders(
	config: GatewayClientConfig,
	extra: Record<string, string> = {}
): Record<string, string> {
	return config.apiKey
		? { ...extra, authorization: `Bearer ${config.apiKey}` }
		: { ...extra };
}

/** Lower-level Gateway calls the namespace exposes; each makes exactly the requests named. */
export interface GatewayClient {
	authStatus(): Promise<GatewayAuthStatus>;
	chatCompletion(
		params: GatewayChatCompletionParams
	): Promise<GatewayChatCompletion>;
	chatCompletionStream(
		params: GatewayChatCompletionParams
	): AsyncGenerator<GatewayChatCompletionChunk>;
	embeddings(params: GatewayEmbeddingParams): Promise<GatewayEmbeddingList>;
	health(): Promise<GatewayHealth>;
	listModels(): Promise<GatewayModelList>;
	openAICompatible(): GatewayOpenAICompatibleConfig;
}

/** Builds the Gateway client over `fetch` (the call's service-scoped fetch). Does no I/O. */
export function createGatewayClient(
	config: GatewayClientConfig,
	fetch: RyuFetch,
	signal?: AbortSignal
): GatewayClient {
	const get = <T>(path: string, decode: (value: unknown) => T) =>
		requestJson(fetch, config.baseUrl, {
			decode,
			headers: authHeaders(config),
			method: "GET",
			path,
			signal,
		});

	async function* chatCompletionStream(
		params: GatewayChatCompletionParams
	): AsyncGenerator<GatewayChatCompletionChunk> {
		const response = await requestRaw(fetch, config.baseUrl, {
			body: { ...params, stream: true },
			headers: authHeaders(config, { accept: "text/event-stream" }),
			method: "POST",
			path: "/v1/chat/completions",
			signal,
		});
		if (response.body === null) {
			throw new SyntaxError("The Gateway answered the stream with no body.");
		}
		for await (const frame of readServerSentEvents(untilDone(response.body))) {
			if (isRecord(frame.data) && isRecord(frame.data.error)) {
				throwStreamError(frame.data.error);
			}
			yield gatewayChatCompletionChunkSchema.parse(
				frame.data
			) as GatewayChatCompletionChunk;
		}
	}

	return {
		authStatus: () =>
			get(
				"/v1/auth/status",
				(value) => gatewayAuthStatusSchema.parse(value) as GatewayAuthStatus
			),
		chatCompletion: (params) =>
			requestJson(fetch, config.baseUrl, {
				body: { ...params, stream: false },
				decode: (value) =>
					gatewayChatCompletionSchema.parse(value) as GatewayChatCompletion,
				headers: authHeaders(config),
				method: "POST",
				path: "/v1/chat/completions",
				signal,
			}),
		chatCompletionStream,
		embeddings: (params) =>
			requestJson(fetch, config.baseUrl, {
				body: params,
				decode: (value) =>
					gatewayEmbeddingListSchema.parse(value) as GatewayEmbeddingList,
				headers: authHeaders(config),
				method: "POST",
				path: "/v1/embeddings",
				signal,
			}),
		health: () =>
			get(
				"/health",
				(value) => gatewayHealthSchema.parse(value) as GatewayHealth
			),
		listModels: () =>
			get(
				"/v1/models",
				(value) => gatewayModelListSchema.parse(value) as GatewayModelList
			),
		openAICompatible: () => ({
			apiKey: config.apiKey ?? "",
			baseURL: `${config.baseUrl.replace(TRAILING_SLASHES, "")}/v1`,
		}),
	};
}
