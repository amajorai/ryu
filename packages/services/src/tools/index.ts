// packages/services/src/tools/index.ts
//
// `@ryuhq/services/tools`: Ryu's standalone services as typed agent tools,
// from one registry. The same definitions back `ryu-services mcp`,
// `toAiSdkTools` (Vercel AI SDK) and `toRyuAgentTools` (@ryuhq/sdk Agent).

export {
	type AiSdkToolCallOptions,
	type AiSdkToolsOptions,
	type RyuAiSdkTool,
	toAiSdkTools,
} from "./adapters/ai-sdk.ts";
export {
	defaultNeedsApproval,
	type RyuToolApprovalOption,
} from "./adapters/approval.ts";
export {
	type RyuAgentTool,
	type RyuAgentToolsOptions,
	toRyuAgentTools,
} from "./adapters/ryu-agent.ts";
export { READ as READ_ONLY_ANNOTATIONS } from "./annotations.ts";
export {
	BOX_TOOLS,
	DEFAULT_BOX_READ_CHARS,
	MAX_BOX_READ_CHARS,
} from "./box.ts";
export {
	type CollectedEvents,
	type CollectOptions,
	collectEvents,
} from "./collect.ts";
export {
	GATEWAY_TOOLS,
	gatewayChatBody,
	MAX_CHAT_TOOL_TOKENS,
} from "./gateway.ts";
export {
	type RyuJsonValue,
	type RyuToolJsonSchema,
	ryuToolJsonSchema,
} from "./json-schema.ts";
export { MAIL_TOOLS } from "./mail.ts";
export {
	DEFAULT_EVENTS_PAGE,
	DEFAULT_MAX_EVENTS,
	listPendingApprovals,
	MANAGED_AGENTS_TOOLS,
	type PendingApproval,
} from "./managed-agents.ts";
export {
	MESSAGING_METADATA_MAX_ENTRIES,
	MESSAGING_TOOLS,
} from "./messaging.ts";
export {
	DEFAULT_APPROVAL_TOOL_TIMEOUT_MS,
	DEFAULT_APPROVAL_WAIT_MS,
	defaultNotifyUsageWindow,
	MAX_APPROVAL_TIMEOUT_MS,
	MAX_APPROVAL_WAIT_MS,
	NOTIFY_TOOL_LEVELS,
	NOTIFY_TOOLS,
} from "./notify.ts";
export {
	NO_DATA,
	type RyuToolOutputJsonSchema,
	type RyuToolOutputSchema,
	ryuToolOutputJsonSchema,
	toolMetaSchema,
	toolOutput,
} from "./output.ts";
export { PASSPORT_TOOLS } from "./passport.ts";
export {
	credentialFreeRyuTools,
	getRyuTool,
	RYU_TOOL_PREFIXES,
	RYU_TOOL_SERVICES,
	RYU_TOOLS,
	RYU_TOOLS_BY_SERVICE,
	type RyuToolFilter,
	type RyuToolSelection,
	ryuToolPassesFilter,
	selectRyuTools,
} from "./registry.ts";
export {
	invalidToolInput,
	isSettledToolCall,
	parseToolInput,
	type RyuToolErrorJSON,
	type RyuToolInputIssue,
	type RyuToolMetaJSON,
	type RyuToolResultJSON,
	runRyuTool,
	ryuForToolCall,
	type SettledToolCall,
	settled,
	settledMap,
	settleToolCall,
	toPlainJson,
	toToolErrorJson,
	toToolMetaJson,
	toToolResultJson,
} from "./run.ts";
export { SITES_TOOLS } from "./sites.ts";
export {
	type AnyRyuTool,
	defineRyuTool,
	type RyuToolAnnotations,
	type RyuToolContext,
	type RyuToolDefinition,
} from "./types.ts";
