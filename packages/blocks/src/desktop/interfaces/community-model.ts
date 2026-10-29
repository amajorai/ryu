import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Where a community comes from: a project or team (the user's groups), an
 * agent (its own community, like a profile you can post to), or the user's
 * profile for threads with no agent and no group.
 */
export type CommunityKind = "agent" | "profile" | "project" | "team";

export interface Community {
	/** The agent behind an agent community. */
	agentId: string | null;
	/** One plain sentence for the About card. */
	description: string;
	/** Reddit-style name without the prefix, e.g. `WebsiteRedesign`. */
	handle: string;
	/** Stable key across kinds, e.g. `project:project-website`. */
	key: string;
	kind: CommunityKind;
	/** Newest activity across the community's posts, or null with none. */
	lastActivity: string | null;
	/** Agents in the community, in a stable order. */
	members: InterfaceAgent[];
	/** Display name, e.g. `Website Redesign`. */
	name: string;
	/** `r/` for communities, `u/` for the user's profile. */
	prefix: "r/" | "u/";
	/** Dither seed shared by the icon and the banner. */
	seed: string;
	/** The group id (project/team), agent id, or `profile`. */
	sourceId: string;
	/** Posts that belong in the community's feed. */
	threadCount: number;
	/** Members with a live run right now. */
	workingCount: number;
}

export interface CommunityPost {
	/** Replies under the post: every message after the first. */
	comments: number;
	/** The community the post is filed in (project, then team, then agent). */
	community: Community;
	/** The newest message, when the host has it. */
	excerpt: string | null;
	/** The agent shown as the poster, when the thread has one. */
	poster: InterfaceAgent | null;
	/** Base score before the user's own vote: the thread's message count. */
	score: number;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export type CommunitySort = "hot" | "new" | "top";

export const COMMUNITY_SORTS: readonly { id: CommunitySort; label: string }[] =
	[
		{ id: "hot", label: "Hot" },
		{ id: "new", label: "New" },
		{ id: "top", label: "Top" },
	];

export type CommunityViewMode = "card" | "compact";

/** Which feed the centre column shows. */
export type CommunityScope =
	| { kind: "community"; key: string }
	| { kind: "home" }
	| { kind: "popular" };

export type CommunityVote = -1 | 1;

export const PROFILE_KEY = "profile:you";

const HANDLE_LIMIT = 21;

/** Reddit-style community name: letters and digits, words run together. */
export function communityHandle(name: string): string {
	const words = name
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9\s]+/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	const joined = words
		.map((word) => (word[0]?.toUpperCase() ?? "") + word.slice(1))
		.join("")
		.slice(0, HANDLE_LIMIT);
	return joined || "Community";
}

function agentsFor(
	snapshot: InterfaceSnapshot,
	ids: readonly string[]
): InterfaceAgent[] {
	const agents: InterfaceAgent[] = [];
	for (const id of ids) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent && !agents.includes(agent)) {
			agents.push(agent);
		}
	}
	return agents;
}

/** Whether a thread belongs in a community's feed. */
export function inCommunity(
	community: Community,
	thread: InterfaceThread
): boolean {
	switch (community.kind) {
		case "project":
			return thread.projectId === community.sourceId;
		case "team":
			return thread.teamId === community.sourceId;
		case "agent":
			return thread.agentIds.includes(community.sourceId);
		default:
			return (
				thread.agentIds.length === 0 && !thread.projectId && !thread.teamId
			);
	}
}

function newest(threads: readonly InterfaceThread[]): string | null {
	let latest: string | null = null;
	for (const thread of threads) {
		if (!latest || thread.updatedAt > latest) {
			latest = thread.updatedAt;
		}
	}
	return latest;
}

function describeCommunity(
	kind: CommunityKind,
	name: string,
	agent?: InterfaceAgent
) {
	switch (kind) {
		case "project":
			return `Threads filed under the ${name} project.`;
		case "team":
			return `Threads the ${name} team works on together.`;
		case "agent":
			return agent?.description.trim() || `Threads with ${name}.`;
		default:
			return "Threads you started with no agent, project, or team.";
	}
}

/**
 * Every community, in nav order: projects, teams, then agents. The user's
 * profile comes last and only when some thread has nowhere else to go.
 * Handles stay unique by numbering repeats.
 */
