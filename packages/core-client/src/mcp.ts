// apps/desktop/src/lib/api/mcp.ts
//
// Typed client for Core's MCP endpoints (`/api/mcp/*`). Core registers MCP
// servers from config plus a built-in Shadow provider, and exposes the tools
// they advertise. The desktop Tools page lists servers and tools, narrows the
// tool list to a single agent's allowlist, and test-calls a tool. Wire shapes
// mirror `apps/core/src/sidecar/mcp/mod.rs` (snake_case fields, no serde rename).

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

import { type ApiTarget, fetchForTarget, request } from "./client.ts";

interface McpDispatchHeaders {
	"Content-Type": string;
	[header: string]: string;
}
function mcpDispatchHeaders(target: ApiTarget): McpDispatchHeaders {
	const headers: McpDispatchHeaders = { "Content-Type": "application/json" };
	if (target.token) {
		headers.Authorization = `Bearer ${target.token}`;
	}
	return headers;
}
const mcpCreatedServerFields = z.object({
	name: z.string(),
	command: z.string(),
	args: z.array(z.string()).nullable().optional(),
	description: z.string().nullable().optional(),
	enabled: z.boolean().nullable().optional(),
	transport: z.string().optional(),
	url: z.string().optional(),
	available: z.boolean().nullable().optional(),
	auth_required: z.boolean().optional(),
	auth_configured: z.boolean().optional(),
	auth_type: z.string().optional(),
	owner_plugin_id: z.string().optional(),
	owner_server_name: z.string().optional(),
	env_keys: z.array(z.string()).optional(),
	header_names: z.array(z.string()).optional(),
});
const mcpCreatedResponseFields = z.object({
	ok: z.boolean().optional(),
	server: mcpCreatedServerFields.nullable().optional(),
	error: z.string().nullable().optional(),
});
const mcpCreatedResponse = z.custom<z.output<typeof mcpCreatedResponseFields>>(
	(value) => mcpCreatedResponseFields.safeParse(value).success
);
const mcpCallResponseFields = z.object({
	ok: z.boolean().nullable().optional(),
	output: appResponseValueSchema.optional(),
	error: z.string().optional(),
});
const mcpCallResponse = z.custom<z.output<typeof mcpCallResponseFields>>(
	(value) => mcpCallResponseFields.safeParse(value).success
);

