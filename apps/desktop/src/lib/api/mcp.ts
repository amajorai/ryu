// apps/desktop/src/lib/api/mcp.ts
//
// Typed client for Core's MCP endpoints (`/api/mcp/*`). Core registers MCP
// servers from config plus a built-in Shadow provider, and exposes the tools
// they advertise. The desktop Tools page lists servers and tools, narrows the
// tool list to a single agent's allowlist, and test-calls a tool. Wire shapes
// mirror `apps/core/src/sidecar/mcp/mod.rs` (snake_case fields, no serde rename).

import type { GhostActionInput } from "@ryuhq/core-client/mcp.ts";
import { z } from "zod";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import { ghostActionToCall } from "./mcp-ghost-action.ts";
import {
	type McpJsonPayload,
	mcpJsonPayloadSchema,
} from "./mcp-json-payload.ts";

export type {
	GhostActionInput,
	GhostActionKind,
	McpCatalogCard,
	McpCatalogDetail,
	McpCatalogSource,
	McpCatalogSources,
	McpInstallResult,
	McpPackage,
	McpRemote,
	McpSearchParams,
} from "@ryuhq/core-client/mcp.ts";
export {
	fetchMcpCatalogDetail,
	installMcpServer,
	listMcpUpdates,
	type McpCatalogPage,
	type McpInstallPreview,
	type McpUpdateEntry,
	mcpInstallPreviewSchema,
	previewMcpServerInstall,
	searchMcpCatalog,
} from "./mcp-catalog.ts";
export { fetchMcpSources, selectMcpSource } from "./mcp-catalog-sources.ts";
export {
	type McpJsonPayload,
	mcpJsonPayloadSchema,
} from "./mcp-json-payload.ts";

const mcpCallResponseSchema = z.object({
	ok: z.boolean().optional(),
	output: mcpJsonPayloadSchema.optional(),
	error: z.string().optional(),
});
interface McpServerWriteBody {
	args?: string[];
	command?: string;
	description?: string | null;
	enabled?: boolean;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	name?: string;
	type?: McpTransport;
	url?: string;
}

/** A registered MCP server as Core summarizes it for the listing endpoint. */
export interface McpServer {
	args: string[];
	/** True when static credentials are stored in the server config. */
	authConfigured: boolean;
	/** True when OAuth or a conventional auth header is declared. */
	authRequired: boolean;
	authType: "env" | "header" | "oauth" | null;
	/** Whether the command is present on disk; null when it can't be determined. */
	available: boolean | null;
	command: string;
	description: string | null;
	enabled: boolean;
	envKeys: string[];
	headerNames: string[];
	name: string;
	ownerPluginId: string | null;
	ownerServerName: string | null;
	/**
	 * The id an agent's account access names (`mcp-secret:<id>`) when calling
	 * this server hands it one of your saved keys; `null` when it uses none.
	 */
	savedKeyAccount: string | null;
	/** `stdio`, Streamable HTTP, or the legacy HTTP+SSE transport. */
	transport: string | null;
	/** The configured endpoint for a remote server, if any. */
	url: string | null;
}

/** A tool advertised by a registered MCP server. */
export interface McpTool {
	description: string | null;
	/** Fully-qualified id `<server>.<tool>`, unique across servers. */
	id: string;
	inputSchema: unknown | null;
	meta?: unknown;
	name: string;
	server: string;
}

/** Transport names accepted by the desktop add-server form. */
export type McpTransport = "stdio" | "streamable-http" | "sse";

/** Outcome of a test tool call: success carries output, failure carries error. */
export interface McpCallResult {
	error?: string;
	ok: boolean;
	output?: McpJsonPayload;
}

interface ServerWire {
	args?: string[];
	auth_configured?: boolean;
	auth_required?: boolean;
	auth_type?: "env" | "header" | "oauth" | null;
	available?: boolean | null;
	command: string;
	description?: string | null;
	enabled: boolean;
	env_keys?: string[];
	header_names?: string[];
	name: string;
	owner_plugin_id?: string | null;
	owner_server_name?: string | null;
	saved_key_account?: string | null;
	transport?: string | null;
	url?: string | null;
}

interface ToolWire {
	description?: string | null;
	id: string;
	input_schema?: unknown | null;
	meta?: unknown;
	name: string;
	server: string;
}

