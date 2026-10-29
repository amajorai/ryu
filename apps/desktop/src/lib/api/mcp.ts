import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/mcp.ts
//
// Typed client for Core's MCP endpoints (`/api/mcp/*`). Core registers MCP
// servers from config plus a built-in Shadow provider, and exposes the tools
// they advertise. The desktop Tools page lists servers and tools, narrows the
// tool list to a single agent's allowlist, and test-calls a tool. Wire shapes
// mirror `apps/core/src/sidecar/mcp/mod.rs` (snake_case fields, no serde rename).

import type {
	GhostActionInput,
	McpCatalogCard,
	McpCatalogDetail,
	McpCatalogSource,
	McpCatalogSources,
	McpInstallResult,
	McpPackage,
	McpRemote,
	McpSearchParams,
} from "@ryuhq/core-client/mcp.ts";
import { z } from "zod";
import { type ApiTarget, authenticatedFetch, request } from "./client.ts";

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

export const mcpJsonPayloadSchema = z.json();
export type McpJsonPayload = z.infer<typeof mcpJsonPayloadSchema>;
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
const catalogCardWireResponseCodec: z.ZodType<CatalogCardWire> = z
	.object({
		description: z.union([z.string(), z.null()]).optional(),
		has_packages: z.boolean().optional(),
		has_remotes: z.boolean().optional(),
		id: z.string(),
		installed: z.boolean().optional(),
		name: z.string().optional(),
		transports: z.array(z.string()).optional(),
		version: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const packageWireResponseCodec: z.ZodType<PackageWire> = z
	.object({
		file_sha256: z.union([z.string(), z.null()]).optional(),
		identifier: z.union([z.string(), z.null()]).optional(),
		registry_base_url: z.union([z.string(), z.null()]).optional(),
		registry_type: z.union([z.string(), z.null()]).optional(),
		transport: z.union([z.string(), z.null()]).optional(),
		version: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const remoteWireResponseCodec: z.ZodType<RemoteWire> = z
	.object({
		transport_type: z.union([z.string(), z.null()]).optional(),
		url: z.union([z.string(), z.null()]).optional(),
	})
	.passthrough();
const sourceWireResponseCodec: z.ZodType<SourceWire> = z
	.object({
		base_url: z.union([z.string(), z.null()]).optional(),
		builtin: z.boolean().optional(),
		display_name: z.string(),
		id: z.string(),
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

// ── MCP catalog (browse + install from the active MCP source; #464/#466) ─────
//
// The MCP catalog browses servers from the active source (the official MCP
// registry by default), shows each server's packages/remotes so the launch
// command is reviewable, and installs a chosen server as a **disabled**
// `~/.ryu/state/mcp.json` entry (Core never auto-launches a registry command). ALL
// logic lives in Core; this module only shapes requests and parses responses.
//
// Installed-state is NOT carried by the catalog payload (Core hardcodes
// `installed: false` since the registry has no per-user view). The desktop
// derives it by cross-referencing the registered set from `fetchMcpServers`:
// install writes the entry under the sanitized server name, which equals the
// trimmed catalog `id` (slashes preserved — see `sanitize_server_name` in
// `apps/core/src/mcp_catalog/mod.rs`). So a card is installed iff its id is in
// the registered-server name set.

interface CatalogCardWire {
	description?: string | null;
	has_packages?: boolean;
	has_remotes?: boolean;
	id: string;
	installed?: boolean;
	name?: string;
	transports?: string[];
	version?: string | null;
}

interface PackageWire {
	file_sha256?: string | null;
	identifier?: string | null;
	registry_base_url?: string | null;
	registry_type?: string | null;
	transport?: string | null;
	version?: string | null;
}

interface RemoteWire {
	transport_type?: string | null;
	url?: string | null;
}

function toCatalogCard(w: CatalogCardWire): McpCatalogCard {
	return {
		id: w.id,
		name: w.name ?? w.id,
		description: w.description ?? null,
		version: w.version ?? null,
		hasPackages: w.has_packages ?? false,
		hasRemotes: w.has_remotes ?? false,
		transports: w.transports ?? [],
		installed: w.installed ?? false,
	};
}

function toPackage(w: PackageWire): McpPackage {
	return {
		fileSha256: w.file_sha256 ?? null,
		registryType: w.registry_type ?? null,
		registryBaseUrl: w.registry_base_url ?? null,
		identifier: w.identifier ?? null,
		version: w.version ?? null,
		transport: w.transport ?? null,
	};
}

function toRemote(w: RemoteWire): McpRemote {
	return {
		transportType: w.transport_type ?? null,
		url: w.url ?? null,
	};
}

/** One page of catalog results plus the cursor for the next page (if any). */
export interface McpCatalogPage {
	nextCursor: string | null;
	servers: McpCatalogCard[];
	total?: number | null;
}

/**
 * Search the MCP catalog. Core filters/paginates against the active source and
 * returns an opaque `next_cursor`; it's re-encoded via `URLSearchParams` so it
 * survives the round-trip back to Core (which forwards it to the registry).
 */
export async function searchMcpCatalog(
	target: ApiTarget,
	params: McpSearchParams = {}
): Promise<McpCatalogPage> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("query", params.query);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.cursor) {
		q.set("cursor", params.cursor);
	}
	const json = await request<{
		servers?: CatalogCardWire[];
		next_cursor?: string | null;
		total?: number | null;
		total_count?: number | null;
	}>(
		target,
		`/api/mcp/catalog?${q.toString()}`,
		{},
		z
			.object({
				servers: z.array(catalogCardWireResponseCodec).optional(),
				next_cursor: z.union([z.string(), z.null()]).optional(),
				total: z.union([z.number(), z.null()]).optional(),
				total_count: z.union([z.number(), z.null()]).optional(),
			})
			.passthrough()
	);
	return {
		servers: (json.servers ?? []).map(toCatalogCard),
		nextCursor: json.next_cursor ?? null,
		total: json.total ?? json.total_count ?? null,
	};
}

/** Fetch a server's detail (card + its packages + remotes). */
export async function fetchMcpCatalogDetail(
	target: ApiTarget,
	id: string
): Promise<McpCatalogDetail> {
	const json = await request<{
		card: CatalogCardWire;
		packages?: PackageWire[];
		remotes?: RemoteWire[];
	}>(
		target,
		`/api/mcp/catalog/detail?id=${encodeURIComponent(id)}`,
		{},
		z
			.object({
				card: catalogCardWireResponseCodec,
				packages: z.array(packageWireResponseCodec).optional(),
				remotes: z.array(remoteWireResponseCodec).optional(),
			})
			.passthrough()
	);
	return {
		card: toCatalogCard(json.card),
		packages: (json.packages ?? []).map(toPackage),
		remotes: (json.remotes ?? []).map(toRemote),
	};
}

export const mcpInstallPreviewSchema = z
	.object({
		action: z.literal("install"),
		dryRun: z.literal(true),
		success: z.boolean(),
		server: z.discriminatedUnion("transport", [
			z
				.object({
					transport: z.literal("stdio"),
					args: z.array(z.string()),
					command: z.string(),
					name: z.string(),
					url: z.null(),
					description: z.string().nullable().optional(),
				})
				.catchall(mcpJsonPayloadSchema),
			z
				.object({
					transport: z.literal("streamable-http"),
					args: z.tuple([]),
					command: z.null(),
					name: z.string(),
					url: z.string(),
					description: z.string().nullable().optional(),
				})
				.catchall(mcpJsonPayloadSchema),
		]),
	})
	.catchall(mcpJsonPayloadSchema);
export type McpInstallPreview = z.infer<typeof mcpInstallPreviewSchema>;

/**
 * Install a catalog server as a **disabled** `~/.ryu/state/mcp.json` entry. Core never
 * auto-launches the registry command; the user must explicitly enable/start it
 * via the existing MCP servers path. The written `name` equals the catalog id.
 */
export async function installMcpServer(
	target: ApiTarget,
	id: string,
	force = false,
	source?: string | null
): Promise<McpInstallResult> {
	const json = await request<{
		success?: boolean;
		error?: string;
		server?: {
			args: string[];
			command: string | null;
			name: string;
			transport: "stdio" | "streamable-http";
			url: string | null;
		};
	}>(
		target,
		"/api/mcp/catalog/install",
		{
			method: "POST",
			body: { id, force, ...(source ? { source } : {}) },
		},
		z
			.object({
				success: z.boolean().optional(),
				error: z.string().optional(),
				server: z
					.object({
						args: z.array(z.string()),
						command: z.union([z.string(), z.null()]),
						name: z.string(),
						transport: z.union([
							z.literal("stdio"),
							z.literal("streamable-http"),
						]),
						url: z.union([z.string(), z.null()]),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
	);
	if (json.success === false || !json.server) {
		throw new Error(json.error ?? `Failed to install ${id}`);
	}
	if (
		json.server.transport === "stdio" &&
		json.server.command &&
		json.server.url === null
	) {
		return {
			args: json.server.args,
			command: json.server.command,
			name: json.server.name,
			transport: "stdio",
			url: null,
		};
	}
	if (
		json.server.transport === "streamable-http" &&
		json.server.command === null &&
		json.server.url
	) {
		return {
			args: [],
			command: null,
			name: json.server.name,
			transport: "streamable-http",
			url: json.server.url,
		};
	}
	throw new Error("Core returned an invalid MCP install result");
}

/** Resolve a catalog MCP server without writing mcp.json, lifecycle state, or
 * warming its package in the Download Center. */
export function previewMcpServerInstall(
	target: ApiTarget,
	id: string,
	force = false
): Promise<McpInstallPreview> {
	return request(
		target,
		"/api/mcp/catalog/install",
		{
			method: "POST",
			body: { dryRun: true, force, id },
		},
		mcpInstallPreviewSchema
	);
}

/** One installed MCP server whose recorded catalog version trails the registry.
 *  From `GET /api/mcp/updates`. `catalogId` is the re-install key. */
export interface McpUpdateEntry {
	catalogId: string;
	currentVersion: string | null;
	latestVersion: string | null;
	name: string;
	/** MCP source the update was found on, which must apply it. */
	source: string | null;
}

/** List installed MCP servers with a newer catalog version. Returns `[]` on any
 *  error (older Core without the endpoint) so the caller renders nothing. */
export async function listMcpUpdates(
	target: ApiTarget
): Promise<McpUpdateEntry[]> {
	try {
		const json = await request<{
			updates?: {
				name?: string;
				catalog_id?: string;
				current_version?: string | null;
				latest_version?: string | null;
				source?: string | null;
			}[];
		}>(
			target,
			"/api/mcp/updates",
			{},
			z
				.object({
					updates: z
						.array(
							z
								.object({
									name: z.string().optional(),
									catalog_id: z.string().optional(),
									current_version: z.union([z.string(), z.null()]).optional(),
									latest_version: z.union([z.string(), z.null()]).optional(),
								})
								.passthrough()
						)
						.optional(),
				})
				.passthrough()
		);
		return (json.updates ?? []).map((u) => ({
			name: u.name ?? u.catalog_id ?? "",
			catalogId: u.catalog_id ?? "",
			currentVersion: u.current_version ?? null,
			latestVersion: u.latest_version ?? null,
			source: u.source ?? null,
		}));
	} catch {
		return [];
	}
}

// ── MCP catalog sources (#464) ───────────────────────────────────────────────
//
// The MCP catalog can be backed by more than one source (the official MCP
// registry by default, with Smithery / a Ryu-hosted registry behind the same
// seam). The active source lives in Core; the dropdown lists them and selects
// one, after which the catalog re-keys against the newly-active endpoint.

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

function toSource(w: SourceWire): McpCatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List the MCP catalog sources and which one is active. */
export async function fetchMcpSources(
	target: ApiTarget
): Promise<McpCatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SourceWire[];
	}>(
		target,
		"/api/catalog/sources?kind=mcp",
		{},
		z
			.object({
				active: z.string().optional(),
				sources: z.array(sourceWireResponseCodec).optional(),
			})
			.passthrough()
	);
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toSource),
	};
}

/** Select the active MCP catalog source by id. */
export async function selectMcpSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		"/api/catalog/sources/select",
		{
			method: "POST",
			body: { kind: "mcp", id },
		},
		gatewayJsonValueSchema
	);
}

// ── Ghost computer-use actions (M7 / issue #201) ─────────────────────────────

/**
 * Map a named Ghost action to its fully-qualified tool id and arguments.
 * Returns `null` when required parameters are missing.
 */
function ghostActionToCall(
	input: GhostActionInput
): { arguments: unknown; tool: string } | null {
	switch (input.kind) {
		case "focus": {
			if (!input.target) {
				return null;
			}
			return {
				tool: "ghost.ghost_focus",
				arguments: { app: input.target },
			};
		}
		case "click": {
			if (!input.target) {
				return null;
			}
			return {
				tool: "ghost.ghost_click",
				arguments: { query: input.target },
			};
		}
		case "screenshot": {
			return {
				tool: "ghost.ghost_screenshot",
				arguments: {},
			};
		}
		default: {
			// Exhaustive check — TypeScript ensures all GhostActionKind variants
			// are handled above; this branch is unreachable at runtime.
			return null;
		}
	}
}

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