function mcpNativeResponse<S extends z.ZodObject>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const mcpListedServerFields = mcpCreatedServerFields.extend({
	enabled: z.boolean(),
});
const mcpListedServersSchema = mcpNativeResponse(
	z.object({ servers: z.array(mcpListedServerFields).nullish() })
);
const mcpWidgetFields = z.object({
	template_uri: z.string(),
	widget_accessible: z.boolean(),
	invoking_label: z.string().optional(),
	invoked_label: z.string().optional(),
});
export const mcpListedToolFields = z.object({
	id: z.string(),
	server: z.string(),
	name: z.string(),
	description: z.string().nullish(),
	input_schema: appResponseValueSchema.optional(),
	output_schema: appResponseValueSchema.optional(),
	annotations: appResponseValueSchema.optional(),
	meta: appResponseValueSchema.optional(),
	widget: mcpWidgetFields.optional(),
	widget_accessible: z.boolean().optional(),
	output_template: z.string().optional(),
	// `InlineDeno` is what Core releases before the `inline_js` rename report for
	// the same backend; keep it so a newer client can still list their tools.
	app_backend: z
		.enum(["Alias", "InlineJs", "InlineDeno", "Http", "Command"])
		.optional(),
});
const mcpListedToolsSchema = mcpNativeResponse(
	z.object({ tools: z.array(mcpListedToolFields).nullish() })
);
const mcpCatalogCardFields = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().nullish(),
	version: z.string().nullish(),
	has_packages: z.boolean().nullish(),
	has_remotes: z.boolean().nullish(),
	transports: z.array(z.string()).nullish(),
	installed: z.boolean().nullish(),
});
const mcpCatalogPackageFields = z.object({
	file_sha256: z.string().nullish(),
	identifier: z.string().nullish(),
	registry_base_url: z.string().nullish(),
	registry_type: z.string().nullish(),
	transport: z.string().nullish(),
	version: z.string().nullish(),
});
const mcpCatalogRemoteFields = z.object({
	transport_type: z.string().nullish(),
	url: z.string().nullish(),
});
const mcpCatalogPageSchema = mcpNativeResponse(
	z.object({
		servers: z.array(mcpCatalogCardFields).nullish(),
		next_cursor: z.string().nullish(),
	})
);
const mcpCatalogDetailSchema = mcpNativeResponse(
	z.object({
		card: mcpCatalogCardFields,
		packages: z.array(mcpCatalogPackageFields).nullish(),
		remotes: z.array(mcpCatalogRemoteFields).nullish(),
	})
);
const mcpInstalledServerFields = z.object({
	args: z.array(z.string()),
	command: z.string().nullable(),
	name: z.string(),
	transport: z.string(),
	url: z.string().nullable(),
	description: z.string().nullish(),
	enabled: z.boolean().optional(),
});
const mcpInstalledResponseSchema = mcpNativeResponse(
	z.object({
		success: z.boolean().optional(),
		error: z.string().optional(),
		server: mcpInstalledServerFields.nullish(),
		dryRun: z.boolean().optional(),
		action: z.string().optional(),
		writes: z.array(appResponseValueSchema).optional(),
	})
);
const mcpSourceFields = z.object({
	id: z.string(),
	display_name: z.string(),
	builtin: z.boolean().nullish(),
	base_url: z.string().nullish(),
	has_auth: z.boolean().optional(),
});
const mcpSourcesResponseSchema = mcpNativeResponse(
	z.object({
		kind: z.string().optional(),
		active: z.string().nullish(),
		sources: z.array(mcpSourceFields).nullish(),
	})
);

/** A registered MCP server as Core summarizes it for the listing endpoint. */
export interface McpServer {
	args: string[];
	/** Whether the command is present on disk; null when it can't be determined. */
	available: boolean | null;
	command: string;
	description: string | null;
	enabled: boolean;
	name: string;
}

/** A tool advertised by a registered MCP server. */
export interface McpTool {
	description: string | null;
	/** Fully-qualified id `<server>.<tool>`, unique across servers. */
	id: string;
	inputSchema: unknown | null;
	name: string;
	server: string;
}

/** Outcome of a test tool call: success carries output, failure carries error. */
export interface McpCallResult {
	error?: string;
	ok: boolean;
	output?: unknown;
}

type ServerWire = z.output<typeof mcpListedServerFields>;

type ToolWire = z.output<typeof mcpListedToolFields>;

function toServer(s: ServerWire): McpServer {
	return {
		name: s.name,
		command: s.command,
		args: s.args ?? [],
		description: s.description ?? null,
		enabled: s.enabled,
		available: s.available ?? null,
	};
}

function toTool(t: ToolWire): McpTool {
	return {
		id: t.id,
		server: t.server,
		name: t.name,
		description: t.description ?? null,
		inputSchema: t.input_schema ?? null,
	};
}

export async function fetchMcpServers(target: ApiTarget): Promise<McpServer[]> {
	const json = await request(
		target,
		"/api/mcp/servers",
		{},
		mcpListedServersSchema
	);
	return (json.servers ?? []).map(toServer);
}

/**
 * List MCP tools. When `agentId` is provided, Core narrows the result to that
 * agent's per-agent allowlist; otherwise every registered tool is returned.
 */
export async function fetchMcpTools(
	target: ApiTarget,
	agentId?: string
): Promise<McpTool[]> {
	const suffix = agentId ? `?agent=${encodeURIComponent(agentId)}` : "";
	const json = await request(
		target,
		`/api/mcp/tools${suffix}`,
		{},
		mcpListedToolsSchema
	);
	return (json.tools ?? []).map(toTool);
}

