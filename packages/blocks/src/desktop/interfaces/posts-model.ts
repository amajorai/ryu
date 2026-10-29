import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Posts view model. A post is a thread: its title is the post title, the
 * newest message is the preview, and every message after the first counts as
 * a comment. Spaces are the snapshot's teams and projects, plus General for
 * threads filed under neither.
 */

export const GENERAL_SPACE_ID = "general";

export type PostsView =
	| { kind: "all" }
	| { kind: "home" }
	| { agentId: string; kind: "member" }
	| { id: string; kind: "space" };

export const HOME_VIEW: PostsView = { kind: "home" };
export const ALL_VIEW: PostsView = { kind: "all" };

/** Campsite's post states, mapped from the shared thread status. */
export type PostMarker =
	| "awaiting-reply"
	| "feedback-requested"
	| "in-progress"
	| "needs-attention"
	| "resolved";

const MARKER_BY_STATUS: Record<ThreadStatus, PostMarker> = {
	attention: "needs-attention",
	quiet: "resolved",
	waiting: "awaiting-reply",
	working: "in-progress",
	"your-turn": "feedback-requested",
};

export const POST_MARKER_LABELS: Record<PostMarker, string> = {
	"awaiting-reply": "Waiting for a reply",
	"feedback-requested": "Feedback requested",
	"in-progress": "In progress",
	"needs-attention": "Needs attention",
	resolved: "Resolved",
};

/**
 * The status line a post shows, in the same words in the feed and the
 * details rail: named after the agent when there is one.
 */
export function markerLabel(item: Pick<PostItem, "author" | "marker">): string {
	const name = item.author?.name;
	if (item.marker === "in-progress") {
		return name ? `${name} is working` : "In progress";
	}
	if (item.marker === "awaiting-reply") {
		return name ? `Waiting on ${name}` : "Waiting for a reply";
	}
	return POST_MARKER_LABELS[item.marker];
}

export function postMarker(status: ThreadStatus): PostMarker {
	return MARKER_BY_STATUS[status];
}

/** Markers that put a post in Home, most urgent first. */
export const HOME_MARKERS: readonly PostMarker[] = [
	"needs-attention",
	"feedback-requested",
];

export interface PostSpace {
	id: string;
	kind: "general" | "project" | "team";
	memberAgentIds: string[];
	name: string;
	/** Posts in this space that need you. */
	needsYou: number;
	threadIds: string[];
}

export interface PostItem {
	/** The agent who owns the post, or null when the user posted to no one. */
	author: InterfaceAgent | null;
	/** Every agent on the thread, author first. */
	commenters: InterfaceAgent[];
	/** Messages after the opening one. */
	comments: number;
	marker: PostMarker;
	space: PostSpace | null;
	status: ThreadStatus;
	thread: InterfaceThread;
}

function byPinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

function needsYou(thread: InterfaceThread): boolean {
	return HOME_MARKERS.includes(postMarker(threadStatus(thread)));
}

/** The space id a thread files under: its project, else its team, else General. */
export function threadSpaceId(thread: InterfaceThread): string {
	return thread.projectId ?? thread.teamId ?? GENERAL_SPACE_ID;
}

/**
 * Teams first, then projects, each in snapshot order, then General when any
 * thread is unfiled. A group's posts are the threads filed under it.
 */
