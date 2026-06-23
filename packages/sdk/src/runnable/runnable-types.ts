/**
 * Shared Runnable interface and context types.
 *
 * Every factory (defineAgent, defineWorkflow, defineTool, defineSkill) returns
 * a value that satisfies the `Runnable` interface.  This keeps the contract
 * in one place and avoids circular imports between the four factory modules.
 */

import type { ChatDelta, ChatMessage, ChatResult } from "../model/client";
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
	/**
	 * Gateway client — the single allowed path for model calls.
	 * Never null; a Runnable that needs a model must use this.
	 */
	gateway: GatewayClient;
	/** Optional session id for stateful runs (Core session). */
	sessionId?: string;
	/** Signal to abort a long-running run. */
	signal?: AbortSignal;
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
