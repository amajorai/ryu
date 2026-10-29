import { z } from "zod";
import { spansManagedAgentPublicSuffix } from "./managed-agents-public-suffixes.ts";
import { wireObject } from "./wire-object.ts";

/*
 * Ryu Managed Agents public wire contract (`/api/v1/managed-agents`).
 *
 * Input parsers are closed: unknown keys anywhere in a request body are rejected and defaults are
 * filled. Response parsers are tolerant: they validate the declared fields and return the raw
 * value, so fields added later in v1 are kept.
 */

export const MANAGED_AGENTS_PROTOCOL_VERSION = "ryu.managed-agents.v1";

/** Mount path of the REST surface on the control plane. */
export const MANAGED_AGENTS_BASE_PATH = "/api/v1/managed-agents";

export const MANAGED_AGENT_BACKENDS = [
	"anthropic",
	"openai",
	"gemini",
	"ryu_node",
	"ryu_serverless",
] as const;

export const MANAGED_AGENT_VENDOR_PROVIDERS = [
	"anthropic",
	"openai",
	"gemini",
] as const;

export const MANAGED_AGENT_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
] as const;

export const MANAGED_AGENT_BUILTIN_TOOLS = [
	"web_search",
	"web_fetch",
	"code_execution",
	"file_search",
] as const;

export const MANAGED_AGENT_SESSION_STATUSES = [
	"pending",
	"running",
	"idle",
	"completed",
	"failed",
	"canceled",
] as const;

export const MANAGED_AGENT_TERMINAL_STATUSES = [
	"completed",
	"failed",
	"canceled",
] as const;

export const MANAGED_AGENT_STOP_REASONS = [
	"end_turn",
	"requires_action",
	"interrupted",
	"retries_exhausted",
	"budget_reached",
	"insufficient_credits",
	"refusal",
	"max_tokens",
	"error",
] as const;

export const MANAGED_AGENT_STATUS_DETAILS = [
	"provisioning",
	"provisioned",
	"rescheduling",
	"closing",
] as const;

export const MANAGED_AGENT_USER_EVENT_TYPES = [
	"user.message",
	"user.interrupt",
	"user.custom_tool_result",
	"user.tool_approval",
] as const;

/** Every event type declared in v1. `agent.message.delta` is reserved and never emitted in v1. */
export const MANAGED_AGENT_EVENT_TYPES = [
	...MANAGED_AGENT_USER_EVENT_TYPES,
	"agent.message",
	"agent.message.delta",
	"agent.tool_use",
	"agent.tool_result",
	"agent.custom_tool_use",
	"agent.tool_approval_request",
	"session.status",
	"session.error",
	"session.usage",
] as const;

export const MANAGED_AGENT_ID_PREFIXES = {
	agent: "magt_",
	environment: "menv_",
	session: "msess_",
	event: "mevt_",
	credential: "mcred_",
	toolUse: "mtool_",
	request: "req_",
} as const;

export const DEFAULT_GEMINI_AGENT = "antigravity-preview-09-2026";

export const MANAGED_AGENTS_HEADERS = {
	organization: "X-Ryu-Organization",
	requestId: "X-Request-ID",
	idempotencyKey: "Idempotency-Key",
	replayed: "Idempotent-Replayed",
	lastEventId: "Last-Event-ID",
} as const;

/** Public limits (§4.9). Ranges are inclusive `{ min, max }`. */
export const MANAGED_AGENTS_LIMITS = {
	nameChars: 256,
	descriptionChars: 2048,
	titleChars: 256,
	labelChars: 64,
	modelChars: 128,
	instructionsChars: 100_000,
	toolsPerAgent: 64,
	toolDescriptionChars: 1024,
	inputSchemaBytes: 65_536,
	mcpServersPerAgent: 20,
	mcpUrlChars: 2048,
	mcpAllowedToolsPerServer: 128,
	allowedDomainsPerTool: 64,
	networkDomains: 64,
	packagesPerManager: 64,
	packageNameChars: 128,
	metadataPairs: 16,
	metadataKeyChars: 64,
	metadataValueChars: 512,
	apiKeyChars: { min: 8, max: 512 },
	agentsPerOrg: 500,
	versionsPerAgent: 1000,
	agentVersionsPerOrg: 10_000,
	environmentsPerOrg: 100,
	credentialsPerOrg: 50,
	activeSessionsPerOrg: 100,
	sessionsCreatedPerOrgPerHour: 1000,
	idleSessionTtlDays: 7,
	writesPerOrgPerMinute: 600,
	eventsPerRequest: 8,
	initialEventsPerSession: 8,
	queuedInputsPerSession: 32,
	userEventBytesPerOrgPerDay: 536_870_912,
	textBlocksPerMessage: 16,
	messageTextChars: 100_000,
	agentMessageTextChars: 100_000,
	agentToolResultBlockChars: 32_768,
	agentToolResultBlocks: 8,
	toolInputBytes: 65_536,
	eventBytes: 524_288,
	eventsPerSession: 100_000,
	/** An unanswered `agent.tool_approval_request` is denied this long after it was appended. */
	toolApprovalTimeoutSeconds: 600,
	approvalMessageChars: 1024,
	listLimitDefault: 20,
	listLimitMax: 100,
	eventsListLimitDefault: 100,
	eventsListLimitMax: 500,
	eventsListMaxBytes: 4_194_304,
	streamMaxSeconds: 600,
	streamKeepaliveMs: 8000,
	streamRetryMs: 2000,
	streamsPerReplica: 512,
	streamsPerOrgPerReplica: 16,
	streamsPerSession: 4,
	streamsPerPrincipal: 8,
	idempotencyKeyPattern: "^[A-Za-z0-9_-]{16,128}$",
	idempotencyTtlHours: 24,
	sessionBudgetMicroUsd: { min: 10_000, max: 1_000_000_000_000 },
	openaiMaxToolCalls: { min: 1, max: 200 },
	geminiMaxTotalTokens: { min: 1000, max: 10_000_000 },
	ryuNodeTimeoutSeconds: { min: 30, max: 120 },
} as const;

/** HTTP status for every error code (§4.8.1). */
export const MANAGED_AGENTS_ERROR_STATUS = {
	invalid_request: 400,
	invalid_cursor: 400,
	invalid_idempotency_key: 400,
	organization_required: 400,
	unauthenticated: 401,
	insufficient_credits: 402,
	api_key_spend_cap_reached: 402,
	forbidden: 403,
	organization_mismatch: 403,
	org_access_denied: 403,
	feature_disabled: 403,
	step_up_required: 403,
	not_found: 404,
	version_conflict: 409,
	revision_conflict: 409,
	name_taken: 409,
	agent_archived: 409,
	environment_archived: 409,
	limit_reached: 409,
	idempotency_key_reused: 409,
	idempotency_in_progress: 409,
	session_closed: 409,
	session_running: 409,
	session_not_terminal: 409,
	tool_result_required: 409,
	unknown_tool_use: 409,
	tool_result_already_submitted: 409,
	session_budget_exhausted: 409,
	event_log_full: 409,
	payload_too_large: 413,
	unsupported_for_backend: 422,
	unsupported_content: 422,
	model_not_priced: 422,
	credential_unavailable: 422,
	platform_credentials_disabled: 422,
	node_not_found: 422,
	node_unreachable: 422,
	node_forbidden: 422,
	rate_limited: 429,
	session_limit_reached: 429,
	stream_limit_reached: 429,
	internal_error: 500,
	backend_not_implemented: 501,
	vendor_error: 502,
	managed_agents_disabled: 503,
	backend_disabled: 503,
	billing_unavailable: 503,
	event_append_contended: 503,
	service_unavailable: 503,
} as const satisfies Readonly<Record<string, number>>;

/** Stable HTTP error code (§4.8.1). Clients treat an unknown code by its HTTP status. */
export type ManagedAgentsErrorCode = keyof typeof MANAGED_AGENTS_ERROR_STATUS;

/** Stable in-log `session.error` codes (§4.8.2). */
export const MANAGED_AGENT_SESSION_ERROR_CODES = [
	"vendor_error",
	"vendor_rate_limited",
	"vendor_overloaded",
	"vendor_billing_error",
	"credential_rejected",
	"credential_unavailable",
	"vendor_session_lost",
	"vendor_context_expired",
	"vendor_environment_expired",
	"vendor_create_unconfirmed",
	"vendor_redirect",
	"input_rejected",
	"input_delivery_failed",
	"refusal",
	"incomplete",
	"mcp_connection_failed",
	"mcp_authentication_failed",
	"tool_approval_unsupported",
	"tool_approval_timeout",
	"budget_reached",
	"insufficient_credits",
	"billing_unavailable",
	"usage_unavailable",
	"node_unreachable",
	"node_forbidden",
	"node_paused",
	"node_turn_failed",
	"node_auth_failed",
	"event_log_full",
	"provision_timeout",
	"idle_timeout",
	"teardown_incomplete",
	"internal_error",
] as const;

export type ManagedAgentSessionErrorCode =
	(typeof MANAGED_AGENT_SESSION_ERROR_CODES)[number];
export type ManagedAgentSessionErrorSource = "ryu" | "vendor" | "node";

/** One row of the §4.8.2 table. */
export interface ManagedAgentSessionErrorInfo {
	/** Whether a later input may succeed; `null` where the table says n/a. */
	readonly retryable: boolean | null;
	/** Who reports the error. */
	readonly source: ManagedAgentSessionErrorSource;
}

