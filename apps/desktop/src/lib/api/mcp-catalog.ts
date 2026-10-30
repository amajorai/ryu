import type {
	McpCatalogCard,
	McpCatalogDetail,
	McpInstallResult,
	McpPackage,
	McpRemote,
	McpSearchParams,
} from "@ryuhq/core-client/mcp.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { mcpJsonPayloadSchema } from "./mcp-json-payload.ts";

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
const remoteWireResponseCodec: z.ZodType<RemoteWire> = z.object({
	transport_type: z.union([z.string(), z.null()]).optional(),
	url: z.union([z.string(), z.null()]).optional(),
});

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
