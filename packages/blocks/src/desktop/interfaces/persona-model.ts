import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";

/** The five sections of the Persona app, in tab-bar order. */
export const PERSONA_TABS = [
	"chat",
	"feed",
	"ideas",
	"goals",
	"activity",
] as const;
export type PersonaTab = (typeof PERSONA_TABS)[number];

export const PERSONA_TAB_LABELS: Record<PersonaTab, string> = {
	activity: "Activity",
	chat: "Chat",
	feed: "Feed",
	goals: "Goals",
	ideas: "Ideas",
};

/** How far the status line under the persona's name is unfolded. */
export type StatusDepth = 0 | 1 | 2;

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function statusRank(thread: InterfaceThread): number {
	return THREAD_STATUS_ORDER.indexOf(threadStatus(thread));
}

/** The persona's threads, pinned first, then most recent. */
export function personaThreads(
	snapshot: InterfaceSnapshot,
	agentId: string | null
): InterfaceThread[] {
	if (!agentId) {
		return [];
	}
	return snapshot.threads
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b));
}

/**
 * The persona to show first: the agent behind the most recent conversation,
 * so opening the app lands on whoever you last talked to.
 */
export function defaultPersonaId(snapshot: InterfaceSnapshot): string | null {
	const recent = [...snapshot.threads].sort(byRecency);
	for (const thread of recent) {
		const owner = thread.agentIds.find((id) =>
			snapshot.agents.some((agent) => agent.id === id)
		);
		if (owner) {
			return owner;
		}
	}
	return snapshot.agents[0]?.id ?? null;
}

/** The persona that owns a thread, preferring the current one when shared. */
export function personaForThread(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread | undefined,
	current: string | null
): string | null {
	if (!thread) {
		return current;
	}
	if (current && thread.agentIds.includes(current)) {
		return current;
	}
	return (
		thread.agentIds.find((id) =>
			snapshot.agents.some((agent) => agent.id === id)
		) ?? current
	);
}

/**
 * The persona's main conversation: its one-to-one thread, chosen so it
 * stays put while new chats arrive. A pinned one wins; otherwise the one
 * with the most messages, then the one least recently touched, so a fresh
 * side chat (few messages, just updated) never takes over. Group threads are
 * side chats; with no one-to-one thread the busiest shared one stands in.
 */
export function mainThread(
	threads: InterfaceThread[],
	agentId: string | null
): InterfaceThread | undefined {
	const direct = threads.filter(
		(thread) => thread.agentIds.length === 1 && thread.agentIds[0] === agentId
	);
	const pool = direct.length > 0 ? direct : threads;
	return [...pool].sort(
		(a, b) =>
			Number(b.pinned) - Number(a.pinned) ||
			b.messageCount - a.messageCount ||
			a.updatedAt.localeCompare(b.updatedAt) ||
			a.id.localeCompare(b.id)
	)[0];
}

/** Every other thread of the persona, newest first. */
export function sideChats(
	threads: InterfaceThread[],
	main: InterfaceThread | undefined
): InterfaceThread[] {
	return threads
		.filter((thread) => thread.id !== main?.id)
		.sort((a, b) => byRecency(a, b));
}

export interface PersonaStatus {
	/** The one-liner under the persona's name ("Launch week plan · Your turn"). */
	headline: string;
	/** What the lead task is doing ("Working"), empty when idle. */
	label: string;
	/** The status that colors the headline's mark. */
	status: ThreadStatus | "idle";
	/** Threads in motion (or waiting on someone), most urgent first. */
	steps: InterfaceThread[];
	totals: {
		lastActiveAt: string | null;
		messages: number;
		threads: number;
	};
}

/**
 * What the persona's one-liner leads with: live work first (that is what
 * "what is it doing" means), then a stopped run, then your message it has
 * not picked up, then a reply waiting on you.
 */
const STEP_ORDER: ThreadStatus[] = [
	"working",
	"attention",
	"waiting",
	"your-turn",
];

function stepRank(thread: InterfaceThread): number {
	const rank = STEP_ORDER.indexOf(threadStatus(thread));
	return rank === -1 ? STEP_ORDER.length : rank;
}

