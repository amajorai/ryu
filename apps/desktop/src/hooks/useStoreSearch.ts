// apps/desktop/src/hooks/useStoreSearch.ts
//
// Store-wide search for the desktop Store shell (apps/desktop/src/pages/StorePage).
// One debounced query fans out across every searchable realm at once — Plugins,
// Models, Skills, MCP, and Agents — and returns the matches grouped per realm so
// the shell can render one sectioned result view (a header per realm) instead of
// making the user pick a tab first. Engines are excluded: that section is a
// curated, modality-grouped layout with no searchable card list.
//
// The network realms (Models / Skills / MCP) hit Core's search endpoints; the
// full-catalog realms (Plugins / Agents) reuse the SAME TanStack Query keys as
// their sections (`["apps","catalog",url]`, `["agents","catalog",url]`) so the
// cache dedupes instead of double-fetching, then filter client-side. Every query
// is gated on a non-empty query, so nothing fetches until the user types.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchAgentCatalog } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { searchMcpCatalog } from "@/src/lib/api/mcp.ts";
import { searchModels } from "@/src/lib/api/models.ts";
import { fetchAppsCatalog } from "@/src/lib/api/plugins.ts";
import { searchSkills } from "@/src/lib/api/skills.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

const SEARCH_DEBOUNCE_MS = 300;
// Each realm contributes at most a handful of hits to the aggregated view; the
// realm's own tab (opened with the query carried over) is where you go for depth.
const PER_REALM_LIMIT = 6;

/** A realm that participates in store-wide search (maps to a StorePage section).
 *  The plugin catalog splits into "apps" (companion-UI apps) and "plugins"
 *  (everything else), mirroring the Store's Apps/Plugins sections. */
export type StoreSearchRealm =
	| "apps"
	| "plugins"
	| "models"
	| "skills"
	| "mcp"
	| "agents";

/** One normalized result row, realm-agnostic so the shell renders them uniformly. */
export interface StoreSearchItem {
	description: string | null;
	id: string;
	name: string;
	/** Short kind/category chip (format, transport, engine, …). */
	tag: string | null;
}

export interface StoreSearchGroup {
	items: StoreSearchItem[];
	label: string;
	realm: StoreSearchRealm;
}

export interface UseStoreSearchResult {
	groups: StoreSearchGroup[];
	/** True once the debounced query is non-empty (drives "show results" mode). */
	hasQuery: boolean;
	/** Every realm came back empty for the current query. */
	isEmpty: boolean;
	/** At least one realm's search failed for the current query. */
	isError: boolean;
	loading: boolean;
	/** Re-run every realm's search (used by the results view's Retry action). */
	refetch: () => Promise<unknown>;
}

function matches(
	query: string,
	...fields: (string | null | undefined)[]
): boolean {
	return fields.some((f) => f?.toLowerCase().includes(query));
}

