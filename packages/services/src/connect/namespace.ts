// packages/services/src/connect/namespace.ts
//
// `ryu.connect`: the Ryu Connect runtime thin client (design §2.4).
//
//   ryu.connect.skills.list() / skills.get(skillId)
//   ryu.connect.tools.search({ q }) / tools.describe({ toolId }) / tools.exec({ toolId, arguments })
//   ryu.connect.composio.execute({ toolId, body, expectedAccountId })   (native body only)
//   ryu.connect.usage({ from, to }) / usage.iterate({ from, to })
//   ryu.connect.mcp()   -> { type, url: `${baseUrl}/mcp`, headers }; no network call
//
// Bearer `RYU_CONNECT_API_KEY` (the tenant's runtime key), no default URL.
// `tools.exec` and `composio.execute` are never retried on a network error
// or 5xx, because the tool may already have run.

import type { RyuFetch } from "@ryuhq/client";
import type { ResolvedServiceConfig } from "../config.ts";
import {
	messageWithoutHint,
	type RyuError,
	withRyuErrorFields,
} from "../errors.ts";
import type { Paginated } from "../pagination.ts";
import type { RyuResult, SAFE_VIEW, Safe } from "../result.ts";
import type { CallOptions } from "../transport/fetch-shim.ts";
import type { NamespaceDefinition } from "../wrap.ts";
import {
	type ConnectComposioExecuteInput,
	type ConnectComposioExecuteResult,
	type ConnectMcpConfig,
	type ConnectSkill,
	type ConnectSkillList,
	type ConnectToolDescription,
	type ConnectToolExecInput,
	type ConnectToolExecResult,
	type ConnectToolSearchQuery,
	type ConnectToolSearchResult,
	type ConnectUsageLine,
	type ConnectUsageQuery,
	type ConnectUsageReport,
	createConnectClient,
} from "./client.ts";
import { type ConnectUsageIterateQuery, iterateUsage } from "./iterate.ts";
import { CONNECT_ROUTES } from "./routes.ts";

export type {
	ConnectComposioExecuteInput,
	ConnectComposioExecuteResult,
	ConnectMcpConfig,
	ConnectSkill,
	ConnectSkillList,
	ConnectSkillSummary,
	ConnectToolDescription,
	ConnectToolExecInput,
	ConnectToolExecResult,
	ConnectToolSearchQuery,
	ConnectToolSearchResult,
	ConnectToolSummary,
	ConnectUsageLine,
	ConnectUsageQuery,
	ConnectUsageReport,
} from "./client.ts";
export type { ConnectUsageIterateQuery } from "./iterate.ts";

/** `ryu.connect.usage`: callable for one page, plus `iterate()`. */
export interface ConnectUsage {
	/** Every line in the window across pages. Throws RyuError, also in object mode. */
	iterate(
		query: ConnectUsageIterateQuery
	): Paginated<ConnectUsageLine, ConnectUsageReport>;
	/** `GET /v1/usage`: one page of Composio billing receipts for a whole-hour window. */
	(query: ConnectUsageQuery): Promise<ConnectUsageReport>;
}

/** Every member of `ryu.connect` except the callable `usage`. */
export interface ConnectNamespaceBase {
	readonly composio: {
		/**
		 * `POST /v1/composio/execute` with `operation: "execute"`. Never
		 * retried on a 5xx: a repeat could run the action twice.
		 */
		execute(
			input: ConnectComposioExecuteInput
		): Promise<ConnectComposioExecuteResult>;
	};
	/** MCP client settings for Connect's own MCP server at `/mcp`. Makes no network call. */
	mcp(): ConnectMcpConfig;
	readonly skills: {
		/** `GET /v1/skills/{id}`. */
		get(skillId: string): Promise<ConnectSkill>;
		/** `GET /v1/skills`: the shared Skill catalog. */
		list(): Promise<ConnectSkillList>;
	};
	readonly tools: {
		/** `GET /v1/tools/describe?id=`: one granted tool and its parameters. */
		describe(input: { toolId: string }): Promise<ConnectToolDescription>;
		/**
		 * `POST /v1/exec/tool`. Never retried on a 5xx: a repeat could run the
		 * tool twice.
		 */
		exec(input: ConnectToolExecInput): Promise<ConnectToolExecResult>;
		/** `GET /v1/tools/search`: granted tools matching `q`. */
		search(query?: ConnectToolSearchQuery): Promise<ConnectToolSearchResult>;
	};
}

