import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Categories: projects, then teams, then agents, then Uncategorized
// ---------------------------------------------------------------------------

export type ForumCategoryKind = "agent" | "project" | "team" | "uncategorized";

/** Discourse's default bucket for topics filed nowhere else. */
export const UNCATEGORIZED_ID = "uncategorized";

export interface ForumCategory {
	/** Set for an agent category: the agent the category stands for. */
	agent: InterfaceAgent | null;
	description: string;
	id: string;
	kind: ForumCategoryKind;
	/** The newest topic filed here, or null when the category is empty. */
	latest: InterfaceThread | null;
	/** Member agents (a group's members, or the agent itself). */
	memberIds: string[];
	name: string;
	/** Index into the swatch hue table, assigned in listing order. */
	swatch: number;
	/** Topic ids filed here, most recent activity first. */
	topicIds: string[];
}

export const CATEGORY_SECTION_LABELS: Record<ForumCategoryKind, string> = {
	agent: "Agents",
	project: "Projects",
	team: "Teams",
	uncategorized: "Other",
};

const KIND_ORDER: readonly ForumCategoryKind[] = [
	"project",
	"team",
	"agent",
	"uncategorized",
];

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** "Atlas", "Atlas and Echo", "Atlas, Echo and Forge". */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function groupDescription(
	snapshot: InterfaceSnapshot,
	memberIds: readonly string[]
): string {
	const names = memberIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id)?.name)
		.filter((name): name is string => Boolean(name));
	return names.length > 0 ? `With ${joinNames(names)}` : "No members yet";
}

/**
 * Which category a topic is filed in: its project, else its team, else its
 * first agent, else Uncategorized. Ids that no longer resolve fall through.
 */
export function topicCategoryId(
	thread: InterfaceThread,
	known: ReadonlySet<string>
): string {
	if (thread.projectId && known.has(thread.projectId)) {
		return thread.projectId;
	}
	if (thread.teamId && known.has(thread.teamId)) {
		return thread.teamId;
	}
	const agentId = thread.agentIds.find((id) => known.has(id));
	return agentId ?? UNCATEGORIZED_ID;
}

/**
 * Every category in listing order. Groups and agents are always listed, even
 * empty; Uncategorized only appears once a topic lands in it.
 */
export function forumCategories(snapshot: InterfaceSnapshot): ForumCategory[] {
	const categories: ForumCategory[] = [];
	for (const kind of ["project", "team"] as const) {
		for (const group of snapshot.groups) {
			if (group.kind === kind) {
				categories.push({
					agent: null,
					description: groupDescription(snapshot, group.memberAgentIds),
					id: group.id,
					kind,
					latest: null,
					memberIds: [...group.memberAgentIds],
					name: group.name,
					swatch: 0,
					topicIds: [],
				});
			}
		}
	}
	for (const agent of snapshot.agents) {
		categories.push({
			agent,
			description: agent.description,
			id: agent.id,
			kind: "agent",
			latest: null,
			memberIds: [agent.id],
			name: agent.name,
			swatch: 0,
			topicIds: [],
		});
	}
	const uncategorized: ForumCategory = {
		agent: null,
		description: "Topics without a project, team, or agent.",
		id: UNCATEGORIZED_ID,
		kind: "uncategorized",
		latest: null,
		memberIds: [],
		name: "Uncategorized",
		swatch: 0,
		topicIds: [],
	};
	const byId = new Map<string, ForumCategory>();
	for (const category of categories) {
		byId.set(category.id, category);
	}
	const known = new Set(byId.keys());
	for (const thread of [...snapshot.threads].sort(byRecency)) {
		const category = byId.get(topicCategoryId(thread, known)) ?? uncategorized;
		category.topicIds.push(thread.id);
		category.latest ??= thread;
	}
	if (uncategorized.topicIds.length > 0) {
		categories.push(uncategorized);
	}
	categories.forEach((category, index) => {
		category.swatch = index;
	});
	return categories;
}

/** Categories with their section kind, in the order sections are listed. */
export function categorySections(
	categories: readonly ForumCategory[]
): { kind: ForumCategoryKind; categories: ForumCategory[] }[] {
	const sections: { kind: ForumCategoryKind; categories: ForumCategory[] }[] =
		[];
	for (const kind of KIND_ORDER) {
		const members = categories.filter((category) => category.kind === kind);
		if (members.length > 0) {
			sections.push({ categories: members, kind });
		}
	}
	return sections;
}

