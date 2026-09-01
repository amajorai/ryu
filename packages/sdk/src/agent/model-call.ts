/**
 * Native tool-calling model call for the Ryu agent runtime.
 *
 * The gateway-mandatory `ModelClient` (packages/sdk/src/model/client.ts) only
 * exposes text `chat`/`stream` — it cannot pass a `tools` array or receive
 * `tool_calls`. The autonomous agent loop needs both, so this module makes a
 * direct request to the node's gateway `POST /v1/chat/completions` endpoint
 * with the caller's own `tools` and reads back `message.tool_calls`.
 *
 * The no-direct-provider guarantee is preserved: `assertAllowedEgressUrl` (the
 * same Rust-cored blocklist the ModelClient uses) is called before every fetch,
 * so a direct provider base URL throws exactly as it would elsewhere in the SDK.
 *
 * `x-ryu-raw-tools: on` is always sent. On a plain gateway it is a harmless
 * no-op; on a Composio-on managed node it forces the plain completion branch so
 * the caller's `tool_calls` are returned verbatim instead of being intercepted
 * and executed by Core's own tool loop (see apps/gateway/src/pipeline/mod.rs).
 */

import { assertAllowedEgressUrl } from "../model/gateway.ts";

// ── OpenAI-compatible wire types (function-calling subset) ────────────────────

/** An OpenAI function tool definition passed to the model. */
export interface ToolFunctionDef {
	function: {
		description?: string;
		name: string;
		/** JSON Schema for the function's arguments. */
		parameters: Record<string, unknown>;
	};
	type: "function";
}

/** A single tool call emitted by the model. */
export interface ToolCall {
	function: {
		/** JSON-encoded arguments string (per the OpenAI wire format). */
		arguments: string;
		name: string;
	};
	id: string;
	type: "function";
}

/** An assistant turn — may carry text, tool calls, or both. */
export interface AssistantMessage {
	content: string | null;
	role: "assistant";
	tool_calls?: ToolCall[];
}

/** A message in the loop's running transcript. */
export type LoopMessage =
	| { content: string; role: "system" | "user" }
	| AssistantMessage
	| { content: string; role: "tool"; tool_call_id: string };

/** Token usage as reported by the gateway (optional — gateway may omit). */
export interface ModelUsage {
	completionTokens: number;
	promptTokens: number;
	totalTokens: number;
}

/** Options for a single native tool-calling completion. */
export interface ModelCallOptions {
	/** Gateway base URL (no trailing `/v1`). */
	baseUrl: string;
	/** Running transcript. */
	messages: LoopMessage[];
	/** Model id routed by the gateway (provider is derived from the id). */
	model: string;
	/** Optional OpenAI-compatible response format for structured output. */
	responseFormat?: Record<string, unknown>;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Bearer token forwarded to the gateway (never a provider key). */
	token?: string;
	/** How the model should choose tools; defaults to gateway/provider default. */
	toolChoice?: "auto" | "none" | "required";
	/** Function tool definitions the model may call. */
	tools?: ToolFunctionDef[];
}

/** Result of a single completion. */
export interface ModelCallResult {
	finishReason: string | null;
	message: AssistantMessage;
	usage?: ModelUsage;
}

/** A chunk from a streaming OpenAI-compatible completion. */
export type ModelStreamEvent =
	| { delta: string; type: "text_delta" }
	| { result: ModelCallResult; type: "done" };

// ── Internal response shape (minimal subset we read) ──────────────────────────

interface ChatCompletionResponse {
	choices?: Array<{
		finish_reason?: string | null;
		message?: {
			content?: string | null;
			tool_calls?: ToolCall[];
		};
	}>;
	usage?: {
		completion_tokens?: number;
		prompt_tokens?: number;
		total_tokens?: number;
	};
}

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** Strip a trailing slash so `baseUrl + path` never doubles up. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function requestBody(
	options: ModelCallOptions,
	stream: boolean
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: options.model,
		messages: options.messages,
		stream,
	};
	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools;
		if (options.toolChoice) {
			body.tool_choice = options.toolChoice;
		}
	}
	if (options.responseFormat) {
		body.response_format = options.responseFormat;
	}
	return body;
}

function requestHeaders(options: ModelCallOptions): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		// Force the gateway's plain-completion branch so our own tool_calls are
		// returned verbatim on Composio-on managed nodes.
		"x-ryu-raw-tools": "on",
	};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}
	return headers;
}

function parseModelCallResponse(json: ChatCompletionResponse): ModelCallResult {
	const choice = json.choices?.[0];
	const rawMessage = choice?.message;
	const message: AssistantMessage = {
		role: "assistant",
		content: rawMessage?.content ?? null,
		...(rawMessage?.tool_calls && rawMessage.tool_calls.length > 0
			? { tool_calls: rawMessage.tool_calls }
			: {}),
	};

	const usage: ModelUsage | undefined = json.usage
		? {
				promptTokens: json.usage.prompt_tokens ?? 0,
				completionTokens: json.usage.completion_tokens ?? 0,
				totalTokens: json.usage.total_tokens ?? 0,
			}
		: undefined;

	return {
		message,
		finishReason: choice?.finish_reason ?? null,
		usage,
	};
}