/** The §4.8.2 table, keyed by code. */
export const MANAGED_AGENT_SESSION_ERROR_INFO = {
	vendor_error: { retryable: true, source: "vendor" },
	vendor_rate_limited: { retryable: true, source: "vendor" },
	vendor_overloaded: { retryable: true, source: "vendor" },
	vendor_billing_error: { retryable: false, source: "vendor" },
	credential_rejected: { retryable: false, source: "vendor" },
	credential_unavailable: { retryable: false, source: "ryu" },
	vendor_session_lost: { retryable: false, source: "vendor" },
	vendor_context_expired: { retryable: true, source: "vendor" },
	vendor_environment_expired: { retryable: false, source: "vendor" },
	vendor_create_unconfirmed: { retryable: true, source: "ryu" },
	vendor_redirect: { retryable: false, source: "ryu" },
	input_rejected: { retryable: false, source: "vendor" },
	input_delivery_failed: { retryable: true, source: "ryu" },
	refusal: { retryable: true, source: "vendor" },
	incomplete: { retryable: true, source: "vendor" },
	mcp_connection_failed: { retryable: true, source: "vendor" },
	mcp_authentication_failed: { retryable: false, source: "vendor" },
	tool_approval_unsupported: { retryable: true, source: "ryu" },
	tool_approval_timeout: { retryable: true, source: "ryu" },
	budget_reached: { retryable: false, source: "ryu" },
	insufficient_credits: { retryable: true, source: "ryu" },
	billing_unavailable: { retryable: true, source: "ryu" },
	usage_unavailable: { retryable: null, source: "ryu" },
	node_unreachable: { retryable: true, source: "node" },
	node_forbidden: { retryable: false, source: "node" },
	node_paused: { retryable: true, source: "node" },
	node_turn_failed: { retryable: true, source: "node" },
	node_auth_failed: { retryable: false, source: "node" },
	event_log_full: { retryable: false, source: "ryu" },
	provision_timeout: { retryable: false, source: "ryu" },
	idle_timeout: { retryable: null, source: "ryu" },
	teardown_incomplete: { retryable: null, source: "ryu" },
	internal_error: { retryable: true, source: "ryu" },
} as const satisfies Readonly<
	Record<ManagedAgentSessionErrorCode, ManagedAgentSessionErrorInfo>
>;

/**
 * Ryu-authored `session.error.message` per code. Platform mode always stores these instead of
 * vendor text, so tenant-visible errors never name Ryu's vendor accounts (§4.8.2).
 */
export const MANAGED_AGENT_SESSION_ERROR_MESSAGES = {
	vendor_error: "The model provider returned an error. Ryu will retry.",
	vendor_rate_limited: "The model provider is busy. Ryu will retry.",
	vendor_overloaded: "The model provider is overloaded. Ryu will retry.",
	vendor_billing_error:
		"The model provider refused the request because of a billing problem.",
	credential_rejected: "The model provider rejected the credential.",
	credential_unavailable:
		"The credential for this environment is no longer available.",
	vendor_session_lost: "The model provider no longer has this session.",
	vendor_context_expired:
		"The model provider's conversation context expired. Send a new message to continue.",
	vendor_environment_expired:
		"The model provider's execution environment expired.",
	vendor_create_unconfirmed:
		"Ryu could not confirm that the model provider received this input. Send it again if needed.",
	vendor_redirect:
		"The model provider answered with a redirect, which Ryu does not follow.",
	input_rejected: "The model provider rejected this input.",
	input_delivery_failed:
		"This input was not delivered to the model provider. Send it again.",
	refusal: "The model declined to respond.",
	incomplete: "The model provider returned an incomplete response.",
	mcp_connection_failed:
		"The model provider could not connect to an MCP server.",
	mcp_authentication_failed: "An MCP server refused authentication.",
	tool_approval_unsupported:
		"A tool asked for approval, which Managed Agents does not support. The call was denied.",
	tool_approval_timeout:
		"A tool approval request was not answered in time. The call was denied.",
	budget_reached: "The session budget is used up.",
	insufficient_credits:
		"The organization does not have enough credits for this turn.",
	billing_unavailable:
		"Ryu could not confirm billing for this session. Try again later.",
	usage_unavailable: "Usage for this turn could not be measured.",
	node_unreachable: "Ryu could not reach the node.",
	node_forbidden: "The node refused this session.",
	node_paused: "The node is paused.",
	node_turn_failed: "The node could not complete the turn.",
	node_auth_failed: "The node rejected Ryu's credentials.",
	event_log_full: "The session event log is full.",
	provision_timeout: "The session was not ready within 5 minutes.",
	idle_timeout: "The session was completed after 7 days without activity.",
	teardown_incomplete:
		"Ryu could not confirm that every provider resource for this session was removed.",
	internal_error: "An internal error occurred.",
} as const satisfies Readonly<Record<ManagedAgentSessionErrorCode, string>>;

export interface ManagedAgentsRoute {
	readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	readonly operation: string;
	/** Relative to `MANAGED_AGENTS_BASE_PATH`, with `{name}` placeholders. */
	readonly path: string;
}

/** The 27 REST routes (§4.6), in table order. */
export const MANAGED_AGENTS_ROUTES = [
	{ method: "POST", path: "/agents", operation: "agents.create" },
	{ method: "GET", path: "/agents", operation: "agents.list" },
	{ method: "GET", path: "/agents/{agentId}", operation: "agents.get" },
	{ method: "PATCH", path: "/agents/{agentId}", operation: "agents.update" },
	{
		method: "POST",
		path: "/agents/{agentId}/archive",
		operation: "agents.archive",
	},
	{
		method: "GET",
		path: "/agents/{agentId}/versions",
		operation: "agents.listVersions",
	},
	{
		method: "GET",
		path: "/agents/{agentId}/versions/{version}",
		operation: "agents.getVersion",
	},
	{ method: "POST", path: "/environments", operation: "environments.create" },
	{ method: "GET", path: "/environments", operation: "environments.list" },
	{
		method: "GET",
		path: "/environments/{environmentId}",
		operation: "environments.get",
	},
	{
		method: "PATCH",
		path: "/environments/{environmentId}",
		operation: "environments.update",
	},
	{
		method: "POST",
		path: "/environments/{environmentId}/archive",
		operation: "environments.archive",
	},
	{ method: "POST", path: "/credentials", operation: "credentials.create" },
	{ method: "GET", path: "/credentials", operation: "credentials.list" },
	{
		method: "GET",
		path: "/credentials/{credentialId}",
		operation: "credentials.get",
	},
	{
		method: "PUT",
		path: "/credentials/{credentialId}/key",
		operation: "credentials.rotate",
	},
	{
		method: "DELETE",
		path: "/credentials/{credentialId}",
		operation: "credentials.revoke",
	},
	{ method: "POST", path: "/sessions", operation: "sessions.create" },
	{ method: "GET", path: "/sessions", operation: "sessions.list" },
	{ method: "GET", path: "/sessions/{sessionId}", operation: "sessions.get" },
	{
		method: "PATCH",
		path: "/sessions/{sessionId}",
		operation: "sessions.update",
	},
	{
		method: "POST",
		path: "/sessions/{sessionId}/events",
		operation: "sessions.sendEvents",
	},
	{
		method: "GET",
		path: "/sessions/{sessionId}/events",
		operation: "sessions.listEvents",
	},
	{
		method: "GET",
		path: "/sessions/{sessionId}/stream",
		operation: "sessions.stream",
	},
	{
		method: "POST",
		path: "/sessions/{sessionId}/cancel",
		operation: "sessions.cancel",
	},
	{
		method: "POST",
		path: "/sessions/{sessionId}/complete",
		operation: "sessions.complete",
	},
	{
		method: "DELETE",
		path: "/sessions/{sessionId}",
		operation: "sessions.delete",
	},
] as const satisfies readonly ManagedAgentsRoute[];

export type ManagedAgentsOperation =
	(typeof MANAGED_AGENTS_ROUTES)[number]["operation"];

// ---------------------------------------------------------------------------------------------
// Resource types (§4.3)
// ---------------------------------------------------------------------------------------------

export type ManagedAgentBackend = (typeof MANAGED_AGENT_BACKENDS)[number];
export type ManagedAgentVendorProvider =
	(typeof MANAGED_AGENT_VENDOR_PROVIDERS)[number];
export type ManagedAgentReasoningEffort =
	(typeof MANAGED_AGENT_REASONING_EFFORTS)[number];
export type ManagedAgentBuiltinTool =
	(typeof MANAGED_AGENT_BUILTIN_TOOLS)[number];
export type ManagedAgentIdKind = keyof typeof MANAGED_AGENT_ID_PREFIXES;

/** A JSON value as it travels on the wire. Parsers reject anything JSON cannot carry. */
export type ManagedAgentJsonValue =
	| boolean
	| null
	| number
	| string
	| ManagedAgentJsonValue[]
	| { [key: string]: ManagedAgentJsonValue };

/** A JSON object: a tool `inputSchema`, a tool call `input`, error `details` or a config patch. */
export type ManagedAgentJsonObject = Record<string, ManagedAgentJsonValue>;

export type ManagedAgentToolSpec =
	| {
			type: "builtin";
			name: ManagedAgentBuiltinTool;
			/** web_search and web_fetch only; otherwise []. */
			allowedDomains: string[];
			/**
			 * Ask the client before each call (`agent.tool_approval_request`). Omitted or false runs
			 * the tool without asking. Only backends with interactive approvals accept true.
			 */
			requireApproval?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			/** A JSON Schema whose `type` is "object". */
			inputSchema: ManagedAgentJsonObject;
	  };

export interface ManagedAgentMcpServer {
	/** `null` allows every tool the server exposes. */
	allowedTools: string[] | null;
	/** `^[a-z0-9_]{1,64}$`, unique per agent. */
	name: string;
	/**
	 * Ask the client before each call to this server's tools (`agent.tool_approval_request`).
	 * Omitted or false runs them without asking.
	 */
	requireApproval?: boolean;
	/** `https:`, at most 2,048 characters, no userinfo, not an IP literal or localhost. */
	url: string;
}