/** The state that follows the task in the one-liner. */
export const STEP_LABELS: Record<ThreadStatus, string> = {
	attention: "Run stopped",
	quiet: "Not started",
	waiting: "Queued",
	working: "Working",
	"your-turn": "Your turn",
};

/**
 * The three-layer status line: an essential one-liner, the steps behind it
 * (the persona's running, failed, waiting and replied threads), and the
 * totals the detail layer shows.
 */
export function personaStatus(
	agent: InterfaceAgent | undefined,
	threads: InterfaceThread[]
): PersonaStatus {
	const steps = threads
		.filter((thread) => threadStatus(thread) !== "quiet")
		.sort((a, b) => stepRank(a) - stepRank(b) || byRecency(a, b));
	const latest = [...threads].sort(byRecency)[0];
	const totals = {
		lastActiveAt: latest?.updatedAt ?? null,
		messages: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
		threads: threads.length,
	};
	const lead = steps[0];
	if (!lead) {
		return {
			headline: agent?.description || "Free to chat",
			label: "",
			status: "idle",
			steps,
			totals,
		};
	}
	const status = threadStatus(lead);
	const label = STEP_LABELS[status];
	return {
		headline: `${lead.title || "Untitled"} · ${label}`,
		label,
		status,
		steps,
		totals,
	};
}

export interface FeedDay {
	key: string;
	label: string;
	threads: InterfaceThread[];
}

/** Calendar label for a local day relative to now ("Today", "Yesterday", "Oct 5"). */
export function dayLabel(iso: string, now: number = Date.now()): string {
	const date = new Date(iso);
	const today = new Date(now);
	const key = localDayKey(date);
	if (key === localDayKey(today)) {
		return "Today";
	}
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return "Yesterday";
	}
	const sameYear = date.getFullYear() === today.getFullYear();
	return date.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		...(sameYear ? {} : { year: "numeric" }),
	});
}

/** Clock time for a log row ("9:41 AM"). */
export function clockTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

/** Day and clock time for a detail line ("Today 9:41 AM", "Oct 5 9:41 AM"). */
export function dayTime(iso: string, now: number = Date.now()): string {
	const time = clockTime(iso);
	return time ? `${dayLabel(iso, now)} ${time}` : "";
}

/** Full date and time for a `title` tooltip. */
export function fullTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/**
 * The feed: every thread with something to say, newest first, grouped by
 * local day. `agentId` narrows it to one persona.
 */
export function projectFeed(
	snapshot: InterfaceSnapshot,
	agentId: string | null,
	now: number = Date.now()
): FeedDay[] {
	const days: FeedDay[] = [];
	const threads = snapshot.threads
		.filter((thread) => thread.lastMessage)
		.filter((thread) => !agentId || thread.agentIds.includes(agentId))
		.sort(byRecency);
	for (const thread of threads) {
		const key = localDayKey(new Date(thread.updatedAt));
		const last = days.at(-1);
		if (last?.key === key) {
			last.threads.push(thread);
		} else {
			days.push({
				key,
				label: dayLabel(thread.updatedAt, now),
				threads: [thread],
			});
		}
	}
	return days;
}

export interface PersonaIdea {
	id: string;
	prompt: string;
	/** When the conversation an idea follows up on last moved. */
	updatedAt?: string;
}

export interface PersonaIdeaGroup {
	ideas: PersonaIdea[];
	key: string;
	label: string;
}

const MAX_RECENT_IDEAS = 4;
const SKILL_TEMPLATES = [
	{
		prompt: (topic: string) => `What changed in ${topic} this week?`,
	},
	{
		prompt: (topic: string) => `Draft a plan for ${topic}`,
	},
	{
		prompt: (topic: string) => `Review ${topic} and flag anything risky`,
	},
] as const;

/** A part that reads as an action ("digs through papers"), not a topic. */
const VERB_PHRASE = /^\w+s\s+(through|into|on|for|with|about|over)\b/i;
/** A part that names a role ("full-stack engineer"), not a topic. */
const ROLE_NOUN =
	/\b(agent|analyst|assistant|designer|developer|engineer|manager|researcher|writer)$/i;

