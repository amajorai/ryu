import { translate as tr } from "@ryu/i18n/lite";
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
	escapeValues,
	groupLink,
	joinSegments,
	richSegments,
	segmentsText,
	text,
	threadLink,
	type WikiSegment,
	wikiAgo,
	wikiCount,
} from "./wiki-model-prose.ts";
import {
	byName,
	byRecency,
	wikiAgent,
	wikiGroup,
	wikiThread,
	wikiThreadTitle,
} from "./wiki-model-routes.ts";

export {
	agentLeadActivity,
	agentLeadIntro,
} from "./wiki-model-leads.ts";

// ---------------------------------------------------------------------------
// Status phrasing
// ---------------------------------------------------------------------------

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
	const memberList = joinSegments(members.map(agentLink));
	const latest = threads[0];
	const latestLink = latest ? threadLink(latest) : null;
	const values = escapeValues({
		ago: latest ? wikiAgo(latest.updatedAt, now) : "",
		agents: wikiCount(members.length, "agent"),
		count: threads.length,
		kind: group.kind === "team" ? "team" : "project",
		latest: latestLink?.text ?? "",
		members: segmentsText(memberList),
		messages: wikiCount(article.messages, "message"),
		name: group.name,
		threads: wikiCount(threads.length, "thread"),
	});
	const tags = {
		b: (inner: string) => [bold(inner)],
		latest: () => (latestLink ? [latestLink] : []),
		members: () => memberList,
	};
	const out =
		members.length > 0
			? richSegments(
					tr(
						"{kind, select, team {<b>{name}</b> is a team in this workspace made up of {agents}: <members>{members}</members>.} other {<b>{name}</b> is a project in this workspace staffed by {agents}: <members>{members}</members>.}}",
						values
					),
					tags
				)
			: richSegments(
					tr(
						"{kind, select, team {<b>{name}</b> is a team in this workspace with no agents assigned.} other {<b>{name}</b> is a project in this workspace with no agents assigned.}}",
						values
					),
					tags
				);
	out.push(text(" "));
	if (!latest) {
		out.push(
			text(
				tr(
					"{kind, select, team {No threads have been filed under this team yet.} other {No threads have been filed under this project yet.}}",
					values
				)
			)
		);
		return out;
	}
	out.push(
		...richSegments(
			tr(
				"{count, plural, one {Its {threads} holds {messages}; the most recent is <latest>{latest}</latest>, updated {ago}.} other {Its {threads} hold {messages}; the most recent is <latest>{latest}</latest>, updated {ago}.}}",
				values
			),
			tags
		)
	);
	if (counts.working > 0) {
		out.push(
			text(" "),
			text(
				tr(
					"{count, plural, one {{n} run is live.} other {{n} runs are live.}}",
					{ count: counts.working, n: countWord(counts.working) }
				)
			)
		);
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

/** The thread's status in running prose ("is being worked on right now"). */
function statusProse(status: ThreadStatus): string {
	switch (status) {
		case "attention":
			return tr("The thread needs attention after its last run stopped.");
		case "quiet":
			return tr("The thread has not started yet.");
		case "waiting":
			return tr(
				"The thread is waiting on an agent to pick up your last message."
			);
		case "working":
			return tr("The thread is being worked on right now.");
		default:
			return tr("The thread is waiting on your reply.");
	}
}

export function threadLead(
	article: WikiThreadArticle,
	now: number
): WikiSegment[] {
	const { agents, project, team, thread, status } = article;
	const home = project ?? team;
	const homeLink = home ? groupLink(home) : null;
	const agentList = joinSegments(agents.map(agentLink));
	const values = escapeValues({
		agents: segmentsText(agentList),
		home: homeLink?.text ?? "",
		kind: home?.kind === "team" ? "team" : "project",
		title: wikiThreadTitle(thread),
	});
	const tags = {
		agents: () => agentList,
		b: (inner: string) => [bold(inner)],
		home: () => (homeLink ? [homeLink] : []),
	};
	let opening: string;
	if (home && agents.length > 0) {
		opening = tr(
			"{kind, select, team {<b>{title}</b> is a thread in the <home>{home}</home> team with <agents>{agents}</agents>.} other {<b>{title}</b> is a thread in the <home>{home}</home> project with <agents>{agents}</agents>.}}",
			values
		);
	} else if (home) {
		opening = tr(
			"{kind, select, team {<b>{title}</b> is a thread in the <home>{home}</home> team with no agent assigned.} other {<b>{title}</b> is a thread in the <home>{home}</home> project with no agent assigned.}}",
			values
		);
	} else if (agents.length > 0) {
		opening = tr(
			"<b>{title}</b> is a thread with <agents>{agents}</agents>.",
			values
		);
	} else {
		opening = tr("<b>{title}</b> is a thread with no agent assigned.", values);
	}
	return [
		...richSegments(opening, tags),
		text(" "),
		text(
			tr("It has {messages} and was last updated {ago}. {status}", {
				ago: wikiAgo(thread.updatedAt, now),
				messages: wikiCount(thread.messageCount, "message"),
				status: statusProse(status),
			})
		),
	];
}

/** Who wrote the latest message, for its attribution line. */
export function latestAuthor(article: WikiThreadArticle): string {
	if (article.thread.lastMessageRole === "user") {
		return tr("You");
	}
	return article.agents[0]?.name ?? tr("An agent");
}