export interface ManagedAgent {
	archivedAt: string | null;
	createdAt: string;
	description: string | null;
	/** `magt_…` */
	id: string;
	instructions: string | null;
	mcpServers: ManagedAgentMcpServer[];
	metadata: Record<string, string>;
	model: string | null;
	name: string;
	reasoningEffort: ManagedAgentReasoningEffort | null;
	tools: ManagedAgentToolSpec[];
	updatedAt: string;
	/** Latest version. */
	version: number;
}

export interface ManagedAgentVersion {
	agentId: string;
	createdAt: string;
	description: string | null;
	instructions: string | null;
	mcpServers: ManagedAgentMcpServer[];
	metadata: Record<string, string>;
	model: string | null;
	name: string;
	reasoningEffort: ManagedAgentReasoningEffort | null;
	tools: ManagedAgentToolSpec[];
	version: number;
}

export type ManagedAgentEnvironmentCredential =
	| { source: "byok"; credentialId: string }
	| { source: "platform" }
	| { source: "none" };

export type ManagedAgentNetwork =
	| { type: "disabled" }
	| { type: "allowlist"; domains: string[] }
	| { type: "unrestricted" };

export interface AnthropicEnvironmentConfig {
	networking:
		| {
				type: "limited";
				allowedHosts: string[];
				allowPackageManagers: boolean;
				allowMcpServers: boolean;
		  }
		| { type: "unrestricted" };
	packages: {
		apt: string[];
		cargo: string[];
		gem: string[];
		go: string[];
		npm: string[];
		pip: string[];
	};
}

export interface OpenAiEnvironmentConfig {
	codeExecutionTool: "code_interpreter" | "shell";
	container: {
		memoryLimit: "1g" | "4g" | "16g" | "64g";
		network: { type: "disabled" } | { type: "allowlist"; domains: string[] };
	};
	maxToolCalls: number | null;
	mode: "responses";
	/** BYOK only; at most 8. */
	vectorStoreIds: string[];
}

export interface GeminiEnvironmentConfig {
	/** `^[a-z0-9-]{1,128}$`; platform mode accepts only the server allowlist. */
	agent: string;
	maxTotalTokens: number | null;
	network: ManagedAgentNetwork;
}

export interface RyuNodeEnvironmentConfig {
	/** An org-scope node only. */
	nodeId: string;
	/** Read-only: server-set to the last person who changed the target. */
	runAsUserId: string;
	timeoutSeconds: number;
}

/** `ryu_node` config as accepted in a request: `runAsUserId` is server-set and dropped. */
export type RyuNodeEnvironmentConfigInput = Omit<
	RyuNodeEnvironmentConfig,
	"runAsUserId"
>;

export type RyuServerlessEnvironmentConfig = Record<string, never>;

export interface ManagedAgentBackendConfigMap {
	anthropic: AnthropicEnvironmentConfig;
	gemini: GeminiEnvironmentConfig;
	openai: OpenAiEnvironmentConfig;
	ryu_node: RyuNodeEnvironmentConfig;
	ryu_serverless: RyuServerlessEnvironmentConfig;
}

/** Config shapes after input parsing (defaults filled, `runAsUserId` dropped). */
export interface ManagedAgentBackendConfigInputMap {
	anthropic: AnthropicEnvironmentConfig;
	gemini: GeminiEnvironmentConfig;
	openai: OpenAiEnvironmentConfig;
	ryu_node: RyuNodeEnvironmentConfigInput;
	ryu_serverless: RyuServerlessEnvironmentConfig;
}

export type ManagedAgentEnvironment = {
	[B in ManagedAgentBackend]: {
		archivedAt: string | null;
		backend: B;
		config: ManagedAgentBackendConfigMap[B];
		createdAt: string;
		credential: ManagedAgentEnvironmentCredential;
		description: string | null;
		/** `menv_…` */
		id: string;
		/** Unique among non-archived environments in the org. */
		name: string;
		/** Starts at 1; +1 per accepted update. */
		revision: number;
		updatedAt: string;
	};
}[ManagedAgentBackend];

export interface ManagedAgentCredential {
	createdAt: string;
	/** sha256(key).hex[0..16] */
	fingerprint: string;
	/** `mcred_…` */
	id: string;
	/** Last 4 characters of the key. */
	keyHint: string;
	label: string;
	provider: ManagedAgentVendorProvider;
	revokedAt: string | null;
	updatedAt: string;
}

export type ManagedAgentSessionStatus =
	(typeof MANAGED_AGENT_SESSION_STATUSES)[number];
export type ManagedAgentTerminalSessionStatus =
	(typeof MANAGED_AGENT_TERMINAL_STATUSES)[number];
export type ManagedAgentStopReason =
	(typeof MANAGED_AGENT_STOP_REASONS)[number];
export type ManagedAgentStatusDetail =
	(typeof MANAGED_AGENT_STATUS_DETAILS)[number];

export interface ManagedAgentUsageTotals {
	activeSeconds: number;
	cacheReadInputTokens: number;
	cacheWriteInputTokens: number;
	/** UNCACHED input only, for every backend (cache reads and writes are separate). */
	inputTokens: number;
	/** Vendor list price before markup; null when unknown. */
	listCostMicroUsd: number | null;
	outputTokens: number;
	reasoningTokens: number;
	webSearchRequests: number;
}

export interface ManagedAgentSession {
	agentId: string;
	agentVersion: number;
	backend: ManagedAgentBackend;
	/** Platform debits so far (0 for BYOK and nodes). */
	billedMicroUsd: number;
	budget: { maxCostMicroUsd: number } | null;
	closing: {
		target: "canceled" | "completed";
		requestedAt: string;
	} | null;
	createdAt: string;
	/** Terminal transition. */
	endedAt: string | null;
	environmentId: string;
	environmentRevision: number;
	/** Advisory; may lag the log briefly (use GET …/events `headSeq` for the live tail). */
	headSeq: number;
	/** `msess_…` */
	id: string;
	lastError: { code: string; message: string } | null;
	metadata: Record<string, string>;
	/** Custom tool calls the client must answer. */
	pendingToolUseIds: string[];
	/** First transition out of `pending`. */
	startedAt: string | null;
	status: ManagedAgentSessionStatus;
	/** Set when a turn ended (idle) or terminal; null after provisioning. */
	stopReason: ManagedAgentStopReason | null;
	title: string | null;
	updatedAt: string;
	/** Cumulative. */
	usage: ManagedAgentUsageTotals;
}

// ---------------------------------------------------------------------------------------------
// Event types (§4.4)
// ---------------------------------------------------------------------------------------------

export type ManagedAgentEventType = (typeof MANAGED_AGENT_EVENT_TYPES)[number];
export type ManagedAgentUserEventType =
	(typeof MANAGED_AGENT_USER_EVENT_TYPES)[number];

export interface ManagedAgentEventEnvelope {
	/** When Ryu appended it. */
	createdAt: string;
	/** `mevt_…` */
	id: string;
	/** ≥1, gap-free and monotonic per session. */
	seq: number;
	sessionId: string;
}

export interface TextBlock {
	text: string;
	type: "text";
}
export type AgentContentBlock = TextBlock | { type: "redacted" };

export interface ManagedAgentSessionErrorBody {
	/** Stable Ryu code (§4.8.2). */
	code: string;
	details: {
		/** Raw vendor error code or type, at most 128 characters. */
		vendorCode?: string;
		/** BYOK and ryu_node only; never in platform mode. */
		vendorRequestId?: string;
		mcpServer?: string;
		/** The user event this error refers to. */
		eventSeq?: number;
		refusalCategory?: string;
	};
	/** At most 1,024 characters. BYOK: scrubbed vendor text. Platform: the Ryu-authored string. */
	message: string;
	/** True when a later input may succeed without config changes. */
	retryable: boolean;
	source: ManagedAgentSessionErrorSource;
	type: "session.error";
}

export interface ManagedAgentUserMessageEventBody {
	content: TextBlock[];
	type: "user.message";
}
export interface ManagedAgentUserInterruptEventBody {
	type: "user.interrupt";
}
export interface ManagedAgentUserCustomToolResultEventBody {
	content: TextBlock[];
	isError: boolean;
	toolUseId: string;
	type: "user.custom_tool_result";
}

/** The client's answer to an `agent.tool_approval_request`. */
export interface ManagedAgentUserToolApprovalEventBody {
	decision: "allow" | "deny";
	/** Shown to the model with a denial; at most 1,024 characters. */
	message: string | null;
	toolUseId: string;
	type: "user.tool_approval";
}

export type ManagedAgentUserEventBody =
	| ManagedAgentUserMessageEventBody
	| ManagedAgentUserInterruptEventBody
	| ManagedAgentUserCustomToolResultEventBody
	| ManagedAgentUserToolApprovalEventBody;

/**
 * A server-executed tool call waits for the client's decision. The call itself is the
 * `agent.tool_use` with the same `toolUseId`; answer with `user.tool_approval` before `expiresAt`
 * or it is denied (`session.error{code:"tool_approval_timeout"}`).
 */
export interface ManagedAgentToolApprovalRequestEventBody {
	expiresAt: string;
	name: string;
	server: string | null;
	source: "builtin" | "mcp";
	toolUseId: string;
	type: "agent.tool_approval_request";
}

