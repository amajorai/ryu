import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** The feed's filter tabs, in Stack Overflow's order: everything first. */
export type QaTab = "answered" | "attention" | "top" | "unanswered";

export const QA_TABS: readonly {
	id: QaTab;
	label: string;
	/** What the tab says when the feed is phone-narrow. */
	short: string;
}[] = [
	{ id: "top", label: "Top", short: "Top" },
	{ id: "unanswered", label: "Unanswered", short: "Unanswered" },
	{ id: "answered", label: "Answered", short: "Answered" },
	{ id: "attention", label: "Needs attention", short: "Attention" },
];

/** A question's topic tag: the project or team its thread is filed under. */
export interface QaTopic {
	id: string;
	kind: "project" | "team";
	name: string;
}

/**
 * What the byline over a question's excerpt says, from the user's side:
 * an agent answered, is answering, or failed; the user asked and is waiting;
 * or nothing has been said yet.
 */
export type QaBylineKind =
	| "answered"
	| "answering"
	| "asked"
	| "failed"
	| "unasked";

export interface QaQuestion {
	/** The thread's agents, in the thread's order. */
	answerers: InterfaceAgent[];
	/** Agent replies, estimated from the alternating message count. */
	answers: number;
	byline: QaBylineKind;
	/** The newest message, flattened, when the host has it. */
	excerpt: string | null;
	status: ThreadStatus;
	thread: InterfaceThread;
	topics: QaTopic[];
}

export interface QaFilter {
	agentId: string | null;
	query: string;
	tab: QaTab;
	topicId: string | null;
}

export const EMPTY_QA_FILTER: QaFilter = {
	agentId: null,
	query: "",
	tab: "top",
	topicId: null,
};

const BYLINE: Record<ThreadStatus, QaBylineKind> = {
	attention: "failed",
	quiet: "unasked",
	waiting: "asked",
	working: "answering",
	"your-turn": "answered",
};

/**
 * Agent replies in a thread. Threads alternate user then agent, so an even
 * count ending on the agent is half agent replies, and an odd count ending on
 * the user leaves the trailing question unanswered.
 */
export function qaAnswerCount(thread: InterfaceThread): number {
	const total = Math.max(0, thread.messageCount);
	if (total === 0) {
		return 0;
	}
	if (thread.lastMessageRole === "assistant") {
		return Math.max(1, Math.ceil(total / 2));
	}
	return Math.floor(total / 2);
}

export function qaTopicsFor(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): QaTopic[] {
	const topics: QaTopic[] = [];
	for (const id of [thread.projectId, thread.teamId]) {
		const group = id
			? snapshot.groups.find((candidate) => candidate.id === id)
			: undefined;
		if (group) {
			topics.push({ id: group.id, kind: group.kind, name: group.name });
		}
	}
	return topics;
}

function agentsOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	const agents: InterfaceAgent[] = [];
	for (const id of thread.agentIds) {
		const agent = snapshot.agents.find((candidate) => candidate.id === id);
		if (agent) {
			agents.push(agent);
		}
	}
	return agents;
}

export function qaQuestion(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): QaQuestion {
	const status = threadStatus(thread);
	return {
		answerers: agentsOf(snapshot, thread),
		answers: qaAnswerCount(thread),
		byline: BYLINE[status],
		excerpt: thread.lastMessage?.trim() || null,
		status,
		thread,
		topics: qaTopicsFor(snapshot, thread),
	};
}

/** Which non-Top tab a status belongs to; working runs only show under Top. */
export function qaTabOf(status: ThreadStatus): QaTab | null {
	switch (status) {
		case "attention":
			return "attention";
		case "your-turn":
			return "answered";
		case "waiting":
		case "quiet":
			return "unanswered";
		default:
			return null;
	}
}

