import {
	ALL_PLUGIN_SOURCES_ID,
	ALL_SKILL_SOURCES_ID,
} from "@ryu/marketplace/catalog/types";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { agentCatalogQuery } from "@/src/hooks/useAgentsCatalog.ts";
import { pluginCatalogQuery } from "@/src/hooks/useAppsCatalog.ts";
import { contributedStoreCatalogQuery } from "@/src/hooks/useContributedStoreCatalog.ts";
import { integrationsListQuery } from "@/src/hooks/useIntegrationsCatalog.ts";
import { mcpListQuery, mcpSourcesQuery } from "@/src/hooks/useMcpCatalog.ts";
import {
	MODEL_LIST_DEFAULTS,
	modelListQuery,
} from "@/src/hooks/useModelCatalog.ts";
import { MODEL_CATEGORY_TASK } from "@/src/lib/api/models.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { searchSkillCatalogPage } from "@/src/lib/api/skills.ts";
import { fetchCatalog } from "@/src/lib/services-api.ts";
import { useSandboxBackends } from "./useSandboxBackends.ts";

interface CountablePage {
	nextCursor?: string | null;
	total?: number | null;
}

function finiteTotal(value: number | null | undefined): number | undefined {
	return isNativeNumber(value) && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

/** Only use a row length when the producer explicitly says the page is complete. */
function totalFromPages<T extends CountablePage>(
	pages: T[] | undefined
): number | undefined {
	const last = pages?.at(-1);
	const explicit = finiteTotal(last?.total);
	if (explicit !== undefined) {
		return explicit;
	}
	return undefined;
}

function pluginKindTotal(
	pages:
		| Array<{
				appTotal?: number | null;
				entries: Array<{ type?: string; kinds?: string[] }>;
				pluginTotal?: number | null;
				total?: number | null;
		  }>
		| undefined,
	kind: "app" | "plugin"
): number | undefined {
	const last = pages?.at(-1);
	const declared = finiteTotal(
		kind === "app" ? last?.appTotal : last?.pluginTotal
	);
	if (declared !== undefined) {
		return declared;
	}
	const total = finiteTotal(last?.total);
	if (total === undefined || !last || last.entries.length !== total) {
		return undefined;
	}
	return last.entries.filter((entry) =>
		kind === "app"
			? entry.type === "app" || entry.kinds?.includes("companion")
			: entry.type !== "app" && !entry.kinds?.includes("companion")
	).length;
}

/**
 * Counts for the Store tab strip. Every catalog count comes from a catalog-level
 * total, never from the visible first page. If a remote producer does not expose
 * a total yet, the count stays absent instead of presenting a plausible lie.
 */
export function useStoreSectionCounts(
	contributedTabs: PluginStoreTab[]
): Record<string, number | undefined> {
	const node = useActiveNode();
	const target = useMemo(
		() => ({ url: node.url, token: node.token, userJwt: node.userJwt ?? null }),
		[node.url, node.token, node.userJwt]
	);

	const pluginsQuery = useInfiniteQuery({
		...pluginCatalogQuery(target, {
			query: "",
			source: ALL_PLUGIN_SOURCES_ID,
		}),
		staleTime: 5 * 60_000,
	});
	const communityPluginsQuery = useInfiniteQuery({
		...pluginCatalogQuery(target, {
			origin: "community",
			query: "",
			source: "",
		}),
		staleTime: 5 * 60_000,
	});
	const integrationsQuery = useInfiniteQuery({
		...integrationsListQuery(target, { query: "" }),
		staleTime: 5 * 60_000,
	});
	const agentsQuery = useQuery({
		...agentCatalogQuery(target),
		staleTime: 5 * 60_000,
	});
	const skillsQuery = useQuery({
		queryKey: ["skills", "count", target.url],
		queryFn: () =>
			searchSkillCatalogPage(target, {
				installedOnly: false,
				limit: 120,
				query: "",
				source: ALL_SKILL_SOURCES_ID,
			}),
		staleTime: 5 * 60_000,
	});
	const mcpSourceQuery = useQuery({
		...mcpSourcesQuery(target),
		staleTime: 5 * 60_000,
	});
	const mcpQuery = useInfiniteQuery({
		...mcpListQuery(target, {
			query: "",
			source: mcpSourceQuery.data?.active ?? "",
		}),
		staleTime: 5 * 60_000,
	});
	const modelsQuery = useInfiniteQuery({
		...modelListQuery(target, {
			...MODEL_LIST_DEFAULTS,
			task: MODEL_CATEGORY_TASK[MODEL_LIST_DEFAULTS.category],
		}),
		staleTime: 5 * 60_000,
	});
	const enginesQuery = useQuery({
		queryKey: ["catalog", "sidecars", target.url],
		queryFn: () =>
			fetchCatalog(target.url, target.token, undefined, target.userJwt),
		staleTime: 5 * 60_000,
	});
	const sandbox = useSandboxBackends();
	const contributedQueryOptions = useMemo(
		() =>
			contributedTabs.map((tab) =>
				contributedStoreCatalogQuery(tab, target, tab.app_enabled)
			),
		[contributedTabs, target]
	);
	const contributedQueries = useQueries({
		queries: contributedQueryOptions,
	});

	return useMemo(() => {
		const pluginPages = pluginsQuery.data?.pages;
		const communityPages = communityPluginsQuery.data?.pages;
		const pluginTotal = pluginKindTotal(pluginPages, "plugin");
		const appTotal = pluginKindTotal(pluginPages, "app");
		const communityPluginTotal = pluginKindTotal(communityPages, "plugin");
		const communityAppTotal = pluginKindTotal(communityPages, "app");
		const integrationsTotal = totalFromPages(integrationsQuery.data?.pages);
		const skillsTotal = finiteTotal(skillsQuery.data?.total);
		const mcpTotal = totalFromPages(mcpQuery.data?.pages);
		const modelTotal = totalFromPages(modelsQuery.data?.pages);
		const engines = enginesQuery.data ?? [];
		const engineTotal =
			engines.length + sandbox.backends.length > 0
				? engines.filter((item) =>
						["provider", "media", "voice", "embedding"].includes(item.category)
					).length + sandbox.backends.length
				: enginesQuery.isLoading || sandbox.loading
					? undefined
					: 0;
		const counts = new Map<string, number | undefined>(
			Object.entries({
				agents: agentsQuery.data?.length,
				apps:
					appTotal === undefined && communityAppTotal === undefined
						? undefined
						: (appTotal ?? 0) + (communityAppTotal ?? 0),
				engines: engineTotal,
				integrations: integrationsTotal,
				mcp: mcpTotal,
				models: modelTotal,
				plugins:
					pluginTotal === undefined && communityPluginTotal === undefined
						? undefined
						: (pluginTotal ?? 0) + (communityPluginTotal ?? 0),
				skills: skillsTotal,
			})
		);
		for (const [index, tab] of contributedTabs.entries()) {
			counts.set(
				`plugin:${tab.plugin}:${tab.id}`,
				contributedQueries[index]?.data?.total ?? undefined
			);
		}
		return Object.fromEntries(counts);
	}, [
		agentsQuery.data,
		communityPluginsQuery.data?.pages,
		contributedQueries,
		contributedTabs,
		enginesQuery.data,
		enginesQuery.isLoading,
		integrationsQuery.data?.pages,
		mcpQuery.data?.pages,
		modelsQuery.data?.pages,
		pluginsQuery.data?.pages,
		sandbox.backends,
		sandbox.loading,
		skillsQuery.data?.total,
	]);
}