export function buildCommunities(snapshot: InterfaceSnapshot): Community[] {
	const taken = new Map<string, number>();
	const unique = (name: string) => {
		const base = communityHandle(name);
		const key = base.toLowerCase();
		const seen = taken.get(key) ?? 0;
		taken.set(key, seen + 1);
		return seen === 0 ? base : `${base}${seen + 1}`;
	};
	const finish = (
		draft: Omit<Community, "lastActivity" | "threadCount" | "workingCount">
	): Community => {
		const community: Community = {
			...draft,
			lastActivity: null,
			threadCount: 0,
			workingCount: draft.members.filter((agent) => agent.status === "working")
				.length,
		};
		const threads = snapshot.threads.filter((thread) =>
			inCommunity(community, thread)
		);
		community.threadCount = threads.length;
		community.lastActivity = newest(threads);
		return community;
	};

	const communities: Community[] = [];
	const groups = [...snapshot.groups].sort(
		(a, b) =>
			Number(a.kind === "team") - Number(b.kind === "team") ||
			a.name.localeCompare(b.name)
	);
	for (const group of groups) {
		const threadAgents = snapshot.threads
			.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id
			)
			.flatMap((thread) => thread.agentIds);
		communities.push(
			finish({
				agentId: null,
				description: describeCommunity(group.kind, group.name),
				handle: unique(group.name),
				key: `${group.kind}:${group.id}`,
				kind: group.kind,
				members: agentsFor(snapshot, [
					...group.memberAgentIds,
					...threadAgents,
				]),
				name: group.name,
				prefix: "r/",
				seed: `community:${group.id}`,
				sourceId: group.id,
			})
		);
	}
	const agents = [...snapshot.agents].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	for (const agent of agents) {
		communities.push(
			finish({
				agentId: agent.id,
				description: describeCommunity("agent", agent.name, agent),
				handle: unique(agent.name),
				key: `agent:${agent.id}`,
				kind: "agent",
				members: [agent],
				name: agent.name,
				prefix: "r/",
				seed: agent.name,
				sourceId: agent.id,
			})
		);
	}
	const profile = finish({
		agentId: null,
		description: describeCommunity("profile", "you"),
		handle: "you",
		key: PROFILE_KEY,
		kind: "profile",
		members: [],
		name: "Your profile",
		prefix: "u/",
		seed: "profile:you",
		sourceId: "profile",
	});
	if (profile.threadCount > 0) {
		communities.push(profile);
	}
	return communities;
}

/** The community a post is filed in: its project, then team, then agent. */
export function primaryCommunity(
	communities: readonly Community[],
	thread: InterfaceThread
): Community {
	const keys = [
		thread.projectId ? `project:${thread.projectId}` : null,
		thread.teamId ? `team:${thread.teamId}` : null,
		thread.agentIds[0] ? `agent:${thread.agentIds[0]}` : null,
	];
	for (const key of keys) {
		const found = key
			? communities.find((community) => community.key === key)
			: undefined;
		if (found) {
			return found;
		}
	}
	return (
		communities.find((community) => community.key === PROFILE_KEY) ?? {
			agentId: null,
			description: describeCommunity("profile", "you"),
			handle: "you",
			key: PROFILE_KEY,
			kind: "profile",
			lastActivity: thread.updatedAt,
			members: [],
			name: "Your profile",
			prefix: "u/",
			seed: "profile:you",
			sourceId: "profile",
			threadCount: 1,
			workingCount: 0,
		}
	);
}

/** Replies under a post: every message after the opening one. */
export function commentCount(thread: InterfaceThread): number {
	return Math.max(0, thread.messageCount - 1);
}

export function buildPosts(
	snapshot: InterfaceSnapshot,
	communities: readonly Community[]
): CommunityPost[] {
	return snapshot.threads.map((thread) => {
		const [posterId] = thread.agentIds;
		return {
			comments: commentCount(thread),
			community: primaryCommunity(communities, thread),
			excerpt: thread.lastMessage?.trim() || null,
			poster: posterId
				? (snapshot.agents.find((agent) => agent.id === posterId) ?? null)
				: null,
			score: Math.max(0, thread.messageCount),
			status: threadStatus(thread),
			thread,
		};
	});
}

/** Score with the user's own vote applied. */
export function displayScore(
	post: CommunityPost,
	vote: CommunityVote | undefined
): number {
	return post.score + (vote ?? 0);
}

