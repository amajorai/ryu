import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	notebookEditedLabel,
	notebookRunTime,
	notebookTimestamp,
} from "./notebook-model-dates.ts";

export {
	type NotebookTreeMove,
	notebookTreeMove,
} from "./notebook-model-keys.ts";

/**
 * Notebook view model: threads as pages in a Notion-style page tree. Pure, so
 * the tree, its keyboard moves, and the Home page lists are tested without a
 * DOM.
 */

export type NotebookSectionKey =
	| "agents"
	| "favorites"
	| "projects"
	| "teams"
	| "unfiled";

export type NotebookGroupKind = "agent" | "project" | "team";

export interface NotebookPage {
	/** Unique per tree position (a pinned page also appears in Favorites). */
	id: string;
	kind: "page";
	leadAgentId: string | null;
	status: ThreadStatus;
	threadId: string;
	title: string;
	updatedAt: string;
}

export interface NotebookGroup {
	entityId: string;
	groupKind: NotebookGroupKind;
	id: string;
	kind: "group";
	label: string;
	pages: NotebookPage[];
}

export interface NotebookSection {
	children: (NotebookGroup | NotebookPage)[];
	id: string;
	key: NotebookSectionKey;
	kind: "section";
	label: string;
}

export type NotebookNode = NotebookGroup | NotebookPage | NotebookSection;

export const NOTEBOOK_SECTION_LABELS: Record<NotebookSectionKey, string> = {
	get agents() {
		return tr("Agents");
	},
	get favorites() {
		return tr("Favorites");
	},
	get projects() {
		return tr("Projects");
	},
	get teams() {
		return tr("Teams");
	},
	get unfiled() {
		return tr("Unfiled");
	},
};

const SECTION_ORDER: readonly NotebookSectionKey[] = [
	"favorites",
	"projects",
	"teams",
	"agents",
	"unfiled",
];

export function sectionNodeId(key: NotebookSectionKey): string {
	return `section:${key}`;
}

export function groupNodeId(kind: NotebookGroupKind, entityId: string): string {
	return `${kind}:${entityId}`;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name);
}

function pageNode(thread: InterfaceThread, parentId: string): NotebookPage {
	return {
		id: `${parentId}/${thread.id}`,
		kind: "page",
		leadAgentId: thread.agentIds[0] ?? null,
		status: threadStatus(thread),
		threadId: thread.id,
		title: notebookPageTitle(thread),
		updatedAt: thread.updatedAt,
	};
}

