/**
 * @ryu/sdk — Ryu developer SDK.
 *
 * Re-exports the manifest types, builder utilities, gateway-mandatory model
 * client, and Runnable authoring API as a single entry point for consumers
 * who import from "@ryu/sdk".
 *
 * CLI users run `bunx ryu pack <dir>` via the bin entry in package.json.
 */

export {
	AgentBuilder,
	agent,
	PluginBuilder,
	SkillBuilder,
	skill,
	ToolBuilder,
	tool,
	WorkflowBuilder,
	workflow,
} from "./builder";
export type {
	CompanionSurface,
	PluginManifest,
	RunnableKind,
	RunnableMeta,
} from "./manifest";
export {
	coreManifestJsonSchema,
	CompanionSurfaceSchema,
	PluginManifestSchema,
	RunnableKindSchema,
	RunnableMetaSchema,
	validateManifestStrict,
	validatePluginId,
} from "./manifest";
export type {
	ChatDelta,
	ChatMessage,
	ChatResult,
	ModelClientOptions,
} from "./model/client";
export { defineModel, ModelClient } from "./model/client";
export {
	assertAllowedEgressUrl,
	DEFAULT_GATEWAY_URL,
	resolveGatewayToken,
	resolveGatewayUrl,
} from "./model/gateway";
export type { AgentOptions } from "./runnable/agent";
export { defineAgent } from "./runnable/agent";
export type {
	GatewayClient,
	Runnable,
	RunnableContext,
} from "./runnable/runnable-types";
export type { SkillOptions } from "./runnable/skill";
export { defineSkill } from "./runnable/skill";
export type {
	JsonSchemaProperty,
	ToolOptions,
	ToolRunnable,
	ToolSchema,
} from "./runnable/tool";
export { defineTool } from "./runnable/tool";
export type { WorkflowOptions, WorkflowStep } from "./runnable/workflow";
export { defineWorkflow } from "./runnable/workflow";