export function useStoreSearch(query: string): UseStoreSearchResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
	const enabled = debounced.length > 0;
	const lower = debounced.toLowerCase();

	const modelsQuery = useQuery({
		queryKey: ["store-search", "models", url, debounced],
		queryFn: () =>
			searchModels(
				{ url, token },
				{ query: debounced, limit: PER_REALM_LIMIT }
			),
		enabled,
	});

	const skillsQuery = useQuery({
		queryKey: ["store-search", "skills", url, debounced],
		queryFn: () =>
			searchSkills(
				{ url, token },
				{ query: debounced, limit: PER_REALM_LIMIT }
			),
		enabled,
	});

	const mcpQuery = useQuery({
		queryKey: ["store-search", "mcp", url, debounced],
		queryFn: () =>
			searchMcpCatalog(
				{ url, token },
				{ query: debounced, limit: PER_REALM_LIMIT }
			),
		enabled,
	});

	// Plugins + Agents have no search endpoint: fetch the full catalog once (shared
	// query key with their sections → cache-deduped) and filter in-memory.
	const appsQuery = useQuery({
		queryKey: ["apps", "catalog", url],
		queryFn: () => fetchAppsCatalog({ url, token }),
		enabled,
	});

	const agentsQuery = useQuery({
		queryKey: ["agents", "catalog", url],
		queryFn: () => fetchAgentCatalog({ url, token }),
		enabled,
	});

	const groups = useMemo<StoreSearchGroup[]>(() => {
		if (!enabled) {
			return [];
		}
		const result: StoreSearchGroup[] = [];

		const models = (modelsQuery.data?.models ?? [])
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((m) => ({
				id: m.id,
				name: m.name,
				description: m.author || null,
				tag: m.format ? m.format.toUpperCase() : null,
			}));
		if (models.length > 0) {
			result.push({ realm: "models", label: "Models", items: models });
		}

		const skills = (skillsQuery.data ?? [])
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((s) => ({
				id: s.id,
				name: s.name,
				description: s.source || null,
				tag: "Skill",
			}));
		if (skills.length > 0) {
			result.push({ realm: "skills", label: "Skills", items: skills });
		}

		const mcp = (mcpQuery.data?.servers ?? [])
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				tag: s.transports[0] ?? "MCP",
			}));
		if (mcp.length > 0) {
			result.push({ realm: "mcp", label: "MCP", items: mcp });
		}

		// One catalog fetch, split by kind: companion-UI plugins are "Apps", the
		// rest are "Plugins" — mirroring the Store's two sections.
		const pluginMatches = (appsQuery.data ?? []).filter((e) =>
			matches(lower, e.name, e.description, e.kinds.join(" "), e.tags.join(" "))
		);
		const apps = pluginMatches
			.filter((e) => e.kinds.includes("companion"))
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((e) => ({
				id: e.id,
				name: e.name,
				description: e.description || null,
				tag: e.kinds[0] ?? null,
			}));
		if (apps.length > 0) {
			result.push({ realm: "apps", label: "Apps", items: apps });
		}
		const plugins = pluginMatches
			.filter((e) => !e.kinds.includes("companion"))
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((e) => ({
				id: e.id,
				name: e.name,
				description: e.description || null,
				tag: e.kinds[0] ?? null,
			}));
		if (plugins.length > 0) {
			result.push({ realm: "plugins", label: "Plugins", items: plugins });
		}

		const agents = (agentsQuery.data ?? [])
			.filter((a) => matches(lower, a.name, a.description, a.engine))
			.slice(0, PER_REALM_LIMIT)
			.map<StoreSearchItem>((a) => ({
				id: a.id,
				name: a.name,
				description: a.description,
				tag: a.engine,
			}));
		if (agents.length > 0) {
			result.push({ realm: "agents", label: "Agents", items: agents });
		}

		// Render order mirrors the nav rail: Apps, Plugins, Models, Skills, MCP,
		// Agents.
		const order: StoreSearchRealm[] = [
			"apps",
			"plugins",
			"models",
			"skills",
			"mcp",
			"agents",
		];
		return result.sort(
			(a, b) => order.indexOf(a.realm) - order.indexOf(b.realm)
		);
	}, [
		enabled,
		lower,
		modelsQuery.data,
		skillsQuery.data,
		mcpQuery.data,
		appsQuery.data,
		agentsQuery.data,
	]);

	const loading =
		enabled &&
		(modelsQuery.isLoading ||
			skillsQuery.isLoading ||
			mcpQuery.isLoading ||
			appsQuery.isLoading ||
			agentsQuery.isLoading);

	const isError =
		enabled &&
		(modelsQuery.isError ||
			skillsQuery.isError ||
			mcpQuery.isError ||
			appsQuery.isError ||
			agentsQuery.isError);

	const refetch = () =>
		Promise.all([
			modelsQuery.refetch(),
			skillsQuery.refetch(),
			mcpQuery.refetch(),
			appsQuery.refetch(),
			agentsQuery.refetch(),
		]);

	return {
		groups,
		hasQuery: enabled,
		isEmpty: groups.length === 0,
		loading,
		isError,
		refetch,
	};
}