export interface ManagedAgentSessionStatusEventBody {
	detail: ManagedAgentStatusDetail | null;
	/** Highest user-event seq the backend had accepted when this status was appended; null when none. */
	inputSeq: number | null;
	pendingToolUseIds: string[];
	status: ManagedAgentSessionStatus;
	stopReason: ManagedAgentStopReason | null;
	type: "session.status";
}

export interface ManagedAgentSessionUsageEventBody {
	billing: {
		mode: "platform" | "byok" | "none";
		amountMicroUsd: number;
	};
	cumulative: ManagedAgentUsageTotals;
	delta: ManagedAgentUsageTotals;
	type: "session.usage";
}

export type ManagedAgentEventBody =
	| ManagedAgentUserEventBody
	| { type: "agent.message"; content: AgentContentBlock[] }
	/** RESERVED: never persisted or emitted in v1. */
	| {
			type: "agent.message.delta";
			messageKey: string;
			index: number;
			text: string;
	  }
	| {
			type: "agent.tool_use";
			toolUseId: string;
			/** Backend-native tool name, for example `bash` or `code_interpreter`. */
			name: string;
			input: ManagedAgentJsonObject;
			inputTruncated: boolean;
			source: "builtin" | "mcp";
			server: string | null;
	  }
	| {
			type: "agent.tool_result";
			toolUseId: string;
			content: TextBlock[];
			isError: boolean;
			truncated: boolean;
	  }
	| {
			type: "agent.custom_tool_use";
			toolUseId: string;
			name: string;
			input: ManagedAgentJsonObject;
	  }
	| ManagedAgentToolApprovalRequestEventBody
	| ManagedAgentSessionStatusEventBody
	| ManagedAgentSessionErrorBody
	| ManagedAgentSessionUsageEventBody;

export type ManagedAgentEvent = ManagedAgentEventEnvelope &
	ManagedAgentEventBody;

/** A well-formed event whose type this contract version does not know. */
export interface ManagedAgentRawUnknownEvent extends ManagedAgentEventEnvelope {
	type: string;
	readonly [field: string]: ManagedAgentJsonValue;
}

/** An unknown event as returned by `parseManagedAgentEvent`. Clients ignore it. */
export interface ManagedAgentUnknownEvent extends ManagedAgentRawUnknownEvent {
	known: false;
}

/** Result of `parseManagedAgentEvent`: the raw event plus whether its type is known. */
export type ManagedAgentParsedEvent =
	| (ManagedAgentEvent & { known: true })
	| ManagedAgentUnknownEvent;

export interface ManagedAgentEventList {
	data: ManagedAgentEvent[];
	hasMore: boolean;
	/** Tail seq at read time. */
	headSeq: number;
	/** The last returned seq, or `after` when nothing is returned. */
	nextAfter: number;
}

/** Data of the SSE `event: end` frame (§4.7). It has no `id:` and is never a log event. */
export interface ManagedAgentStreamEnd {
	headSeq: number;
	reason: "terminal" | "deleted";
	sessionId: string;
	status: ManagedAgentSessionStatus;
}

export interface ManagedAgentsList<T> {
	data: T[];
	nextCursor: string | null;
}

export interface ManagedAgentsErrorBody {
	error: {
		code: ManagedAgentsErrorCode;
		message: string;
		requestId: string;
		details?: ManagedAgentJsonObject;
	};
}

// ---------------------------------------------------------------------------------------------
// Input types (§4.6), as returned by the input parsers (defaults filled)
// ---------------------------------------------------------------------------------------------

export interface CreateManagedAgentInput {
	description: string | null;
	instructions: string | null;
	mcpServers: ManagedAgentMcpServer[];
	metadata: Record<string, string>;
	model: string | null;
	name: string;
	reasoningEffort: ManagedAgentReasoningEffort | null;
	tools: ManagedAgentToolSpec[];
}

export interface UpdateManagedAgentInput {
	description?: string | null;
	expectedVersion?: number;
	instructions?: string | null;
	mcpServers?: ManagedAgentMcpServer[];
	/** Merged per key; `null` deletes the key. */
	metadata?: Record<string, string | null>;
	model?: string | null;
	name?: string;
	reasoningEffort?: ManagedAgentReasoningEffort | null;
	tools?: ManagedAgentToolSpec[];
}

export type CreateManagedAgentEnvironmentInput = {
	[B in ManagedAgentBackend]: {
		backend: B;
		config: ManagedAgentBackendConfigInputMap[B];
		credential: ManagedAgentEnvironmentCredential;
		description: string | null;
		name: string;
	};
}[ManagedAgentBackend];

/**
 * A replacement `config` in an environment PATCH. It is valid for at least one backend; the
 * server re-parses it for the stored backend with `parseManagedAgentEnvironmentConfig`, which
 * fills that backend's defaults.
 */
export type ManagedAgentEnvironmentConfigPatch = ManagedAgentJsonObject;

export interface UpdateManagedAgentEnvironmentInput {
	config?: ManagedAgentEnvironmentConfigPatch;
	credential?: ManagedAgentEnvironmentCredential;
	description?: string | null;
	expectedRevision?: number;
	name?: string;
}

export interface CreateManagedAgentCredentialInput {
	apiKey: string;
	label: string;
	provider: ManagedAgentVendorProvider;
}

export interface RotateManagedAgentCredentialInput {
	apiKey: string;
}

export interface CreateManagedAgentSessionInput {
	agentId: string;
	/** `null` pins the latest version. */
	agentVersion: number | null;
	budget: { maxCostMicroUsd: number } | null;
	environmentId: string;
	initialEvents: ManagedAgentUserMessageEventBody[];
	metadata: Record<string, string>;
	title: string | null;
}

export interface UpdateManagedAgentSessionInput {
	/** Merged per key; `null` deletes the key. */
	metadata?: Record<string, string | null>;
	title?: string | null;
}

export interface SendManagedAgentEventsInput {
	events: ManagedAgentUserEventBody[];
}

export interface CancelManagedAgentSessionInput {
	reason: string | null;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const LIMITS = MANAGED_AGENTS_LIMITS;
const ID_HEX_RE = /^[0-9a-f]{32}$/u;
const IDEMPOTENCY_KEY_RE = new RegExp(LIMITS.idempotencyKeyPattern, "u");
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const NUMERIC_LABEL_RE = /^\d+$/u;
const WHITESPACE_RE = /\s/u;
const CUSTOM_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const MCP_SERVER_NAME_RE = /^[a-z0-9_]{1,64}$/u;
const GEMINI_AGENT_RE = /^[a-z0-9-]{1,128}$/u;
const OPAQUE_REF_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_HOSTNAME_CHARS = 253;
const CANCEL_REASON_CHARS = 256;
const TOOL_NAME_CHARS = 256;
const textEncoder = new TextEncoder();

/** Names that collide with vendor builtin or Antigravity filesystem tools (§4.3.1). */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"bash",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"web_fetch",
	"web_search",
	"code_execution",
	"code_interpreter",
	"shell",
	"file_search",
	"google_search",
	"url_context",
	"write_to_file",
	"replace_file_content",
	"view_file",
	"list_dir",
	"find_by_name",
	"grep_search",
]);
const RESERVED_TOOL_PREFIXES = ["mcp__", "ant__"] as const;
const DOMAIN_FILTER_TOOLS: ReadonlySet<string> = new Set([
	"web_search",
	"web_fetch",
]);
const eventTypeSet: ReadonlySet<string> = new Set(MANAGED_AGENT_EVENT_TYPES);
const userEventTypeSet: ReadonlySet<string> = new Set(
	MANAGED_AGENT_USER_EVENT_TYPES
);
const terminalStatusSet: ReadonlySet<string> = new Set(
	MANAGED_AGENT_TERMINAL_STATUSES
);

export function isTerminalSessionStatus(
	status: string
): status is ManagedAgentTerminalSessionStatus {
	return terminalStatusSet.has(status);
}

export function isUserEventType(
	type: string
): type is ManagedAgentUserEventType {
	return userEventTypeSet.has(type);
}

/** Whether an event type is declared in this contract version. */
export function isManagedAgentEventType(
	type: string
): type is ManagedAgentEventType {
	return eventTypeSet.has(type);
}

/** Whether a value has the form of a Ryu Managed Agents id of the given kind. */
export function isManagedAgentId(
	kind: ManagedAgentIdKind,
	value: string
): boolean {
	const prefix = MANAGED_AGENT_ID_PREFIXES[kind];
	return value.startsWith(prefix) && ID_HEX_RE.test(value.slice(prefix.length));
}

/** Whether an `Idempotency-Key` value (the bare token) is well formed (§4.1). */
export function isManagedAgentsIdempotencyKey(value: string): boolean {
	return IDEMPOTENCY_KEY_RE.test(value);
}

/**
 * The key an `Idempotency-Key` header carries (§4.1), or null when malformed. The header is
 * accepted as a bare token (`abcd-efgh_ijkl-mn`) or as an RFC 9651 Structured Field String
 * (`"abcd-efgh_ijkl-mn"`, the form the IETF Idempotency-Key draft defines); both name the same
 * key. The inner value must match `idempotencyKeyPattern`, so it never needs SF escapes.
 */
export function parseManagedAgentsIdempotencyKey(raw: string): string | null {
	let value = raw.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		value = value.slice(1, -1);
	}
	return IDEMPOTENCY_KEY_RE.test(value) ? value : null;
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
		) {
			return true;
		}
	}
	return false;
}

function isLowercaseHostname(value: string): boolean {
	if (value.length > MAX_HOSTNAME_CHARS) {
		return false;
	}
	const labels = value.split(".");
	if (labels.length < 2) {
		return false;
	}
	for (const label of labels) {
		if (!HOST_LABEL_RE.test(label)) {
			return false;
		}
	}
	const topLevel = labels.at(-1) ?? "";
	return !NUMERIC_LABEL_RE.test(topLevel) && topLevel !== "localhost";
}

