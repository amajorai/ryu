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

import { ALL_SKILL_SOURCES_ID } from "@ryu/marketplace/catalog/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { fetchAgentCatalog } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { searchMcpCatalog } from "@/src/lib/api/mcp.ts";
import { searchModels } from "@/src/lib/api/models.ts";
import { fetchApps, fetchAppsCatalog } from "@/src/lib/api/plugins.ts";
import { searchSkills } from "@/src/lib/api/skills.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useStoreListingAllowed } from "./useFeatureFlag.ts";

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
	refetch: ReturnType<typeof useStoreSearch>["refetch"];
}

function matches(
	query: string,
	...fields: (string | null | undefined)[]
): boolean {
	return fields.some((f) => f?.toLowerCase().includes(query));
}

export function useStoreSearch(query: string) {
	const activeNode = useActiveNode();
	const target = useMemo<ApiTarget>(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const { url } = target;

	// The same rollout discovery gate the Apps tab applies: a gated, uninstalled
	// app must not surface here either.
	const listingAllowed = useStoreListingAllowed();

	const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
	const enabled = debounced.length > 0;
	const lower = debounced.toLowerCase();

	const modelsQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["store-search", "models", url, debounced],
				queryFn: () =>
					searchModels(target, {
						query: debounced,
						limit: PER_REALM_LIMIT,
					}),
				enabled,
			}),
			[target, url, debounced, enabled]
		)
	);

	const skillsQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["store-search", "skills", url, debounced],
				queryFn: () =>
					searchSkills(target, {
						query: debounced,
						limit: PER_REALM_LIMIT,
						source: ALL_SKILL_SOURCES_ID,
					}),
				enabled,
			}),
			[target, url, debounced, enabled]
		)
	);

	const mcpQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["store-search", "mcp", url, debounced],
				queryFn: () =>
					searchMcpCatalog(target, {
						query: debounced,
						limit: PER_REALM_LIMIT,
					}),
				enabled,
			}),
			[target, url, debounced, enabled]
		)
	);

	// Plugins + Agents have no search endpoint: fetch the full catalog once (shared
	// query key with their sections → cache-deduped) and filter in-memory.
	const appsQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["apps", "catalog", url],
				queryFn: () => fetchAppsCatalog(target),
				enabled,
			}),
			[target, url, enabled]
		)
	);

	// The catalog carries no installed flag, so the rollout gate's "installed
	// copies always show" rule joins it against the lifecycle records, under the
	// same key `useAppsCatalog` and Store Home use (one shared fetch).
	const appsInstalledQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["apps", "list", url],
				queryFn: () => fetchApps(target),
				enabled,
			}),
			[target, url, enabled]
		)
	);

	const agentsQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["agents", "catalog", url],
				queryFn: () => fetchAgentCatalog(target),
				enabled,
			}),
			[target, url, enabled]
		)
	);

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

		// One catalog fetch, split into the "Apps" vs "Plugins" realms exactly the
		// way the Store's two sections do: prefer the explicit `type`
		// discriminator, and fall back to the legacy "ships a Companion runnable"
		// derivation only for an older wire that predates `type`.
		//
		// Preferring `type` is not a nicety — it is the whole rule. An app claims a
		// UI DESTINATION, and Core's `manifest_declares_destination` reads three
		// keys for that (a companion runnable, a `contributes.dock_panels` entry in
		// any panel mode, or a top-level `contributes.sidebar_buttons[].target`).
		// `kinds` carries only the first of the three, so deriving here filed
		// Browser, Simulator, CRM, UGC, Dashboards, Drafts and Mission Control into
		// the Plugins realm while the Store tabs — which do read `type` — showed
		// them under Apps. Same rule, one source; see `isCompanionApp` in
		// packages/marketplace/src/catalog/apps-catalog-section.tsx.
		const installedIds = new Set(
			(appsInstalledQuery.data ?? [])
				.filter((a) => a.installed)
				.map((a) => a.id)
		);
		const pluginMatches = (appsQuery.data ?? []).filter(
			(e) =>
				listingAllowed({ id: e.id, installed: installedIds.has(e.id) }) &&
				matches(
					lower,
					e.name,
					e.description,
					e.kinds.join(" "),
					e.tags.join(" ")
				)
		);
		const isApp = (e: (typeof pluginMatches)[number]) =>
			e.type ? e.type === "app" : e.kinds.includes("companion");
		const apps = pluginMatches
			.filter((e) => isApp(e))
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
			.filter((e) => !isApp(e))
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
		appsInstalledQuery.data,
		agentsQuery.data,
		listingAllowed,
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

	const refetch = useCallback(
		() =>
			Promise.all([
				modelsQuery.refetch(),
				skillsQuery.refetch(),
				mcpQuery.refetch(),
				appsQuery.refetch(),
				agentsQuery.refetch(),
			]),
		[
			modelsQuery.refetch,
			skillsQuery.refetch,
			mcpQuery.refetch,
			appsQuery.refetch,
			agentsQuery.refetch,
		]
	);

	return {
		groups,
		hasQuery: enabled,
		isEmpty: groups.length === 0,
		loading,
		isError,
		refetch,
	};
}