/**
 * Hue turns (degrees) applied to the theme's primary for each category
 * swatch. Neighbours sit far apart so adjacent rows never look alike, and the
 * first category keeps the primary itself.
 */
const SWATCH_TURNS = [0, 150, 60, 230, 300, 105, 190, 30, 265, 340] as const;

/**
 * A category's swatch as CSS: the theme's primary hue-turned in LCH, with a
 * floor on lightness and chroma so monochrome themes still get distinct,
 * legible squares. Derived from the active theme alone.
 */
export function swatchColor(index: number): string {
	const turn = SWATCH_TURNS[index % SWATCH_TURNS.length] ?? 0;
	return `lch(from var(--primary) clamp(48, l, 72) max(c, 42) calc(h + ${turn}))`;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

export interface ForumTopic {
	/** Who wrote the latest message, shown as the opening post (null: you). */
	author: InterfaceAgent | null;
	category: ForumCategory;
	/** Agents on the topic, original poster first. */
	posters: InterfaceAgent[];
	replies: number;
	status: ThreadStatus;
	thread: InterfaceThread;
	views: number;
}

export function forumTopic(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	categories: readonly ForumCategory[]
): ForumTopic {
	const known = new Set(categories.map((category) => category.id));
	const categoryId = topicCategoryId(thread, known);
	const category =
		categories.find((candidate) => candidate.id === categoryId) ??
		uncategorizedFallback();
	const posters = thread.agentIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	return {
		author: thread.lastMessageRole === "user" ? null : (posters[0] ?? null),
		category,
		posters,
		replies: Math.max(0, thread.messageCount - 1),
		status: threadStatus(thread),
		thread,
		views: thread.messageCount,
	};
}

function uncategorizedFallback(): ForumCategory {
	return {
		agent: null,
		description: "",
		id: UNCATEGORIZED_ID,
		kind: "uncategorized",
		latest: null,
		memberIds: [],
		name: "Uncategorized",
		swatch: 0,
		topicIds: [],
	};
}

export type ForumSort = "latest" | "top" | "unread";

export const FORUM_SORTS: readonly ForumSort[] = ["latest", "top", "unread"];

export const FORUM_SORT_LABELS: Record<ForumSort, string> = {
	latest: "Latest",
	top: "Top",
	unread: "Unread",
};

/** Discourse's end-of-list line for each list. */
export const FORUM_SORT_END: Record<ForumSort, string> = {
	latest: "There are no more latest topics.",
	top: "There are no more top topics.",
	unread: "There are no more unread topics.",
};

/** Discourse's empty-list line for each list. */
export const FORUM_SORT_EMPTY: Record<ForumSort, string> = {
	latest: "There are no latest topics.",
	top: "There are no top topics.",
	unread: "You have no unread topics. Topics land here when an agent replies.",
};

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return Number(b.pinned) - Number(a.pinned) || byRecency(a, b);
}

function mostActive(a: InterfaceThread, b: InterfaceThread): number {
	return b.messageCount - a.messageCount || byRecency(a, b);
}

/** Every word must appear in the topic's title, message, category or agents. */
export function matchesSearch(topic: ForumTopic, search: string): boolean {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return true;
	}
	const haystack = [
		topic.thread.title,
		topic.thread.lastMessage ?? "",
		topic.category.name,
		...topic.posters.map((agent) => agent.name),
	]
		.join(" ")
		.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

export interface TopicListQuery {
	categoryId: string | null;
	search: string;
	sort: ForumSort;
}

/** The topics a list shows, in its order. */
export function topicList(
	snapshot: InterfaceSnapshot,
	categories: readonly ForumCategory[],
	query: TopicListQuery
): ForumTopic[] {
	const order = query.sort === "top" ? mostActive : pinnedThenRecent;
	return [...snapshot.threads]
		.sort(order)
		.map((thread) => forumTopic(snapshot, thread, categories))
		.filter(
			(topic) =>
				(query.categoryId === null || topic.category.id === query.categoryId) &&
				(query.sort !== "unread" || topic.status === "your-turn") &&
				matchesSearch(topic, query.search)
		);
}