/**
 * AllowedHost (§4.3): a lowercase RFC 1123 hostname of at least two labels, or `*.` plus a
 * domain of at least two labels that is not a public suffix and does not contain one. IP
 * literals, `localhost`, schemes, ports, paths and userinfo are rejected.
 */
export function isManagedAgentAllowedHost(value: string): boolean {
	if (value.startsWith("*.")) {
		const domain = value.slice(2);
		return (
			isLowercaseHostname(domain) && !spansManagedAgentPublicSuffix(domain)
		);
	}
	return isLowercaseHostname(value);
}

function isLocalhostName(hostname: string): boolean {
	const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
	return name === "localhost" || name.endsWith(".localhost");
}

function isIpLiteralHostname(hostname: string): boolean {
	if (hostname.startsWith("[")) {
		return true;
	}
	const labels = hostname.split(".").filter((label) => label !== "");
	const last = labels.at(-1);
	return last !== undefined && NUMERIC_LABEL_RE.test(last);
}

/** MCP server URL rule (§6): https only, no userinfo, not an IP literal and not localhost. */
export function isManagedAgentMcpServerUrl(value: string): boolean {
	if (
		value.length > LIMITS.mcpUrlChars ||
		WHITESPACE_RE.test(value) ||
		hasControlCharacters(value) ||
		!URL.canParse(value)
	) {
		return false;
	}
	const url = new URL(value);
	return (
		url.protocol === "https:" &&
		url.username === "" &&
		url.password === "" &&
		url.hostname !== "" &&
		!isIpLiteralHostname(url.hostname) &&
		!isLocalhostName(url.hostname)
	);
}

function isCustomToolName(name: string): boolean {
	if (!CUSTOM_TOOL_NAME_RE.test(name)) {
		return false;
	}
	const lower = name.toLowerCase();
	return !(
		RESERVED_TOOL_NAMES.has(lower) ||
		RESERVED_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix))
	);
}

/** A JSON object; values JSON cannot carry (undefined, NaN, Infinity, functions) fail. */
const jsonObjectSchema: z.ZodType<ManagedAgentJsonObject> = z.record(
	z.string(),
	z.json()
);

function serializedBytes(value: ManagedAgentJsonObject): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined
			? null
			: textEncoder.encode(serialized).length;
	} catch {
		return null;
	}
}

function fitsBytes(value: ManagedAgentJsonObject, maxBytes: number): boolean {
	const bytes = serializedBytes(value);
	return bytes !== null && bytes <= maxBytes;
}

function totalTextChars(blocks: readonly { text: string }[]): number {
	let total = 0;
	for (const block of blocks) {
		total += block.text.length;
	}
	return total;
}

