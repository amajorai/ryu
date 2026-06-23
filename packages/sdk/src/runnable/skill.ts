/**
 * defineSkill — factory for Runnable skills.
 *
 * A skill is a prompt-template / capability block that is reusable across
 * agents and workflows.  Like a tool it is stateless, but its primary purpose
 * is to encapsulate a reusable prompt pattern rather than a side-effectful
 * function.
 *
 * All model calls must go through `ctx.gateway` — no direct provider imports.
 */

import type { Runnable, RunnableContext } from "./runnable-types";

/** Options accepted by `defineSkill`. */
export interface SkillOptions<TInput, TOutput> {
	/** Stable unique identifier (e.g. "skill-summarise"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/**
	 * The skill's run implementation.
	 *
	 * Skills typically build a prompt from `input` and call `ctx.gateway.chat()`
	 * to get a model response, then return structured output.  All model calls
	 * MUST go through `ctx.gateway`.
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
}

/**
 * Create a Runnable skill.
 *
 * The returned value satisfies the `Runnable<TInput, TOutput>` interface with
 * `kind = "skill"`.
 *
 * @example
 * ```ts
 * const summariseSkill = defineSkill({
 *   id: "skill-summarise",
 *   name: "Summarise",
 *   async run({ text }, ctx) {
 *     const result = await ctx.gateway.chat([
 *       { role: "user", content: `Summarise the following:\n\n${text}` },
 *     ]);
 *     return { summary: result.content };
 *   },
 * });
 * ```
 */
export function defineSkill<TInput = unknown, TOutput = unknown>(
	options: SkillOptions<TInput, TOutput>
): Runnable<TInput, TOutput> {
	const { id, name, run } = options;
	return {
		id,
		name,
		kind: "skill",
		run,
	} satisfies Runnable<TInput, TOutput>;
}
