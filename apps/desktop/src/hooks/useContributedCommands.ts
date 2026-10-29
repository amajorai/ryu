import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
// apps/desktop/src/hooks/useContributedCommands.ts
//
// Feeds the command palette the app-registered sidebar contributions so the shell
// doesn't hardcode them: every `sidebar_buttons` entry becomes a navigate command,
// and every `sidebar_sections` entry's live items (meeting notes, canvas docs, …)
// become searchable rows under the section's name. The section fetch reuses the
// exact declarative pattern the sidebar's DynamicSidebarSection uses — `toTarget`
// → authed `fetch(apiUrl(...))` → `sourceItemsFromResponse` — so a section that
// lists in the sidebar is searchable in the palette with zero extra wiring.

import {
	contributionSourceRequest,
	type SourceItem,
	sourceItemsFromResponse,
	type ViewSource,
} from "@ryu/app-host/views";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { usePluginContributions } from "./usePluginContributions.ts";

interface FetchableSection {
	section: PluginSidebarSection;
	source: ViewSource;
	sourceRequest: { method: "GET"; path: string };
}

/** One contributed section's fetched items, ready to render as command rows. */
export interface ContributedSectionItems {
	icon?: string;
	items: SourceItem[];
	/** Route template (`/meetings/{{item.id}}`) an item navigates to on select. */
	itemTarget?: string;
	plugin: string;
	sectionId: string;
	/** The section's display name — becomes the command group heading. */
	title: string;
}

/**
 * Fetch the live items of every app-contributed sidebar section, so the command
 * palette can search them. `enabled` gates the network — pass the palette's open
 * state so nothing fetches until the user opens it. Results are cached (staleTime)
 * so reopening is instant.
 */
export function useContributedSectionItems(
	enabled: boolean
): ContributedSectionItems[] {
	const { sidebar_sections: sections } = usePluginContributions();
	const node = useActiveNode();
	const target = toTarget(node);
	const { token, url, userJwt } = target;

	// Only sections whose declarative source points at a Core API path are
	// fetchable here (the same guard the sidebar applies); the rest carry no
	// listable items and are skipped.
	const fetchable = useMemo<FetchableSection[]>(
		() =>
			sections.flatMap((section) => {
				const source = pluginSidebarSpec(section)?.source;
				const sourceRequest = contributionSourceRequest(section, source);
				return source && sourceRequest
					? [{ section, source, sourceRequest }]
					: [];
			}),
		[sections]
	);

	const queries = useMemo(
		() =>
			fetchable.map(({ section, source, sourceRequest }) => ({
				queryKey: [
					"command-section-items",
					url,
					token,
					userJwt,
					section.plugin,
					section.id,
					sourceRequest.path,
				],
				queryFn: async ({ signal }: { signal: AbortSignal }) => {
					const requestTarget = { url, token, userJwt };
					const resp = await fetch(apiUrl(requestTarget, sourceRequest.path), {
						method: sourceRequest.method,
						signal,
						headers: await requestHeaders(requestTarget),
					});
					if (!resp.ok) {
						return [];
					}
					return sourceItemsFromResponse(source, await resp.json());
				},
				enabled,
				staleTime: 30_000,
			})),
		[enabled, fetchable, token, url, userJwt]
	);

	const results = useQueries({ queries });

	return useMemo(
		() =>
			fetchable.map(({ section }, index) => ({
				sectionId: section.id,
				plugin: section.plugin,
				title: section.title,
				icon: section.icon,
				itemTarget: pluginSidebarSpec(section)?.itemTarget,
				items: results[index]?.data ?? [],
			})),
		[fetchable, results]
	);
}