function hasUniqueValues(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function isMetadataKey(key: string): boolean {
	return (
		key.length >= 1 &&
		key.length <= LIMITS.metadataKeyChars &&
		!hasControlCharacters(key) &&
		!key.includes(".") &&
		!key.startsWith("$") &&
		key !== "__proto__"
	);
}

const eventContainerSchema = z.object({
	events: z.array(z.unknown()).optional(),
	initialEvents: z.array(z.unknown()).optional(),
});
const eventBlockTypesSchema = z.object({
	content: z.array(z.object({ type: z.string() })),
});

/**
 * Whether a raw POST /sessions or POST …/events body carries a non-text content block. The server
 * answers 422 `unsupported_content` instead of 400 `invalid_request` for such a body (D11).
 */
export function hasUnsupportedManagedAgentContent(
	body: Parameters<typeof eventContainerSchema.safeParse>[0]
): boolean {
	const parsed = eventContainerSchema.safeParse(body);
	if (!parsed.success) {
		return false;
	}
	for (const event of [
		...(parsed.data.events ?? []),
		...(parsed.data.initialEvents ?? []),
	]) {
		const blocks = eventBlockTypesSchema.safeParse(event);
		// Block types other than `text` are reserved (images, documents).
		if (
			blocks.success &&
			blocks.data.content.some((block) => block.type !== "text")
		) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------------------------
// Closed input schemas
// ---------------------------------------------------------------------------------------------

function singleLineText(maxChars: number) {
	return z
		.string()
		.min(1)
		.max(maxChars)
		.refine((value) => value.trim().length > 0 && !hasControlCharacters(value));
}

function idSchema(kind: ManagedAgentIdKind) {
	return z.string().refine((value) => isManagedAgentId(kind, value));
}

const nameSchema = singleLineText(LIMITS.nameChars);
const descriptionSchema = z.string().max(LIMITS.descriptionChars);
const titleSchema = singleLineText(LIMITS.titleChars);
const modelSchema = singleLineText(LIMITS.modelChars);
const instructionsSchema = z.string().max(LIMITS.instructionsChars);
const allowedHostSchema = z.string().refine(isManagedAgentAllowedHost);

const metadataSchema = z
	.record(
		z.string().refine(isMetadataKey),
		z.string().max(LIMITS.metadataValueChars)
	)
	.refine((value) => Object.keys(value).length <= LIMITS.metadataPairs);

const metadataPatchSchema = z
	.record(
		z.string().refine(isMetadataKey),
		z.string().max(LIMITS.metadataValueChars).nullable()
	)
	.refine((value) => Object.keys(value).length <= LIMITS.metadataPairs);

const builtinToolSchema = wireObject(
	{
		type: z.literal("builtin"),
		name: z.enum(MANAGED_AGENT_BUILTIN_TOOLS),
		allowedDomains: z
			.array(allowedHostSchema)
			.max(LIMITS.allowedDomainsPerTool)
			.default([]),
		requireApproval: z.boolean().optional(),
	},
	true
).refine(
	(tool) =>
		DOMAIN_FILTER_TOOLS.has(tool.name) || tool.allowedDomains.length === 0
);

const customToolSchema = wireObject(
	{
		type: z.literal("custom"),
		name: z.string().refine(isCustomToolName),
		description: z.string().max(LIMITS.toolDescriptionChars),
		inputSchema: jsonObjectSchema.refine(
			(schema) =>
				schema.type === "object" && fitsBytes(schema, LIMITS.inputSchemaBytes)
		),
	},
	true
);

const toolsSchema = z
	.array(z.union([builtinToolSchema, customToolSchema]))
	.max(LIMITS.toolsPerAgent)
	.refine((tools) => {
		const builtin = tools.flatMap((tool) =>
			tool.type === "builtin" ? [tool.name] : []
		);
		const custom = tools.flatMap((tool) =>
			tool.type === "custom" ? [tool.name] : []
		);
		return hasUniqueValues(builtin) && hasUniqueValues(custom);
	});

const mcpToolNameSchema = singleLineText(TOOL_NAME_CHARS).refine(
	(value) => !WHITESPACE_RE.test(value)
);

const mcpServerSchema = wireObject(
	{
		name: z.string().regex(MCP_SERVER_NAME_RE),
		url: z.string().refine(isManagedAgentMcpServerUrl),
		allowedTools: z
			.array(mcpToolNameSchema)
			.max(LIMITS.mcpAllowedToolsPerServer)
			.nullable()
			.default(null),
		requireApproval: z.boolean().optional(),
	},
	true
);

const mcpServersSchema = z
	.array(mcpServerSchema)
	.max(LIMITS.mcpServersPerAgent)
	.refine((servers) => hasUniqueValues(servers.map((server) => server.name)));

const createAgentSchema: z.ZodType<CreateManagedAgentInput> = wireObject(
	{
		name: nameSchema,
		description: descriptionSchema.nullable().default(null),
		model: modelSchema.nullable().default(null),
		instructions: instructionsSchema.nullable().default(null),
		tools: toolsSchema.default([]),
		mcpServers: mcpServersSchema.default([]),
		reasoningEffort: z
			.enum(MANAGED_AGENT_REASONING_EFFORTS)
			.nullable()
			.default(null),
		metadata: metadataSchema.default({}),
	},
	true
);

const updateAgentSchema: z.ZodType<UpdateManagedAgentInput> = wireObject(
	{
		expectedVersion: z.int().min(1).optional(),
		name: nameSchema.optional(),
		description: descriptionSchema.nullable().optional(),
		model: modelSchema.nullable().optional(),
		instructions: instructionsSchema.nullable().optional(),
		tools: toolsSchema.optional(),
		mcpServers: mcpServersSchema.optional(),
		reasoningEffort: z
			.enum(MANAGED_AGENT_REASONING_EFFORTS)
			.nullable()
			.optional(),
		metadata: metadataPatchSchema.optional(),
	},
	true
);

const packageNameSchema = singleLineText(LIMITS.packageNameChars).refine(
	(value) => !(WHITESPACE_RE.test(value) || value.startsWith("-"))
);
const packageListSchema = z
	.array(packageNameSchema)
	.max(LIMITS.packagesPerManager)
	.default([]);

const domainAllowlistSchema = z
	.array(allowedHostSchema)
	.min(1)
	.max(LIMITS.networkDomains);

const disabledNetworkSchema = wireObject({ type: z.literal("disabled") }, true);
const allowlistNetworkSchema = wireObject(
	{ type: z.literal("allowlist"), domains: domainAllowlistSchema },
	true
);
const unrestrictedNetworkSchema = wireObject(
	{ type: z.literal("unrestricted") },
	true
);

const anthropicConfigSchema = wireObject(
	{
		networking: z
			.union([
				wireObject(
					{
						type: z.literal("limited"),
						allowedHosts: z
							.array(allowedHostSchema)
							.max(LIMITS.networkDomains)
							.default([]),
						allowPackageManagers: z.boolean().default(false),
						allowMcpServers: z.boolean().default(true),
					},
					true
				),
				unrestrictedNetworkSchema,
			])
			.prefault({ type: "limited" }),
		packages: wireObject(
			{
				apt: packageListSchema,
				cargo: packageListSchema,
				gem: packageListSchema,
				go: packageListSchema,
				npm: packageListSchema,
				pip: packageListSchema,
			},
			true
		).prefault({}),
	},
	true
);

const openAiConfigSchema = wireObject(
	{
		mode: z.literal("responses").default("responses"),
		codeExecutionTool: z
			.enum(["code_interpreter", "shell"])
			.default("code_interpreter"),
		container: wireObject(
			{
				memoryLimit: z.enum(["1g", "4g", "16g", "64g"]).default("4g"),
				network: z
					.union([disabledNetworkSchema, allowlistNetworkSchema])
					.default({ type: "disabled" }),
			},
			true
		).prefault({}),
		maxToolCalls: z
			.int()
			.min(LIMITS.openaiMaxToolCalls.min)
			.max(LIMITS.openaiMaxToolCalls.max)
			.nullable()
			.default(null),
		vectorStoreIds: z
			.array(z.string().regex(OPAQUE_REF_RE))
			.max(8)
			.refine(hasUniqueValues)
			.default([]),
	},
	true
);

const geminiConfigSchema = wireObject(
	{
		agent: z.string().regex(GEMINI_AGENT_RE).default(DEFAULT_GEMINI_AGENT),
		network: z
			.union([
				disabledNetworkSchema,
				allowlistNetworkSchema,
				unrestrictedNetworkSchema,
			])
			.default({ type: "disabled" }),
		maxTotalTokens: z
			.int()
			.min(LIMITS.geminiMaxTotalTokens.min)
			.max(LIMITS.geminiMaxTotalTokens.max)
			.nullable()
			.default(null),
	},
	true
);

const ryuNodeConfigSchema = wireObject(
	{
		nodeId: z.string().regex(OPAQUE_REF_RE),
		timeoutSeconds: z
			.int()
			.min(LIMITS.ryuNodeTimeoutSeconds.min)
			.max(LIMITS.ryuNodeTimeoutSeconds.max)
			.default(60),
		// Server-set (D13). Accepted so a fetched config can be sent back, then dropped.
		runAsUserId: z.unknown().optional(),
	},
	true
).transform(
	(config): RyuNodeEnvironmentConfigInput => ({
		nodeId: config.nodeId,
		timeoutSeconds: config.timeoutSeconds,
	})
);

const ryuServerlessConfigSchema = wireObject({}, true).transform(
	(): RyuServerlessEnvironmentConfig => ({})
);

/** Closed config schema per backend, each typed by its input contract. */
type EnvironmentConfigSchemaMap = {
	readonly [B in ManagedAgentBackend]: z.ZodType<
		ManagedAgentBackendConfigInputMap[B]
	>;
};

const environmentConfigSchemas: EnvironmentConfigSchemaMap = {
	anthropic: anthropicConfigSchema,
	openai: openAiConfigSchema,
	gemini: geminiConfigSchema,
	ryu_node: ryuNodeConfigSchema,
	ryu_serverless: ryuServerlessConfigSchema,
} as const;

const byokCredentialSchema = wireObject(
	{ source: z.literal("byok"), credentialId: idSchema("credential") },
	true
);
const platformCredentialSchema = wireObject(
	{ source: z.literal("platform") },
	true
);
const noneCredentialSchema = wireObject({ source: z.literal("none") }, true);
const vendorCredentialSchema = z.union([
	byokCredentialSchema,
	platformCredentialSchema,
]);
const anyCredentialSchema = z.union([
	byokCredentialSchema,
	platformCredentialSchema,
	noneCredentialSchema,
]);

const environmentCommonFields = {
	name: nameSchema,
	description: descriptionSchema.nullable().default(null),
};

const createEnvironmentSchema: z.ZodType<CreateManagedAgentEnvironmentInput> =
	z.union([
		wireObject(
			{
				...environmentCommonFields,
				backend: z.literal("anthropic"),
				credential: vendorCredentialSchema,
				config: anthropicConfigSchema.prefault({}),
			},
			true
		),
		wireObject(
			{
				...environmentCommonFields,
				backend: z.literal("openai"),
				credential: vendorCredentialSchema,
				config: openAiConfigSchema.prefault({}),
			},
			true
		),
		wireObject(
			{
				...environmentCommonFields,
				backend: z.literal("gemini"),
				credential: vendorCredentialSchema,
				config: geminiConfigSchema.prefault({}),
			},
			true
		),
		wireObject(
			{
				...environmentCommonFields,
				backend: z.literal("ryu_node"),
				credential: noneCredentialSchema.default({ source: "none" }),
				config: ryuNodeConfigSchema,
			},
			true
		),
		wireObject(
			{
				...environmentCommonFields,
				backend: z.literal("ryu_serverless"),
				credential: noneCredentialSchema.default({ source: "none" }),
				config: ryuServerlessConfigSchema.prefault({}),
			},
			true
		),
	]);

const environmentConfigPatchSchema = jsonObjectSchema.refine((config) =>
	MANAGED_AGENT_BACKENDS.some(
		(backend) => environmentConfigSchemas[backend].safeParse(config).success
	)
);

const updateEnvironmentSchema: z.ZodType<UpdateManagedAgentEnvironmentInput> =
	wireObject(
		{
			expectedRevision: z.int().min(1).optional(),
			name: nameSchema.optional(),
			description: descriptionSchema.nullable().optional(),
			credential: anyCredentialSchema.optional(),
			config: environmentConfigPatchSchema.optional(),
		},
		true
	);

const apiKeySchema = z
	.string()
	.min(LIMITS.apiKeyChars.min)
	.max(LIMITS.apiKeyChars.max)
	.refine(
		(value) => !(WHITESPACE_RE.test(value) || hasControlCharacters(value))
	);

const createCredentialSchema: z.ZodType<CreateManagedAgentCredentialInput> =
	wireObject(
		{
			provider: z.enum(MANAGED_AGENT_VENDOR_PROVIDERS),
			label: singleLineText(LIMITS.labelChars),
			apiKey: apiKeySchema,
		},
		true
	);

const rotateCredentialSchema: z.ZodType<RotateManagedAgentCredentialInput> =
	wireObject({ apiKey: apiKeySchema }, true);

const userTextBlockSchema = wireObject(
	{ type: z.literal("text"), text: z.string().min(1) },
	true
);

const userMessageSchema = wireObject(
	{
		type: z.literal("user.message"),
		content: z
			.array(userTextBlockSchema)
			.min(1)
			.max(LIMITS.textBlocksPerMessage),
	},
	true
).refine((event) => totalTextChars(event.content) <= LIMITS.messageTextChars);

const userInterruptSchema = wireObject(
	{ type: z.literal("user.interrupt") },
	true
);

const userCustomToolResultSchema = wireObject(
	{
		type: z.literal("user.custom_tool_result"),
		toolUseId: idSchema("toolUse"),
		content: z
			.array(userTextBlockSchema)
			.max(LIMITS.textBlocksPerMessage)
			.default([]),
		isError: z.boolean().default(false),
	},
	true
).refine((event) => totalTextChars(event.content) <= LIMITS.messageTextChars);

const userToolApprovalSchema = wireObject(
	{
		type: z.literal("user.tool_approval"),
		toolUseId: idSchema("toolUse"),
		decision: z.enum(["allow", "deny"]),
		message: z
			.string()
			.max(LIMITS.approvalMessageChars)
			.nullable()
			.default(null),
	},
	true
);

const userEventSchema = z.union([
	userMessageSchema,
	userInterruptSchema,
	userCustomToolResultSchema,
	userToolApprovalSchema,
]);

function isAllowedEventMix(events: readonly ManagedAgentUserEventBody[]) {
	const [first] = events;
	if (first === undefined) {
		return false;
	}
	if (first.type === "user.interrupt") {
		return events.length === 1;
	}
	if (first.type === "user.message") {
		return events.every((event) => event.type === "user.message");
	}
	// Answers: custom tool results and tool approvals, at most one per tool use.
	const toolUseIds: string[] = [];
	for (const event of events) {
		if (
			event.type !== "user.custom_tool_result" &&
			event.type !== "user.tool_approval"
		) {
			return false;
		}
		toolUseIds.push(event.toolUseId);
	}
	return hasUniqueValues(toolUseIds);
}

const sendEventsSchema: z.ZodType<SendManagedAgentEventsInput> = wireObject(
	{
		events: z
			.array(userEventSchema)
			.min(1)
			.max(LIMITS.eventsPerRequest)
			.refine(isAllowedEventMix),
	},
	true
);

const createSessionSchema: z.ZodType<CreateManagedAgentSessionInput> =
	wireObject(
		{
			agentId: idSchema("agent"),
			agentVersion: z.int().min(1).nullable().default(null),
			environmentId: idSchema("environment"),
			title: titleSchema.nullable().default(null),
			metadata: metadataSchema.default({}),
			budget: wireObject(
				{
					maxCostMicroUsd: z
						.int()
						.min(LIMITS.sessionBudgetMicroUsd.min)
						.max(LIMITS.sessionBudgetMicroUsd.max),
				},
				true
			)
				.nullable()
				.default(null),
			initialEvents: z
				.array(userMessageSchema)
				.max(LIMITS.initialEventsPerSession)
				.default([]),
		},
		true
	);

const updateSessionSchema: z.ZodType<UpdateManagedAgentSessionInput> =
	wireObject(
		{
			title: titleSchema.nullable().optional(),
			metadata: metadataPatchSchema.optional(),
		},
		true
	);

const cancelSessionSchema: z.ZodType<CancelManagedAgentSessionInput> =
	wireObject(
		{
			reason: z
				.string()
				.max(CANCEL_REASON_CHARS)
				.refine((value) => !hasControlCharacters(value))
				.nullable()
				.optional(),
		},
		true
	).transform(
		(input): CancelManagedAgentSessionInput => ({
			reason: input.reason ?? null,
		})
	);

/** POST /agents body. */
export const parseCreateManagedAgentInput = createAgentSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** PATCH /agents/{agentId} body. */
export const parseUpdateManagedAgentInput = updateAgentSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** POST /environments body, with the backend's config defaults filled. */
export const parseCreateManagedAgentEnvironmentInput = createEnvironmentSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** PATCH /environments/{environmentId} body. `backend` is immutable, so sending it fails. */
export const parseUpdateManagedAgentEnvironmentInput = updateEnvironmentSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** Closed per-backend config parser with defaults filled; the PATCH path uses the stored backend. */
export function parseManagedAgentEnvironmentConfig<
	B extends ManagedAgentBackend,
>(
	backend: B,
	value: Parameters<typeof anthropicConfigSchema.safeParse>[0]
): ManagedAgentBackendConfigInputMap[B] | undefined {
	const parsed = environmentConfigSchemas[backend].safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** POST /credentials body. */
export const parseCreateManagedAgentCredentialInput = createCredentialSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** PUT /credentials/{credentialId}/key body. */
export const parseRotateManagedAgentCredentialInput = rotateCredentialSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** POST /sessions body. */
export const parseCreateManagedAgentSessionInput = createSessionSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** PATCH /sessions/{sessionId} body. */
export const parseUpdateManagedAgentSessionInput = updateSessionSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** POST /sessions/{sessionId}/events body, including the allowed event mixes. */
export const parseSendManagedAgentEventsInput = sendEventsSchema
	.or(z.undefined())
	.catch(undefined).parse;

/** POST /sessions/{sessionId}/cancel body. Send `{}` for an empty body. */
export const parseCancelManagedAgentSessionInput = cancelSessionSchema
	.or(z.undefined())
	.catch(undefined).parse;

// ---------------------------------------------------------------------------------------------
// Closed event body schema (server side, before append)
// ---------------------------------------------------------------------------------------------

const nonNegativeInt = z.int().min(0);
const finiteNumber = z.number().refine(Number.isFinite);

const usageTotalsSchema = wireObject(
	{
		inputTokens: nonNegativeInt,
		outputTokens: nonNegativeInt,
		cacheReadInputTokens: nonNegativeInt,
		cacheWriteInputTokens: nonNegativeInt,
		reasoningTokens: nonNegativeInt,
		webSearchRequests: nonNegativeInt,
		activeSeconds: finiteNumber.min(0),
		listCostMicroUsd: nonNegativeInt.nullable(),
	},
	true
);

/** Deltas are differences of vendor-reported totals, so their sign is not constrained. */
const usageDeltaSchema = wireObject(
	{
		inputTokens: z.int(),
		outputTokens: z.int(),
		cacheReadInputTokens: z.int(),
		cacheWriteInputTokens: z.int(),
		reasoningTokens: z.int(),
		webSearchRequests: z.int(),
		activeSeconds: finiteNumber,
		listCostMicroUsd: z.int().nullable(),
	},
	true
);

const agentTextBlockSchema = wireObject(
	{ type: z.literal("text"), text: z.string() },
	true
);

const agentMessageBodySchema = wireObject(
	{
		type: z.literal("agent.message"),
		content: z.array(
			z.union([
				agentTextBlockSchema,
				wireObject({ type: z.literal("redacted") }, true),
			])
		),
	},
	true
).refine(
	(event) =>
		totalTextChars(
			event.content.flatMap((block) => (block.type === "text" ? [block] : []))
		) <= LIMITS.agentMessageTextChars
);

const agentToolUseBodySchema = wireObject(
	{
		type: z.literal("agent.tool_use"),
		toolUseId: idSchema("toolUse"),
		name: z.string().min(1).max(TOOL_NAME_CHARS),
		input: jsonObjectSchema.refine((input) =>
			fitsBytes(input, LIMITS.toolInputBytes)
		),
		inputTruncated: z.boolean(),
		source: z.enum(["builtin", "mcp"]),
		server: z.string().min(1).max(64).nullable(),
	},
	true
).refine((event) => (event.source === "mcp") === (event.server !== null));

const agentToolResultBodySchema = wireObject(
	{
		type: z.literal("agent.tool_result"),
		toolUseId: idSchema("toolUse"),
		content: z
			.array(
				wireObject(
					{
						type: z.literal("text"),
						text: z.string().max(LIMITS.agentToolResultBlockChars),
					},
					true
				)
			)
			.max(LIMITS.agentToolResultBlocks),
		isError: z.boolean(),
		truncated: z.boolean(),
	},
	true
);

const agentCustomToolUseBodySchema = wireObject(
	{
		type: z.literal("agent.custom_tool_use"),
		toolUseId: idSchema("toolUse"),
		name: z.string().min(1).max(TOOL_NAME_CHARS),
		input: jsonObjectSchema.refine((input) =>
			fitsBytes(input, LIMITS.eventBytes)
		),
	},
	true
);

const agentToolApprovalRequestBodySchema = wireObject(
	{
		type: z.literal("agent.tool_approval_request"),
		toolUseId: idSchema("toolUse"),
		name: z.string().min(1).max(TOOL_NAME_CHARS),
		source: z.enum(["builtin", "mcp"]),
		server: z.string().min(1).max(64).nullable(),
		expiresAt: z.iso.datetime(),
	},
	true
).refine((event) => (event.source === "mcp") === (event.server !== null));

const sessionStatusBodySchema = wireObject(
	{
		type: z.literal("session.status"),
		status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
		stopReason: z.enum(MANAGED_AGENT_STOP_REASONS).nullable(),
		pendingToolUseIds: z.array(idSchema("toolUse")),
		detail: z.enum(MANAGED_AGENT_STATUS_DETAILS).nullable(),
		inputSeq: z.int().min(1).nullable(),
	},
	true
);

const sessionErrorBodySchema = wireObject(
	{
		type: z.literal("session.error"),
		code: z.enum(MANAGED_AGENT_SESSION_ERROR_CODES),
		message: z.string().max(1024),
		retryable: z.boolean(),
		source: z.enum(["ryu", "vendor", "node"]),
		details: wireObject(
			{
				vendorCode: z.string().max(128).optional(),
				vendorRequestId: z.string().max(256).optional(),
				mcpServer: z.string().max(64).optional(),
				eventSeq: z.int().min(1).optional(),
				refusalCategory: z.string().max(128).optional(),
			},
			true
		),
	},
	true
);

const sessionUsageBodySchema = wireObject(
	{
		type: z.literal("session.usage"),
		cumulative: usageTotalsSchema,
		delta: usageDeltaSchema,
		billing: wireObject(
			{
				mode: z.enum(["platform", "byok", "none"]),
				amountMicroUsd: nonNegativeInt,
			},
			true
		),
	},
	true
);

/**
 * Closed schema for an event body (payload without the envelope) that the server is about to
 * append. Unknown keys and out-of-contract values fail. The reserved `agent.message.delta` is
 * rejected because v1 never persists it.
 */
export const managedAgentEventBodySchema: z.ZodType<ManagedAgentEventBody> =
	z.union([
		userMessageSchema,
		userInterruptSchema,
		userCustomToolResultSchema,
		userToolApprovalSchema,
		agentMessageBodySchema,
		agentToolUseBodySchema,
		agentToolResultBodySchema,
		agentCustomToolUseBodySchema,
		agentToolApprovalRequestBodySchema,
		sessionStatusBodySchema,
		sessionErrorBodySchema,
		sessionUsageBodySchema,
	]);

// ---------------------------------------------------------------------------------------------
// Tolerant response parsers: validate declared fields, return the raw value
// ---------------------------------------------------------------------------------------------

const wireText = z.string();
const wireNullableText = wireText.nullable();
const wireCount = z.int().min(0);
const wireRecord = z.record(z.string(), z.unknown());
const wireJsonObject = z.record(z.string(), z.json());

function isUnknownTag(known: readonly string[]) {
	return wireText.refine((value) => !known.includes(value));
}

const wireToolValidation = z.union([
	z.object({
		type: z.literal("builtin"),
		name: wireText,
		allowedDomains: z.array(wireText),
		requireApproval: z.boolean().optional(),
	}),
	z.object({
		type: z.literal("custom"),
		name: wireText,
		description: wireText,
		inputSchema: wireJsonObject,
	}),
	z.object({ type: isUnknownTag(["builtin", "custom"]) }),
]);

const wireMcpServerValidation = z.object({
	name: wireText,
	url: wireText,
	allowedTools: z.array(wireText).nullable(),
	requireApproval: z.boolean().optional(),
});

const wireAgentConfigFields = {
	name: wireText,
	description: wireNullableText,
	model: wireNullableText,
	instructions: wireNullableText,
	tools: z.array(wireToolValidation),
	mcpServers: z.array(wireMcpServerValidation),
	reasoningEffort: wireNullableText,
	metadata: z.record(z.string(), z.string()),
	createdAt: wireText,
};

const wireAgentValidation = z.object({
	...wireAgentConfigFields,
	id: wireText,
	version: z.int().min(1),
	archivedAt: wireNullableText,
	updatedAt: wireText,
});

const wireAgentVersionValidation = z.object({
	...wireAgentConfigFields,
	agentId: wireText,
	version: z.int().min(1),
});

const wireCredentialRefValidation = z.union([
	z.object({ source: z.literal("byok"), credentialId: wireText }),
	z.object({ source: isUnknownTag(["byok"]) }),
]);

const wireEnvironmentValidation = z.object({
	id: wireText,
	name: wireText,
	description: wireNullableText,
	backend: wireText,
	credential: wireCredentialRefValidation,
	config: wireRecord,
	revision: z.int().min(1),
	archivedAt: wireNullableText,
	createdAt: wireText,
	updatedAt: wireText,
});

const wireCredentialValidation = z.object({
	id: wireText,
	provider: wireText,
	label: wireText,
	keyHint: wireText,
	fingerprint: wireText,
	createdAt: wireText,
	updatedAt: wireText,
	revokedAt: wireNullableText,
});

const wireUsageValidation = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadInputTokens: z.number(),
	cacheWriteInputTokens: z.number(),
	reasoningTokens: z.number(),
	webSearchRequests: z.number(),
	activeSeconds: z.number(),
	listCostMicroUsd: z.number().nullable(),
});

const wireSessionValidation = z.object({
	id: wireText,
	agentId: wireText,
	agentVersion: z.int().min(1),
	environmentId: wireText,
	environmentRevision: z.int().min(1),
	backend: wireText,
	title: wireNullableText,
	metadata: z.record(z.string(), z.string()),
	status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
	stopReason: wireNullableText,
	pendingToolUseIds: z.array(wireText),
	lastError: z.object({ code: wireText, message: wireText }).nullable(),
	headSeq: wireCount,
	usage: wireUsageValidation,
	billedMicroUsd: z.number(),
	budget: z.object({ maxCostMicroUsd: z.number() }).nullable(),
	closing: z
		.object({
			target: z.enum(["canceled", "completed"]),
			requestedAt: wireText,
		})
		.nullable(),
	createdAt: wireText,
	updatedAt: wireText,
	startedAt: wireNullableText,
	endedAt: wireNullableText,
});

const wireContentBlockValidation = z.union([
	z.object({ type: z.literal("text"), text: wireText }),
	z.object({ type: isUnknownTag(["text"]) }),
]);
const wireContentValidation = z.array(wireContentBlockValidation);

const wireEnvelopeValidation = z.object({
	id: wireText,
	sessionId: wireText,
	seq: z.int().min(1),
	createdAt: wireText,
	type: wireText,
});

const wireKnownBodyValidation = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user.message"), content: wireContentValidation }),
	z.object({ type: z.literal("user.interrupt") }),
	z.object({
		type: z.literal("user.custom_tool_result"),
		toolUseId: wireText,
		content: wireContentValidation,
		isError: z.boolean(),
	}),
	z.object({
		type: z.literal("agent.message"),
		content: wireContentValidation,
	}),
	z.object({
		type: z.literal("agent.message.delta"),
		messageKey: wireText,
		index: wireCount,
		text: wireText,
	}),
	z.object({
		type: z.literal("agent.tool_use"),
		toolUseId: wireText,
		name: wireText,
		input: wireJsonObject,
		inputTruncated: z.boolean(),
		source: wireText,
		server: wireNullableText,
	}),
	z.object({
		type: z.literal("agent.tool_result"),
		toolUseId: wireText,
		content: wireContentValidation,
		isError: z.boolean(),
		truncated: z.boolean(),
	}),
	z.object({
		type: z.literal("agent.custom_tool_use"),
		toolUseId: wireText,
		name: wireText,
		input: wireJsonObject,
	}),
	z.object({
		type: z.literal("agent.tool_approval_request"),
		toolUseId: wireText,
		name: wireText,
		source: wireText,
		server: wireNullableText,
		expiresAt: wireText,
	}),
	z.object({
		type: z.literal("user.tool_approval"),
		toolUseId: wireText,
		decision: wireText,
		message: wireNullableText,
	}),
	z.object({
		type: z.literal("session.status"),
		status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
		stopReason: wireNullableText,
		pendingToolUseIds: z.array(wireText),
		detail: wireNullableText,
		inputSeq: z.int().min(1).nullish(),
	}),
	z.object({
		type: z.literal("session.error"),
		code: wireText,
		message: wireText,
		retryable: z.boolean(),
		source: wireText,
		details: wireRecord,
	}),
	z.object({
		type: z.literal("session.usage"),
		cumulative: wireUsageValidation,
		delta: wireUsageValidation,
		billing: z.object({ mode: wireText, amountMicroUsd: z.number() }),
	}),
]);