/**
 * Call the node's gateway with the caller's own tools and return the first
 * choice, including any `tool_calls`.
 *
 * Throws when the base URL is a direct provider (egress enforcement) or when
 * the gateway returns a non-2xx status.
 */
export async function callModelWithTools(
	options: ModelCallOptions
): Promise<ModelCallResult> {
	const base = normalizeBaseUrl(options.baseUrl);
	// Preserve the BYOK-at-the-gateway rule — same blocklist as ModelClient.
	assertAllowedEgressUrl(base);

	const body = requestBody(options, false);
	const headers = requestHeaders(options);

	const res = await fetch(`${base}${CHAT_COMPLETIONS_PATH}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: options.signal,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`[ryu-sdk] gateway ${res.status} ${res.statusText} at ${base}${CHAT_COMPLETIONS_PATH}${
				text ? `: ${text}` : ""
			}`
		);
	}

	return parseModelCallResponse((await res.json()) as ChatCompletionResponse);
}

interface ChatCompletionStreamChunk {
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { arguments?: string; name?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ChatCompletionResponse["usage"];
}

function streamDataFrames(buffer: string): { frames: string[]; rest: string } {
	const frames: string[] = [];
	let rest = buffer;
	while (true) {
		const match = /\r?\n\r?\n/.exec(rest);
		if (!match || match.index === undefined) {
			break;
		}
		const raw = rest.slice(0, match.index);
		rest = rest.slice(match.index + match[0].length);
		const data = raw
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data) {
			frames.push(data);
		}
	}
	return { frames, rest };
}

/**
 * Stream a gateway completion and assemble tool-call deltas into one final
 * assistant message. Providers that do not expose SSE are accepted through a
 * JSON fallback, which keeps older gateways and deterministic test doubles
 * compatible while preserving real deltas whenever the gateway supports them.
 */
export async function* streamModelWithTools(
	options: ModelCallOptions
): AsyncGenerator<ModelStreamEvent> {
	const base = normalizeBaseUrl(options.baseUrl);
	assertAllowedEgressUrl(base);
	const res = await fetch(`${base}${CHAT_COMPLETIONS_PATH}`, {
		method: "POST",
		headers: requestHeaders(options),
		body: JSON.stringify(requestBody(options, true)),
		signal: options.signal,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`[ryu-sdk] gateway ${res.status} ${res.statusText} at ${base}${CHAT_COMPLETIONS_PATH}${
				text ? `: ${text}` : ""
			}`
		);
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (!(contentType.includes("text/event-stream") && res.body)) {
		const fallback = parseModelCallResponse(
			(await res.json()) as ChatCompletionResponse
		);
		yield { type: "done", result: fallback };
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let finishReason: string | null = null;
	let usage: ModelUsage | undefined;
	const toolCalls = new Map<
		number,
		{ arguments: string; id: string; name: string }
	>();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const parsed = streamDataFrames(buffer);
			buffer = parsed.rest;
			for (const frame of parsed.frames) {
				if (frame === "[DONE]") {
					continue;
				}
				const chunk = JSON.parse(frame) as ChatCompletionStreamChunk;
				const choice = chunk.choices?.[0];
				finishReason = choice?.finish_reason ?? finishReason;
				if (chunk.usage) {
					usage = {
						promptTokens: chunk.usage.prompt_tokens ?? 0,
						completionTokens: chunk.usage.completion_tokens ?? 0,
						totalTokens: chunk.usage.total_tokens ?? 0,
					};
				}
				const delta = choice?.delta;
				if (delta?.content) {
					content += delta.content;
					yield { type: "text_delta", delta: delta.content };
				}
				for (const [fallbackIndex, tool] of (
					delta?.tool_calls ?? []
				).entries()) {
					const index = tool.index ?? fallbackIndex;
					const current = toolCalls.get(index) ?? {
						arguments: "",
						id: tool.id ?? `call_${index}`,
						name: tool.function?.name ?? "",
					};
					if (tool.id) {
						current.id = tool.id;
					}
					if (tool.function?.name) {
						current.name = tool.function.name;
					}
					current.arguments += tool.function?.arguments ?? "";
					toolCalls.set(index, current);
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	const message: AssistantMessage = {
		role: "assistant",
		content: content || null,
		...(toolCalls.size > 0
			? {
					tool_calls: [...toolCalls.entries()]
						.sort(([a], [b]) => a - b)
						.map(([, call]) => ({
							id: call.id,
							type: "function" as const,
							function: {
								arguments: call.arguments,
								name: call.name,
							},
						})),
				}
			: {}),
	};
	yield {
		result: { finishReason, message, usage },
		type: "done",
	};
}