/** How many topics wait on you: an agent replied and nothing is running. */
export function unreadCount(
	snapshot: InterfaceSnapshot,
	categoryId: string | null = null,
	categories: readonly ForumCategory[] = []
): number {
	const known = new Set(categories.map((category) => category.id));
	let count = 0;
	for (const thread of snapshot.threads) {
		if (
			threadStatus(thread) === "your-turn" &&
			(categoryId === null || topicCategoryId(thread, known) === categoryId)
		) {
			count += 1;
		}
	}
	return count;
}

/** The next id for j/k and the arrow keys, clamped to the list. */
export function stepTopic(
	order: readonly string[],
	current: string | null,
	delta: number
): string | null {
	if (order.length === 0) {
		return null;
	}
	const index = current === null ? -1 : order.indexOf(current);
	if (index === -1) {
		return delta > 0 ? (order[0] ?? null) : (order.at(-1) ?? null);
	}
	const next = Math.min(order.length - 1, Math.max(0, index + delta));
	return order[next] ?? null;
}

/** What a topic's status adds to its meta line, when anything. */
export function topicStatusNote(topic: ForumTopic): string | null {
	switch (topic.status) {
		case "attention":
			return topic.thread.runState === "interrupted"
				? "Run interrupted"
				: "Run failed";
		case "working":
			return "Working";
		case "waiting":
			return "Waiting on agent";
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Topic progress (Discourse's timeline)
// ---------------------------------------------------------------------------

/** The post a scroll fraction (0 top, 1 bottom) lands on, 1-based. */
export function progressPost(fraction: number, total: number): number {
	if (total <= 1) {
		return 1;
	}
	const clamped = Math.min(1, Math.max(0, fraction));
	return 1 + Math.round(clamped * (total - 1));
}

/** The scroll fraction that puts a 1-based post in view. */
export function postFraction(post: number, total: number): number {
	if (total <= 1) {
		return 0;
	}
	return (Math.min(total, Math.max(1, post)) - 1) / (total - 1);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ForumDraft {
	/** null: let the host pick; ignored for an agent category. */
	agentId: string | null;
	body: string;
	categoryId: string;
	title: string;
}

export function emptyDraft(categoryId: string | null): ForumDraft {
	return {
		agentId: null,
		body: "",
		categoryId: categoryId ?? UNCATEGORIZED_ID,
		title: "",
	};
}

/** Title and body as the first message; the title alone is enough. */
export function draftPrompt(draft: Pick<ForumDraft, "body" | "title">): string {
	const title = draft.title.trim();
	const body = draft.body.trim();
	if (title && body) {
		return `${title}\n\n${body}`;
	}
	return title;
}

export interface ForumStartInput {
	agentId?: string;
	projectId?: string;
	prompt: string;
	teamId?: string;
}

/** What `port.startThread` receives for a draft, or null until it has a title. */
export function draftStartInput(
	draft: ForumDraft,
	categories: readonly ForumCategory[]
): ForumStartInput | null {
	const prompt = draftPrompt(draft);
	if (!prompt) {
		return null;
	}
	const input: ForumStartInput = { prompt };
	const category = categories.find(
		(candidate) => candidate.id === draft.categoryId
	);
	if (category?.kind === "agent") {
		input.agentId = category.id;
		return input;
	}
	if (category?.kind === "project") {
		input.projectId = category.id;
	} else if (category?.kind === "team") {
		input.teamId = category.id;
	}
	if (draft.agentId) {
		input.agentId = draft.agentId;
	}
	return input;
}

/** Composer category options: Uncategorized is always offered. */
export function composerCategories(
	categories: readonly ForumCategory[]
): ForumCategory[] {
	if (categories.some((category) => category.id === UNCATEGORIZED_ID)) {
		return [...categories];
	}
	return [
		...categories,
		{
			...uncategorizedFallback(),
			description: "Topics without a project, team, or agent.",
			swatch: categories.length,
		},
	];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
});

const FULL_DATE = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	year: "numeric",
});

/** "Oct 12", as Discourse labels dates in its timeline. */
export function monthDay(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : MONTH_DAY.format(time);
}

/** "Oct 12, 2026, 9:41 AM" for tooltips and titles. */
export function fullDate(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : FULL_DATE.format(time);
}
