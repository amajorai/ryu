/**
 * defineWorkflow — factory for Runnable workflows.
 *
 * A workflow orchestrates agents (and other Runnables) as sequential steps.
 * It exposes the peer relationship described in packages/sdk/README.md §2:
 * a workflow may list an agent as a step and call it via its run() method.
 *
 * All model calls must go through `ctx.gateway` — no direct provider imports.
 */

import type { Runnable, RunnableContext } from "./runnable-types.ts";

/**
 * A single step inside a workflow definition.
 *
 * A step is any `Runnable` — most commonly an agent, but may also be a tool
 * or a nested workflow (allowing composition without a strict hierarchy).
 */
export type WorkflowStep<
	TStepInput = unknown,
	TStepOutput = unknown,
> = Runnable<TStepInput, TStepOutput>;

/** Options accepted by `defineWorkflow`. */
export interface WorkflowOptions<TInput, TOutput> {
	/** Stable unique identifier (e.g. "workflow-report"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/**
	 * The workflow's run implementation.
	 *
	 * May call any step via `step.run(input, ctx)`.  All model calls that
	 * steps make MUST go through `ctx.gateway`.
	 */
	run(input: TInput, ctx: RunnableContext): Promise<TOutput>;
	/**
	 * Optional list of Runnables this workflow orchestrates as steps.
	 *
	 * An agent may be listed here so the workflow can invoke it by calling
	 * `step.run(input, ctx)` — this is the peer relationship described in
	 * packages/sdk/README.md §2.
	 */
	steps?: readonly Runnable[];
}

/**
 * Create a Runnable workflow.
 *
 * The returned value satisfies the `Runnable<TInput, TOutput>` interface with
 * `kind = "workflow"`.
 *
 * @example
 * ```ts
 * const myWorkflow = defineWorkflow({
 *   id: "workflow-report",
 *   name: "Report Workflow",
 *   steps: [researchAgent],
 *   async run({ topic }, ctx) {
 *     const { answer } = await researchAgent.run({ query: topic }, ctx);
 *     return { report: answer };
 *   },
 * });
 * ```
 */
export function defineWorkflow<TInput = unknown, TOutput = unknown>(
	options: WorkflowOptions<TInput, TOutput>
): Runnable<TInput, TOutput> {
	const { id, name, run } = options;
	return {
		id,
		name,
		kind: "workflow",
		run,
	} satisfies Runnable<TInput, TOutput>;
}
