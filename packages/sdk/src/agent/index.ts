/**
 * `@ryu/sdk/agent` — the declarative agent runtime.
 *
 * Public entry for building apps on top of the SDK: a loop-owning `Agent`
 * (Mastra-style) and a `query()` streaming call (Claude-Agent-SDK-style), plus
 * `ryuTool` to reference existing Ryu tools and the event/type surface.
 */

export type {
	AgentConfig,
	Endpoint,
	GenerateResult,
} from "./agent.ts";
export { Agent, createAgent } from "./agent.ts";
export type {
	AgentEvent,
	AgentEventAuthRequired,
	AgentEventError,
	AgentEventResult,
	AgentEventText,
	AgentEventToolCall,
	AgentEventToolResult,
	LoopConfig,
} from "./loop.ts";
export { runAgentLoop } from "./loop.ts";
export type {
	AssistantMessage,
	LoopMessage,
	ModelCallOptions,
	ModelCallResult,
	ModelUsage,
	ToolCall,
	ToolFunctionDef,
} from "./model-call.ts";
export { callModelWithTools } from "./model-call.ts";
export type { QueryInput, QueryOptions } from "./query.ts";
export { query } from "./query.ts";
export type {
	AgentTool,
	Elicitation,
	RemoteToolRef,
	RyuToolOptions,
	ToolExecContext,
	ToolExecResult,
} from "./tools.ts";
export {
	detectElicitation,
	executeTool,
	resolveToolDefs,
	ryuTool,
} from "./tools.ts";
