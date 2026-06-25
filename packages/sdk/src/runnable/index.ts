/**
 * Runnable — the single contract unifying Agent, Workflow, Tool, and Skill
 * in the Ryu SDK.
 *
 * Design rules (from the M8 spike doc packages/sdk/README.md):
 *   - An agent may invoke a workflow as a named tool.
 *   - A workflow may orchestrate agents as steps.
 *   - All model calls MUST go through `ctx.gateway` — never a direct provider.
 *   - The four kinds are peers, not a hierarchy.
 *
 * This module re-exports all factory functions and types so consumers can
 * import from `@ryuhq/sdk/runnable` as a single entry point.
 */

export type { AgentOptions } from "./agent";
// biome-ignore lint/performance/noBarrelFile: intentional package entry point for @ryuhq/sdk/runnable
export { defineAgent } from "./agent";
export type {
	GatewayClient,
	Runnable,
	RunnableContext,
} from "./runnable-types";
export type { SkillOptions } from "./skill";
export { defineSkill } from "./skill";
export type { JsonSchemaProperty, ToolOptions, ToolSchema } from "./tool";
export { defineTool } from "./tool";
export type { WorkflowOptions, WorkflowStep } from "./workflow";
export { defineWorkflow } from "./workflow";
