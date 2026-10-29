import { z } from "zod";
// Main-process client for Ryu Core's marketplace catalog (skills + MCP).
//
// Like the rest of the Core client (services/core.ts), all HTTP runs here (the
// renderer can't reach Core directly (CORS) and every method resolves to a
// result envelope rather than throwing, so the renderer never sees a rejected
// promise. Browse/install logic lives entirely in Core; this module only shapes
// requests and maps Core's snake_case wire shapes to the renderer view models.
//
// MCP installed-state derivation: the MCP catalog payload hardcodes
// `installed: false`, so a card is marked installed here iff its id matches a
// registered server name from `GET /api/mcp/servers`.

import type {
	CatalogActionResult,
	CatalogItem,
	CatalogListResult,
	CatalogSource,
	CatalogSourcesResult,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";
import { withResponseDeadline } from "./response-deadline.ts";

const PROBE_TIMEOUT_MS = 8000;

const catalogFailureSchema = z
	.union([z.instanceof(DOMException), z.instanceof(Error)])
	.catch(new Error("unreachable"));

function reasonFromError(error: z.infer<typeof catalogFailureSchema>): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

const sourceWireSchema = z.object({
	base_url: z.string().nullable().optional(),
	builtin: z.boolean().optional(),
	display_name: z.string(),
	id: z.string(),
});
type SourceWire = z.infer<typeof sourceWireSchema>;
const catalogSourcesSchema = z.object({
	active: z.string().optional(),
	sources: z.array(sourceWireSchema).optional(),
});
const catalogInstallSchema = z.object({
	success: z.boolean().optional(),
	error: z.string().optional(),
	result: z.json().optional(),
	server: z.json().optional(),
});

function toSource(w: SourceWire): CatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List the catalog sources for a kind and which one is active. */
export async function sources(
	kind: "skill" | "mcp"
): Promise<CatalogSourcesResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CatalogSourcesResult>(
			`${coreBaseUrl}/api/catalog/sources?kind=${kind}`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = catalogSourcesSchema.parse(await resp.json());
				return {
					available: true,
					active: data.active ?? "",
					sources: (data.sources ?? []).map(toSource),
				};
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

/** Select the active catalog source for a kind by id. */
export async function selectSource(
	kind: "skill" | "mcp",
	id: string
): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CatalogActionResult>(
			`${coreBaseUrl}/api/catalog/sources/select`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ kind, id }),
			},
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return {
						available: true,
						ok: false,
						error: `core responded ${resp.status}`,
					};
				}
				return { available: true, ok: true };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

// ── Skills ─────────────────────────────────────────────────────────────────--

const skillCardSchema = z.object({
	id: z.string(),
	installed: z.boolean().optional(),
	installs: z.number().optional(),
	name: z.string().optional(),
	slug: z.string().optional(),
	source: z.string().optional(),
});
type SkillCardWire = z.infer<typeof skillCardSchema>;
const skillCatalogSchema = z.object({
	skills: z.array(skillCardSchema).optional(),
});

function skillToItem(w: SkillCardWire): CatalogItem {
	const installs = w.installs ?? 0;
	return {
		id: w.id,
		name: w.name ?? w.slug ?? w.id,
		description: null,
		subtitle: installs > 0 ? `${installs} installs` : (w.source ?? null),
		installed: w.installed ?? false,
	};
}