/** A page's display title; untitled threads read like Notion's "Untitled". */
export function notebookPageTitle(
	thread: Pick<InterfaceThread, "title"> | undefined
): string {
	const title = thread?.title.trim();
	return title || tr("Untitled");
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function matches(value: string, query: string): boolean {
	return query === "" || value.toLowerCase().includes(query);
}

/** Where a thread lives in the tree, ignoring Favorites. */
export interface NotebookPlacement {
	group: { kind: NotebookGroupKind; id: string; label: string } | null;
	section: NotebookSectionKey;
}

export function notebookPlacement(
	snapshot: InterfaceSnapshot,
	thread: Pick<InterfaceThread, "agentIds" | "projectId" | "teamId">
): NotebookPlacement {
	const project = thread.projectId
		? snapshot.groups.find(
				(group) => group.kind === "project" && group.id === thread.projectId
			)
		: undefined;
	if (project) {
		return {
			group: { id: project.id, kind: "project", label: project.name },
			section: "projects",
		};
	}
	const team = thread.teamId
		? snapshot.groups.find(
				(group) => group.kind === "team" && group.id === thread.teamId
			)
		: undefined;
	if (team) {
		return {
			group: { id: team.id, kind: "team", label: team.name },
			section: "teams",
		};
	}
	const leadId = thread.agentIds[0];
	const lead = leadId
		? snapshot.agents.find((agent) => agent.id === leadId)
		: undefined;
	if (lead) {
		return {
			group: { id: lead.id, kind: "agent", label: lead.name },
			section: "agents",
		};
	}
	return { group: null, section: "unfiled" };
}

function groupSection(
	snapshot: InterfaceSnapshot,
	threads: readonly InterfaceThread[],
	kind: "project" | "team",
	query: string
): NotebookGroup[] {
	const groups: InterfaceGroup[] = snapshot.groups
		.filter((group) => group.kind === kind)
		.sort(byName);
	const result: NotebookGroup[] = [];
	for (const group of groups) {
		const id = groupNodeId(kind, group.id);
		const groupMatches = query !== "" && matches(group.name, query);
		const pages = threads
			.filter(
				(thread) => notebookPlacementKey(snapshot, thread, kind) === group.id
			)
			.filter((thread) => groupMatches || matches(thread.title, query))
			.map((thread) => pageNode(thread, id));
		if (query !== "" && !groupMatches && pages.length === 0) {
			continue;
		}
		result.push({
			entityId: group.id,
			groupKind: kind,
			id,
			kind: "group",
			label: group.name,
			pages,
		});
	}
	return result;
}

/** The group id a thread files under for one section kind, if it does. */
function notebookPlacementKey(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	kind: NotebookGroupKind
): string | null {
	const placement = notebookPlacement(snapshot, thread);
	return placement.group?.kind === kind ? placement.group.id : null;
}

/**
 * The sidebar tree. Each thread files under exactly one parent (its project,
 * else its team, else its lead agent, else Unfiled); pinned threads also show
 * in Favorites. Every agent gets a row, even with no pages, so "+" can start
 * a page with them; agents stay alphabetical and the sidebar dims the ones
 * without pages. A non-empty `query` keeps only matching pages (or every
 * page of a matching parent) and drops empty sections.
 */
export function buildNotebookTree(
	snapshot: InterfaceSnapshot,
	rawQuery = ""
): NotebookSection[] {
	const query = normalize(rawQuery);
	const threads = [...snapshot.threads].sort(byRecency);
	const children: Record<NotebookSectionKey, NotebookSection["children"]> = {
		agents: [],
		favorites: [],
		projects: groupSection(snapshot, threads, "project", query),
		teams: groupSection(snapshot, threads, "team", query),
		unfiled: [],
	};

	const favoritesId = sectionNodeId("favorites");
	children.favorites = threads
		.filter((thread) => thread.pinned && matches(thread.title, query))
		.map((thread) => pageNode(thread, favoritesId));

	for (const agent of [...snapshot.agents].sort(byName)) {
		const id = groupNodeId("agent", agent.id);
		const agentMatches = query !== "" && matches(agent.name, query);
		const pages = threads
			.filter(
				(thread) => notebookPlacementKey(snapshot, thread, "agent") === agent.id
			)
			.filter((thread) => agentMatches || matches(thread.title, query))
			.map((thread) => pageNode(thread, id));
		if (query !== "" && !agentMatches && pages.length === 0) {
			continue;
		}
		children.agents.push({
			entityId: agent.id,
			groupKind: "agent",
			id,
			kind: "group",
			label: agent.name,
			pages,
		});
	}

	const unfiledId = sectionNodeId("unfiled");
	children.unfiled = threads
		.filter(
			(thread) =>
				notebookPlacement(snapshot, thread).section === "unfiled" &&
				matches(thread.title, query)
		)
		.map((thread) => pageNode(thread, unfiledId));

	return SECTION_ORDER.filter((key) => children[key].length > 0).map((key) => ({
		children: children[key],
		id: sectionNodeId(key),
		key,
		kind: "section",
		label: NOTEBOOK_SECTION_LABELS[key],
	}));
}

/** True when the node has (or could have) children to show. */
export function isExpandable(node: NotebookNode): boolean {
	return node.kind !== "page";
}

function childrenOf(node: NotebookNode): readonly NotebookNode[] {
	if (node.kind === "section") {
		return node.children;
	}
	if (node.kind === "group") {
		return node.pages;
	}
	return [];
}

export interface NotebookRow {
	expanded: boolean;
	id: string;
	level: number;
	node: NotebookNode;
	parentId: string | null;
}

/** The rows a reader can currently see, in document order (for arrow keys). */
export function visibleNotebookRows(
	sections: readonly NotebookSection[],
	expanded: ReadonlySet<string>
): NotebookRow[] {
	const rows: NotebookRow[] = [];
	const walk = (
		nodes: readonly NotebookNode[],
		level: number,
		parentId: string | null
	) => {
		for (const node of nodes) {
			const open = isExpandable(node) && expanded.has(node.id);
			rows.push({ expanded: open, id: node.id, level, node, parentId });
			if (open) {
				walk(childrenOf(node), level + 1, node.id);
			}
		}
	};
	walk(sections, 1, null);
	return rows;
}

/** Every expandable id, used while searching so every match shows. */
export function allExpandableIds(
	sections: readonly NotebookSection[]
): Set<string> {
	const ids = new Set<string>();
	for (const section of sections) {
		ids.add(section.id);
		for (const child of section.children) {
			if (child.kind === "group") {
				ids.add(child.id);
			}
		}
	}
	return ids;
}

/** Ids to open so `threadId`'s page is visible (its section and parent). */
export function ancestorIdsOf(
	sections: readonly NotebookSection[],
	threadId: string | null
): string[] {
	if (!threadId) {
		return [];
	}
	for (const section of sections) {
		if (section.key === "favorites") {
			continue;
		}
		for (const child of section.children) {
			if (child.kind === "page" && child.threadId === threadId) {
				return [section.id];
			}
			if (
				child.kind === "group" &&
				child.pages.some((page) => page.threadId === threadId)
			) {
				return [section.id, child.id];
			}
		}
	}
	return [];
}

/** Most project/team parents start open; agents start folded. */
const OPEN_GROUP_LIMIT = 4;

export function initialNotebookExpanded(
	sections: readonly NotebookSection[],
	activeThreadId: string | null
): Set<string> {
	const ids = new Set<string>();
	for (const section of sections) {
		ids.add(section.id);
		if (section.key !== "projects" && section.key !== "teams") {
			continue;
		}
		for (const child of section.children.slice(0, OPEN_GROUP_LIMIT)) {
			ids.add(child.id);
		}
	}
	for (const id of ancestorIdsOf(sections, activeThreadId)) {
		ids.add(id);
	}
	return ids;
}

/** The `startThread` input for a "+" on a parent row. */
export function notebookStartInput(group: NotebookGroup): {
	agentId?: string;
	projectId?: string;
	teamId?: string;
} {
	switch (group.groupKind) {
		case "project":
			return { projectId: group.entityId };
		case "team":
			return { teamId: group.entityId };
		default:
			return { agentId: group.entityId };
	}
}

/** The newest pages, for Home's "Recently edited" gallery. */
export function recentNotebookPages(
	snapshot: InterfaceSnapshot,
	limit = 8
): InterfaceThread[] {
	return [...snapshot.threads].sort(byRecency).slice(0, limit);
}

/** Pages that wait on the reader: failed runs first, then agent replies. */
export function notebookNeedsYou(
	snapshot: InterfaceSnapshot,
	limit = 5
): InterfaceThread[] {
	const rank = (thread: InterfaceThread) =>
		THREAD_STATUS_ORDER.indexOf(threadStatus(thread));
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort((a, b) => rank(a) - rank(b) || byRecency(a, b))
		.slice(0, limit);
}

/** Scheduled runs still ahead, soonest first. */
export function upcomingNotebookEvents(
	snapshot: InterfaceSnapshot,
	now: number,
	limit = 4
): InterfaceEvent[] {
	return (snapshot.events ?? [])
		.filter(
			(event) => event.kind === "upcoming" && Date.parse(event.start) >= now
		)
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, limit);
}

export function notebookGreeting(date: Date): string {
	const hour = date.getHours();
	if (hour >= 5 && hour < 12) {
		return "Good morning";
	}
	if (hour >= 12 && hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}
