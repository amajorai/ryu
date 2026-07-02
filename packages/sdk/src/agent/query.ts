/**
 * `query()` — Claude-Agent-SDK-style streaming entry over the same `Agent`.
 *
 * Where `Agent` gives you Mastra's config-object + method shape, `query()` gives
 * you the `for await (const msg of query({ prompt, options }))` ergonomics of
 * the Claude Agent SDK. Both drive the identical loop; this is a thin wrapper.
 */

import { Agent, type AgentConfig } from "./agent.ts";
import type { AgentEvent } from "./loop.ts";

/** Options accepted by `query` — an `AgentConfig` with an optional `name`. */
export type QueryOptions = Omit<AgentConfig, "name"> & { name?: string };

/** Input to `query`: a prompt plus agent options. */
export interface QueryInput {
	options: QueryOptions;
	prompt: string;
}

/**
 * Run an agent for a single prompt and stream its events.
 *
 * @example
 * ```ts
 * for await (const msg of query({
 *   prompt: "Find my expenses from last month.",
 *   options: { model: "gpt-4o", agentId: "agent-expense", tools: { gmailSearch } },
 * })) {
 *   if (msg.type === "result") console.log(msg.text);
 * }
 * ```
 */
export function query(input: QueryInput): AsyncGenerator<AgentEvent> {
	const agent = new Agent({
		name: input.options.name ?? "agent",
		...input.options,
	});
	return agent.stream(input.prompt);
}
