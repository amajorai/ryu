import {
	contributionSourceRequest,
	type StoreCatalogItem,
	storeItemsFromResponse,
	storeTotalFromResponse,
} from "@ryu/app-host/views";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import { pluginStoreSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import { pluginValueSchema } from "@/src/lib/api/plugin-wire-values.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";

export interface ContributedStoreCatalogData {
	items: StoreCatalogItem[];
	total: number | null;
}

/** Build the single cached source query shared by the tab and its nav count. */
export function contributedStoreCatalogQuery(
	tab: PluginStoreTab,
	target: ReturnType<typeof toTarget>,
	enabled: boolean
) {
	const spec = pluginStoreSpec(tab);
	const source = spec?.source;
	const sourceRequest = contributionSourceRequest(tab, source);
	return {
		enabled: enabled && sourceRequest !== null,
		queryKey: [
			"store-tab-catalog",
			tab.plugin,
			tab.id,
			target.url,
			target.token,
			target.userJwt ?? null,
			sourceRequest?.path ?? "",
		],
		queryFn: async (): Promise<ContributedStoreCatalogData> => {
			if (!(spec && source && sourceRequest)) {
				return { items: [], total: null };
			}
			const response = await fetch(apiUrl(target, sourceRequest.path), {
				method: sourceRequest.method,
				headers: await requestHeaders(target),
			});
			if (!response.ok) {
				throw new Error(`${sourceRequest.path} failed: ${response.status}`);
			}
			const payload = pluginValueSchema.parse(await response.json());
			return {
				items: storeItemsFromResponse(spec, payload),
				total: storeTotalFromResponse(spec, payload),
			};
		},
	};
}

/** Read one app-registered Store tab through the host's authenticated Core seam. */
export function useContributedStoreCatalog(
	tab: PluginStoreTab,
	enabled = tab.app_enabled
) {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const queryOptions = useMemo(
		() => contributedStoreCatalogQuery(tab, target, enabled),
		[enabled, tab, target]
	);
	return useQuery(queryOptions);
}