/** Input for registering a new MCP server via POST /api/mcp/servers. */
export interface CreateMcpServerInput {
	args?: string[];
	command: string;
	description?: string;
	env?: Record<string, string>;
	name: string;
}

/** Result from POST /api/mcp/servers. */
export interface CreateMcpServerResult {
	error?: string;
	ok: boolean;
	server?: McpServer;
}

/**
 * Register a new user-defined MCP server. On success, Core writes the entry
 * into `~/.ryu/mcp.json` and reloads the registry so the server and its tools
 * appear immediately in GET /api/mcp/servers and GET /api/mcp/tools.
 *
 * A non-2xx response carries `{ ok: false, error }` — surfaced inline in the
 * form rather than thrown, consistent with `callMcpTool`.
 */
export async function createMcpServer(
	target: ApiTarget,
	input: CreateMcpServerInput
): Promise<CreateMcpServerResult> {
	const resp = await fetchForTarget(target)(
		`${target.url.replace(/\/$/, "")}/api/mcp/servers`,
		{
			method: "POST",
			headers: mcpDispatchHeaders(target),
			body: JSON.stringify({
				name: input.name,
				command: input.command,
				args: input.args ?? [],
				env: input.env ?? {},
				description: input.description ?? null,
			}),
		}
	);
	const text = await resp.text();
	const parsed = mcpCreatedResponse.parse(text ? JSON.parse(text) : {});
	if (!resp.ok) {
		return { ok: false, error: parsed.error ?? `HTTP ${resp.status}` };
	}
	const srv = parsed.server;
	return {
		ok: true,
		server: srv
			? {
					name: srv.name,
					command: srv.command,
					args: srv.args ?? [],
					description: srv.description ?? null,
					enabled: srv.enabled ?? true,
					available: null,
				}
			: undefined,
	};
}

// ── MCP catalog (browse + install from the active MCP source; #464/#466) ─────
//
// The MCP catalog browses servers from the active source (the official MCP
// registry by default), shows each server's packages/remotes so the launch
// command is reviewable, and installs a chosen server as a **disabled**
// `~/.ryu/mcp.json` entry (Core never auto-launches a registry command). ALL
// logic lives in Core; this module only shapes requests and parses responses.
//
// Installed-state is NOT carried by the catalog payload (Core hardcodes
// `installed: false` since the registry has no per-user view). The desktop
// derives it by cross-referencing the registered set from `fetchMcpServers`:
// install writes the entry under the sanitized server name, which equals the
// trimmed catalog `id` (slashes preserved — see `sanitize_server_name` in
// `apps/core/src/mcp_catalog/mod.rs`). So a card is installed iff its id is in
// the registered-server name set.

/** A server row in the left-hand MCP catalog selector. */
export interface McpCatalogCard {
	description: string | null;
	/** Whether this server advertises any local (stdio) package. */
	hasPackages: boolean;
	/** Whether this server advertises any remote (hosted) endpoint. */
	hasRemotes: boolean;
	/** Registry id / name, e.g. `io.github.owner/server`. */
	id: string;
	/** Whether this server is registered in `~/.ryu/mcp.json` (derived). */
	installed: boolean;
	name: string;
	/** Transport strings advertised by the server (stdio, http, sse, …). */
	transports: string[];
	version: string | null;
}

/** A launchable package for a server (npm/pypi/oci, etc.). */
export interface McpPackage {
	fileSha256: string | null;
	identifier: string | null;
	registryBaseUrl: string | null;
	registryType: string | null;
	transport: string | null;
	version: string | null;
}

/** A hosted remote endpoint for a server. */
export interface McpRemote {
	transportType: string | null;
	url: string | null;
}

/** Full right-hand detail payload for a selected catalog server. */
export interface McpCatalogDetail {
	card: McpCatalogCard;
	packages: McpPackage[];
	remotes: McpRemote[];
}

type CatalogCardWire = z.output<typeof mcpCatalogCardFields>;

type PackageWire = z.output<typeof mcpCatalogPackageFields>;

type RemoteWire = z.output<typeof mcpCatalogRemoteFields>;

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

