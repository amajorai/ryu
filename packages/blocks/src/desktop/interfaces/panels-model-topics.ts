import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";
import { byRecency } from "./panels-model-threads.ts";

// ---------------------------------------------------------------------------
// Projects: each project or team as a topic with its conversations
// ---------------------------------------------------------------------------

export interface PanelsTopic {
	group: InterfaceGroup | null;
	id: string;
	members: InterfaceAgent[];
	name: string;
	threads: InterfaceThread[];
}

/** Projects first, then teams, then everything filed under neither. */
export function buildTopics(snapshot: InterfaceSnapshot): PanelsTopic[] {
	const groups = [...snapshot.groups].sort(
		(a, b) =>
			Number(a.kind === "team") - Number(b.kind === "team") ||
			a.name.localeCompare(b.name)
	);
	const projectIds = new Set(
		groups.filter((group) => group.kind === "project").map((group) => group.id)
	);
	const order = (a: InterfaceThread, b: InterfaceThread) =>
		Number(b.pinned) - Number(a.pinned) || byRecency(a, b);
	const topics: PanelsTopic[] = groups.map((group) => ({
		group,
		id: group.id,
		members: group.memberAgentIds
			.map((id) => agentById(snapshot, id))
			.filter((agent): agent is InterfaceAgent => agent !== undefined),
		name: group.name,
		threads: snapshot.threads
			.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id &&
						!(thread.projectId && projectIds.has(thread.projectId))
			)
			.sort(order),
	}));
	const known = new Set(groups.map((group) => group.id));
	const loose = snapshot.threads
		.filter(
			(thread) =>
				!(
					(thread.projectId && known.has(thread.projectId)) ||
					(thread.teamId && known.has(thread.teamId))
				)
		)
		.sort(order);
	if (loose.length > 0) {
		topics.push({
			group: null,
			id: "other",
			members: [],
			name: "Other conversations",
			threads: loose,
		});
	}
	return topics;
}