export function postSpaces(snapshot: InterfaceSnapshot): PostSpace[] {
	const threadsBySpace = new Map<string, InterfaceThread[]>();
	for (const thread of [...snapshot.threads].sort(byPinnedThenRecent)) {
		const id = threadSpaceId(thread);
		const list = threadsBySpace.get(id) ?? [];
		list.push(thread);
		threadsBySpace.set(id, list);
	}
	const known = new Set(snapshot.groups.map((group) => group.id));
	const spaces: PostSpace[] = [];
	for (const kind of ["team", "project"] as const) {
		for (const group of snapshot.groups) {
			if (group.kind !== kind) {
				continue;
			}
			const threads = threadsBySpace.get(group.id) ?? [];
			spaces.push({
				id: group.id,
				kind,
				memberAgentIds: group.memberAgentIds,
				name: group.name,
				needsYou: threads.filter(needsYou).length,
				threadIds: threads.map((thread) => thread.id),
			});
		}
	}
	// Unfiled threads, and threads whose group is missing from the snapshot.
	const general: InterfaceThread[] = [];
	for (const [id, threads] of threadsBySpace) {
		if (!known.has(id)) {
			general.push(...threads);
		}
	}
	if (general.length > 0) {
		general.sort(byPinnedThenRecent);
		const agentIds = new Set<string>();
		for (const thread of general) {
			for (const agentId of thread.agentIds) {
				agentIds.add(agentId);
			}
		}
		spaces.push({
			id: GENERAL_SPACE_ID,
			kind: "general",
			memberAgentIds: [...agentIds],
			name: "General",
			needsYou: general.filter(needsYou).length,
			threadIds: general.map((thread) => thread.id),
		});
	}
	return spaces;
}

export function spaceForThread(
	spaces: readonly PostSpace[],
	threadId: string
): PostSpace | null {
	return spaces.find((space) => space.threadIds.includes(threadId)) ?? null;
}

export function postItem(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	spaces: readonly PostSpace[]
): PostItem {
	const commenters: InterfaceAgent[] = [];
	for (const agentId of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
		if (agent && !commenters.includes(agent)) {
			commenters.push(agent);
		}
	}
	const status = threadStatus(thread);
	return {
		author: commenters[0] ?? null,
		comments: Math.max(0, thread.messageCount - 1),
		commenters,
		marker: postMarker(status),
		space: spaceForThread(spaces, thread.id),
		status,
		thread,
	};
}

function matchesView(
	thread: InterfaceThread,
	view: PostsView,
	spaces: readonly PostSpace[]
): boolean {
	switch (view.kind) {
		case "all":
			return true;
		case "home":
			return needsYou(thread);
		case "member":
			return thread.agentIds.includes(view.agentId);
		default:
			return (
				spaces
					.find((space) => space.id === view.id)
					?.threadIds.includes(thread.id) ?? false
			);
	}
}

/** The view's posts: pinned first, then most recent activity. */
export function viewPosts(
	snapshot: InterfaceSnapshot,
	view: PostsView,
	spaces: readonly PostSpace[]
): PostItem[] {
	return snapshot.threads
		.filter((thread) => matchesView(thread, view, spaces))
		.sort(byPinnedThenRecent)
		.map((thread) => postItem(snapshot, thread, spaces));
}

export interface PostSection {
	items: PostItem[];
	label: string;
	marker: PostMarker;
}

/** Home's sections, most urgent first; empty sections are left out. */
export function homeSections(items: readonly PostItem[]): PostSection[] {
	return HOME_MARKERS.map((marker) => ({
		items: items.filter((item) => item.marker === marker),
		label: POST_MARKER_LABELS[marker],
		marker,
	})).filter((section) => section.items.length > 0);
}

export function homeCount(snapshot: InterfaceSnapshot): number {
	return snapshot.threads.filter(needsYou).length;
}