const wireKnownEventSchema = z.custom<ManagedAgentEvent>(
	(value) =>
		wireEnvelopeValidation.safeParse(value).success &&
		wireKnownBodyValidation.safeParse(value).success
);
const wireUnknownEventSchema = z.custom<ManagedAgentRawUnknownEvent>(
	(value) => {
		const envelope = wireEnvelopeValidation.safeParse(value);
		return (
			envelope.success &&
			!isManagedAgentEventType(envelope.data.type) &&
			wireJsonObject.safeParse(value).success
		);
	}
);
/** A list entry: a valid known event, or an unknown type with a valid envelope and JSON fields. */
const wireEventSchema = z.union([wireKnownEventSchema, wireUnknownEventSchema]);

const wireEventListValidation = z.object({
	data: z.array(wireEventSchema),
	hasMore: z.boolean(),
	nextAfter: wireCount,
	headSeq: wireCount,
});

const wireErrorBodyValidation = z.object({
	error: z.object({
		code: wireText,
		message: wireText,
		requestId: wireText,
		details: wireJsonObject.optional(),
	}),
});

const wireStreamEndValidation = z.object({
	sessionId: wireText,
	status: z.enum(MANAGED_AGENT_SESSION_STATUSES),
	headSeq: wireCount,
	reason: wireText,
});

