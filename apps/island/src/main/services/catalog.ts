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

const PROBE_TIMEOUT_MS = 8000;

function reasonFromError(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") {
		return "timeout";
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

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
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/catalog/sources?kind=${kind}`,
			{ method: "GET", headers: coreHeaders() }
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as {
			active?: string;
			sources?: SourceWire[];
		};
		return {
			available: true,
			active: data.active ?? "",
			sources: (data.sources ?? []).map(toSource),
		};
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Select the active catalog source for a kind by id. */
export async function selectSource(
	kind: "skill" | "mcp",
	id: string
): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/catalog/sources/select`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ kind, id }),
			}
		);
		if (!resp.ok) {
			return {
				available: true,
				ok: false,
				error: `core responded ${resp.status}`,
			};
		}
		return { available: true, ok: true };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

// ── Skills ─────────────────────────────────────────────────────────────────--

interface SkillCardWire {
	id: string;
	installed?: boolean;
	installs?: number;
	name?: string;
	slug?: string;
	source?: string;
}

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
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/skills/catalog?${q.toString()}`,
			{ method: "GET", headers: coreHeaders() }
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { skills?: SkillCardWire[] };
		return { available: true, items: (data.skills ?? []).map(skillToItem) };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

async function installSkill(id: string): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/skills/catalog/install`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ id }),
			}
		);
		const data = (await resp.json().catch(() => ({}))) as {
			success?: boolean;
			error?: string;
			result?: unknown;
		};
		const ok = resp.ok && data.success !== false && Boolean(data.result);
		return { available: true, ok, error: ok ? undefined : data.error };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

// ── MCP ──────────────────────────────────────────────────────────────────────

interface McpCardWire {
	description?: string | null;
	id: string;
	name?: string;
	transports?: string[];
	version?: string | null;
}

interface McpServerWire {
	name: string;
}

/** Fetch the set of registered MCP server names (for installed-state derivation). */
async function mcpServerNames(coreBaseUrl: string): Promise<Set<string>> {
	try {
		const resp = await fetchWithTimeout(`${coreBaseUrl}/api/mcp/servers`, {
			method: "GET",
			headers: coreHeaders(),
		});
		if (!resp.ok) {
			return new Set();
		}
		const data = (await resp.json()) as { servers?: McpServerWire[] };
		return new Set((data.servers ?? []).map((s) => s.name));
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
			fetchWithTimeout(`${coreBaseUrl}/api/mcp/catalog?${q.toString()}`, {
				method: "GET",
				headers: coreHeaders(),
			}),
			mcpServerNames(coreBaseUrl),
		]);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { servers?: McpCardWire[] };
		return {
			available: true,
			items: (data.servers ?? []).map((s) => mcpToItem(s, installed)),
		};
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

async function installMcp(id: string): Promise<CatalogActionResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/mcp/catalog/install`,
			{
				method: "POST",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ id }),
			}
		);
		const data = (await resp.json().catch(() => ({}))) as {
			success?: boolean;
			error?: string;
			server?: unknown;
		};
		const ok = resp.ok && data.success !== false && Boolean(data.server);
		return { available: true, ok, error: ok ? undefined : data.error };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
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