/** Reddit's epoch for hot ranking (Dec 8, 2005). */
const HOT_EPOCH_SECONDS = 1_134_028_003;
/** Seconds that equal one order of magnitude of score. */
const HOT_DECAY_SECONDS = 45_000;

/**
 * Reddit's hot rank: the log of the score plus time, so a post needs ten
 * times the score to hold its place against one 12.5 hours newer.
 */
export function hotRank(score: number, iso: string): number {
	const time = Date.parse(iso);
	const seconds = Number.isNaN(time) ? 0 : time / 1000 - HOT_EPOCH_SECONDS;
	const order = Math.log10(Math.max(Math.abs(score), 1));
	const sign = Math.sign(score);
	return sign * order + seconds / HOT_DECAY_SECONDS;
}

function byRecency(a: CommunityPost, b: CommunityPost): number {
	return (
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

/**
 * Orders posts. Votes never reorder a feed while the user is looking at it,
 * so ranking reads the base score only. Pinned posts lead a community's Hot
 * feed, the way stickied posts do.
 */
export function sortPosts(
	posts: readonly CommunityPost[],
	sort: CommunitySort,
	pinPinned = false
): CommunityPost[] {
	const ranked = [...posts];
	switch (sort) {
		case "new":
			ranked.sort(byRecency);
			break;
		case "top":
			ranked.sort((a, b) => b.score - a.score || byRecency(a, b));
			break;
		default:
			ranked.sort(
				(a, b) =>
					(pinPinned ? Number(b.thread.pinned) - Number(a.thread.pinned) : 0) ||
					hotRank(b.score, b.thread.updatedAt) -
						hotRank(a.score, a.thread.updatedAt) ||
					byRecency(a, b)
			);
	}
	return ranked;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Popular: posts active in the last day. */
export function isPopular(post: CommunityPost, now: number): boolean {
	const time = Date.parse(post.thread.updatedAt);
	return !Number.isNaN(time) && now - time <= DAY_MS;
}

function normalize(value: string): string {
	return value.toLowerCase().normalize("NFKD");
}

/** Every whitespace-separated term must appear somewhere in the post. */
export function matchesQuery(post: CommunityPost, query: string): boolean {
	const terms = normalize(query).split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return true;
	}
	const haystack = normalize(
		[
			post.thread.title,
			post.excerpt ?? "",
			post.community.name,
			`${post.community.prefix}${post.community.handle}`,
			post.poster?.name ?? "",
		].join(" ")
	);
	return terms.every((term) => haystack.includes(term));
}

export interface CommunityFeedInput {
	communities: readonly Community[];
	now: number;
	posts: readonly CommunityPost[];
	query: string;
	scope: CommunityScope;
	sort: CommunitySort;
}

/** The posts the centre column shows for a scope, search, and sort. */
export function communityFeed({
	communities,
	now,
	posts,
	query,
	scope,
	sort,
}: CommunityFeedInput): CommunityPost[] {
	let scoped: CommunityPost[];
	if (query.trim()) {
		scoped = posts.filter((post) => matchesQuery(post, query));
	} else if (scope.kind === "community") {
		const community = communities.find(
			(candidate) => candidate.key === scope.key
		);
		scoped = community
			? posts.filter((post) => inCommunity(community, post.thread))
			: [];
	} else if (scope.kind === "popular") {
		scoped = posts.filter((post) => isPopular(post, now));
	} else {
		scoped = [...posts];
	}
	return sortPosts(scoped, sort, scope.kind === "community" && !query.trim());
}

/** Communities ranked for the home rail: busiest first, then by name. */
export function rankedCommunities(
	communities: readonly Community[]
): Community[] {
	return communities
		.filter(
			(community) => community.kind !== "profile" && community.threadCount > 0
		)
		.sort(
			(a, b) =>
				b.threadCount - a.threadCount ||
				b.workingCount - a.workingCount ||
				a.name.localeCompare(b.name)
		);
}

/** Moves through the feed's order, clamping at the ends. */
export function stepPost(
	order: readonly string[],
	current: string | null,
	step: number
): string | null {
	if (order.length === 0) {
		return null;
	}
	const index = current ? order.indexOf(current) : -1;
	if (index === -1) {
		return step > 0 ? (order[0] ?? null) : (order.at(-1) ?? null);
	}
	return order[Math.min(order.length - 1, Math.max(0, index + step))] ?? null;
}

/** Toggles a vote the way Reddit does: same arrow again clears it. */
export function nextVote(
	current: CommunityVote | undefined,
	pressed: CommunityVote
): CommunityVote | undefined {
	return current === pressed ? undefined : pressed;
}

export const TITLE_LIMIT = 300;

export interface CommunityDraft {
	body: string;
	/** The chosen community's key, or null before one is picked. */
	communityKey: string | null;
	title: string;
}

export function emptyDraft(communityKey: string | null = null): CommunityDraft {
	return { body: "", communityKey, title: "" };
}

/** The one message a post sends: its title, then any body text. */
export function draftPrompt(draft: CommunityDraft): string {
	const title = draft.title.trim().slice(0, TITLE_LIMIT);
	const body = draft.body.trim();
	if (!title) {
		return "";
	}
	return body ? `${title}\n\n${body}` : title;
}

export interface CommunityStartInput {
	agentId?: string;
	projectId?: string;
	prompt?: string;
	teamId?: string;
}

/** Port input that files a new thread in a community. */
export function communityTarget(community: Community): CommunityStartInput {
	switch (community.kind) {
		case "project":
			return { projectId: community.sourceId };
		case "team":
			return { teamId: community.sourceId };
		case "agent":
			return { agentId: community.sourceId };
		default:
			return {};
	}
}

/** The port call for a draft, or null until it has a title and a community. */
export function draftStartInput(
	draft: CommunityDraft,
	communities: readonly Community[]
): CommunityStartInput | null {
	const prompt = draftPrompt(draft);
	const community = draft.communityKey
		? communities.find((candidate) => candidate.key === draft.communityKey)
		: undefined;
	if (!(prompt && (community || draft.communityKey === PROFILE_KEY))) {
		return null;
	}
	return { ...(community ? communityTarget(community) : {}), prompt };
}

/** Port input for "Message": an empty thread with one agent, filed here. */
export function messageInput(
	community: Community,
	agentId: string
): CommunityStartInput {
	if (community.kind === "project") {
		return { agentId, projectId: community.sourceId };
	}
	if (community.kind === "team") {
		return { agentId, teamId: community.sourceId };
	}
	return { agentId };
}

const AGE_STEPS: readonly [number, string, string][] = [
	[60, "min.", "min."],
	[24, "hr.", "hr."],
	[30, "day", "days"],
	[12, "mo.", "mo."],
	[Number.POSITIVE_INFINITY, "yr.", "yr."],
];

/** Reddit's relative time: "just now", "5 min. ago", "2 days ago". */
export function redditAge(iso: string, now: number): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) {
		return "";
	}
	let value = Math.floor(Math.max(0, now - time) / 60_000);
	if (value < 1) {
		return "just now";
	}
	for (const [size, one, many] of AGE_STEPS) {
		if (value < size) {
			return `${value} ${value === 1 ? one : many} ago`;
		}
		value = Math.floor(value / size);
	}
	return "";
}