const wireListValidation = z.object({
	data: z.array(z.unknown()),
	nextCursor: wireNullableText,
});

export const managedAgentSchema = z.custom<ManagedAgent>(
	(value) => wireAgentValidation.safeParse(value).success
);
export const managedAgentVersionSchema = z.custom<ManagedAgentVersion>(
	(value) => wireAgentVersionValidation.safeParse(value).success
);
export const managedAgentEnvironmentSchema = z.custom<ManagedAgentEnvironment>(
	(value) => wireEnvironmentValidation.safeParse(value).success
);
export const managedAgentCredentialSchema = z.custom<ManagedAgentCredential>(
	(value) => wireCredentialValidation.safeParse(value).success
);
export const managedAgentSessionSchema = z.custom<ManagedAgentSession>(
	(value) => wireSessionValidation.safeParse(value).success
);
export const managedAgentEventListSchema = z.custom<ManagedAgentEventList>(
	(value) => wireEventListValidation.safeParse(value).success
);
export const managedAgentsErrorBodySchema = z.custom<ManagedAgentsErrorBody>(
	(value) => wireErrorBodyValidation.safeParse(value).success
);

export const parseManagedAgent = managedAgentSchema
	.or(z.undefined())
	.catch(undefined).parse;
export const parseManagedAgentVersion = managedAgentVersionSchema
	.or(z.undefined())
	.catch(undefined).parse;
export const parseManagedAgentEnvironment = managedAgentEnvironmentSchema
	.or(z.undefined())
	.catch(undefined).parse;
export const parseManagedAgentCredential = managedAgentCredentialSchema
	.or(z.undefined())
	.catch(undefined).parse;
export const parseManagedAgentSession = managedAgentSessionSchema
	.or(z.undefined())
	.catch(undefined).parse;
/** The raw list; `data` may hold event types this version does not know (see parseManagedAgentEvent). */
export const parseManagedAgentEventList = managedAgentEventListSchema
	.or(z.undefined())
	.catch(undefined).parse;
/** The §4.1 error envelope. An unknown `code` is accepted; branch on the HTTP status for it. */
export const parseManagedAgentsErrorBody = managedAgentsErrorBodySchema
	.or(z.undefined())
	.catch(undefined).parse;
/** The SSE end frame's data. A future `reason` is accepted; stop reading either way. */
export const parseManagedAgentStreamEnd = z
	.custom<ManagedAgentStreamEnd>(
		(value) => wireStreamEndValidation.safeParse(value).success
	)
	.or(z.undefined())
	.catch(undefined).parse;

/**
 * Parse one event. A known type with a valid body returns `{...raw, known: true}`; an unknown
 * type with a valid envelope and JSON fields returns `{...raw, known: false}`; anything else
 * returns undefined.
 */
export function parseManagedAgentEvent(
	value: Parameters<typeof wireKnownEventSchema.safeParse>[0]
): ManagedAgentParsedEvent | undefined {
	const known = wireKnownEventSchema.safeParse(value);
	if (known.success) {
		return { ...known.data, known: true };
	}
	const unknown = wireUnknownEventSchema.safeParse(value);
	if (unknown.success) {
		return { ...unknown.data, known: false };
	}
	return undefined;
}

/**
 * Parse a collection page (`{data, nextCursor}`) with an item parser such as parseManagedAgent.
 * Every item must parse; the page keeps its raw fields.
 */
export function parseManagedAgentsList<T>(
	value: Parameters<typeof wireListValidation.safeParse>[0],
	parseItem: (
		item: Parameters<typeof managedAgentSchema.parse>[0]
	) => T | undefined
): ManagedAgentsList<T> | undefined {
	const page = wireListValidation.safeParse(value);
	if (!page.success) {
		return undefined;
	}
	const items: T[] = [];
	for (const item of page.data.data) {
		const parsed = parseItem(item);
		if (parsed === undefined) {
			return undefined;
		}
		items.push(parsed);
	}
	const raw = wireRecord.parse(value);
	return { ...raw, data: items, nextCursor: page.data.nextCursor };
}
