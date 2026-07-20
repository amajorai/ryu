// apps/desktop/src/hooks/useStoreHome.ts
//
// The data behind the Store's "Home" tab — an app-store landing feed that pulls
// together, in one place, a curated featured rail plus a "row per realm" of the
// most relevant items to browse. This is the "featured + algorithmic mix": the
// featured rail is admin-curated (control-plane /api/marketplace/featured), while
// each realm row is the realm's own default ranking (trending models, featured
// skills, recommended agents, the plugin catalog, the MCP registry).
//
// Like useStoreSearch this is a ROUTER, not an installer: it only shapes the
// browse feed, and the Home tab hands a click back to the shell to open that
// realm's own tab (where the real detail + install flow lives). So no install
// logic is duplicated here.
//
// Two API planes feed it: the node realms (Models/Skills/MCP/Agents/Plugins) hit
// Core (:7980) via TanStack Query — reusing the sections' query keys where they
// exist so the cache dedupes — and the featured rail hits the control-plane money
// layer (:3000). The featured rail degrades to empty on any error (signed out, no
// org, network) so a Core-only home is never blocked by the money layer.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchAgentCatalog } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchFeatured,
	type MarketplaceCard,
	type MarketplaceKind,
} from "@/src/lib/api/marketplace.ts";
import { searchMcpCatalog } from "@/src/lib/api/mcp.ts";
import { searchModels } from "@/src/lib/api/models.ts";
import { fetchAppsCatalog } from "@/src/lib/api/plugins.ts";
import { searchSkills } from "@/src/lib/api/skills.ts";
import { useActiveNode } from "./useActiveNode.ts";
import type { StoreSearchRealm } from "./useStoreSearch.ts";

// Each home row is a browse teaser, not the full list — the realm's own tab is
// where you go for depth ("See all" carries you there).
const PER_ROW_LIMIT = 12;
const FEATURED_LIMIT = 12;

/** One normalized card in a home row, realm-agnostic so rows render uniformly. */
export interface HomeCard {
	description: string | null;
	/** Resolvable logo URL, or null to fall back to the item's initial. */
	iconUrl: string | null;
	id: string;
	name: string;
	/** Short kind/format/engine chip. */
	tag: string | null;
}

/** A realm's row: a header (that opens the realm's tab) and its teaser cards. */
export interface HomeRow {
	items: HomeCard[];
	label: string;
	realm: StoreSearchRealm;
}

/** A curated featured item, carrying its marketplace kind so a click can route. */
export interface HomeFeaturedItem {
	card: MarketplaceCard;
	/** The Store realm this kind maps to, for routing a click. */
	realm: StoreSearchRealm;
}

export interface UseStoreHomeResult {
	/** Admin-curated cross-kind rail (empty when uncurated / money layer is off). */
	featured: HomeFeaturedItem[];
	/** True while at least one realm row is still loading its first page. */
	loading: boolean;
	/** The per-realm browse rows, in display order (empty rows omitted). */
	rows: HomeRow[];
}

/** Marketplace kind → the Store realm/section that browses it. Marketplace
 *  "plugin" cards route to the Plugins section (third-party marketplace items
 *  are overwhelmingly non-companion plugins). */
const KIND_TO_REALM: Record<MarketplaceKind, StoreSearchRealm> = {
	plugin: "plugins",
	skill: "skills",
	model: "models",
	mcp: "mcp",
};

