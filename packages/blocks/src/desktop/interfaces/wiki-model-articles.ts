import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	agentLink,
	bold,
	countWord,
	groupLink,
	joinSegments,
	lowerFirst,
	plural,
	text,
	threadLink,
	type WikiSegment,
	wikiAgo,
} from "./wiki-model-prose.ts";
import {
	byName,
	byRecency,
	wikiAgent,
	wikiGroup,
	wikiThread,
	wikiThreadTitle,
} from "./wiki-model-routes.ts";

// ---------------------------------------------------------------------------
// Status phrasing
// ---------------------------------------------------------------------------

/** Status in running prose ("is working", "needs attention"). */
const STATUS_PROSE: Record<ThreadStatus, string> = {
	attention: "needs attention after its last run stopped",
	quiet: "has not started yet",
	waiting: "is waiting on an agent to pick up your last message",
	working: "is being worked on right now",
	"your-turn": "is waiting on your reply",
};

export function statusCounts(
	threads: InterfaceThread[]
): Record<ThreadStatus, number> {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Agent articles
// ---------------------------------------------------------------------------

export interface WikiCollaborator {
	agent: InterfaceAgent;
	/** Threads both agents are on. */
	shared: number;
	/** Teams or projects both agents belong to. */
	sharedGroups: number;
}

export interface WikiAgentArticle {
	agent: InterfaceAgent;
	collaborators: WikiCollaborator[];
	counts: Record<ThreadStatus, number>;
	lastActive: string | null;
	messages: number;
	pastRuns: InterfaceEvent[];
	projects: InterfaceGroup[];
	teams: InterfaceGroup[];
	threads: InterfaceThread[];
	upcomingRuns: InterfaceEvent[];
}

function agentGroups(
	snapshot: InterfaceSnapshot,
	agentId: string,
	threads: InterfaceThread[]
): InterfaceGroup[] {
	const ids = new Set<string>();
	for (const thread of threads) {
		if (thread.teamId) {
			ids.add(thread.teamId);
		}
		if (thread.projectId) {
			ids.add(thread.projectId);
		}
	}
	return snapshot.groups
		.filter(
			(group) => group.memberAgentIds.includes(agentId) || ids.has(group.id)
		)
		.sort(byName);
}

export function wikiAgentArticle(
	snapshot: InterfaceSnapshot,
	agentId: string
): WikiAgentArticle | null {
	const agent = wikiAgent(snapshot, agentId);
	if (!agent) {
		return null;
	}
	const threads = snapshot.threads
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort(byRecency);
	const groups = agentGroups(snapshot, agentId, threads);
	const collaboratorMap = new Map<string, WikiCollaborator>();
	const touch = (id: string): WikiCollaborator | undefined => {
		if (id === agentId) {
			return undefined;
		}
		const other = wikiAgent(snapshot, id);
		if (!other) {
			return undefined;
		}
		const existing = collaboratorMap.get(id) ?? {
			agent: other,
			shared: 0,
			sharedGroups: 0,
		};
		collaboratorMap.set(id, existing);
		return existing;
	};
	for (const thread of threads) {
		for (const id of new Set(thread.agentIds)) {
			const entry = touch(id);
			if (entry) {
				entry.shared += 1;
			}
		}
	}
	for (const group of groups) {
		if (!group.memberAgentIds.includes(agentId)) {
			continue;
		}
		for (const id of new Set(group.memberAgentIds)) {
			const entry = touch(id);
			if (entry) {
				entry.sharedGroups += 1;
			}
		}
	}
	const collaborators = [...collaboratorMap.values()].sort(
		(a, b) =>
			b.shared - a.shared ||
			b.sharedGroups - a.sharedGroups ||
			byName(a.agent, b.agent)
	);
	const events = (snapshot.events ?? []).filter(
		(event) => event.agentId === agentId
	);
	return {
		agent,
		collaborators,
		counts: statusCounts(threads),
		lastActive: threads[0]?.updatedAt ?? null,
		messages: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
		pastRuns: events
			.filter((event) => event.kind === "past")
			.sort((a, b) => b.start.localeCompare(a.start)),
		projects: groups.filter((group) => group.kind === "project"),
		teams: groups.filter((group) => group.kind === "team"),
		threads,
		upcomingRuns: events
			.filter((event) => event.kind === "upcoming")
			.sort((a, b) => a.start.localeCompare(b.start)),
	};
}

/** First lead paragraph: who the agent is and where it belongs. */
export function agentLeadIntro(article: WikiAgentArticle): WikiSegment[] {
	const { agent, teams, projects } = article;
	const out: WikiSegment[] = [
		bold(agent.name),
		text(" is an agent in this workspace"),
	];
	const description = lowerFirst(agent.description);
	if (description) {
		out.push(text(`, described as “${description}”`));
	}
	out.push(text("."));
	const memberships = [
		...teams.map((group) => ({ group, noun: "team" })),
		...projects.map((group) => ({ group, noun: "project" })),
	].filter(({ group }) => group.memberAgentIds.includes(agent.id));
	if (memberships.length > 0) {
		out.push(text(" It is a member of "));
		const phrases: WikiSegment[][] = [];
		for (const noun of ["team", "project"]) {
			const groups = memberships.filter((item) => item.noun === noun);
			if (groups.length === 0) {
				continue;
			}
			phrases.push([
				text("the "),
				...joinSegments(groups.map(({ group }) => groupLink(group))),
				text(groups.length === 1 ? ` ${noun}` : ` ${noun}s`),
			]);
		}
		for (const [index, phrase] of phrases.entries()) {
			if (index > 0) {
				out.push(text(" and "));
			}
			out.push(...phrase);
		}
		out.push(text("."));
	}
	return out;
}

/** Second lead paragraph: activity in numbers. */
export function agentLeadActivity(
	article: WikiAgentArticle,
	now: number
): WikiSegment[] {
	const { agent, threads, counts, messages } = article;
	const latest = threads[0];
	if (!latest) {
		return [
			text(
				`${agent.name} has not taken part in any threads yet. Its talk page is where to start one.`
			),
		];
	}
	const out: WikiSegment[] = [
		text(
			`${agent.name} has taken part in ${plural(threads.length, "thread")}, with ${plural(messages, "message")} in all. Its most recent is `
		),
		threadLink(latest),
		text(`, updated ${wikiAgo(latest.updatedAt, now)}.`),
	];
	const notes: string[] = [];
	if (counts.working > 0) {
		notes.push(`it is working on ${plural(counts.working, "thread")}`);
	}
	if (counts["your-turn"] > 0) {
		notes.push(
			`${countWord(counts["your-turn"])} of its threads ${counts["your-turn"] === 1 ? "is" : "are"} waiting on your reply`
		);
	}
	if (counts.attention > 0) {
		notes.push(
			`${countWord(counts.attention)} of its threads ${counts.attention === 1 ? "needs" : "need"} attention after a stopped run`
		);
	}
	if (notes.length > 0) {
		out.push(
			text(" Right now, "),
			...joinSegments(notes.map((note) => text(note))),
			text(".")
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Group (team / project) articles
// ---------------------------------------------------------------------------

export interface WikiGroupArticle {
	counts: Record<ThreadStatus, number>;
	group: InterfaceGroup;
	lastActive: string | null;
	members: InterfaceAgent[];
	messages: number;
	/** Other groups that share a member. */
	related: InterfaceGroup[];
	threads: InterfaceThread[];
}

export function wikiGroupArticle(
	snapshot: InterfaceSnapshot,
	groupId: string
): WikiGroupArticle | null {
	const group = wikiGroup(snapshot, groupId);
	if (!group) {
		return null;
	}
	const threads = snapshot.threads
		.filter((thread) =>
			group.kind === "team"
				? thread.teamId === group.id
				: thread.projectId === group.id
		)
		.sort(byRecency);
	const members = group.memberAgentIds
		.map((id) => wikiAgent(snapshot, id))
		.filter((agent) => agent !== undefined)
		.sort(byName);
	const memberIds = new Set(group.memberAgentIds);
	const related = snapshot.groups
		.filter(
			(other) =>
				other.id !== group.id &&
				other.memberAgentIds.some((id) => memberIds.has(id))
		)
		.sort(byName);
	return {
		counts: statusCounts(threads),
		group,
		lastActive: threads[0]?.updatedAt ?? null,
		members,
		messages: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
		related,
		threads,
	};
}

export function groupLead(
	article: WikiGroupArticle,
	now: number
): WikiSegment[] {
	const { group, members, threads, counts } = article;
	const noun = group.kind === "team" ? "team" : "project";
	const out: WikiSegment[] = [
		bold(group.name),
		text(` is a ${noun} in this workspace`),
	];
	if (members.length > 0) {
		out.push(
			text(
				group.kind === "team"
					? ` made up of ${plural(members.length, "agent")}: `
					: ` staffed by ${plural(members.length, "agent")}: `
			),
			...joinSegments(members.map(agentLink))
		);
	} else {
		out.push(text(" with no agents assigned"));
	}
	out.push(text("."));
	const latest = threads[0];
	if (latest) {
		out.push(
			text(
				` Its ${plural(threads.length, "thread")} ${threads.length === 1 ? "holds" : "hold"} ${plural(article.messages, "message")}; the most recent is `
			),
			threadLink(latest),
			text(`, updated ${wikiAgo(latest.updatedAt, now)}.`)
		);
		if (counts.working > 0) {
			out.push(
				text(
					` ${countWord(counts.working)} ${counts.working === 1 ? "run is" : "runs are"} live.`
				)
			);
		}
	} else {
		out.push(text(` No threads have been filed under this ${noun} yet.`));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Thread articles
// ---------------------------------------------------------------------------

export interface WikiThreadArticle {
	agents: InterfaceAgent[];
	project: InterfaceGroup | undefined;
	/** Threads that share the project, team, or an agent; newest first. */
	related: InterfaceThread[];
	status: ThreadStatus;
	team: InterfaceGroup | undefined;
	thread: InterfaceThread;
}

const RELATED_LIMIT = 5;

export function wikiThreadArticle(
	snapshot: InterfaceSnapshot,
	threadId: string
): WikiThreadArticle | null {
	const thread = wikiThread(snapshot, threadId);
	if (!thread) {
		return null;
	}
	const agentIds = new Set(thread.agentIds);
	const related = snapshot.threads
		.filter(
			(other) =>
				other.id !== thread.id &&
				((thread.projectId !== null && other.projectId === thread.projectId) ||
					(thread.teamId !== null && other.teamId === thread.teamId) ||
					other.agentIds.some((id) => agentIds.has(id)))
		)
		.sort(byRecency)
		.slice(0, RELATED_LIMIT);
	return {
		agents: thread.agentIds
			.map((id) => wikiAgent(snapshot, id))
			.filter((agent) => agent !== undefined),
		project: wikiGroup(snapshot, thread.projectId),
		related,
		status: threadStatus(thread),
		team: wikiGroup(snapshot, thread.teamId),
		thread,
	};
}

export function threadLead(
	article: WikiThreadArticle,
	now: number
): WikiSegment[] {
	const { agents, project, team, thread, status } = article;
	const out: WikiSegment[] = [
		bold(wikiThreadTitle(thread)),
		text(" is a thread"),
	];
	const home = project ?? team;
	if (home) {
		out.push(
			text(" in the "),
			groupLink(home),
			text(home.kind === "team" ? " team" : " project")
		);
	}
	if (agents.length > 0) {
		out.push(text(" with "), ...joinSegments(agents.map(agentLink)));
	} else {
		out.push(text(" with no agent assigned"));
	}
	out.push(
		text(
			`. It has ${plural(thread.messageCount, "message")} and was last updated ${wikiAgo(thread.updatedAt, now)}. The thread ${STATUS_PROSE[status]}.`
		)
	);
	return out;
}

/** Who wrote the latest message, for its attribution line. */
export function latestAuthor(article: WikiThreadArticle): string {
	if (article.thread.lastMessageRole === "user") {
		return "You";
	}
	return article.agents[0]?.name ?? "An agent";
}
