import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** Where the left rail can take the user. */
export type StreamView = "activity" | "home" | "profile" | "search";

/** The two home feeds, like the reference's "For you" / "Following". */
export type StreamFeed = "for-you" | "working";

export type StreamActivityFilter = "all" | "failed" | "replies";

export type StreamProfileTab = "replies" | "threads";

/** One conversation drawn as a post by its lead agent. */
export interface StreamPost {
	/** The lead agent, or undefined for a thread nobody owns (shown as "You"). */
	author: InterfaceAgent | undefined;
	/** Flattened newest message, empty when the host has none. */
	body: string;
	bodyRole: InterfaceThread["lastMessageRole"];
	/** Faces in the reply facepile: the other agents, else the lead. */
	faces: InterfaceAgent[];
	/** Every agent in the thread that the snapshot knows. */
	participants: InterfaceAgent[];
	pinned: boolean;
	/** Messages after the opening one. */
	replyCount: number;
	runState: InterfaceThread["runState"];
	status: ThreadStatus;
	threadId: string;
	title: string;
	/** The team or project the thread is filed under, shown as a topic. */
	topic: string | null;
	updatedAt: string;
}

/** A phrase under the post saying where the conversation stands. */
export interface StreamStatusLine {
	text: string;
	tone: "attention" | "live" | "muted" | "strong";
}

const WHITESPACE = /\s+/g;

function flatten(text: string | null): string {
	return (text ?? "").replace(WHITESPACE, " ").trim();
}

function byRecency(a: StreamPost, b: StreamPost): number {
	return (
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.threadId.localeCompare(b.threadId)
	);
}

function topicFor(
	thread: InterfaceThread,
	groups: Map<string, InterfaceGroup>
): string | null {
	const groupId = thread.teamId ?? thread.projectId;
	return groupId ? (groups.get(groupId)?.name ?? null) : null;
}

/** Project a thread into a post. */
export function toStreamPost(
	thread: InterfaceThread,
	agents: Map<string, InterfaceAgent>,
	groups: Map<string, InterfaceGroup>
): StreamPost {
	const participants = thread.agentIds
		.map((id) => agents.get(id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	const [author, ...others] = participants;
	const title = flatten(thread.title) || "Untitled thread";
	const message = flatten(thread.lastMessage);
	return {
		author,
		// A fresh thread is titled from its first message; don't say it twice.
		body: message === title ? "" : message,
		bodyRole: thread.lastMessageRole,
		faces: others.length > 0 ? others : participants.slice(0, 1),
		participants,
		pinned: thread.pinned,
		replyCount: Math.max(0, thread.messageCount - 1),
		runState: thread.runState ?? null,
		status: threadStatus(thread),
		threadId: thread.id,
		title,
		topic: topicFor(thread, groups),
		updatedAt: thread.updatedAt,
	};
}

/** Every thread as a post: pinned first, then most recent activity. */
export function projectStreamPosts(snapshot: InterfaceSnapshot): StreamPost[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	return snapshot.threads
		.map((thread) => toStreamPost(thread, agents, groups))
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b));
}

/** "For you" is everything; "Working" is the conversations with a live run. */
export function feedPosts(posts: StreamPost[], feed: StreamFeed): StreamPost[] {
	if (feed === "for-you") {
		return posts;
	}
	return posts.filter((post) => post.status === "working").sort(byRecency);
}

const ACTIVITY_STATUSES: Record<StreamActivityFilter, ThreadStatus[]> = {
	all: ["attention", "your-turn"],
	failed: ["attention"],
	replies: ["your-turn"],
};

/** Conversations waiting on the user, most urgent first. */
export function activityPosts(
	posts: StreamPost[],
	filter: StreamActivityFilter
): StreamPost[] {
	const wanted = ACTIVITY_STATUSES[filter];
	return posts
		.filter((post) => wanted.includes(post.status))
		.sort(
			(a, b) =>
				THREAD_STATUS_ORDER.indexOf(a.status) -
					THREAD_STATUS_ORDER.indexOf(b.status) || byRecency(a, b)
		);
}

/** How many conversations wait on the user (the rail's Activity dot). */
export function activityCount(posts: StreamPost[]): number {
	return activityPosts(posts, "all").length;
}