export function findSpace(
	spaces: readonly PostSpace[],
	id: string | null | undefined
): PostSpace | undefined {
	return id ? spaces.find((space) => space.id === id) : undefined;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

const SPACE_KIND_LABELS: Record<PostSpace["kind"], string> = {
	general: "Posts not filed under a team or project",
	project: "Project",
	team: "Team",
};

export interface PostsViewHeader {
	description: string;
	members: InterfaceAgent[];
	title: string;
}

function agentsByIds(
	snapshot: InterfaceSnapshot,
	ids: readonly string[]
): InterfaceAgent[] {
	return ids.flatMap((id) => {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		return agent ? [agent] : [];
	});
}

/** Name, one factual line, and members for the view's header. */
export function viewHeader(
	snapshot: InterfaceSnapshot,
	view: PostsView,
	spaces: readonly PostSpace[]
): PostsViewHeader {
	switch (view.kind) {
		case "home":
			return {
				description: "Feedback requests and failed runs",
				members: [],
				title: "Home",
			};
		case "all":
			return {
				description: `${plural(snapshot.threads.length, "post", "posts")} across ${plural(spaces.length, "space", "spaces")}`,
				members: [],
				title: "Posts",
			};
		case "member": {
			const agent = snapshot.agents.find(
				(candidate) => candidate.id === view.agentId
			);
			return {
				description: agent?.description || "Agent",
				members: agent ? [agent] : [],
				title: agent?.name ?? "Member",
			};
		}
		default: {
			const space = findSpace(spaces, view.id);
			if (!space) {
				return { description: "", members: [], title: "Space" };
			}
			const members = agentsByIds(snapshot, space.memberAgentIds);
			const parts = [
				SPACE_KIND_LABELS[space.kind],
				space.kind === "general"
					? null
					: plural(members.length, "member", "members"),
				plural(space.threadIds.length, "post", "posts"),
			].filter((part): part is string => part !== null);
			return { description: parts.join(" · "), members, title: space.name };
		}
	}
}

/** A stable string for a view, for keys and `aria-current`. */
export function viewKey(view: PostsView): string {
	switch (view.kind) {
		case "member":
			return `member:${view.agentId}`;
		case "space":
			return `space:${view.id}`;
		default:
			return view.kind;
	}
}

/** Falls back to Home when a space or member left the snapshot. */
export function resolveView(
	snapshot: InterfaceSnapshot,
	view: PostsView,
	spaces: readonly PostSpace[]
): PostsView {
	if (view.kind === "space" && !findSpace(spaces, view.id)) {
		return HOME_VIEW;
	}
	if (
		view.kind === "member" &&
		!snapshot.agents.some((agent) => agent.id === view.agentId)
	) {
		return HOME_VIEW;
	}
	return view;
}

export interface PostDraft {
	agentId: string | null;
	body: string;
	spaceId: string | null;
	title: string;
}

export function emptyDraft(view: PostsView): PostDraft {
	return {
		agentId: view.kind === "member" ? view.agentId : null,
		body: "",
		spaceId:
			view.kind === "space" && view.id !== GENERAL_SPACE_ID ? view.id : null,
		title: "",
	};
}

/** The prompt a post sends: the title, a blank line, then the body. */
export function postPrompt(draft: Pick<PostDraft, "body" | "title">): string {
	const title = draft.title.trim();
	const body = draft.body.trim();
	if (title && body) {
		return `${title}\n\n${body}`;
	}
	return title || body;
}

export interface PostStartInput {
	agentId?: string;
	projectId?: string;
	prompt: string;
	teamId?: string;
}

/** What `port.startThread` receives for a draft, or null for an empty one. */
export function postStartInput(
	draft: PostDraft,
	spaces: readonly PostSpace[]
): PostStartInput | null {
	const prompt = postPrompt(draft);
	if (!prompt) {
		return null;
	}
	const input: PostStartInput = { prompt };
	const space = findSpace(spaces, draft.spaceId);
	if (space?.kind === "project") {
		input.projectId = space.id;
	} else if (space?.kind === "team") {
		input.teamId = space.id;
	}
	if (draft.agentId) {
		input.agentId = draft.agentId;
	}
	return input;
}

/** "2 comments", or null when nobody has replied yet. */
export function commentLabel(count: number): string | null {
	return count > 0 ? plural(count, "comment", "comments") : null;
}

/** The next post id for j/k and arrow keys, clamped to the list. */
export function stepPost(
	order: readonly string[],
	current: string | null,
	delta: number
): string | undefined {
	if (order.length === 0) {
		return undefined;
	}
	const index = current ? order.indexOf(current) : -1;
	if (index === -1) {
		return delta > 0 ? order[0] : order.at(-1);
	}
	return order[Math.min(order.length - 1, Math.max(0, index + delta))];
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
});

/** "Oct 13, 2:04 PM" for the details rail. */
export function absoluteTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : DATE_FORMAT.format(time);
}