async function listSkills(query: string): Promise<CatalogListResult> {
	const { coreBaseUrl } = loadConfig();
	const q = new URLSearchParams({ limit: "30" });
	if (query) {
		q.set("query", query);
	}
	try {
		return await withResponseDeadline<CatalogListResult>(
			`${coreBaseUrl}/api/skills/catalog?${q.toString()}`,
			{ method: "GET", headers: coreHeaders() },
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return { available: false, reason: `core responded ${resp.status}` };
				}
				const data = skillCatalogSchema.parse(await resp.json());
				return { available: true, items: (data.skills ?? []).map(skillToItem) };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

async function installSkill(id: string): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CatalogActionResult>(
			`${coreBaseUrl}/api/skills/catalog/install`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ id }),
			},
			PROBE_TIMEOUT_MS,
			async (resp) => {
				const data = catalogInstallSchema.parse(
					await resp.json().catch(() => ({}))
				);
				const ok = resp.ok && data.success !== false && Boolean(data.result);
				return { available: true, ok, error: ok ? undefined : data.error };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

// ── MCP ──────────────────────────────────────────────────────────────────────

const mcpCardSchema = z.object({
	description: z.string().nullable().optional(),
	id: z.string(),
	name: z.string().optional(),
	transports: z.array(z.string()).optional(),
	version: z.string().nullable().optional(),
});
type McpCardWire = z.infer<typeof mcpCardSchema>;
const mcpCatalogSchema = z.object({
	servers: z.array(mcpCardSchema).optional(),
});
const mcpServersSchema = z.object({
	servers: z.array(z.object({ name: z.string() })).optional(),
});

/** Fetch the set of registered MCP server names (for installed-state derivation). */
async function mcpServerNames(coreBaseUrl: string): Promise<Set<string>> {
	try {
		return await withResponseDeadline<Set<string>>(
			`${coreBaseUrl}/api/mcp/servers`,
			{
				method: "GET",
				headers: coreHeaders(),
			},
			PROBE_TIMEOUT_MS,
			async (resp) => {
				if (!resp.ok) {
					return new Set();
				}
				const data = mcpServersSchema.parse(await resp.json());
				return new Set((data.servers ?? []).map((s) => s.name));
			}
		);
	} catch {
		return new Set();
	}
}

function mcpToItem(w: McpCardWire, installed: Set<string>): CatalogItem {
	return {
		id: w.id,
		name: w.name ?? w.id,
		description: w.description ?? null,
		subtitle:
			w.transports && w.transports.length > 0
				? w.transports.join(", ")
				: (w.version ?? null),
		installed: installed.has(w.id),
	};
}

async function listMcp(query: string): Promise<CatalogListResult> {
	const { coreBaseUrl } = loadConfig();
	const q = new URLSearchParams({ limit: "30" });
	if (query) {
		q.set("query", query);
	}
	try {
		const [resp, installed] = await Promise.all([
			withResponseDeadline(
				`${coreBaseUrl}/api/mcp/catalog?${q.toString()}`,
				{
					method: "GET",
					headers: coreHeaders(),
				},
				PROBE_TIMEOUT_MS,
				async (response) => ({
					ok: response.ok,
					status: response.status,
					servers: response.ok
						? (mcpCatalogSchema.parse(await response.json()).servers ?? [])
						: [],
				})
			),
			mcpServerNames(coreBaseUrl),
		]);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		return {
			available: true,
			items: resp.servers.map((s) => mcpToItem(s, installed)),
		};
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

async function installMcp(id: string): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		return await withResponseDeadline<CatalogActionResult>(
			`${coreBaseUrl}/api/mcp/catalog/install`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ id }),
			},
			PROBE_TIMEOUT_MS,
			async (resp) => {
				const data = catalogInstallSchema.parse(
					await resp.json().catch(() => ({}))
				);
				const ok = resp.ok && data.success !== false && Boolean(data.server);
				return { available: true, ok, error: ok ? undefined : data.error };
			}
		);
	} catch (error) {
		return {
			available: false,
			reason: reasonFromError(catalogFailureSchema.parse(error)),
		};
	}
}

// ── Kind-dispatched entry points ─────────────────────────────────────────────

/** List the active source's catalog for a kind. */
export function list(
	kind: "skill" | "mcp",
	query: string
): Promise<CatalogListResult> {
	return kind === "skill" ? listSkills(query) : listMcp(query);
}

/** Install a skill or MCP server by id. */
export function install(
	kind: "skill" | "mcp",
	id: string
): Promise<CatalogActionResult> {
	return kind === "skill" ? installSkill(id) : installMcp(id);
}