/**
 * The object-mode (`result: "object"`, `ryu.safe`) view of `ryu.connect`.
 * The mapped projection sees the callable `usage` only as a function and
 * would drop `usage.iterate`, so it is projected here: the call resolves to a
 * RyuResult, and `iterate()` keeps throwing RyuError, as in throw mode.
 */
export type ConnectSafeNamespace = Safe<ConnectNamespaceBase> & {
	readonly usage: Pick<ConnectUsage, "iterate"> &
		((query: ConnectUsageQuery) => Promise<RyuResult<ConnectUsageReport>>);
};

/** The methods of `ryu.connect`. */
export interface ConnectNamespace extends ConnectNamespaceBase {
	readonly usage: ConnectUsage;
	readonly [SAFE_VIEW]?: ConnectSafeNamespace;
}

/** Builds the Connect client for one call. Does no I/O. */
export function createConnectNamespace(
	config: ResolvedServiceConfig,
	fetch: RyuFetch,
	options: CallOptions = {}
): ConnectNamespace {
	const client = createConnectClient(
		{ apiKey: config.apiKey ?? "", baseUrl: config.baseUrl },
		fetch,
		options.signal
	);
	const usage: ConnectUsage = Object.assign(
		(query: ConnectUsageQuery) => client.usage(query),
		{
			iterate: (query: ConnectUsageIterateQuery) => iterateUsage(client, query),
		}
	);
	return {
		composio: { execute: (input) => client.composioExecute(input) },
		mcp: () => client.mcp(),
		skills: {
			get: (skillId) => client.getSkill(skillId),
			list: () => client.listSkills(),
		},
		tools: {
			describe: ({ toolId }) => client.describeTool(toolId),
			exec: (input) => client.execTool(input),
			search: (query) => client.searchTools(query),
		},
		usage,
	};
}

/**
 * Messages for the codes Connect answers with a bare `{ code }` body, so the
 * SDK error reads as an explanation instead of repeating the code.
 */
export const CONNECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
	connection_denied: "That Composio connection is not granted to this tenant.",
	insufficient_credits: "This organization has no Ryu credits left.",
	invalid_filters: "The tool search filters are not valid.",
	invalid_limit: "The limit is out of range.",
	invalid_skill_id: "The Skill id is not valid.",
	mcp_unconfigured: "MCP is not configured on this Connect server.",
	native_composio_unavailable:
		"Native Composio execution is not configured on this Connect server.",
	provider_unavailable: "The tool provider is unavailable right now.",
	skills_unavailable:
		"The Skill catalog is not available on this Connect server.",
	tool_denied: "That tool (or its account) is not granted to this tenant.",
	tool_unavailable: "That tool is not available on this Connect server.",
	toolkit_denied: "That toolkit is not granted to this tenant.",
	upstream_invalid:
		"The tool provider returned a response Connect could not read.",
	upstream_unconfigured:
		"The tool provider is not configured on this Connect server.",
};

/** Replaces a message that only repeats its code with the code's explanation. */
export function decorateConnectError(error: RyuError): RyuError {
	const message = CONNECT_ERROR_MESSAGES[error.code];
	return messageWithoutHint(error) === error.code && message !== undefined
		? withRyuErrorFields(error, { message })
		: error;
}

/** How the facade wraps Connect. */
export const CONNECT_NAMESPACE: NamespaceDefinition<ConnectNamespace> = {
	create: createConnectNamespace,
	decorateError: decorateConnectError,
	errors: "throw",
	routes: CONNECT_ROUTES,
	service: "connect",
	syncMethods: ["mcp"],
};