/**
 * Split "Deploys, alerts and on-call runbooks" into lower-cased topics,
 * dropping parts that describe an action or a role, so templates read as
 * plain sentences.
 */
export function descriptionTopics(description: string): string[] {
	return description
		.split(/,|\band\b|&|;|\//i)
		.map((part) =>
			part
				.trim()
				.replace(/\.$/, "")
				.replace(/^(the|a|an)\s+/i, "")
		)
		.filter(
			(part) =>
				part.length > 1 && !VERB_PHRASE.test(part) && !ROLE_NOUN.test(part)
		)
		.map((part) =>
			/^[A-Z][a-z]/.test(part) ? part[0]?.toLowerCase() + part.slice(1) : part
		)
		.slice(0, SKILL_TEMPLATES.length);
}

/**
 * A description with no list of topics ("Full-stack engineer") names a
 * role, so the ideas ask the persona about its own next move instead of
 * echoing the role back as a template.
 */
function roleIdeas(description: string): PersonaIdea[] {
	if (description.trim().length < 2) {
		return [];
	}
	return [
		{ id: "role:next", prompt: "What would you tackle next?" },
		{ id: "role:ship", prompt: "What should we check before shipping?" },
	];
}

function threadIdea(thread: InterfaceThread): PersonaIdea | null {
	const title = thread.title || "Untitled";
	switch (threadStatus(thread)) {
		case "attention":
			return {
				id: `retry:${thread.id}`,
				prompt: `Retry ${title} and tell me what went wrong`,
				updatedAt: thread.updatedAt,
			};
		case "your-turn":
			return {
				id: `follow:${thread.id}`,
				prompt: `Follow up on ${title}`,
				updatedAt: thread.updatedAt,
			};
		case "waiting":
			return {
				id: `nudge:${thread.id}`,
				prompt: `Add more detail to ${title}`,
				updatedAt: thread.updatedAt,
			};
		case "working":
			return {
				id: `status:${thread.id}`,
				prompt: `Give me a short status on ${title}`,
				updatedAt: thread.updatedAt,
			};
		default:
			return null;
	}
}

/**
 * Prompt suggestions, derived deterministically from the persona's recent
 * thread titles and description. Nothing here is sent: the user edits and
 * submits a suggestion in the composer.
 */
export function personaIdeas(
	agent: InterfaceAgent | undefined,
	threads: InterfaceThread[]
): PersonaIdeaGroup[] {
	if (!agent) {
		return [];
	}
	const groups: PersonaIdeaGroup[] = [];
	const recent: PersonaIdea[] = [];
	for (const thread of [...threads].sort(byRecency)) {
		const idea = threadIdea(thread);
		if (idea) {
			recent.push(idea);
		}
		if (recent.length >= MAX_RECENT_IDEAS) {
			break;
		}
	}
	if (recent.length > 0) {
		groups.push({
			ideas: recent,
			key: "recent",
			label: "Pick up where you left off",
		});
	}
	const skills = descriptionTopics(agent.description).map(
		(topic, index): PersonaIdea => ({
			id: `skill:${index}`,
			prompt: SKILL_TEMPLATES[index]?.prompt(topic) ?? topic,
		})
	);
	if (skills.length === 0) {
		skills.push(...roleIdeas(agent.description));
	}
	if (skills.length > 0) {
		groups.push({
			ideas: skills,
			key: "skills",
			label: `Ask about ${agent.name}'s work`,
		});
	}
	groups.push({
		ideas: [
			{
				id: "routine:week",
				prompt: "Summarise this week",
			},
			{
				id: "routine:today",
				prompt: "What needs my attention today?",
			},
		],
		key: "routine",
		label: "Check-ins",
	});
	return groups;
}

export interface PersonaGoal {
	/** Threads the agent has answered: replied, nothing running or failing. */
	answered: number;
	group: InterfaceGroup;
	/** True when the persona is a member or has a thread in the goal. */
	includesPersona: boolean;
	/** Threads not finished yet: running, queued, stopped or not started. */
	open: number;
	threads: InterfaceThread[];
	total: number;
}

/**
 * A thread counts as answered once the agent has replied and nothing is
 * running, queued or failed (the ball is with the user). Everything else in a
 * goal is still open on the agent's side.
 */
export function isThreadAnswered(thread: InterfaceThread): boolean {
	return threadStatus(thread) === "your-turn";
}

/** Projects and teams as goals, with answered vs open threads. */
export function personaGoals(
	snapshot: InterfaceSnapshot,
	agentId: string | null
): { projects: PersonaGoal[]; teams: PersonaGoal[] } {
	const goals = snapshot.groups.map((group): PersonaGoal => {
		const threads = snapshot.threads
			.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id
			)
			.sort(
				(a, b) =>
					Number(isThreadAnswered(a)) - Number(isThreadAnswered(b)) ||
					statusRank(a) - statusRank(b) ||
					byRecency(a, b)
			);
		const answered = threads.filter(isThreadAnswered).length;
		const includesPersona = agentId
			? group.memberAgentIds.includes(agentId) ||
				threads.some((thread) => thread.agentIds.includes(agentId))
			: false;
		return {
			answered,
			group,
			includesPersona,
			open: threads.length - answered,
			threads,
			total: threads.length,
		};
	});
	const order = (a: PersonaGoal, b: PersonaGoal) =>
		Number(b.includesPersona) - Number(a.includesPersona) ||
		a.group.name.localeCompare(b.group.name);
	return {
		projects: goals.filter((goal) => goal.group.kind === "project").sort(order),
		teams: goals.filter((goal) => goal.group.kind === "team").sort(order),
	};
}