/** Reddit's short counts: 999, 1k, 1.2k, 12k. */
export function shortCount(value: number): string {
	if (Math.abs(value) < 1000) {
		return String(value);
	}
	const thousands = value / 1000;
	const rounded =
		Math.abs(thousands) >= 10
			? Math.round(thousands)
			: Math.round(thousands * 10) / 10;
	return `${rounded}k`;
}

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The short flair a post carries for its status. */
export const STATUS_FLAIR: Record<ThreadStatus, string> = {
	attention: "Run failed",
	quiet: "Not started",
	waiting: "Waiting on agent",
	working: "Working",
	"your-turn": "Your turn",
};

/** A post's flair text: interrupted runs say so instead of "failed". */
export function flairLabel(post: CommunityPost): string {
	if (post.status === "attention" && post.thread.runState === "interrupted") {
		return "Interrupted";
	}
	return STATUS_FLAIR[post.status];
}

/** `r/WebsiteRedesign`, `u/you`. */
export function communityLabel(community: Community): string {
	return `${community.prefix}${community.handle}`;
}

/** `u/forge` for an agent poster, `u/you` with none. */
export function posterLabel(agent: InterfaceAgent | null): string {
	if (!agent) {
		return "u/you";
	}
	const handle = agent.name.toLowerCase().replace(/[^a-z0-9_]+/g, "");
	return `u/${handle || "agent"}`;
}

const ABSOLUTE = new Intl.DateTimeFormat("en", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	year: "numeric",
});

/** A full timestamp for `title` attributes. */
export function absoluteTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : ABSOLUTE.format(time);
}