export function useStoreHome(): UseStoreHomeResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	// Node realms — Core (:7980). Each uses the realm's default ranking with no
	// query, which is exactly the "browse the best of this realm" feed we want.
	const modelsQuery = useQuery({
		queryKey: ["store-home", "models", url],
		queryFn: () =>
			searchModels({ url, token }, { sort: "trending", limit: PER_ROW_LIMIT }),
	});

	const skillsQuery = useQuery({
		queryKey: ["store-home", "skills", url],
		queryFn: () => searchSkills({ url, token }, { limit: PER_ROW_LIMIT }),
	});

	const mcpQuery = useQuery({
		queryKey: ["store-home", "mcp", url],
		queryFn: () => searchMcpCatalog({ url, token }, { limit: PER_ROW_LIMIT }),
	});

	// Plugins + Agents have no search endpoint — reuse the sections' full-catalog
	// query keys so the cache dedupes with their tabs instead of double-fetching.
	const appsQuery = useQuery({
		queryKey: ["apps", "catalog", url],
		queryFn: () => fetchAppsCatalog({ url, token }),
	});

	const agentsQuery = useQuery({
		queryKey: ["agents", "catalog", url],
		queryFn: () => fetchAgentCatalog({ url, token }),
	});

	// Curated featured rail — control-plane (:3000). Fails soft to an empty rail so
	// a signed-out / org-less / offline user still sees the Core browse feed.
	const featuredQuery = useQuery({
		queryKey: ["store-home", "featured"],
		queryFn: async () => {
			try {
				return await fetchFeatured(undefined, FEATURED_LIMIT);
			} catch {
				return [] as MarketplaceCard[];
			}
		},
		staleTime: 5 * 60 * 1000,
	});

	const featured = useMemo<HomeFeaturedItem[]>(
		() =>
			(featuredQuery.data ?? []).map((card) => ({
				card,
				realm: KIND_TO_REALM[card.kind],
			})),
		[featuredQuery.data]
	);

	const rows = useMemo<HomeRow[]>(() => {
		const result: HomeRow[] = [];

		const skills = (skillsQuery.data ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((s) => ({
				id: s.id,
				name: s.name,
				description: s.source || null,
				tag: "Skill",
				iconUrl: null,
			}));
		if (skills.length > 0) {
			result.push({ realm: "skills", label: "Featured skills", items: skills });
		}

		const models = (modelsQuery.data?.models ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((m) => ({
				id: m.id,
				name: m.name,
				description: m.author || null,
				tag: m.format ? m.format.toUpperCase() : null,
				iconUrl: null,
			}));
		if (models.length > 0) {
			result.push({ realm: "models", label: "Popular models", items: models });
		}

		const agents = (agentsQuery.data ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((a) => ({
				id: a.id,
				name: a.name,
				description: a.description,
				tag: a.engine,
				iconUrl: a.iconUrl,
			}));
		if (agents.length > 0) {
			result.push({ realm: "agents", label: "Agents", items: agents });
		}

		// One catalog fetch, split by kind: companion-UI plugins are the "Apps"
		// row, the rest the "Plugins" row — mirroring the Store's two sections.
		const catalog = appsQuery.data ?? [];
		const apps = catalog
			.filter((e) => e.kinds.includes("companion"))
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((e) => ({
				id: e.id,
				name: e.name,
				description: e.description || null,
				tag: e.kinds[0] ?? null,
				iconUrl: null,
			}));
		if (apps.length > 0) {
			result.push({ realm: "apps", label: "Apps", items: apps });
		}

		const plugins = catalog
			.filter((e) => !e.kinds.includes("companion"))
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((e) => ({
				id: e.id,
				name: e.name,
				description: e.description || null,
				tag: e.kinds[0] ?? null,
				iconUrl: null,
			}));
		if (plugins.length > 0) {
			result.push({ realm: "plugins", label: "Plugins", items: plugins });
		}

		const mcp = (mcpQuery.data?.servers ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				tag: s.transports[0] ?? "MCP",
				iconUrl: null,
			}));
		if (mcp.length > 0) {
			result.push({ realm: "mcp", label: "MCP servers", items: mcp });
		}

		return result;
	}, [
		skillsQuery.data,
		modelsQuery.data,
		agentsQuery.data,
		appsQuery.data,
		mcpQuery.data,
	]);

	const loading =
		modelsQuery.isLoading ||
		skillsQuery.isLoading ||
		mcpQuery.isLoading ||
		appsQuery.isLoading ||
		agentsQuery.isLoading;

	return { featured, rows, loading };
}
