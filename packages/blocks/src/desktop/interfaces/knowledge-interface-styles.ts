import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	adjacency,
	type KnowledgeGraph,
	type KnowledgeNode,
	type KnowledgeSettings,
	type Layout,
	searchNodes,
} from "./knowledge-model.ts";
import type { KnowledgePalette } from "./knowledge-palette.ts";
import { buildStyles } from "./knowledge-stage.ts";

/**
 * What the graph draws from: per-node styles for the current emphasis
 * (hover, keyboard cursor, search, selection), the search results and the
 * legend of what is visible.
 */
export function useKnowledgeStyles({
	cursor,
	hovered,
	layout,
	ordered,
	palette,
	query,
	selected,
	settings,
	visible,
}: {
	cursor: string | null;
	hovered: string | null;
	layout: Layout;
	ordered: KnowledgeNode[];
	palette: KnowledgePalette;
	query: string;
	selected: string | null;
	settings: KnowledgeSettings;
	visible: KnowledgeGraph;
}) {
	const links = useMemo(() => adjacency(visible.links), [visible]);
	const matches = useMemo(
		() => searchNodes(visible.nodes, query),
		[visible, query]
	);
	const results = useMemo(
		() => ordered.filter((node) => matches.has(node.id)),
		[ordered, matches]
	);
	const emphasisHover = hovered ?? cursor;
	const styles = useMemo(
		() =>
			buildStyles(
				visible,
				layout,
				links,
				palette,
				{
					hovered: emphasisHover,
					matches,
					query: query.trim().length > 0,
					selected,
				},
				settings.nodeSize
			),
		[
			visible,
			layout,
			links,
			palette,
			emphasisHover,
			matches,
			query,
			selected,
			settings.nodeSize,
		]
	);
	const legend = useMemo(() => {
		const statuses = new Set<ThreadStatus>();
		const kinds = new Set<KnowledgeNode["kind"]>();
		const agents: string[] = [];
		for (const node of visible.nodes) {
			kinds.add(node.kind);
			if (node.status) {
				statuses.add(node.status);
			}
			if (node.kind === "agent") {
				agents.push(node.label);
			}
		}
		return { agents, kinds, statuses };
	}, [visible]);
	return { legend, results, styles };
}