export interface McpSearchParams {
	/** Opaque pagination cursor from a prior page's {@link McpCatalogPage}. */
	cursor?: string;
	limit?: number;
	query?: string;
}

/** One page of catalog results plus the cursor for the next page (if any). */
export interface McpCatalogPage {
	nextCursor: string | null;
	servers: McpCatalogCard[];
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
	const json = await request(
		target,
		`/api/mcp/catalog?${q.toString()}`,
		{},
		mcpCatalogPageSchema
	);
	return {
		servers: (json.servers ?? []).map(toCatalogCard),
		nextCursor: json.next_cursor ?? null,
	};
}

/** Fetch a server's detail (card + its packages + remotes). */
export async function fetchMcpCatalogDetail(
	target: ApiTarget,
	id: string
): Promise<McpCatalogDetail> {
	const json = await request(
		target,
		`/api/mcp/catalog/detail?id=${encodeURIComponent(id)}`,
		{},
		mcpCatalogDetailSchema
	);
	return {
		card: toCatalogCard(json.card),
		packages: (json.packages ?? []).map(toPackage),
		remotes: (json.remotes ?? []).map(toRemote),
	};
}

/** The written server entry returned by a successful catalog install. */
export type McpInstallResult =
	| {
			args: string[];
			command: string;
			name: string;
			transport: "stdio";
			url: null;
	  }
	| {
			args: [];
			command: null;
			name: string;
			transport: "streamable-http";
			url: string;
	  };

/**
 * Install a catalog server as a **disabled** `~/.ryu/mcp.json` entry. Core never
 * auto-launches the registry command; the user must explicitly enable/start it
 * via the existing MCP servers path. The written `name` equals the catalog id.
 */
export async function installMcpServer(
	target: ApiTarget,
	id: string
): Promise<McpInstallResult> {
	const json = await request(
		target,
		"/api/mcp/catalog/install",
		{ method: "POST", body: { id } },
		mcpInstalledResponseSchema
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

// ── MCP catalog sources (#464) ───────────────────────────────────────────────
//
// The MCP catalog can be backed by more than one source (the official MCP
// registry by default, with Smithery / a Ryu-hosted registry behind the same
// seam). The active source lives in Core; the dropdown lists them and selects
// one, after which the catalog re-keys against the newly-active endpoint.

/** One selectable MCP catalog source. Mirrors Core's source descriptor. */
export interface McpCatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

type SourceWire = z.output<typeof mcpSourceFields>;

/** The active source id plus every source available for the MCP kind. */
export interface McpCatalogSources {
	active: string;
	sources: McpCatalogSource[];
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
	const json = await request(
		target,
		"/api/catalog/sources?kind=mcp",
		{},
		mcpSourcesResponseSchema
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
	await request(
		target,
		"/api/catalog/sources/select",
		{
			method: "POST",
			body: { kind: "mcp", id },
		},
		appResponseValueSchema
	);
}

// ── Ghost computer-use actions (M7 / issue #201) ─────────────────────────────

/**
 * The small, named set of Ghost actions exposed in the companion overlay.
 * Full Ghost tool catalog exposure is out of scope; these cover the most
 * common one-shot automation actions.
 */
export type GhostActionKind = "click" | "focus" | "screenshot";

/** Parameters for each named Ghost action. */
export interface GhostActionInput {
	kind: GhostActionKind;
	/** For `focus` - required app name. For `click` - element query string.
	 *  Not used for `screenshot`. */
	target?: string;
}

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
	const resp = await fetchForTarget(target)(
		`${target.url.replace(/\/$/, "")}/api/mcp/tools/call`,
		{
			method: "POST",
			headers: mcpDispatchHeaders(target),
			body: JSON.stringify({
				tool: input.tool,
				agent_id: input.agentId,
				arguments: input.arguments,
			}),
		}
	);
	const text = await resp.text();
	const parsed = mcpCallResponse.parse(text ? JSON.parse(text) : {});
	return {
		ok: parsed.ok ?? resp.ok,
		output: parsed.output,
		error: parsed.error,
	};
}
