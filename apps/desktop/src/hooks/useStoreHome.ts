// apps/desktop/src/hooks/useStoreHome.ts
//
// The data behind the Store's "Home" tab — an app-store landing feed that pulls
// together, in one place, the For you recommendations plus a "row per realm" of
// the most relevant items to browse. Each realm row is the realm's own default
// ranking (trending models, featured skills, recommended agents, the plugin
// catalog, and the MCP registry).
//
// It routes AND it adds. Routing came first — a click opens the realm's own tab,
// where the full detail flow lives — but "router, not installer" was taken to
// mean the rows could carry no action at all, and the result was a landing page
// on which nothing could be done: six shelves of things to add, and no way to add
// any of them without first learning which tab each one lived in.
//
// So each row carries a one-call add for its realm, and nothing else: no detail,
// no grant dialog, no enable. Anything that needs a decision still routes. The
// busy flag is NOT a sixth private copy of "installing" — it is written into the
// shared `useInstallStore`, the same store the Apps tab's catalog hook writes, so
// adding an app here and looking at its card there agree.
//
// The node realms (Models/Skills/MCP/Agents/Plugins) hit Core (:7980) via TanStack
// Query — reusing the sections' query keys where they exist so the cache dedupes.

import {
	type NormalizedRecommendations,
	normalizeRecommendations,
	type RecommendationWire,
} from "@ryu/marketplace/catalog/recommendations";
import {
	ALL_SKILL_SOURCES_ID,
	type CardDither,
} from "@ryu/marketplace/catalog/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { fetchAgentCatalog, installAgent } from "@/src/lib/api/agents.ts";
import { type ApiTarget, request } from "@/src/lib/api/client.ts";
import {
	type GatewayConfigPatch,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { installMcpServer, searchMcpCatalog } from "@/src/lib/api/mcp.ts";
import {
	installModelSnapshot,
	type ModelFormat,
	searchModels,
} from "@/src/lib/api/models.ts";
import {
	fetchApps,
	fetchAppsCatalog,
	installApp,
	installPluginFromCatalog,
} from "@/src/lib/api/plugins.ts";
import { searchSkills } from "@/src/lib/api/skills.ts";
import { beginInstall, endInstall } from "@/src/store/useInstallStore.ts";
import { useActiveNode } from "./useActiveNode.ts";
import type { StoreSearchRealm } from "./useStoreSearch.ts";

// Each home row is a browse teaser, not the full list — the realm's own tab is
// where you go for depth ("See all" carries you there).
const PER_ROW_LIMIT = 12;

/** One normalized card in a home row, realm-agnostic so rows render uniformly. */
export interface HomeCard {
	/** Ships with Ryu, apps/plugins only: its add is a local lifecycle write
	 *  rather than a catalog fetch, and Core has two endpoints for that. */
	builtIn: boolean;
	description: string | null;
	/** The listing's dithered icon wash (`icon_dither`), when it declares one.
	 *  Carried so a Home card paints the SAME tile as the card in the realm's own
	 *  tab — without it every Home row fell back to the generative placeholder and
	 *  Home, the first tab anyone sees, was the one place the icons were wrong. */
	dither: CardDither | null;
	/** ACP registry id and engine — AGENTS ROW ONLY, and null everywhere else.
	 *
	 *  They exist so Home can render the same themed brand mark the Agents cards
	 *  use (`AgentCatalogLogo`). Home used to hand the agent's raw CDN `iconUrl`
	 *  straight to the icon square, and those marks are solid black SVGs: Claude
	 *  and Codex rendered black-on-black on a dark theme. The Agents tab never had
	 *  the bug because it goes through the logo component, which pairs a
	 *  light/dark asset for the branded engines and `dark:invert`s the rest. */
	engine?: string | null;
	/** Icon-primitive glyph id (`icon`), painted inside the tile. */
	iconId: string | null;
	/** Resolvable logo URL, or null to fall back to the item's initial. */
	iconUrl: string | null;
	id: string;
	/** Already on this node — the row shows an "Added" pill instead of a button. */
	installed: boolean;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	/** Weight format, models only: their add endpoint needs it to pick a file. */
	modelFormat: ModelFormat | null;
	name: string;
	registryId?: string | null;
	/** Short kind/format/engine chip. */
	tag: string | null;
}

/** A realm's row: a header (that opens the realm's tab), its teaser cards, and
 *  the realm's own one-call add. The add lives on the ROW, not on the card,
 *  because it is a property of the realm — five realms, five endpoints — and
 *  hanging it off each card would be five hundred identical closures. */
export interface HomeRow {
	/** Add one card from this row. Rejects with the realm client's own error. */
	add: (card: HomeCard) => Promise<void>;
	items: HomeCard[];
	realm: StoreSearchRealm;
}

export interface UseStoreHomeResult {
	forYou: StoreForYou;
	/** True while at least one realm row is still loading its first page. */
	loading: boolean;
	/** The per-realm browse rows, in display order (empty rows omitted). */
	rows: HomeRow[];
}

export interface StoreForYou {
	data: NormalizedRecommendations;
	loading: boolean;
	onCadenceChange: (cadence: NormalizedRecommendations["cadence"]) => void;
	onHide: () => void;
	onReenable: () => void;
	onRefresh: () => void;
}

export function useStoreHome(): UseStoreHomeResult {
	const { installCatalogSkill } = useSkillDistributionFlow();
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;

	// Node realms — Core (:7980). Each uses the realm's default ranking with no
	// query, which is exactly the "browse the best of this realm" feed we want.
	const modelsQuery = useQuery({
		queryKey: ["store-home", "models", url],
		queryFn: () =>
			searchModels(
				{ url, token, userJwt },
				{ sort: "trending", limit: PER_ROW_LIMIT }
			),
	});

	const skillsQuery = useQuery({
		queryKey: ["store-home", "skills", url],
		queryFn: () =>
			searchSkills(
				{ url, token, userJwt },
				{ limit: PER_ROW_LIMIT, source: ALL_SKILL_SOURCES_ID }
			),
	});

	const mcpQuery = useQuery({
		queryKey: ["store-home", "mcp", url],
		queryFn: () =>
			searchMcpCatalog({ url, token, userJwt }, { limit: PER_ROW_LIMIT }),
	});

	// Plugins + Agents have no search endpoint — reuse the sections' full-catalog
	// query keys so the cache dedupes with their tabs instead of double-fetching.
	const appsQuery = useQuery({
		queryKey: ["apps", "catalog", url],
		queryFn: () => fetchAppsCatalog({ url, token, userJwt }),
	});

	const agentsQuery = useQuery({
		queryKey: ["agents", "catalog", url],
		queryFn: () => fetchAgentCatalog({ url, token, userJwt }),
	});

	// The plugin catalog carries discovery metadata only — no installed flag — so
	// the apps/plugins rows join it against the live lifecycle records, exactly as
	// `useAppsCatalog` does. Same query key, so the two share one fetch and can
	// never disagree about what is already on the node.
	const appsInstalledQuery = useQuery({
		queryKey: ["apps", "list", url],
		queryFn: () => fetchApps({ url, token, userJwt }),
	});

	const recommendationsQuery = useQuery({
		queryKey: ["store-home", "recommendations", url],
		queryFn: async () => {
			const wire = await request<RecommendationWire>(
				target,
				"/api/marketplace/recommendations"
			);
			return normalizeRecommendations(wire);
		},
		staleTime: 5 * 60 * 1000,
	});

	// One `add` per realm, each the realm's own single endpoint. Wrapped once here
	// rather than per row so the shared-flag bookkeeping (and the refresh that
	// flips the row to "Added") is written in one place and cannot drift between
	// realms — the exact drift that gave the Store five different owners of
	// "installing" in the first place.
	const qc = useQueryClient();
	const recommendationData =
		recommendationsQuery.data ?? normalizeRecommendations(undefined);
	const refreshRecommendations = useCallback(async () => {
		try {
			await request<RecommendationWire>(
				target,
				"/api/marketplace/recommendations?refresh=true",
				{ method: "POST" }
			);
			await qc.invalidateQueries({
				queryKey: ["store-home", "recommendations", url],
			});
		} catch {
			// Recommendations are an enhancement; the rest of Home remains usable.
		}
	}, [qc, target, url]);
	const setRecommendationHidden = useCallback(
		async (hidden: boolean) => {
			try {
				await request(target, "/api/marketplace/recommendations/preference", {
					body: { hidden },
					method: "PUT",
				});
				await qc.invalidateQueries({
					queryKey: ["store-home", "recommendations", url],
				});
			} catch {
				// A hidden preference failing should not interrupt Store navigation.
			}
		},
		[qc, target, url]
	);
	const setRecommendationCadence = useCallback(
		async (cadence: NormalizedRecommendations["cadence"]) => {
			const patch: GatewayConfigPatch = {
				marketplace_recommendations: {
					cadence,
					enabled: recommendationData.enabled,
				},
			};
			try {
				await updateGatewayConfig(target, patch);
				await qc.invalidateQueries({
					queryKey: ["store-home", "recommendations", url],
				});
			} catch {
				// Gateway policy remains authoritative if this node is temporarily down.
			}
		},
		[qc, recommendationData.enabled, target, url]
	);
	const runAdd = useCallback(
		async (id: string, call: () => Promise<unknown>, keys: unknown[][]) => {
			beginInstall(id);
			try {
				await call();
			} finally {
				// The flag clears even when the add throws — a failed add leaves a row
				// that can be retried, never one stuck mid-spin.
				endInstall(id);
			}
			await Promise.all(
				keys.map((queryKey) => qc.invalidateQueries({ queryKey }))
			).catch(() => undefined);
		},
		[qc]
	);

	const addByRealm = useMemo<
		Record<StoreSearchRealm, (card: HomeCard) => Promise<void>>
	>(() => {
		const plugins = (card: HomeCard) =>
			runAdd(
				card.id,
				() =>
					// Built-ins are already on disk — their add is a lifecycle record, not
					// a download. Anything else has to be fetched from the catalog first.
					card.builtIn
						? installApp({ url, token, userJwt }, card.id)
						: installPluginFromCatalog({ url, token, userJwt }, card.id, null),
				[
					["apps", "list", url],
					["apps", "catalog", url],
					["plugins", "catalog", url],
				]
			);
		return {
			apps: plugins,
			plugins,
			skills: (card) =>
				runAdd(
					card.id,
					() =>
						installCatalogSkill({
							id: card.id,
							source: card.registryId ?? undefined,
						}),
					[["store-home", "skills", url], ["skills"]]
				),
			mcp: (card) =>
				runAdd(
					card.id,
					() => installMcpServer({ url, token, userJwt }, card.id),
					[["store-home", "mcp", url], ["mcp"]]
				),
			agents: (card) =>
				runAdd(card.id, () => installAgent({ url, token, userJwt }, card.id), [
					["agents", "catalog", url],
				]),
			models: (card) =>
				runAdd(
					card.id,
					() =>
						installModelSnapshot(
							{ url, token, userJwt },
							card.id,
							card.modelFormat ?? "gguf"
						),
					[["store-home", "models", url], ["models"]]
				),
		};
	}, [installCatalogSkill, runAdd, url, token]);

	const rows = useMemo<HomeRow[]>(() => {
		const result: HomeRow[] = [];

		const skills = (skillsQuery.data ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((s) => ({
				id: s.id,
				name: s.name,
				description: s.catalogSourceName ?? s.source ?? null,
				tag: "Skill",
				iconId: null,
				iconUrl: null,
				dither: null,
				installed: s.installed,
				builtIn: false,
				modelFormat: null,
				registryId: s.catalogSourceId,
			}));
		if (skills.length > 0) {
			result.push({
				realm: "skills",
				items: skills,
				add: addByRealm.skills,
			});
		}

		const models = (modelsQuery.data?.models ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((m) => ({
				id: m.id,
				name: m.name,
				description: m.author || null,
				tag: m.format ? m.format.toUpperCase() : null,
				iconId: null,
				iconUrl: null,
				dither: null,
				installed: m.installed,
				builtIn: false,
				modelFormat: m.format ?? null,
			}));
		if (models.length > 0) {
			result.push({
				realm: "models",
				items: models,
				add: addByRealm.models,
			});
		}

		const agents = (agentsQuery.data ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((a) => ({
				id: a.id,
				name: a.name,
				description: a.description,
				tag: a.engine,
				iconId: null,
				// Deliberately NULL, with `engine`/`registryId` carried instead: the
				// raw CDN mark is a solid black SVG and must not reach the icon square.
				// StoreHome renders `AgentCatalogLogo` from those two fields, which is
				// the same themed/inverted mark the Agents tab shows.
				iconUrl: null,
				engine: a.engine,
				registryId: a.registryId,
				dither: null,
				// An agent with no prebuilt package for this platform can be browsed
				// but not one-click added; treating it as already added is the honest
				// rendering — the row shows a pill, not a button that would 400.
				installed: a.added || !a.available,
				builtIn: false,
				modelFormat: null,
			}));
		if (agents.length > 0) {
			result.push({
				realm: "agents",
				items: agents,
				add: addByRealm.agents,
			});
		}

		// One catalog fetch, split into the "Apps" vs "Plugins" rows the same way
		// the Store's two sections do: prefer the explicit `type` discriminator,
		// fall back to the legacy "ships a Companion" derivation for older wires.
		const catalog = appsQuery.data ?? [];
		const installedIds = new Set(
			(appsInstalledQuery.data ?? [])
				.filter((a) => a.installed)
				.map((a) => a.id)
		);
		const isApp = (e: (typeof catalog)[number]) =>
			e.type ? e.type === "app" : e.kinds.includes("companion");
		const toPluginCard = (e: (typeof catalog)[number]): HomeCard => ({
			id: e.id,
			name: e.name,
			description: e.description || null,
			tag: e.kinds[0] ?? null,
			iconId: e.icon ?? null,
			iconUrl: e.icon_url ?? null,
			dither: e.icon_dither ?? null,
			installed: installedIds.has(e.id),
			membershipIncluded: Boolean(e.membership_included),
			builtIn: e.source === "built-in",
			modelFormat: null,
		});
		const apps = catalog
			.filter((e) => isApp(e))
			.slice(0, PER_ROW_LIMIT)
			.map(toPluginCard);
		if (apps.length > 0) {
			result.push({
				realm: "apps",
				items: apps,
				add: addByRealm.apps,
			});
		}

		const plugins = catalog
			.filter((e) => !isApp(e))
			.slice(0, PER_ROW_LIMIT)
			.map(toPluginCard);
		if (plugins.length > 0) {
			result.push({
				realm: "plugins",
				items: plugins,
				add: addByRealm.plugins,
			});
		}

		const mcp = (mcpQuery.data?.servers ?? [])
			.slice(0, PER_ROW_LIMIT)
			.map<HomeCard>((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				tag: s.transports[0] ?? "MCP",
				iconId: null,
				iconUrl: null,
				dither: null,
				installed: s.installed,
				builtIn: false,
				modelFormat: null,
			}));
		if (mcp.length > 0) {
			result.push({
				realm: "mcp",
				items: mcp,
				add: addByRealm.mcp,
			});
		}

		return result;
	}, [
		skillsQuery.data,
		modelsQuery.data,
		agentsQuery.data,
		appsQuery.data,
		appsInstalledQuery.data,
		mcpQuery.data,
		addByRealm,
	]);

	const loading =
		modelsQuery.isLoading ||
		skillsQuery.isLoading ||
		mcpQuery.isLoading ||
		appsQuery.isLoading ||
		agentsQuery.isLoading;

	const forYou: StoreForYou = {
		data: recommendationData,
		loading: recommendationsQuery.isLoading,
		onCadenceChange: (cadence) => {
			void setRecommendationCadence(cadence);
		},
		onHide: () => {
			void setRecommendationHidden(true);
		},
		onRefresh: () => {
			void refreshRecommendations();
		},
		onReenable: () => {
			void setRecommendationHidden(false);
		},
	};

	return {
		forYou,
		rows,
		loading,
	};
}