export type ActivityEntry =
	| {
			at: string;
			id: string;
			kind: "thread";
			status: ThreadStatus;
			thread: InterfaceThread;
	  }
	| { at: string; event: InterfaceEvent; id: string; kind: "run" };

export interface ActivityDay {
	entries: ActivityEntry[];
	key: string;
	label: string;
}

export interface PersonaActivity {
	/** Thread updates and past scheduled runs, newest first, by day. */
	log: ActivityDay[];
	/** Threads whose last run failed or stopped: they need you. */
	stopped: InterfaceThread[];
	/** Projected scheduled runs, soonest first. */
	upcoming: InterfaceEvent[];
}

const LOG_LIMIT = 40;

export function personaActivity(
	snapshot: InterfaceSnapshot,
	now: number = Date.now()
): PersonaActivity {
	const events = snapshot.events ?? [];
	const entries: ActivityEntry[] = [
		...snapshot.threads.map(
			(thread): ActivityEntry => ({
				at: thread.updatedAt,
				id: `thread:${thread.id}`,
				kind: "thread",
				status: threadStatus(thread),
				thread,
			})
		),
		...events
			.filter((event) => event.kind === "past")
			.map(
				(event): ActivityEntry => ({
					at: event.end ?? event.start,
					event,
					id: `run:${event.id}`,
					kind: "run",
				})
			),
	]
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, LOG_LIMIT);
	const log: ActivityDay[] = [];
	for (const entry of entries) {
		const key = localDayKey(new Date(entry.at));
		const last = log.at(-1);
		if (last?.key === key) {
			last.entries.push(entry);
		} else {
			log.push({ entries: [entry], key, label: dayLabel(entry.at, now) });
		}
	}
	return {
		log,
		stopped: snapshot.threads
			.filter((thread) => threadStatus(thread) === "attention")
			.sort(byRecency),
		upcoming: events
			.filter((event) => event.kind === "upcoming")
			.sort((a, b) => a.start.localeCompare(b.start)),
	};
}

/** "in 45m", "in 3h", "in 2d" for an upcoming run. */
export function untilLabel(iso: string, now: number = Date.now()): string {
	const minutes = Math.round((Date.parse(iso) - now) / 60_000);
	if (Number.isNaN(minutes)) {
		return "";
	}
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `in ${hours}h`;
	}
	return `in ${Math.round(hours / 24)}d`;
}

/** "just now", "5m ago", "3h ago". */
export function agoLabel(iso: string, now: number = Date.now()): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

/** Singular/plural count ("1 message", "4 messages"). */
export function countLabel(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
