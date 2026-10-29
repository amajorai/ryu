// packages/services/src/connect/client.ts
//
// The Ryu Connect runtime thin client: Skills, governed tool search and
// execution, native Composio execution, and the usage report. Every call uses
// the tenant's runtime bearer (`RYU_CONNECT_API_KEY`). Auth, timeouts,
// retries and typed errors come from the service fetch shim:
//
// - Connect has no idempotent routes, so no request carries an
//   `Idempotency-Key`, and `tools.exec` / `composio.execute` are never
//   retried on a network error or 5xx: the tool may already have run;
// - Connect errors are `{ code, error?, ok: false, retryAfterSeconds? }`
//   (or a bare `{ code }`), with the request id in `x-request-id`.
//
// The management routes (account linking, triggers) are not in v1; the
// `managementKey` option is reserved for them.

import type { RyuFetch } from "@ryuhq/client";
import { z } from "zod";
import {
	pathSegment,
	requestJson,
	requireUsageWindow,
} from "../transport/request.ts";

// --- Wire types ---------------------------------------------------------------

/** A JSON object Connect passes through unchanged (tool arguments, results, receipts). */
export type ConnectJsonObject = Record<string, unknown>;

/** One hosted Skill in the catalog. */
export interface ConnectSkillSummary {
	description: string;
	id: string;
	name: string;
}

/** `GET /v1/skills`. */
export interface ConnectSkillList {
	data: ConnectSkillSummary[];
	object: "list";
}

/** `GET /v1/skills/{id}`: one Skill with its `SKILL.md` instructions. */
export interface ConnectSkill extends ConnectSkillSummary {
	instructions: string;
}

/** `tools.search()` filters. */
export interface ConnectToolSearchQuery {
	/** `mcp` or `composio` lists one lane; default `any`. */
	kind?: "any" | "mcp" | "composio";
	/** 1-25, default 8. */
	limit?: number;
	/** Case-insensitive text matched against the tool name and description. */
	q?: string;
}

/** One tool in a search result. */
export interface ConnectToolSummary {
	description: string;
	/** The qualified id to pass to `describe` and `exec` (`workspace.search`, `composio.SLACK_SEND_MESSAGE`). */
	id: string;
	kind?: string;
	name: string;
	[field: string]: unknown;
}

/** `GET /v1/tools/search`. `partial: true` when some discovery lane was unavailable. */
export interface ConnectToolSearchResult {
	data: ConnectToolSummary[];
	object?: string;
	partial?: boolean;
	[field: string]: unknown;
}

/** `GET /v1/tools/describe`: one tool and its JSON Schema parameters. */
export interface ConnectToolDescription extends ConnectToolSummary {
	parameters?: unknown;
}

/** `tools.exec()` input. */
export interface ConnectToolExecInput {
	/** Tool arguments; the tool validates them. */
	arguments?: ConnectJsonObject;
	/** The qualified tool id from `tools.search()`. */
	toolId: string;
}

/**
 * `POST /v1/exec/tool`. `ok` is false when the tool reported an error, or,
 * in compatibility mode, when the Gateway refused or failed the call: it
 * answers HTTP 200 with `{ ok: false, error }` and no `result` (firewall
 * denial, exec budget, a tool call that returned an error).
 */
export interface ConnectToolExecResult {
	/** The Composio billing receipt, for `composio.*` tools that returned one. */
	billingReceipt?: ConnectJsonObject | null;
	/** Why the Gateway refused or failed the call (compatibility mode only). */
	error?: string;
	ok: boolean;
	/** The tool result: natively an MCP result (`content`, `isError`, …); absent when `error` is set. */
	result?: unknown;
	[field: string]: unknown;
}

/** `composio.execute()` input: Connect's native body, `operation: "execute"` is added. */
export interface ConnectComposioExecuteInput {
	/** Action arguments; Composio validates them for the bound toolkit version. */
	body?: ConnectJsonObject;
	/** Refuse unless the tenant's bound account is this one. */
	expectedAccountId?: string;
	/** The Composio action slug, e.g. `SLACK_SEND_MESSAGE`. */
	toolId: string;
}

/** `POST /v1/composio/execute`. */
export interface ConnectComposioExecuteResult {
	billingReceipt?: ConnectJsonObject | null;
	data: unknown;
	successful: boolean;
	[field: string]: unknown;
}

/** `usage()` query: a window of whole UTC hours, at most 31 days. */
export interface ConnectUsageQuery {
	/** The `nextCursor` of the previous page. */
	cursor?: string;
	/** Window start: an ISO 8601 time with a zone, on a whole UTC hour. */
	from: string;
	/** Lines per page, 1-1000 (default 1000). */
	limit?: number;
	/** Window end (exclusive), on a whole UTC hour. */
	to: string;
}

/** One billing receipt line. */
export interface ConnectUsageLine {
	at: string;
	transactionId: string;
	usage: ConnectJsonObject;
}

/** A receipt that can never be read; listed on the first page only. */
export interface ConnectUnresolvedReceipt {
	at: string;
	reason: string;
	transactionId: string;
}

/** `GET /v1/usage`. */
export interface ConnectUsageReport {
	from: string;
	lines: ConnectUsageLine[];
	nextCursor: string | null;
	to: string;
	unresolved: ConnectUnresolvedReceipt[];
	[field: string]: unknown;
}

/** MCP client settings for Connect's own MCP server. */
export interface ConnectMcpConfig {
	/** `Authorization: Bearer <runtime key>`. */
	headers: { Authorization: string };
	/** Streamable HTTP, as MCP client configs name it. */
	type: "http";
	/** The Connect base URL plus `/mcp`. */
	url: string;
}