function toServer(s: ServerWire): McpServer {
	return {
		name: s.name,
		command: s.command,
		args: s.args ?? [],
		description: s.description ?? null,
		enabled: s.enabled,
		available: s.available ?? null,
		authRequired: s.auth_required ?? false,
		authConfigured: s.auth_configured ?? false,
		authType: s.auth_type ?? null,
		transport: s.transport ?? null,
		url: s.url ?? null,
		envKeys: s.env_keys ?? [],
		headerNames: s.header_names ?? [],
		ownerPluginId: s.owner_plugin_id ?? null,
		ownerServerName: s.owner_server_name ?? null,
		savedKeyAccount: s.saved_key_account ?? null,
	};
}

function toTool(t: ToolWire): McpTool {
	return {
		meta: t.meta,
		id: t.id,
		server: t.server,
		name: t.name,
		description: t.description ?? null,
		inputSchema: t.input_schema ?? null,
	};
}

const serverWireResponseCodec: z.ZodType<ServerWire> = z
	.object({
		args: z.array(z.string()).optional(),
		auth_configured: z.boolean().optional(),
		auth_required: z.boolean().optional(),
		auth_type: z
			.union([
				z.literal("env"),
				z.literal("header"),
				z.literal("oauth"),
				z.null(),
			])
			.optional(),
		available: z.union([z.boolean(), z.null()]).optional(),
		command: z.string(),
		description: z.union([z.string(), z.null()]).optional(),
		enabled: z.boolean(),
		env_keys: z.array(z.string()).optional(),
		header_names: z.array(z.string()).optional(),
		name: z.string(),
		owner_plugin_id: z.union([z.string(), z.null()]).optional(),
		owner_server_name: z.union([z.string(), z.null()]).optional(),
		saved_key_account: z.union([z.string(), z.null()]).optional(),
		transport: z.union([z.string(), z.null()]).optional(),
		url: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const toolWireResponseCodec: z.ZodType<ToolWire> = z
	.object({
		description: z.union([z.string(), z.null()]).optional(),
		id: z.string(),
		input_schema: z.union([gatewayJsonValueSchema, z.null()]).optional(),
		meta: gatewayJsonValueSchema.optional(),
		name: z.string(),
		server: z.string(),
	})
	.passthrough();
export async function fetchMcpServers(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<McpServer[]> {
	const json = await request<{ servers?: ServerWire[] }>(
		target,
		"/api/mcp/servers",
		{ signal },
		z
			.object({ servers: z.array(serverWireResponseCodec).optional() })
			.passthrough()
	);
	return (json.servers ?? []).map(toServer);
}

/**
 * List MCP tools. When `agentId` is provided, Core narrows the result to that
 * agent's per-agent allowlist; otherwise every registered tool is returned.
 */
export async function fetchMcpTools(
	target: ApiTarget,
	agentId?: string,
	signal?: AbortSignal
): Promise<McpTool[]> {
	const suffix = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
	const json = await request<{ tools?: ToolWire[] }>(
		target,
		`/api/mcp/tools${suffix}`,
		{ signal },
		z.object({ tools: z.array(toolWireResponseCodec).optional() }).passthrough()
	);
	return (json.tools ?? []).map(toTool);
}

/** Input for registering a new MCP server via POST /api/mcp/servers. */
export interface CreateMcpServerInput {
	args?: string[];
	command?: string;
	description?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	name: string;
	transport?: McpTransport;
	url?: string;
}

/** Result from POST /api/mcp/servers. */
export interface CreateMcpServerResult {
	error?: string;
	ok: boolean;
	server?: McpServer;
}

/** Partial update for a user-owned MCP server. Secret maps use the masked value
 * `••••••` to keep an existing value without returning it to the client. */
export interface UpdateMcpServerInput {
	args?: string[];
	command?: string;
	description?: string;
	enabled?: boolean;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	transport?: McpTransport;
	url?: string;
}

export interface UpdateMcpServerResult {
	error?: string;
	ok: boolean;
	server?: McpServer;
}

/**
 * Register a new user-defined MCP server. On success, Core writes the entry
 * into `~/.ryu/state/mcp.json` and reloads the registry so the server and its tools
 * appear immediately in GET /api/mcp/servers and GET /api/mcp/tools.
 *
 * A non-2xx response carries `{ ok: false, error }` — surfaced inline in the
 * form rather than thrown, consistent with `callMcpTool`.
 */
export async function createMcpServer(
	target: ApiTarget,
	input: CreateMcpServerInput
): Promise<CreateMcpServerResult> {
	const body: McpServerWriteBody = {
		name: input.name,
		type: input.transport,
		headers: input.headers ?? {},
		args: input.args ?? [],
		env: input.env ?? {},
		description: input.description ?? null,
	};
	if (input.command) {
		body.command = input.command;
	}
	if (input.url) {
		body.url = input.url;
	}

	const parsed = await request<{
		error?: string;
		ok?: boolean;
		server?: ServerWire;
	}>(
		target,
		"/api/mcp/servers",
		{
			body,
			method: "POST",
		},
		z
			.object({
				error: z.string().optional(),
				ok: z.boolean().optional(),
				server: serverWireResponseCodec.optional(),
			})
			.passthrough()
	);
	return {
		ok: parsed.ok !== false,
		error: parsed.error,
		server: parsed.server ? toServer(parsed.server) : undefined,
	};
}

/** Update a user-owned MCP server and reload Core's registry. */
export async function updateMcpServer(
	target: ApiTarget,
	name: string,
	input: UpdateMcpServerInput
): Promise<UpdateMcpServerResult> {
	const body: McpServerWriteBody = {};
	if (input.command) {
		body.command = input.command;
	}
	if (input.transport) {
		body.type = input.transport;
	}
	if (input.url) {
		body.url = input.url;
	}
	if (input.args) {
		body.args = input.args;
	}
	if (input.env) {
		body.env = input.env;
	}
	if (input.headers) {
		body.headers = input.headers;
	}
	if (input.description !== undefined) {
		body.description = input.description;
	}
	if (input.enabled !== undefined) {
		body.enabled = input.enabled;
	}

	const parsed = await request<{
		error?: string;
		ok?: boolean;
		server?: ServerWire;
	}>(
		target,
		`/api/mcp/servers/${encodeURIComponent(name)}`,
		{
			body,
			method: "PUT",
		},
		z
			.object({
				error: z.string().optional(),
				ok: z.boolean().optional(),
				server: serverWireResponseCodec.optional(),
			})
			.passthrough()
	);
	return {
		error: parsed.error,
		ok: parsed.ok !== false,
		server: parsed.server ? toServer(parsed.server) : undefined,
	};
}

/** Remove a user-owned MCP server. Built-in and plugin-owned servers are refused by Core. */
export async function deleteMcpServer(
	target: ApiTarget,
	name: string
): Promise<{ error?: string; ok: boolean }> {
	const parsed = await request<{ error?: string; ok?: boolean }>(
		target,
		`/api/mcp/servers/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
		z
			.object({ error: z.string().optional(), ok: z.boolean().optional() })
			.passthrough()
	);
	return {
		ok: parsed.ok !== false,
		error: parsed.error,
	};
}

// ── Ghost computer-use actions (M7 / issue #201) ─────────────────────────────

/**
 * Invoke a Ghost computer-use action through Core's MCP path.
 * An `agentId` whose allowlist includes the Ghost server must be supplied —
 * Core will deny the call otherwise (fail-closed per the allowlist rules).
 *
 * This is the entry point for the Companion overlay "do it" button. The caller
 * is responsible for obtaining explicit user confirmation BEFORE calling this
 * function; this function does not ask for confirmation itself.
 */
export function callGhostAction(
	target: ApiTarget,
	agentId: string,
	input: GhostActionInput
): Promise<McpCallResult> {
	const call = ghostActionToCall(input);
	if (!call) {
		return Promise.resolve({
			ok: false,
			error: `Action '${input.kind}' requires a target parameter.`,
		});
	}
	return callMcpTool(target, {
		tool: call.tool,
		agentId,
		arguments: call.arguments,
	});
}

/**
 * Test-call a tool by its fully-qualified id. Core requires a registered
 * `agentId` (a null allowlist would otherwise fail open), so the caller must
 * pass the agent whose allowlist gates the call.
 */
export async function callMcpTool(
	target: ApiTarget,
	input: { tool: string; agentId: string; arguments: unknown }
): Promise<McpCallResult> {
	// Core returns 400/403 with a JSON `{ ok: false, error }` body on a denied or
	// failed call; surface that as a result rather than throwing so the test
	// panel can show the error inline.
	const resp = await authenticatedFetch(target, "/api/mcp/tools/call", {
		method: "POST",
		body: JSON.stringify({
			tool: input.tool,
			agent_id: input.agentId,
			arguments: input.arguments,
		}),
	});
	const text = await resp.text();
	const parsed = mcpCallResponseSchema.parse(text ? JSON.parse(text) : {});
	return {
		ok: parsed.ok ?? resp.ok,
		output: parsed.output,
		error: parsed.error,
	};
}
