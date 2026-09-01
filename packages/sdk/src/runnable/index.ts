/**
 * Runnable — the execution contract unifying Agent, Workflow, Tool, and Skill
 * in the Ryu SDK. `defineAction` is the governed business-operation facade over
 * the Tool kind.
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

export type {
	ActionAnnotations,
	ActionEffect,
	ActionManifestOptions,
	ActionOptions,
	ActionRunnable,
} from "./action.ts";
export { defineAction } from "./action.ts";
export type {
	AgentCard,
	AgentManifestOptions,
	AgentOptions,
	AgentRunnable,
	AgentSlots,
	CapabilitySlot,
	ChatSlot,
} from "./agent.ts";
// biome-ignore lint/performance/noBarrelFile: intentional package entry point for @ryuhq/sdk/runnable
export { defineAgent } from "./agent.ts";
export type { AppToolSpec, DefineAppOptions } from "./app.ts";
export { appToolId, defineApp } from "./app.ts";
export type {
	BackgroundClient,
	BackgroundProcess,
	DurableClient,
	EnginesClient,
	HttpPrimitiveTransportOptions,
	ImageClient,
	MemoryClient,
	MemoryItem,
	PrimitiveBinding,
	PrimitiveTransport,
	RagChunk,
	RagClient,
	RagRerankResult,
	RealtimeClient,
	RealtimeSubscription,
	RyuPrimitives,
	StorageClient,
	SttClient,
	TtsClient,
} from "./primitives.ts";
export {
	createPrimitives,
	httpPrimitiveTransport,
	PRIMITIVE_BINDINGS,
} from "./primitives.ts";
export type {
	GatewayClient,
	Runnable,
	RunnableContext,
} from "./runnable-types.ts";
export type { SkillOptions } from "./skill.ts";
export { defineSkill } from "./skill.ts";
export type {
	InlineToolManifestOptions,
	JsonSchemaProperty,
	ToolOptions,
	ToolSchema,
} from "./tool.ts";
export { defineTool } from "./tool.ts";
export type {
	WorkflowOptions,
	WorkflowRunnable,
	WorkflowStep,
} from "./workflow.ts";
export { defineWorkflow } from "./workflow.ts";
