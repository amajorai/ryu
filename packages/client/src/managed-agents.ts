import { z } from "zod";
import { readServerSentEvents } from "./box.ts";
import {
	isKnownManagedAgentEventType,
	isTerminalManagedAgentSessionStatus,
	type MANAGED_AGENT_EVENT_TYPES,
	type MANAGED_AGENT_SESSION_STATUSES,
	type ManagedAgentUnknownEvent,
	managedAgentAnyEventSchema,
	managedAgentAppendedEventsSchema,
	managedAgentCredentialSchema,
	managedAgentEnvironmentSchema,
	managedAgentEventListSchema,
	managedAgentSchema,
	managedAgentSessionSchema,
	managedAgentStreamEndSchema,
	managedAgentsErrorBodySchema,
	managedAgentsListSchema,
	managedAgentVersionSchema,
} from "./managed-agents-contracts.ts";
import { isSafeRequestPath } from "./path-id.ts";
import type { RyuFetch } from "./types.ts";
import { wireJsonSchema } from "./wire-json.ts";

// packages/client/src/managed-agents.ts
//
// Client for the hosted Ryu Managed Agents API (`/api/v1/managed-agents` on the Ryu control
// plane): versioned agents, environments, read-only BYOK credentials, sessions, the event log
// and its resumable SSE stream. The resource and event types below are identical to the ones in
// `@ryuhq/protocol/managed-agents`; this package re-declares them so it depends only on zod.

/** The wire contract version this client implements; equal to the protocol's constant. */
export const MANAGED_AGENTS_PROTOCOL_VERSION = "ryu.managed-agents.v1";

// ---------------------------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------------------------

/** A JSON value as it travels on the wire. */
export type ManagedAgentJsonValue =
	| boolean
	| null
	| number
	| string
	| ManagedAgentJsonValue[]
	| { [key: string]: ManagedAgentJsonValue };

/** A JSON object: a tool `inputSchema`, a tool call `input`, error `details` or a config patch. */
export type ManagedAgentJsonObject = Record<string, ManagedAgentJsonValue>;

export type ManagedAgentBackend =
	| "anthropic"
	| "openai"
	| "gemini"
	| "ryu_node"
	| "ryu_serverless";
export type ManagedAgentVendorProvider = "anthropic" | "openai" | "gemini";
export type ManagedAgentReasoningEffort = "low" | "medium" | "high";
export type ManagedAgentBuiltinTool =
	| "web_search"
	| "web_fetch"
	| "code_execution"
	| "file_search";

export type ManagedAgentToolSpec =
	| {
			type: "builtin";
			name: ManagedAgentBuiltinTool;
			/** web_search and web_fetch only; otherwise []. */
			allowedDomains: string[];
			/**
			 * Ask the client before each call (`agent.tool_approval_request`). Only backends with
			 * interactive approvals (anthropic) accept true.
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
	/**
	 * A name for the server, 1 to 64 lowercase letters, digits or underscores.
	 *
	 * Unique per agent.
	 */
	name: string;
	/**
	 * Ask before each call to this server's tools
	 * (`agent.tool_approval_request`). Any agent accepts it; starting a session
	 * with this agent in an environment whose backend is not `anthropic` fails
	 * with 422 `unsupported_for_backend`.
	 */
	requireApproval?: boolean;
	/**
	 * An `https:` URL; not an IP literal or localhost.
	 *
	 * At most 2,048 characters, no userinfo.
	 */
	url: string;
}

export interface ManagedAgent {
	/** RFC 3339 UTC with milliseconds. */
	archivedAt: string | null;
	/** RFC 3339 UTC with milliseconds. */
	createdAt: string;
	/** What the agent does, for people; null when unset. */
	description: string | null;
	/** `magt_…` */
	id: string;
	/** The system instructions every session starts with; null when unset. */
	instructions: string | null;
	/** The remote MCP servers the agent may call. */
	mcpServers: ManagedAgentMcpServer[];
	/** Your own string key-value data. */
	metadata: Record<string, string>;
	/** The model id the backend runs; null for the backend's default. */
	model: string | null;
	/** The agent's name. */
	name: string;
	/**
	 * How much the model reasons before answering, where the backend supports it;
	 * null for the backend's default.
	 */
	reasoningEffort: ManagedAgentReasoningEffort | null;
	/** The built-in and custom tools the agent may call. */
	tools: ManagedAgentToolSpec[];
	/** RFC 3339 UTC with milliseconds. */
	updatedAt: string;
	/** The latest version. */
	version: number;
}

