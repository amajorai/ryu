import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { PROFILE_KEY } from "./community-model-keys.ts";
import { sortPosts } from "./community-model-ranking.ts";

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

export type {
	CommunityDraft,
	CommunityStartInput,
} from "./community-model-draft.ts";
export {
	communityTarget,
	draftPrompt,
	draftStartInput,
	emptyDraft,
	messageInput,
	TITLE_LIMIT,
} from "./community-model-draft.ts";
export {
	absoluteTime,
	communityLabel,
	flairLabel,
	plural,
	posterLabel,
	redditAge,
	STATUS_FLAIR,
	shortCount,
} from "./community-model-format.ts";
export { PROFILE_KEY } from "./community-model-keys.ts";
export {
	displayScore,
	hotRank,
	sortPosts,
} from "./community-model-ranking.ts";
