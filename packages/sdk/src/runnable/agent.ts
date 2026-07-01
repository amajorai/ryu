/**
 * defineAgent — factory for Runnable agents.
 *
 * An agent is a Runnable that drives a multi-turn model loop.  It may
 * reference a workflow as a named tool by including a Runnable with
 * kind="workflow" in its `tools` list; the agent's run() implementation
 * calls it like any other tool.
 *
 * All model calls must go through `ctx.gateway` — no direct provider imports.
 */

import type { Runnable, RunnableContext } from "./runnable-types.ts";

/** Options accepted by `defineAgent`. */
export interface AgentOptions<TInput, TOutput> {
	/** Stable unique identifier (e.g. "agent-researcher"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/**
	 * The agent's run implementation.
	 *
	 * All model calls MUST go through `ctx.gateway`.  The implementation
	 * receives typed `input` and returns typed `output`.
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
	/**
	 * Optional list of Runnables this agent exposes as tools.
	 *
	 * A workflow may be listed here so the agent can invoke it as a named
	 * tool — this is the peer (not hierarchical) relationship described in
	 * packages/sdk/README.md §2.
	 */
	tools?: readonly Runnable[];
}

/**
 * Create a Runnable agent.
 *
 * The returned value satisfies the `Runnable<TInput, TOutput>` interface with
 * `kind = "agent"`.
 *
 * @example
 * ```ts
 * const myAgent = defineAgent({
 *   id: "agent-researcher",
 *   name: "Researcher",
 *   async run({ query }, ctx) {
 *     const result = await ctx.gateway.chat([{ role: "user", content: query }]);
 *     return { answer: result.content };
 *   },
 * });
 * ```
 */
export function defineAgent<TInput = unknown, TOutput = unknown>(
	options: AgentOptions<TInput, TOutput>
): Runnable<TInput, TOutput> {
	const { id, name, run } = options;
	return {
		id,
		name,
		kind: "agent",
		run,
	} satisfies Runnable<TInput, TOutput>;
}