export interface ManagedAgentVersion {
	/** The agent this version belongs to (`magt_…`). */
	agentId: string;
	/** RFC 3339 UTC with milliseconds. */
	createdAt: string;
	/** What the agent does, for people; null when unset. */
	description: string | null;
	/** The system instructions every session starts with; null when unset. */
	instructions: string | null;
	/** The remote MCP servers the agent may call. */
	mcpServers: ManagedAgentMcpServer[];
	/** Your own string key-value data. */
	metadata: Record<string, string>;
	/** The model id the backend runs; null for the backend's default. */
	model: string | null;
	/** The agent's name. */
	name: string;
	/**
	 * How much the model reasons before answering, where the backend supports it;
	 * null for the backend's default.
	 */
	reasoningEffort: ManagedAgentReasoningEffort | null;
	/** The built-in and custom tools the agent may call. */
	tools: ManagedAgentToolSpec[];
	/** The version number, starting at 1 and increasing by one per update. */
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

export type RyuServerlessEnvironmentConfig = Record<string, never>;

export interface ManagedAgentBackendConfigMap {
	anthropic: AnthropicEnvironmentConfig;
	gemini: GeminiEnvironmentConfig;
	openai: OpenAiEnvironmentConfig;
	ryu_node: RyuNodeEnvironmentConfig;
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
	/** RFC 3339 UTC with milliseconds. */
	createdAt: string;
	/**
	 * The first 16 hex characters of the key's SHA-256, to tell keys apart
	 * without revealing them.
	 */
	fingerprint: string;
	/** `mcred_…` */
	id: string;
	/** The last 4 characters of the key. */
	keyHint: string;
	/** Your name for the credential. */
	label: string;
	/** The vendor the key is for. */
	provider: ManagedAgentVendorProvider;
	/** RFC 3339 UTC with milliseconds. */
	revokedAt: string | null;
	/** RFC 3339 UTC with milliseconds. */
	updatedAt: string;
}

export type ManagedAgentSessionStatus =
	(typeof MANAGED_AGENT_SESSION_STATUSES)[number];
export type ManagedAgentStopReason =
	| "end_turn"
	| "requires_action"
	| "interrupted"
	| "retries_exhausted"
	| "budget_reached"
	| "insufficient_credits"
	| "refusal"
	| "max_tokens"
	| "error";
export type ManagedAgentStatusDetail =
	| "provisioning"
	| "provisioned"
	| "rescheduling"
	| "closing";

export interface ManagedAgentUsageTotals {
	/** Seconds the backend spent running turns. */
	activeSeconds: number;
	/** Input tokens read from the prompt cache. */
	cacheReadInputTokens: number;
	/** Input tokens written to the prompt cache. */
	cacheWriteInputTokens: number;
	/**
	 * Uncached input tokens; cache reads and writes are counted separately.
	 *
	 * Counted the same way for every backend.
	 */
	inputTokens: number;
	/**
	 * The vendor's list price for this usage before markup, in micro-USD; null
	 * when unknown.
	 */
	listCostMicroUsd: number | null;
	/** Output tokens. */
	outputTokens: number;
	/** Reasoning tokens, where the backend reports them. */
	reasoningTokens: number;
	/** Built-in web searches run. */
	webSearchRequests: number;
}

export interface ManagedAgentSession {
	/** The agent the session runs (`magt_…`). */
	agentId: string;
	/** The agent version pinned at creation. */
	agentVersion: number;
	/** The environment's backend. */
	backend: ManagedAgentBackend;
	/**
	 * Platform credit debited so far, in micro-USD; 0 for your own credential
	 * (`byok`) and for nodes.
	 */
	billedMicroUsd: number;
	/**
	 * The cap on the session's cumulative list cost (`maxCostMicroUsd`,
	 * micro-USD); when it is reached the turn stops with `budget_reached`. Null
	 * for none.
	 */
	budget: { maxCostMicroUsd: number } | null;
	/**
	 * Set while a cancel or complete request is being applied: the terminal
	 * status it moves to (`target`) and when it was requested. Null otherwise.
	 */
	closing: {
		target: "canceled" | "completed";
		requestedAt: string;
	} | null;
	/** RFC 3339 UTC with milliseconds. */
	createdAt: string;
	/**
	 * RFC 3339 UTC with milliseconds.
	 *
	 * Set by the terminal transition.
	 */
	endedAt: string | null;
	/** The environment the session runs in (`menv_…`). */
	environmentId: string;
	/** The environment revision pinned at creation. */
	environmentRevision: number;
	/**
	 * The last event's `seq`. Advisory: it may lag the log briefly; the events
	 * list's `headSeq` is the live tail.
	 */
	headSeq: number;
	/** `msess_…` */
	id: string;
	/** The last error's `code` and `message`; null when none. */
	lastError: { code: string; message: string } | null;
	/** Your own string key-value data. */
	metadata: Record<string, string>;
	/** Custom tool calls waiting for your `user.custom_tool_result` event. */
	pendingToolUseIds: string[];
	/**
	 * RFC 3339 UTC with milliseconds.
	 *
	 * Set by the first transition out of `pending`.
	 */
	startedAt: string | null;
	/**
	 * `pending` until the backend is provisioned, `running` during a turn, `idle`
	 * between turns (see `stopReason`), then one of the terminal statuses
	 * `completed`, `failed` or `canceled`.
	 */
	status: ManagedAgentSessionStatus;
	/**
	 * Why the last turn ended; null after provisioning.
	 *
	 * Set when a turn ended (idle) or the session reached a terminal state.
	 */
	stopReason: ManagedAgentStopReason | null;
	/** A title to recognize the session by; null when unset. */
	title: string | null;
	/** RFC 3339 UTC with milliseconds. */
	updatedAt: string;
	/** Cumulative usage for the session. */
	usage: ManagedAgentUsageTotals;
}

// ---------------------------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------------------------

export type ManagedAgentEventType = (typeof MANAGED_AGENT_EVENT_TYPES)[number];

export interface ManagedAgentEventEnvelope {
	/**
	 * RFC 3339 UTC with milliseconds.
	 *
	 * When Ryu appended it.
	 */
	createdAt: string;
	/** `mevt_…` */
	id: string;
	/** Starts at 1, gap-free and increasing per session. */
	seq: number;
	/** The session the event belongs to (`msess_…`). */
	sessionId: string;
}

export interface TextBlock {
	/** The text content. */
	text: string;
	/** Always `text`. */
	type: "text";
}
export type AgentContentBlock = TextBlock | { type: "redacted" };

export interface ManagedAgentSessionErrorBody {
	/** Stable Ryu code. */
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
	/** At most 1,024 characters. */
	message: string;
	/** True when a later input may succeed without config changes. */
	retryable: boolean;
	source: "ryu" | "vendor" | "node";
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
 * A server-executed tool call waits for the client's decision (the call is the `agent.tool_use`
 * with the same `toolUseId`). Answer before `expiresAt` or the call is denied.
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

export interface ManagedAgentEventList {
	/** Events in `seq` order. */
	data: ManagedAgentEvent[];
	/** True when more events follow `nextAfter`. */
	hasMore: boolean;
	/** The log's tail at read time. */
	headSeq: number;
	/**
	 * Send as `after` for the next page.
	 *
	 * The last returned seq, or `after` when nothing is returned.
	 */
	nextAfter: number;
}

/** Data of the SSE `event: end` frame. It has no `id:` and is never a log event. */
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

// ---------------------------------------------------------------------------------------------
// Request types. Omitted optional fields take the server's defaults.
// ---------------------------------------------------------------------------------------------

export type ManagedAgentToolSpecInput =
	| {
			type: "builtin";
			name: ManagedAgentBuiltinTool;
			/** web_search and web_fetch only. Defaults to []. */
			allowedDomains?: string[];
			/**
			 * Ask the client before each call (`agent.tool_approval_request`). Only backends with
			 * interactive approvals (anthropic) accept true.
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

export interface ManagedAgentMcpServerInput {
	/** Defaults to `null`: every tool the server exposes. */
	allowedTools?: string[] | null;
	name: string;
	/** Ask the client before each call to this server's tools. Defaults to false. */
	requireApproval?: boolean;
	url: string;
}

/** `POST /agents`. Only `name` is required. */
export interface CreateManagedAgentInput {
	/** What the agent does, for people. */
	description?: string | null;
	/** The system instructions every session starts with. */
	instructions?: string | null;
	/** Remote MCP servers whose tools the agent may call. */
	mcpServers?: ManagedAgentMcpServerInput[];
	/** Your own string key-value data. */
	metadata?: Record<string, string>;
	/** The model id the backend runs, such as one of the provider's models. */
	model?: string | null;
	/** The agent's name. */
	name: string;
	/**
	 * How much the model reasons before answering, where the backend supports it.
	 */
	reasoningEffort?: ManagedAgentReasoningEffort | null;
	/** Builtin and custom tools the agent may call. */
	tools?: ManagedAgentToolSpecInput[];
}

/** `PATCH /agents/{agentId}`. Omitted fields keep their value; a change creates a new version. */
export interface UpdateManagedAgentInput {
	/** What the agent does, for people. */
	description?: string | null;
	/** The version you last read; a stale value gets `409 version_conflict`. */
	expectedVersion?: number;
	/** The system instructions every session starts with. */
	instructions?: string | null;
	/** Replaces the stored servers. */
	mcpServers?: ManagedAgentMcpServerInput[];
	/** Merged per key; `null` deletes the key. */
	metadata?: Record<string, string | null>;
	/** The model id the backend runs, such as one of the provider's models. */
	model?: string | null;
	/** The agent's name. */
	name?: string;
	/**
	 * How much the model reasons before answering, where the backend supports it.
	 */
	reasoningEffort?: ManagedAgentReasoningEffort | null;
	/** Replaces the stored tools. */
	tools?: ManagedAgentToolSpecInput[];
}

export interface AnthropicEnvironmentConfigInput {
	networking?:
		| {
				type: "limited";
				allowedHosts?: string[];
				allowPackageManagers?: boolean;
				allowMcpServers?: boolean;
		  }
		| { type: "unrestricted" };
	packages?: Partial<AnthropicEnvironmentConfig["packages"]>;
}

export interface OpenAiEnvironmentConfigInput {
	codeExecutionTool?: OpenAiEnvironmentConfig["codeExecutionTool"];
	container?: Partial<OpenAiEnvironmentConfig["container"]>;
	maxToolCalls?: number | null;
	mode?: "responses";
	vectorStoreIds?: string[];
}

export interface GeminiEnvironmentConfigInput {
	agent?: string;
	maxTotalTokens?: number | null;
	network?: ManagedAgentNetwork;
}

export interface RyuNodeEnvironmentConfigInput {
	nodeId: string;
	/** Ignored: the server sets it to the person who changed the target. */
	runAsUserId?: string;
	timeoutSeconds?: number;
}

type VendorEnvironmentCredential = Exclude<
	ManagedAgentEnvironmentCredential,
	{ source: "none" }
>;

interface ManagedAgentEnvironmentInputBase {
	/** What the environment is for. */
	description?: string | null;
	/** Unique among active environments. */
	name: string;
}

/** `POST /environments`. Needs a personal API key (human principals only). */
export type CreateManagedAgentEnvironmentInput =
	| (ManagedAgentEnvironmentInputBase & {
			backend: "anthropic";
			config?: AnthropicEnvironmentConfigInput;
			credential: VendorEnvironmentCredential;
	  })
	| (ManagedAgentEnvironmentInputBase & {
			backend: "openai";
			config?: OpenAiEnvironmentConfigInput;
			credential: VendorEnvironmentCredential;
	  })
	| (ManagedAgentEnvironmentInputBase & {
			backend: "gemini";
			config?: GeminiEnvironmentConfigInput;
			credential: VendorEnvironmentCredential;
	  })
	| (ManagedAgentEnvironmentInputBase & {
			backend: "ryu_node";
			config: RyuNodeEnvironmentConfigInput;
			credential?: { source: "none" };
	  })
	| (ManagedAgentEnvironmentInputBase & {
			backend: "ryu_serverless";
			config?: RyuServerlessEnvironmentConfig;
			credential?: { source: "none" };
	  });

/**
 * A replacement `config` in an environment PATCH. The server re-parses it for the stored backend
 * and fills that backend's defaults.
 */
export type ManagedAgentEnvironmentConfigPatch = ManagedAgentJsonObject;

/** `PATCH /environments/{environmentId}`. `backend` is immutable. */
export interface UpdateManagedAgentEnvironmentInput {
	/** Replaces the stored config; the backend fills its defaults. */
	config?: ManagedAgentEnvironmentConfigPatch;
	/** Whose model key new sessions use. */
	credential?: ManagedAgentEnvironmentCredential;
	/** What the environment is for. */
	description?: string | null;
	/** The revision you last read; a stale value gets `409 revision_conflict`. */
	expectedRevision?: number;
	/** Unique among active environments. */
	name?: string;
}

/** `POST /sessions`. */
export interface CreateManagedAgentSessionInput {
	/** The agent to run (`magt_…`). */
	agentId: string;
	/** Defaults to the latest version. */
	agentVersion?: number | null;
	/**
	 * An optional cap on the session's cumulative list cost, in micro-USD (at
	 * least 10,000, one cent), or null for none.
	 */
	budget?: { maxCostMicroUsd: number } | null;
	/** The environment to run it in (`menv_…`). */
	environmentId: string;
	/**
	 * Queued before the session is provisioned.
	 *
	 * 0 to 8 `user.message` events.
	 */
	initialEvents?: ManagedAgentUserMessageEventBody[];
	/** Your own string key-value data. */
	metadata?: Record<string, string>;
	/** A title to recognize the session by. */
	title?: string | null;
}

/** `PATCH /sessions/{sessionId}`. */
export interface UpdateManagedAgentSessionInput {
	/** Merged per key; `null` deletes the key. */
	metadata?: Record<string, string | null>;
	/** A new title, or null to clear it. */
	title?: string | null;
}

/** A user event to send. `content` and `isError` of a tool result default to [] and false. */
export type ManagedAgentUserEventInput =
	| ManagedAgentUserMessageEventBody
	| ManagedAgentUserInterruptEventBody
	| {
			content?: TextBlock[];
			isError?: boolean;
			toolUseId: string;
			type: "user.custom_tool_result";
	  }
	| {
			decision: "allow" | "deny";
			message?: string | null;
			toolUseId: string;
			type: "user.tool_approval";
	  };

export interface ManagedAgentsRequestOptions {
	/** `^[A-Za-z0-9_-]{16,128}$`. Retrying with the same key and body replays the first result. */
	idempotencyKey?: string;
}

export interface ManagedAgentsPageQuery {
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	/** 1 to 100; default 20. */
	limit?: number;
}

/** `agents.list` and `environments.list`. */
export interface ManagedAgentListQuery extends ManagedAgentsPageQuery {
	/** Also return archived resources. */
	includeArchived?: boolean;
}

export interface ManagedAgentCredentialListQuery
	extends ManagedAgentsPageQuery {
	/** Also return revoked credentials. */
	includeRevoked?: boolean;
}

export interface ManagedAgentSessionListQuery extends ManagedAgentsPageQuery {
	agentId?: string;
	environmentId?: string;
	status?: ManagedAgentSessionStatus;
}

export interface ManagedAgentEventListQuery {
	/** Return events with a higher seq. Default 0. */
	after?: number;
	/** 1 to 500; default 100. */
	limit?: number;
	types?: readonly ManagedAgentEventType[];
}

export interface ManagedAgentStreamOptions {
	/** Start after this seq. Default 0 (the whole log). */
	after?: number;
	/** Aborting ends the iteration without an error. */
	signal?: AbortSignal;
}

export interface ManagedAgentsClientOptions {
	/** Sent as `x-api-key`; keys never go in URLs. */
	apiKey: string;
	/** Control-plane origin, for example `https://api.ryuhq.com`. The client appends `/api/v1/managed-agents`. */
	baseUrl: string;
	fetch?: RyuFetch;
	/** Sent as `X-Ryu-Organization`. Required for personal keys; optional for organization keys. */
	organizationId?: string;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** `code` of a {@link ManagedAgentsError} built from a reply that did not carry the error envelope. */
export const MANAGED_AGENTS_UNKNOWN_ERROR_CODE = "unknown_error";

/**
 * `code` of a {@link ManagedAgentsError} for a redirect reply. The client never follows a
 * redirect, because fetch would resend `x-api-key` to the new origin; `status` is the 3xx (0 for
 * a browser's opaque redirect) and `details.location` is the target origin when it is readable.
 */
export const MANAGED_AGENTS_REDIRECT_ERROR_CODE = "redirect_refused";

export interface ManagedAgentsErrorInit {
	code: string;
	details: unknown;
	message: string;
	requestId: string | null;
	retryAfterSeconds: number | null;
	status: number;
}

/**
 * A non-2xx reply. `code` is the stable code from the error envelope; branch on it, and on
 * `status` for a code this client does not know. `code` is `"unknown_error"` when the reply did
 * not carry the envelope (for example a proxy error page).
 */
export class ManagedAgentsError extends Error {
	readonly code: string;
	readonly details: unknown;
	readonly requestId: string | null;
	/** `Retry-After`, in seconds, when the reply carried it. */
	readonly retryAfterSeconds: number | null;
	readonly status: number;

