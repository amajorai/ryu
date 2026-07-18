/**
 * @ryuhq/sdk — Ryu developer SDK.
 *
 * Re-exports the manifest types, builder utilities, gateway-mandatory model
 * client, and Runnable authoring API as a single entry point for consumers
 * who import from "@ryuhq/sdk".
 *
 * CLI users run `bunx ryu pack <dir>` via the bin entry in package.json.
 */

export type {
	AgentConfig,
	AgentEvent,
	AgentTool,
	Endpoint,
	GenerateResult,
	QueryInput,
	QueryOptions,
	RemoteToolRef,
} from "./agent/index.ts";
export { Agent, createAgent, query, ryuTool } from "./agent/index.ts";
export {
	AgentBuilder,
	AppBuilder,
	agent,
	app,
	PluginBuilder,
	SkillBuilder,
	skill,
	ToolBuilder,
	tool,
	WorkflowBuilder,
	workflow,
} from "./builder.ts";
export type {
	AppDependency,
	CapabilityReq,
	CompanionSurface,
	Contributes,
	PluginManifest,
	Requires,
	RunnableKind,
	RunnableMeta,
	Surface,
	ToolAppConfig,
	TurnHookContribution,
	WidgetContribution,
} from "./manifest.ts";
export {
	AppDependencySchema,
	CapabilityReqSchema,
	CompanionSurfaceSchema,
	coreManifestJsonSchema,
	PluginManifestSchema,
	RequiresSchema,
	RunnableKindSchema,
	RunnableMetaSchema,
	SurfaceSchema,
	ToolAppConfigSchema,
	validateManifestStrict,
	validatePluginId,
	WidgetContributionSchema,
} from "./manifest.ts";
export type {
	ChatDelta,
	ChatMessage,
	ChatResult,
	ModelClientOptions,
} from "./model/client.ts";
export { defineModel, ModelClient } from "./model/client.ts";
export {
	assertAllowedEgressUrl,
	DEFAULT_GATEWAY_URL,
	resolveGatewayToken,
	resolveGatewayUrl,
} from "./model/gateway.ts";
export type {
	AgentCard,
	AgentManifestOptions,
	AgentOptions,
	AgentRunnable,
	AgentSlots,
	CapabilitySlot,
	ChatSlot,
} from "./runnable/agent.ts";
export { defineAgent } from "./runnable/agent.ts";
export type {
	AppToolSpec,
	DefineAppOptions,
	DefineAppRequires,
} from "./runnable/app.ts";
export { appToolId, defineApp } from "./runnable/app.ts";
export type {
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
	SttClient,
	TtsClient,
} from "./runnable/primitives.ts";
export {
	createPrimitives,
	httpPrimitiveTransport,
	PRIMITIVE_BINDINGS,
} from "./runnable/primitives.ts";
export type {
	GatewayClient,
	Runnable,
	RunnableContext,
} from "./runnable/runnable-types.ts";
export type { SkillOptions } from "./runnable/skill.ts";
export { defineSkill } from "./runnable/skill.ts";
export type {
	JsonSchemaProperty,
	ToolOptions,
	ToolRunnable,
	ToolSchema,
} from "./runnable/tool.ts";
export { defineTool, inlineToolRunnable } from "./runnable/tool.ts";
export type {
	DefinePluginOptions,
	DefineTurnHookOptions,
	HookContext,
	HookDirective,
	HookRun,
	HostApi,
	SideModelArgs,
} from "./runnable/turn-hook.ts";
export { definePlugin, defineTurnHook } from "./runnable/turn-hook.ts";
export type { WorkflowOptions, WorkflowStep } from "./runnable/workflow.ts";
export { defineWorkflow } from "./runnable/workflow.ts";