function byRecency(a: QaQuestion, b: QaQuestion): number {
	return (
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

function pinnedThenRecent(a: QaQuestion, b: QaQuestion): number {
	return Number(b.thread.pinned) - Number(a.thread.pinned) || byRecency(a, b);
}

function normalize(value: string): string {
	return value.toLowerCase().normalize("NFKD");
}

/** Every whitespace-separated term must appear in the question's text. */
export function qaMatches(question: QaQuestion, query: string): boolean {
	const terms = normalize(query).split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return true;
	}
	const haystack = normalize(
		[
			question.thread.title,
			question.excerpt ?? "",
			...question.answerers.map((agent) => agent.name),
			...question.topics.map((topic) => topic.name),
		].join(" ")
	);
	return terms.every((term) => haystack.includes(term));
}

/** All questions, built once per snapshot. */
export function qaAllQuestions(snapshot: InterfaceSnapshot): QaQuestion[] {
	return snapshot.threads.map((thread) => qaQuestion(snapshot, thread));
}

/** Questions that pass the topic, answerer, and search parts of a filter. */
export function qaScoped(
	questions: readonly QaQuestion[],
	filter: QaFilter
): QaQuestion[] {
	return questions.filter(
		(question) =>
			(!filter.topicId ||
				question.topics.some((topic) => topic.id === filter.topicId)) &&
			(!filter.agentId || question.thread.agentIds.includes(filter.agentId)) &&
			qaMatches(question, filter.query)
	);
}

/** The feed for a filter: Top keeps pinned questions first, tabs are recent-first. */
export function qaFeed(
	questions: readonly QaQuestion[],
	filter: QaFilter
): QaQuestion[] {
	const scoped = qaScoped(questions, filter);
	if (filter.tab === "top") {
		return scoped.sort(pinnedThenRecent);
	}
	return scoped
		.filter((question) => qaTabOf(question.status) === filter.tab)
		.sort(byRecency);
}

/** How many questions each tab holds under the rest of the filter. */
export function qaTabCounts(
	questions: readonly QaQuestion[],
	filter: QaFilter
): Record<QaTab, number> {
	const counts: Record<QaTab, number> = {
		answered: 0,
		attention: 0,
		top: 0,
		unanswered: 0,
	};
	for (const question of qaScoped(questions, filter)) {
		counts.top += 1;
		const tab = qaTabOf(question.status);
		if (tab) {
			counts[tab] += 1;
		}
	}
	return counts;
}

export interface QaAnswerer {
	agent: InterfaceAgent;
	/** Agent replies across every thread the agent is on. */
	answers: number;
	/** Threads the agent is on. */
	questions: number;
}

/** Agents ranked by replies, then by name. Agents with no replies are left out. */
export function qaTopAnswerers(
	snapshot: InterfaceSnapshot,
	limit = 5
): QaAnswerer[] {
	const ranked: QaAnswerer[] = [];
	for (const agent of snapshot.agents) {
		let answers = 0;
		let questions = 0;
		for (const thread of snapshot.threads) {
			if (thread.agentIds.includes(agent.id)) {
				questions += 1;
				answers += qaAnswerCount(thread);
			}
		}
		if (answers > 0) {
			ranked.push({ agent, answers, questions });
		}
	}
	return ranked
		.sort(
			(a, b) =>
				b.answers - a.answers || a.agent.name.localeCompare(b.agent.name)
		)
		.slice(0, limit);
}

export interface QaTopicCount {
	count: number;
	topic: QaTopic;
}

/** Topics with how many questions carry each, busiest first. */
export function qaTopicCounts(snapshot: InterfaceSnapshot): QaTopicCount[] {
	const counts: QaTopicCount[] = [];
	for (const group of snapshot.groups) {
		const count = snapshot.threads.filter(
			(thread) => thread.projectId === group.id || thread.teamId === group.id
		).length;
		if (count > 0) {
			counts.push({
				count,
				topic: { id: group.id, kind: group.kind, name: group.name },
			});
		}
	}
	return counts.sort(
		(a, b) => b.count - a.count || a.topic.name.localeCompare(b.topic.name)
	);
}

/**
 * Questions related to an open one: those sharing an agent or a topic, the
 * closest overlap first, then the most recent.
 */
export function qaRelated(
	snapshot: InterfaceSnapshot,
	threadId: string,
	limit = 8
): QaQuestion[] {
	const open = snapshot.threads.find((thread) => thread.id === threadId);
	if (!open) {
		return [];
	}
	const topicIds = new Set(
		[open.projectId, open.teamId].filter((id): id is string => Boolean(id))
	);
	const scored: { question: QaQuestion; score: number }[] = [];
	for (const thread of snapshot.threads) {
		if (thread.id === open.id) {
			continue;
		}
		const sharedAgents = thread.agentIds.filter((id) =>
			open.agentIds.includes(id)
		).length;
		const sharedTopics = [thread.projectId, thread.teamId].filter(
			(id) => id !== null && topicIds.has(id)
		).length;
		const score = sharedAgents + sharedTopics;
		if (score > 0) {
			scored.push({ question: qaQuestion(snapshot, thread), score });
		}
	}
	return scored
		.sort((a, b) => b.score - a.score || byRecency(a.question, b.question))
		.slice(0, limit)
		.map((entry) => entry.question);
}

/** Moves through the feed's order, clamping at the ends. */
export function qaStep(
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
	const next = Math.min(order.length - 1, Math.max(0, index + step));
	return order[next] ?? null;
}

export interface QaDraft {
	/** Who should answer; null lets the host pick. */
	agentId: string | null;
	body: string;
	title: string;
	/** A project or team to file the question under. */
	topicId: string | null;
}

export function emptyQaDraft(filter?: QaFilter): QaDraft {
	return {
		agentId: filter?.agentId ?? null,
		body: "",
		title: "",
		topicId: filter?.topicId ?? null,
	};
}

/** The one message a question sends: its title, then any details. */
export function qaPrompt(draft: QaDraft): string {
	const title = draft.title.trim();
	const body = draft.body.trim();
	if (!title) {
		return "";
	}
	return body ? `${title}\n\n${body}` : title;
}

export interface QaStartInput {
	agentId?: string;
	projectId?: string;
	prompt: string;
	teamId?: string;
}

/** The port call for a draft, or null while it has no question to send. */
export function qaStartInput(
	draft: QaDraft,
	snapshot: InterfaceSnapshot
): QaStartInput | null {
	const prompt = qaPrompt(draft);
	if (!prompt) {
		return null;
	}
	const input: QaStartInput = { prompt };
	if (
		draft.agentId &&
		snapshot.agents.some((agent) => agent.id === draft.agentId)
	) {
		input.agentId = draft.agentId;
	}
	const group = draft.topicId
		? snapshot.groups.find((candidate) => candidate.id === draft.topicId)
		: undefined;
	if (group?.kind === "project") {
		input.projectId = group.id;
	} else if (group?.kind === "team") {
		input.teamId = group.id;
	}
	return input;
}

/** "Atlas", "Atlas and Echo", "Atlas and 2 others". */
export function qaNames(agents: readonly InterfaceAgent[]): string {
	const [first, second] = agents;
	if (!first) {
		return "";
	}
	if (!second) {
		return first.name;
	}
	if (agents.length === 2) {
		return `${first.name} and ${second.name}`;
	}
	return `${first.name} and ${agents.length - 1} others`;
}

/** Pluralized count, e.g. "1 answer", "3 answers". */
export function qaCount(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The feed heading for a filter, in Stack Overflow's words. */
export function qaHeading(
	snapshot: InterfaceSnapshot,
	filter: QaFilter
): string {
	const topic = filter.topicId
		? snapshot.groups.find((group) => group.id === filter.topicId)
		: undefined;
	const agent = filter.agentId
		? snapshot.agents.find((candidate) => candidate.id === filter.agentId)
		: undefined;
	if (filter.query.trim()) {
		return "Search results";
	}
	if (topic && agent) {
		return `${agent.name} in ${topic.name}`;
	}
	if (topic) {
		return `Questions in ${topic.name}`;
	}
	if (agent) {
		return `Questions for ${agent.name}`;
	}
	return "Top questions";
}

const ABSOLUTE = new Intl.DateTimeFormat("en", {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	year: "numeric",
});

/** A full timestamp for tooltips and `title` attributes. */
export function qaAbsoluteTime(iso: string): string {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? "" : ABSOLUTE.format(time);
}
