import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	GraphEdge,
	GraphNode,
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";

export const NODE_STYLE = { pointerEvents: "all" } as const;

/** Edges paint in this order, so live spokes sit above memberships. */
export const EDGE_LAYER: Record<GraphEdge["kind"], number> = {
	collaborates: 1,
	member: 0,
	talks: 2,
};

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

export function agentsFor(
	snapshot: InterfaceSnapshot,
	ids: readonly string[]
): InterfaceAgent[] {
	const wanted = new Set(ids);
	return snapshot.agents.filter((agent) => wanted.has(agent.id));
}

export function nodeDescription(
	snapshot: InterfaceSnapshot,
	node: GraphNode,
	agent: InterfaceAgent | undefined,
	linkedCount: number,
	tl: LiteralMessage
): string {
	switch (node.kind) {
		case "agent":
			return agent?.description.trim() || tl("Agent");
		case "team":
			return tl("Team · {count, plural, one {# member} other {# members}}", {
				count: linkedCount,
			});
		case "project":
			return tl("Project · {count, plural, one {# agent} other {# agents}}", {
				count: linkedCount,
			});
		default:
			return tl(
				"Everyone you work with · {count, plural, one {{countText} agent} other {{countText} agents}}",
				{
					count: snapshot.agents.length,
					countText: String(snapshot.agents.length),
				}
			);
	}
}
