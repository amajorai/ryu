/**
 * Shared Runnable interface and context types.
 *
 * Every factory (defineAgent, defineWorkflow, defineTool, defineSkill) returns
 * a value that satisfies the `Runnable` interface.  This keeps the contract
 * in one place and avoids circular imports between the four factory modules.
 */

import type { ChatDelta, ChatMessage, ChatResult } from "../model/client.ts";
import type {
	DurableClient,
	EnginesClient,
	ImageClient,
	MemoryClient,
	RagClient,
	RealtimeClient,
	SttClient,
	TtsClient,
} from "./primitives.ts";

export type { ChatDelta, ChatMessage, ChatResult };

// ── GatewayClient ─────────────────────────────────────────────────────────────

/**
 * Thin client over the Ryu gateway `POST /v1/chat/completions` endpoint.
 *
 * This is the ONLY way a Runnable may invoke a model.  Injected via
 * `RunnableContext.gateway` so every call is gateway-mandatory — matching the
 * Core-vs-Gateway rule (the SDK decides what runs; the gateway decides what is
 * allowed/measured/paid).
 *
 * Mirrors the interface specified in packages/sdk/README.md §2 and the
 * `ModelClient` shape in `packages/sdk/src/model/client.ts`.
 */
export interface GatewayClient {
	/** POST /v1/chat/completions (non-streaming). */
	chat(messages: ChatMessage[]): Promise<ChatResult>;
	/** POST /v1/chat/completions (streaming SSE). */
	stream(messages: ChatMessage[]): AsyncGenerator<ChatDelta>;
}

// ── RunnableContext ───────────────────────────────────────────────────────────

/**
 * Context injected into every `Runnable.run()` call.
 *
 * The gateway client is always present (fail-closed): a missing gateway throws
 * at construction time via `defineModel`, never at run time.
 */
export interface RunnableContext {
	/** Durable primitive: checkpoint · resume (`crates/ryu-durable`). */
	durable?: DurableClient;
	/** Engines primitive: complete · embed (`crates/ryu-engines`). */
	engines?: EnginesClient;
	/**
	 * Gateway client — the single allowed path for model calls.
	 * Never null; a Runnable that needs a model must use this.
	 */
	gateway: GatewayClient;
	/** Image primitive: generate (`crates/ryu-image`). */
	image?: ImageClient;
	/** Memory primitive: recall · store (`crates/ryu-memory`). */
	memory?: MemoryClient;

	// ── Composable primitive clients (program §6b) ────────────────────────────
	//
	// Each is a typed, gateway-mandatory client over a decomposed capability
	// crate, mounted here so a Runnable composes primitives the same way a
	// developer does: `ctx.rag.retrieve()`, `ctx.memory.recall()`, … They are
	// OPTIONAL — present only when the runner injects a `PrimitiveTransport`
	// (e.g. a Core node it holds a token for). Back-compat: a `{ gateway }` ctx
	// still satisfies this interface. Wire a full bundle with
	// `createPrimitives(transport)` from `./primitives.ts`.

	/** RAG primitive: retrieve · embed · rerank (`crates/ryu-rag`). */
	rag?: RagClient;
	/** Realtime primitive: broadcast · subscribe (`crates/ryu-realtime`). */
	realtime?: RealtimeClient;
	/** Optional session id for stateful runs (Core session). */
	sessionId?: string;
	/** Signal to abort a long-running run. */
	signal?: AbortSignal;
	/** STT primitive: transcribe (`crates/ryu-stt`). */
	stt?: SttClient;
	/** TTS primitive: speak (`crates/ryu-tts`). */
	tts?: TtsClient;
}

// ── Runnable ──────────────────────────────────────────────────────────────────

/**
 * The single contract for everything that can run in Ryu:
 * Agent | Workflow | Tool | Skill.
 *
 * Typed over `TInput` (what the caller passes) and `TOutput` (what run()
 * returns).  The `kind` field narrows the discriminated union.
 */
export interface Runnable<TInput = unknown, TOutput = unknown> {
	/** Stable unique identifier (e.g. "agent-researcher"). */
	readonly id: string;
	/** Kind tag — narrows the discriminated union. */
	readonly kind: "agent" | "workflow" | "tool" | "skill";
	/** Human-readable name. */
	readonly name: string;
	/**
	 * Execute this Runnable.
	 *
	 * Every model call MUST go through `ctx.gateway`.  Direct provider imports
	 * are forbidden by the SDK's egress enforcement (assertAllowedEgressUrl).
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
}
