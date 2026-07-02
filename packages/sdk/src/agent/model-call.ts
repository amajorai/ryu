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

	const body: Record<string, unknown> = {
		model: options.model,
		messages: options.messages,
	};
	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools;
		if (options.toolChoice) {
			body.tool_choice = options.toolChoice;
		}
	}

	const headers: Record<string, string> = {
		"content-type": "application/json",
		// Force the gateway's plain-completion branch so our own tool_calls are
		// returned verbatim on Composio-on managed nodes.
		"x-ryu-raw-tools": "on",
	};
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}

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

	const json = (await res.json()) as ChatCompletionResponse;
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