/** Agents ordered by their latest conversation, then name. */
export function agentsByActivity(
	snapshot: InterfaceSnapshot,
	posts: StreamPost[]
): InterfaceAgent[] {
	const latest = new Map<string, string>();
	for (const post of posts) {
		for (const agent of post.participants) {
			const seen = latest.get(agent.id);
			if (!seen || post.updatedAt > seen) {
				latest.set(agent.id, post.updatedAt);
			}
		}
	}
	return [...snapshot.agents].sort(
		(a, b) =>
			(latest.get(b.id) ?? "").localeCompare(latest.get(a.id) ?? "") ||
			a.name.localeCompare(b.name)
	);
}

function normalize(query: string): string {
	return query.trim().toLowerCase();
}

export interface StreamSearchResult {
	agents: InterfaceAgent[];
	posts: StreamPost[];
}

/** Agents by name or description; posts by title, message, agent or topic. */
export function searchStream(
	agents: InterfaceAgent[],
	posts: StreamPost[],
	query: string
): StreamSearchResult {
	const needle = normalize(query);
	if (!needle) {
		return { agents, posts: [] };
	}
	const hit = (value: string | null | undefined) =>
		(value ?? "").toLowerCase().includes(needle);
	return {
		agents: agents.filter((agent) => hit(agent.name) || hit(agent.description)),
		posts: posts.filter(
			(post) =>
				hit(post.title) ||
				hit(post.body) ||
				hit(post.topic) ||
				post.participants.some((agent) => hit(agent.name))
		),
	};
}

export interface StreamProfile {
	agent: InterfaceAgent;
	/** Teams and projects the agent belongs to. */
	groups: InterfaceGroup[];
	/** Conversations the agent joined but does not lead. */
	replies: StreamPost[];
	/** Agents who share a team or project with this one. */
	teammates: InterfaceAgent[];
	/** Conversations the agent leads. */
	threads: StreamPost[];
}

export function profileFor(
	snapshot: InterfaceSnapshot,
	posts: StreamPost[],
	agentId: string | null
): StreamProfile | null {
	const agent = snapshot.agents.find((item) => item.id === agentId);
	if (!agent) {
		return null;
	}
	const groups = snapshot.groups.filter((group) =>
		group.memberAgentIds.includes(agent.id)
	);
	const teammateIds = new Set(groups.flatMap((group) => group.memberAgentIds));
	teammateIds.delete(agent.id);
	return {
		agent,
		groups,
		replies: posts.filter(
			(post) =>
				post.author?.id !== agent.id &&
				post.participants.some((item) => item.id === agent.id)
		),
		teammates: snapshot.agents.filter((item) => teammateIds.has(item.id)),
		threads: posts.filter((post) => post.author?.id === agent.id),
	};
}

/** Lead conversations per agent, for the search suggestions. */
export function threadCounts(posts: StreamPost[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const post of posts) {
		if (post.author) {
			counts.set(post.author.id, (counts.get(post.author.id) ?? 0) + 1);
		}
	}
	return counts;
}

export function replyLabel(count: number): string {
	return count === 1 ? "1 reply" : `${count} replies`;
}

export function threadLabel(count: number): string {
	return count === 1 ? "1 thread" : `${count} threads`;
}

/** Where the conversation stands, in a few words, or null when it is idle. */
export function statusLine(post: StreamPost): StreamStatusLine | null {
	const lead = post.author?.name;
	switch (post.status) {
		case "working":
			return { text: lead ? `${lead} is replying` : "Replying", tone: "live" };
		case "attention":
			return {
				text:
					post.runState === "interrupted" ? "Run interrupted" : "Run failed",
				tone: "attention",
			};
		case "your-turn":
			return { text: "Your turn", tone: "strong" };
		case "waiting":
			return lead ? { text: `Waiting on ${lead}`, tone: "muted" } : null;
		default:
			return null;
	}
}

/** The activity row's verb: what happened that needs the user. */
export function activityVerb(post: StreamPost): string {
	if (post.status === "attention") {
		return post.runState === "interrupted"
			? "Run interrupted in"
			: "Run failed in";
	}
	return "Replied in";
}

/** The agent the composer posts to by default: the most recently active. */
export function defaultComposerAgent(
	agents: InterfaceAgent[],
	pickedId: string | null
): InterfaceAgent | undefined {
	return agents.find((agent) => agent.id === pickedId) ?? agents[0];
}