// --- Decoders -----------------------------------------------------------------

const jsonObject = z.record(z.string(), z.unknown());

const skillSummarySchema = z.looseObject({
	description: z.string(),
	id: z.string(),
	name: z.string(),
});

/** Validates `GET /v1/skills`. */
export const connectSkillListSchema = z.looseObject({
	data: z.array(skillSummarySchema),
	object: z.literal("list"),
});

/** Validates `GET /v1/skills/{id}`. */
export const connectSkillSchema = skillSummarySchema.extend({
	instructions: z.string(),
});

const toolSummarySchema = z.looseObject({
	description: z.string(),
	id: z.string(),
	kind: z.string().optional(),
	name: z.string(),
});

/** Validates `GET /v1/tools/search`. */
export const connectToolSearchSchema = z.looseObject({
	data: z.array(toolSummarySchema),
	object: z.string().optional(),
	partial: z.boolean().optional(),
});

/** Validates `GET /v1/tools/describe`. */
export const connectToolDescriptionSchema = toolSummarySchema.extend({
	parameters: z.unknown().optional(),
});

/** Validates `POST /v1/exec/tool`. */
export const connectToolExecSchema = z.looseObject({
	billingReceipt: jsonObject.nullable().optional(),
	error: z.string().optional(),
	ok: z.boolean(),
	result: z.unknown().optional(),
});

/** Validates `POST /v1/composio/execute`. */
export const connectComposioExecuteSchema = z.looseObject({
	billingReceipt: jsonObject.nullable().optional(),
	data: z.unknown(),
	successful: z.boolean(),
});

/** Validates `GET /v1/usage`. */
export const connectUsageReportSchema = z.looseObject({
	from: z.string(),
	lines: z.array(
		z.looseObject({
			at: z.string(),
			transactionId: z.string(),
			usage: jsonObject,
		})
	),
	nextCursor: z.string().nullable(),
	to: z.string(),
	unresolved: z.array(
		z.looseObject({
			at: z.string(),
			reason: z.string(),
			transactionId: z.string(),
		})
	),
});

// --- Client -------------------------------------------------------------------

/** The Connect connection one call uses. */
export interface ConnectClientConfig {
	/** The tenant's runtime bearer. */
	apiKey: string;
	baseUrl: string;
}

const TRAILING_SLASHES = /\/+$/u;

/** The Connect runtime calls; each makes exactly one request. */
export interface ConnectClient {
	composioExecute(
		input: ConnectComposioExecuteInput
	): Promise<ConnectComposioExecuteResult>;
	describeTool(toolId: string): Promise<ConnectToolDescription>;
	execTool(input: ConnectToolExecInput): Promise<ConnectToolExecResult>;
	getSkill(skillId: string): Promise<ConnectSkill>;
	listSkills(): Promise<ConnectSkillList>;
	mcp(): ConnectMcpConfig;
	searchTools(query?: ConnectToolSearchQuery): Promise<ConnectToolSearchResult>;
	usage(query: ConnectUsageQuery): Promise<ConnectUsageReport>;
}

/** Builds the Connect client over `fetch` (the call's service-scoped fetch). Does no I/O. */
export function createConnectClient(
	config: ConnectClientConfig,
	fetch: RyuFetch,
	signal?: AbortSignal
): ConnectClient {
	const headers = { authorization: `Bearer ${config.apiKey}` };
	return {
		composioExecute: (input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					body: input.body,
					expectedAccountId: input.expectedAccountId,
					operation: "execute",
					toolId: input.toolId,
				},
				decode: (value) =>
					connectComposioExecuteSchema.parse(
						value
					) as ConnectComposioExecuteResult,
				headers,
				method: "POST",
				path: "/v1/composio/execute",
				signal,
			}),
		describeTool: (toolId) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					connectToolDescriptionSchema.parse(value) as ConnectToolDescription,
				headers,
				method: "GET",
				path: "/v1/tools/describe",
				query: { id: toolId },
				signal,
			}),
		execTool: (input) =>
			requestJson(fetch, config.baseUrl, {
				body: {
					arguments: input.arguments ?? {},
					kind: "tool",
					tool_id: input.toolId,
				},
				decode: (value) =>
					connectToolExecSchema.parse(value) as ConnectToolExecResult,
				headers,
				method: "POST",
				path: "/v1/exec/tool",
				signal,
			}),
		getSkill: (skillId) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) => connectSkillSchema.parse(value) as ConnectSkill,
				headers,
				method: "GET",
				path: `/v1/skills/${pathSegment("connect", skillId, "the skill id")}`,
				signal,
			}),
		listSkills: () =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					connectSkillListSchema.parse(value) as ConnectSkillList,
				headers,
				method: "GET",
				path: "/v1/skills",
				signal,
			}),
		mcp: () => ({
			headers: { Authorization: `Bearer ${config.apiKey}` },
			type: "http",
			url: `${config.baseUrl.replace(TRAILING_SLASHES, "")}/mcp`,
		}),
		searchTools: (query = {}) =>
			requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					connectToolSearchSchema.parse(value) as ConnectToolSearchResult,
				headers,
				method: "GET",
				path: "/v1/tools/search",
				query: { kind: query.kind, limit: query.limit, q: query.q },
				signal,
			}),
		usage: (query) => {
			const window = requireUsageWindow("connect", query);
			return requestJson(fetch, config.baseUrl, {
				decode: (value) =>
					connectUsageReportSchema.parse(value) as ConnectUsageReport,
				headers,
				method: "GET",
				path: "/v1/usage",
				query: {
					cursor: window.cursor,
					from: window.from,
					limit: window.limit,
					to: window.to,
				},
				signal,
			});
		},
	};
}
