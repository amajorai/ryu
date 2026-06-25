/**
 * Gateway-mandatory model client for the Ryu SDK.
 *
 * Rust-cored: this is a thin TypeScript wrapper over the `@ryuhq/sdk-native`
 * addon's `ModelClient`, which is the `crates/ryu-sdk` Rust core. Every model
 * call is routed by the Rust core to the Ryu gateway's OpenAI-compatible
 * `/v1/chat/completions` endpoint; direct-provider base URLs are rejected at
 * construction. No provider SDK or base URL is ever imported here.
 *
 * Usage:
 *
 *   const model = defineModel("gpt-4o");
 *   const reply = await model.chat([{ role: "user", content: "hello" }]);
 *   for await (const delta of model.stream([{ role: "user", content: "hi" }])) {
 *     process.stdout.write(delta.content);
 *   }
 */

import * as native from "@ryuhq/sdk-native";

// ── Wire types (OpenAI-compat subset) ─────────────────────────────────────────

/** A single message in a chat conversation. */
export interface ChatMessage {
	/** The message text. */
	content: string;
	/** The speaker: "system", "user", or "assistant". */
	role: "system" | "user" | "assistant";
}

/** A streaming chat completion delta. */
export interface ChatDelta {
	/** Incremental text fragment from the model. */
	content: string | null;
	/** Non-null on the final chunk when `finish_reason` is set. */
	finishReason: string | null;
}

/** Non-streaming chat completion result. */
export interface ChatResult {
	/** The full assistant reply text. */
	content: string;
	/** The gateway/model-reported finish reason. */
	finishReason: string | null;
	/** Usage stats as reported by the gateway (optional — gateway may omit). */
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

/** Options accepted by `defineModel`. */
export interface ModelClientOptions {
	/**
	 * Gateway base URL (no trailing `/v1`). Defaults to `RYU_GATEWAY_URL` then
	 * the Rust core's default. Direct provider URLs are rejected at construction.
	 */
	baseUrl?: string;
	/**
	 * Bearer token forwarded to the gateway. Defaults to `RYU_GATEWAY_TOKEN`.
	 * This is the gateway token, never a provider API key.
	 */
	token?: string;
}

// ── ModelClient ───────────────────────────────────────────────────────────────

/**
 * A gateway-mandatory model client backed by the Rust core.
 *
 * All calls go through the native `ModelClient`; if the configured base URL is a
 * direct provider, construction throws.
 */
export class ModelClient {
	readonly model: string;
	readonly baseUrl: string;
	private readonly native: native.ModelClient;

	constructor(model: string, options: ModelClientOptions = {}) {
		// Constructing the native client validates egress and resolves the base
		// URL/token in the Rust core.
		this.native = new native.ModelClient(
			model,
			options.baseUrl ?? null,
			options.token ?? null
		);
		this.model = model;
		this.baseUrl = options.baseUrl ?? native.resolveGatewayUrl();
	}

	/** Send a non-streaming chat completion request to the gateway. */
	async chat(messages: ChatMessage[]): Promise<ChatResult> {
		const res = await this.native.chat(messages);
		const usage =
			res.promptTokens === undefined &&
			res.completionTokens === undefined &&
			res.totalTokens === undefined
				? undefined
				: {
						promptTokens: res.promptTokens ?? 0,
						completionTokens: res.completionTokens ?? 0,
						totalTokens: res.totalTokens ?? 0,
					};
		return {
			content: res.content,
			finishReason: res.finishReason ?? null,
			usage,
		};
	}

	/** Send a streaming chat completion request, yielding deltas as they arrive. */
	async *stream(messages: ChatMessage[]): AsyncGenerator<ChatDelta> {
		// Bridge the native push-callback into a pull async-generator via a small
		// queue. The native side calls back with `null` to signal clean end and
		// with an Error on failure.
		const queue: ChatDelta[] = [];
		let done = false;
		let failure: Error | null = null;
		let wake: (() => void) | null = null;
		const notify = () => {
			if (wake) {
				const w = wake;
				wake = null;
				w();
			}
		};

		this.native.stream(messages, (err, delta) => {
			if (err) {
				failure = err;
				done = true;
			} else if (delta === null || delta === undefined) {
				done = true;
			} else {
				queue.push({
					content: delta.content ?? null,
					finishReason: delta.finishReason ?? null,
				});
			}
			notify();
		});

		while (true) {
			while (queue.length > 0) {
				const next = queue.shift();
				if (next) {
					yield next;
				}
			}
			if (failure) {
				throw failure;
			}
			if (done) {
				return;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a gateway-mandatory model client for `modelId`.
 *
 *   const model = defineModel("gpt-4o");
 *   const model = defineModel("claude-3-5-sonnet", { baseUrl: "http://my-gateway:7981" });
 *
 * A direct provider URL throws immediately (egress enforcement in the Rust core).
 */
export function defineModel(
	modelId: string,
	options: ModelClientOptions = {}
): ModelClient {
	return new ModelClient(modelId, options);
}