	constructor(init: ManagedAgentsErrorInit) {
		super(init.message);
		this.name = "ManagedAgentsError";
		this.code = init.code;
		this.details = init.details;
		this.requestId = init.requestId;
		this.retryAfterSeconds = init.retryAfterSeconds;
		this.status = init.status;
	}
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

const MANAGED_AGENTS_PATH = "/api/v1/managed-agents";
const TRAILING_SLASHES = /\/+$/u;
const DIGITS = /^\d+$/u;
const ERROR_TEXT_CHARS = 512;
/** The server's `retry:` value; used before reconnecting after a connection that sent nothing. */
const STREAM_RETRY_MS = 2000;
const STREAM_FAILURE_BACKOFF_MS = 250;
const STREAM_MAX_CONSECUTIVE_FAILURES = 5;

type QueryValue = boolean | number | string | undefined;

function buildQuery(params: Record<string, QueryValue>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			search.set(key, String(value));
		}
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

function segment(value: number | string): string {
	return encodeURIComponent(String(value));
}

/**
 * Refuses a path with an empty, `.` or `..` segment before any request: an id
 * like that resolves onto another route (`DELETE /sessions/..` is the API
 * root). Checked in `send` so every method rejects instead of throwing. The
 * scan is the shared transport one ({@link isSafeRequestPath}), so `\`,
 * tab/CR/LF and space-padded dot segments are refused as the URL parser reads them.
 */
function assertSafePath(path: string): void {
	if (!isSafeRequestPath(path)) {
		throw new ManagedAgentsError({
			code: "invalid_id",
			details: null,
			message: `Ryu Managed Agents: a path id must be a non-empty id other than "." or "..".`,
			requestId: null,
			retryAfterSeconds: null,
			status: 0,
		});
	}
}

function parseJsonText(text: string): z.core.util.JSONType | undefined {
	try {
		return wireJsonSchema.parse(JSON.parse(text));
	} catch {
		return undefined;
	}
}

function parseRetryAfter(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (DIGITS.test(trimmed)) {
		return Number(trimmed);
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) {
		return null;
	}
	return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function errorFromResponse(
	response: Response,
	method: string,
	path: string
): Promise<ManagedAgentsError> {
	const text = await response.text().catch(() => "");
	const retryAfterSeconds = parseRetryAfter(
		response.headers.get("Retry-After")
	);
	const envelope = managedAgentsErrorBodySchema.safeParse(parseJsonText(text));
	if (envelope.success) {
		const { error } = envelope.data;
		return new ManagedAgentsError({
			code: error.code,
			details: error.details ?? null,
			message: error.message,
			requestId: error.requestId,
			retryAfterSeconds,
			status: response.status,
		});
	}
	const excerpt = text.trim().slice(0, ERROR_TEXT_CHARS);
	return new ManagedAgentsError({
		code: MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
		details: null,
		message: `Ryu Managed Agents: ${method} ${path} failed (${response.status})${excerpt ? `: ${excerpt}` : ""}`,
		requestId: response.headers.get("X-Request-ID"),
		retryAfterSeconds,
		status: response.status,
	});
}

function isRedirect(response: Response): boolean {
	return (
		response.type === "opaqueredirect" ||
		(response.status >= 300 && response.status < 400)
	);
}

/** The origin of a `Location` header, never its path or query, which can carry login state. */
function redirectOrigin(location: string | null, url: string): string | null {
	if (location === null) {
		return null;
	}
	try {
		return new URL(location, url).origin;
	} catch {
		return null;
	}
}

async function redirectError(
	response: Response,
	method: string,
	path: string,
	url: string
): Promise<ManagedAgentsError> {
	await response.body?.cancel().catch(() => undefined);
	return new ManagedAgentsError({
		code: MANAGED_AGENTS_REDIRECT_ERROR_CODE,
		details: {
			location: redirectOrigin(response.headers.get("Location"), url),
		},
		message: `Ryu Managed Agents: ${method} ${path} was redirected (${response.status}); the client does not follow redirects, so check baseUrl`,
		requestId: response.headers.get("X-Request-ID"),
		retryAfterSeconds: null,
		status: response.status,
	});
}

interface SendInit {
	accept: string;
	body?: string;
	idempotencyKey?: string;
	lastEventId?: string;
	signal?: AbortSignal;
}

/** Shared HTTP layer: base URL, `x-api-key`, organization header and the error envelope. */
export class ManagedAgentsTransport {
	private readonly options: ManagedAgentsClientOptions;

	constructor(options: ManagedAgentsClientOptions) {
		this.options = options;
	}

	async send(method: string, path: string, init: SendInit): Promise<Response> {
		assertSafePath(path);
		const headers: Record<string, string> = {
			Accept: init.accept,
			"x-api-key": this.options.apiKey,
		};
		if (this.options.organizationId) {
			headers["X-Ryu-Organization"] = this.options.organizationId;
		}
		if (init.body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		if (init.idempotencyKey !== undefined) {
			headers["Idempotency-Key"] = init.idempotencyKey;
		}
		if (init.lastEventId !== undefined) {
			headers["Last-Event-ID"] = init.lastEventId;
		}
		const base = this.options.baseUrl.replace(TRAILING_SLASHES, "");
		const url = `${base}${MANAGED_AGENTS_PATH}${path}`;
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		// Never follow a redirect: fetch drops `Authorization` on a cross-origin hop but resends
		// custom headers, so following would hand `x-api-key` to whatever origin `Location` names.
		const response = await fetchImpl(url, {
			body: init.body ?? null,
			headers,
			method,
			redirect: "manual",
			signal: init.signal ?? null,
		});
		if (isRedirect(response)) {
			throw await redirectError(response, method, path, url);
		}
		if (!response.ok) {
			throw await errorFromResponse(response, method, path);
		}
		return response;
	}

	/** Sends a request and validates the JSON reply with `schema`. */
	async json<T>(
		method: string,
		path: string,
		schema: z.ZodType<T>,
		init: { body?: string; idempotencyKey?: string } = {}
	): Promise<T> {
		const response = await this.send(method, path, {
			accept: "application/json",
			...init,
		});
		const text = await response.text();
		return schema.parse(
			text ? wireJsonSchema.parse(JSON.parse(text)) : undefined
		);
	}

	/** Sends a request whose success reply has no body (`204`). */
	async empty(method: string, path: string): Promise<void> {
		const response = await this.send(method, path, {
			accept: "application/json",
		});
		await response.body?.cancel();
	}
}

function body(value: object): string {
	return JSON.stringify(value);
}

const agentListSchema = managedAgentsListSchema(managedAgentSchema);
const agentVersionListSchema = managedAgentsListSchema(
	managedAgentVersionSchema
);
const environmentListSchema = managedAgentsListSchema(
	managedAgentEnvironmentSchema
);
const credentialListSchema = managedAgentsListSchema(
	managedAgentCredentialSchema
);
const sessionListSchema = managedAgentsListSchema(managedAgentSessionSchema);

function isKnownEvent(
	entry: ManagedAgentEvent | ManagedAgentUnknownEvent
): entry is ManagedAgentEvent {
	return isKnownManagedAgentEventType(entry.type);
}

function knownEvents(
	entries: readonly (ManagedAgentEvent | ManagedAgentUnknownEvent)[]
): ManagedAgentEvent[] {
	return entries.filter(isKnownEvent);
}

function isTerminalStatusEvent(event: ManagedAgentEvent): boolean {
	return (
		event.type === "session.status" &&
		isTerminalManagedAgentSessionStatus(event.status)
	);
}

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

/** Versioned agent definitions. */
export class ManagedAgentsAgentsAPI {
	private readonly transport: ManagedAgentsTransport;

	constructor(transport: ManagedAgentsTransport) {
		this.transport = transport;
	}

	/** Creates version 1. */
	create(
		input: CreateManagedAgentInput,
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgent> {
		return this.transport.json("POST", "/agents", managedAgentSchema, {
			body: body(input),
			idempotencyKey: options.idempotencyKey,
		});
	}

	list(
		query: ManagedAgentListQuery = {}
	): Promise<ManagedAgentsList<ManagedAgent>> {
		return this.transport.json(
			"GET",
			`/agents${buildQuery({
				cursor: query.cursor,
				includeArchived: query.includeArchived,
				limit: query.limit,
			})}`,
			agentListSchema
		);
	}

	/** The latest version's fields. */
	get(agentId: string): Promise<ManagedAgent> {
		return this.transport.json(
			"GET",
			`/agents/${segment(agentId)}`,
			managedAgentSchema
		);
	}

	/** A change inserts version N+1; an unchanged config returns the latest version. */
	update(
		agentId: string,
		input: UpdateManagedAgentInput,
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgent> {
		return this.transport.json(
			"PATCH",
			`/agents/${segment(agentId)}`,
			managedAgentSchema,
			{ body: body(input), idempotencyKey: options.idempotencyKey }
		);
	}

	/** Idempotent. Existing sessions continue; new ones get 409 `agent_archived`. */
	archive(agentId: string): Promise<ManagedAgent> {
		return this.transport.json(
			"POST",
			`/agents/${segment(agentId)}/archive`,
			managedAgentSchema
		);
	}

	/** Newest version first. */
	listVersions(
		agentId: string,
		query: ManagedAgentsPageQuery = {}
	): Promise<ManagedAgentsList<ManagedAgentVersion>> {
		return this.transport.json(
			"GET",
			`/agents/${segment(agentId)}/versions${buildQuery({
				cursor: query.cursor,
				limit: query.limit,
			})}`,
			agentVersionListSchema
		);
	}

	getVersion(agentId: string, version: number): Promise<ManagedAgentVersion> {
		return this.transport.json(
			"GET",
			`/agents/${segment(agentId)}/versions/${segment(version)}`,
			managedAgentVersionSchema
		);
	}
}

/**
 * Execution environments. Writes need a personal API key (human principals only); an
 * organization key gets 403 `forbidden`.
 */
export class ManagedAgentsEnvironmentsAPI {
	private readonly transport: ManagedAgentsTransport;

	constructor(transport: ManagedAgentsTransport) {
		this.transport = transport;
	}

	create(
		input: CreateManagedAgentEnvironmentInput,
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgentEnvironment> {
		return this.transport.json(
			"POST",
			"/environments",
			managedAgentEnvironmentSchema,
			{ body: body(input), idempotencyKey: options.idempotencyKey }
		);
	}

	list(
		query: ManagedAgentListQuery = {}
	): Promise<ManagedAgentsList<ManagedAgentEnvironment>> {
		return this.transport.json(
			"GET",
			`/environments${buildQuery({
				cursor: query.cursor,
				includeArchived: query.includeArchived,
				limit: query.limit,
			})}`,
			environmentListSchema
		);
	}

	get(environmentId: string): Promise<ManagedAgentEnvironment> {
		return this.transport.json(
			"GET",
			`/environments/${segment(environmentId)}`,
			managedAgentEnvironmentSchema
		);
	}

	/** An accepted change increments `revision` and affects only new sessions. */
	update(
		environmentId: string,
		input: UpdateManagedAgentEnvironmentInput,
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgentEnvironment> {
		return this.transport.json(
			"PATCH",
			`/environments/${segment(environmentId)}`,
			managedAgentEnvironmentSchema,
			{ body: body(input), idempotencyKey: options.idempotencyKey }
		);
	}

	/** Idempotent. New sessions get 409 `environment_archived`. */
	archive(environmentId: string): Promise<ManagedAgentEnvironment> {
		return this.transport.json(
			"POST",
			`/environments/${segment(environmentId)}/archive`,
			managedAgentEnvironmentSchema
		);
	}
}

/**
 * BYOK vendor credentials, read-only. Creating, rotating and revoking a credential needs a
 * signed-in console session with a fresh step-up, so the key-based client does not expose it.
 */
export class ManagedAgentsCredentialsAPI {
	private readonly transport: ManagedAgentsTransport;

	constructor(transport: ManagedAgentsTransport) {
		this.transport = transport;
	}

	list(
		query: ManagedAgentCredentialListQuery = {}
	): Promise<ManagedAgentsList<ManagedAgentCredential>> {
		return this.transport.json(
			"GET",
			`/credentials${buildQuery({
				cursor: query.cursor,
				includeRevoked: query.includeRevoked,
				limit: query.limit,
			})}`,
			credentialListSchema
		);
	}

	get(credentialId: string): Promise<ManagedAgentCredential> {
		return this.transport.json(
			"GET",
			`/credentials/${segment(credentialId)}`,
			managedAgentCredentialSchema
		);
	}
}

type StreamOutcome =
	| { kind: "finished" }
	| { kind: "closed"; received: boolean }
	| { error: unknown; kind: "failed"; received: boolean };

interface StreamCursor {
	lastSeq: number;
}

/** Errors that a reconnect cannot fix: HTTP errors and malformed frames. */
function isStreamFatal(error: unknown): boolean {
	return (
		error instanceof ManagedAgentsError ||
		error instanceof z.ZodError ||
		error instanceof SyntaxError
	);
}

function reconnectDelayMs(outcome: StreamOutcome, failures: number): number {
	if (outcome.kind === "failed") {
		return Math.min(
			STREAM_RETRY_MS,
			STREAM_FAILURE_BACKOFF_MS * 2 ** Math.max(0, failures - 1)
		);
	}
	return outcome.kind === "closed" && outcome.received ? 0 : STREAM_RETRY_MS;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0 || signal?.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/**
 * Applies one SSE frame to the cursor. Returns the event to yield (known types only; unknown
 * types are skipped after advancing the cursor) and whether the stream is over.
 */
function readStreamFrame(
	frame: { data: z.core.util.JSONType; event: string; id: string | null },
	cursor: StreamCursor
): { event: ManagedAgentEvent | null; stop: boolean } {
	if (frame.event === "end") {
		managedAgentStreamEndSchema.parse(frame.data);
		return { event: null, stop: true };
	}
	if (frame.id === null) {
		// Every log event carries `id:`; an id-less frame is a control frame from a newer server.
		return { event: null, stop: false };
	}
	const entry = managedAgentAnyEventSchema.parse(frame.data);
	if (entry.seq <= cursor.lastSeq) {
		// At-least-once delivery across a reconnect: dedupe on seq.
		return { event: null, stop: false };
	}
	cursor.lastSeq = entry.seq;
	if (!isKnownEvent(entry)) {
		return { event: null, stop: false };
	}
	return { event: entry, stop: isTerminalStatusEvent(entry) };
}

/** Sessions, their event log and its resumable stream. */
export class ManagedAgentsSessionsAPI {
	private readonly transport: ManagedAgentsTransport;

	constructor(transport: ManagedAgentsTransport) {
		this.transport = transport;
	}

	/** Starts a session of a pinned agent version in an environment; it begins `pending`. */
	create(
		input: CreateManagedAgentSessionInput,
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgentSession> {
		return this.transport.json("POST", "/sessions", managedAgentSessionSchema, {
			body: body(input),
			idempotencyKey: options.idempotencyKey,
		});
	}

	list(
		query: ManagedAgentSessionListQuery = {}
	): Promise<ManagedAgentsList<ManagedAgentSession>> {
		return this.transport.json(
			"GET",
			`/sessions${buildQuery({
				agentId: query.agentId,
				cursor: query.cursor,
				environmentId: query.environmentId,
				limit: query.limit,
				status: query.status,
			})}`,
			sessionListSchema
		);
	}

	get(sessionId: string): Promise<ManagedAgentSession> {
		return this.transport.json(
			"GET",
			`/sessions/${segment(sessionId)}`,
			managedAgentSessionSchema
		);
	}

	/** Ryu-only title and metadata; nothing is sent to the vendor. */
	update(
		sessionId: string,
		input: UpdateManagedAgentSessionInput
	): Promise<ManagedAgentSession> {
		return this.transport.json(
			"PATCH",
			`/sessions/${segment(sessionId)}`,
			managedAgentSessionSchema,
			{ body: body(input) }
		);
	}

	/**
	 * Appends 1 to 8 user events: `user.message` events, one `user.interrupt`, or answers
	 * (`user.custom_tool_result` and `user.tool_approval` events) with distinct `toolUseId`s. Without an `idempotencyKey`
	 * a retried call can append a duplicate message. Resolves to the appended events.
	 */
	async send(
		sessionId: string,
		events: readonly ManagedAgentUserEventInput[],
		options: ManagedAgentsRequestOptions = {}
	): Promise<ManagedAgentEvent[]> {
		const reply = await this.transport.json(
			"POST",
			`/sessions/${segment(sessionId)}/events`,
			managedAgentAppendedEventsSchema,
			{ body: body({ events }), idempotencyKey: options.idempotencyKey }
		);
		return knownEvents(reply.data);
	}

	/**
	 * Answer an `agent.tool_approval_request`: `allow` runs the call, `deny` refuses it and shows
	 * `message` to the model. Resolves to the appended `user.tool_approval` event.
	 */
	async respondToApproval(
		sessionId: string,
		toolUseId: string,
		decision: "allow" | "deny",
		options: ManagedAgentsRequestOptions & { message?: string } = {}
	): Promise<ManagedAgentEvent | undefined> {
		const [appended] = await this.send(
			sessionId,
			[
				{
					type: "user.tool_approval",
					toolUseId,
					decision,
					message: options.message ?? null,
				},
			],
			{ idempotencyKey: options.idempotencyKey }
		);
		return appended;
	}

	/**
	 * One page of the event log after `after`. Event types newer than this client are removed
	 * from `data`; `nextAfter`, `hasMore` and `headSeq` still describe the whole page.
	 */
	async events(
		sessionId: string,
		query: ManagedAgentEventListQuery = {}
	): Promise<ManagedAgentEventList> {
		const page = await this.transport.json(
			"GET",
			`/sessions/${segment(sessionId)}/events${buildQuery({
				after: query.after,
				limit: query.limit,
				types: query.types?.join(","),
			})}`,
			managedAgentEventListSchema
		);
		return { ...page, data: knownEvents(page.data) };
	}

	/**
	 * Replays the log after `after`, then tails it. A dropped connection is resumed with
	 * `Last-Event-ID` set to the last seq received, and replayed events are deduplicated on seq.
	 * The iteration ends at the server's `end` frame, after a terminal `session.status`, or when
	 * `signal` aborts. HTTP errors (including on a reconnect) throw {@link ManagedAgentsError}.
	 */
	async *stream(
		sessionId: string,
		options: ManagedAgentStreamOptions = {}
	): AsyncGenerator<ManagedAgentEvent> {
		const { signal } = options;
		const cursor: StreamCursor = { lastSeq: options.after ?? 0 };
		const path = `/sessions/${segment(sessionId)}/stream${buildQuery({
			after: options.after,
		})}`;
		let failures = 0;
		let reconnect = false;
		while (!signal?.aborted) {
			const outcome = yield* this.streamConnection(
				path,
				cursor,
				reconnect,
				signal
			);
			if (outcome.kind === "finished") {
				return;
			}
			if (outcome.received) {
				failures = 0;
			}
			if (outcome.kind === "failed") {
				failures += 1;
				if (failures > STREAM_MAX_CONSECUTIVE_FAILURES) {
					throw outcome.error;
				}
			}
			reconnect = true;
			await delay(reconnectDelayMs(outcome, failures), signal);
		}
	}

	/** Requests cancellation. A pending session is not provisioned any further. */
	cancel(sessionId: string, reason?: string): Promise<ManagedAgentSession> {
		return this.transport.json(
			"POST",
			`/sessions/${segment(sessionId)}/cancel`,
			managedAgentSessionSchema,
			{ body: body(reason === undefined ? {} : { reason }) }
		);
	}

	/** Closes an `idle` session as `completed`. From `pending` or `running` it is a 409 `session_running`. */
	complete(sessionId: string): Promise<ManagedAgentSession> {
		return this.transport.json(
			"POST",
			`/sessions/${segment(sessionId)}/complete`,
			managedAgentSessionSchema
		);
	}

	/** Deletes a terminal session and its log. A live session is a 409 `session_not_terminal`. */
	delete(sessionId: string): Promise<void> {
		return this.transport.empty("DELETE", `/sessions/${segment(sessionId)}`);
	}

	private async *streamConnection(
		path: string,
		cursor: StreamCursor,
		reconnect: boolean,
		signal: AbortSignal | undefined
	): AsyncGenerator<ManagedAgentEvent, StreamOutcome> {
		let received = false;
		try {
			const response = await this.transport.send("GET", path, {
				accept: "text/event-stream",
				lastEventId: reconnect ? String(cursor.lastSeq) : undefined,
				signal,
			});
			const contentType = response.headers.get("Content-Type") ?? "";
			if (!(response.body && contentType.startsWith("text/event-stream"))) {
				await response.body?.cancel();
				throw new ManagedAgentsError({
					code: MANAGED_AGENTS_UNKNOWN_ERROR_CODE,
					details: null,
					message: `Ryu Managed Agents: GET ${path} did not return an event stream (${contentType || "no content type"})`,
					requestId: response.headers.get("X-Request-ID"),
					retryAfterSeconds: null,
					status: response.status,
				});
			}
			for await (const frame of readServerSentEvents(response.body)) {
				received = true;
				const step = readStreamFrame(frame, cursor);
				if (step.event) {
					yield step.event;
				}
				if (step.stop) {
					return { kind: "finished" };
				}
			}
			return { kind: "closed", received };
		} catch (error) {
			if (signal?.aborted) {
				return { kind: "finished" };
			}
			if (isStreamFatal(error)) {
				throw error;
			}
			return { error, kind: "failed", received };
		}
	}
}

/** The Ryu Managed Agents API. Create one with {@link createManagedAgentsClient}. */
export class ManagedAgentsAPI {
	readonly agents: ManagedAgentsAgentsAPI;
	readonly credentials: ManagedAgentsCredentialsAPI;
	readonly environments: ManagedAgentsEnvironmentsAPI;
	readonly sessions: ManagedAgentsSessionsAPI;

	constructor(options: ManagedAgentsClientOptions) {
		const transport = new ManagedAgentsTransport(options);
		this.agents = new ManagedAgentsAgentsAPI(transport);
		this.credentials = new ManagedAgentsCredentialsAPI(transport);
		this.environments = new ManagedAgentsEnvironmentsAPI(transport);
		this.sessions = new ManagedAgentsSessionsAPI(transport);
	}
}

export function createManagedAgentsClient(
	options: ManagedAgentsClientOptions
): ManagedAgentsAPI {
	return new ManagedAgentsAPI(options);
}
