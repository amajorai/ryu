import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useSidebarSectionSources } from "@/src/hooks/useSidebarSectionSource.ts";
import { callMcpTool, fetchMcpTools } from "@/src/lib/api/mcp.ts";
import { listOutputStyles } from "@/src/lib/api/output-styles.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import {
	isMcpMentionTool,
	mcpMentionSources,
} from "@/src/lib/mentions/mcp-resources.ts";
import {
	buildContributedMentionSources,
	buildOutputStyleMentionSources,
	buildSpacePageMentionSources,
} from "@/src/lib/mentions/resources.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { spaceDocumentListQueryOptions } from "@/src/lib/space-document-list-query.ts";

/** The dynamic resources added to the shared chat @ directory. */
export interface MentionableResources {
	appItems: ReturnType<typeof buildContributedMentionSources>;
	error?: string;
	outputStyles: ReturnType<typeof buildOutputStyleMentionSources>;
	pages: ReturnType<typeof buildSpacePageMentionSources>;
}

/**
 * Join the existing host-owned list bridges to the chat mention directory.
 *
 * Sidebar-section queries intentionally come from `useSidebarSectionSources`, so
 * Chat, Sidebar, and Library share the same React Query cache and response mapper.
 * Space documents and personality profiles use the same active-node cache boundary as their
 * existing surfaces; a missing/old endpoint simply contributes no candidates.
 */
export function useMentionableResources(
	sections: PluginSidebarSection[],
	options?: { agentId?: string; query?: string | null }
): MentionableResources {
	const activeNode = useActiveNode();
	const {
		error: spacesError,
		documentRevisions,
		loading: spacesLoading,
		spaces,
	} = useSpacesContext();
	const contributedSourceData = useSidebarSectionSources(sections);
	const target = useMemo(
		() => ({
			token: activeNode.token ?? null,
			url: activeNode.url,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.token, activeNode.url, activeNode.userJwt]
	);
	const documentQueryOptions = useMemo(
		() =>
			spaces.map((space) => ({
				...spaceDocumentListQueryOptions(
					target,
					space.id,
					documentRevisions.get(space.id) ?? 0
				),
				enabled: !(spacesLoading || spacesError),
			})),
		[documentRevisions, spaces, spacesError, spacesLoading, target]
	);
	const [query, setQuery] = useState<string | null>(null);
	const [remoteItems, setRemoteItems] = useState<
		ReturnType<typeof mcpMentionSources>
	>([]);
	useEffect(() => {
		setRemoteItems([]);
	}, [target.url, target.token, target.userJwt, options?.agentId]);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(options?.query ?? null), 250);
		return () => clearTimeout(timer);
	}, [options?.query]);
	const remoteMentions = useQuery(
		{
			queryKey: [
				"mcp-mention-search",
				target.url,
				target.token,
				target.userJwt,
				options?.agentId,
				query,
			],
			enabled: Boolean(options?.agentId) && query !== null,
			retry: false,
			queryFn: async ({ signal }) => {
				if (!options?.agentId || query === null) {
					return [];
				}
				const tools = (
					await fetchMcpTools(target, options.agentId, signal)
				).filter(isMcpMentionTool);
				const results = await Promise.all(
					tools.slice(0, 8).map(async (tool) => {
						const result = await callMcpTool(target, {
							tool: tool.id,
							agentId: options.agentId ?? "",
							arguments: { query },
						});
						if (!result.ok) {
							throw new Error(
								result.error ?? `Mention search failed for ${tool.server}`
							);
						}
						return mcpMentionSources(tool, result.output);
					})
				);
				return results.flat();
			},
		},
		queryClient
	);
	useEffect(() => {
		if (!remoteMentions.data?.length) {
			return;
		}
		setRemoteItems((previous) => {
			const merged = new Map(previous.map((item) => [item.id, item]));
			for (const item of remoteMentions.data ?? []) {
				merged.set(item.id, item);
			}
			return [...merged.values()].slice(-500);
		});
	}, [remoteMentions.data]);
	const documentQueries = useQueries(
		{ queries: documentQueryOptions },
		queryClient
	);
	const { data: outputStyleData } = useQuery({
		queryFn: () =>
			listOutputStyles({
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
				url: activeNode.url,
			}),
		queryKey: [
			"output-styles",
			activeNode.url,
			activeNode.token ?? null,
			activeNode.userJwt ?? null,
		],
		retry: false,
		staleTime: 30_000,
	});

	return useMemo(
		() => ({
			appItems: [
				...buildContributedMentionSources(contributedSourceData),
				...remoteItems,
			],
			error:
				remoteMentions.error instanceof Error
					? remoteMentions.error.message
					: undefined,
			outputStyles: buildOutputStyleMentionSources(
				outputStyleData?.styles ?? []
			),
			pages: buildSpacePageMentionSources(
				spaces,
				documentQueries.map((query) => query.data ?? [])
			),
		}),
		[
			contributedSourceData,
			documentQueries,
			outputStyleData?.styles,
			spaces,
			remoteItems,
			remoteMentions.error,
		]
	);
}
