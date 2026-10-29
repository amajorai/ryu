import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** The paper's nameplate. Generic on purpose: it is the workspace's paper. */
export const NEWSPAPER_NAME = "The Daily Brief";

/** Stories set under the secondary heads in the right-hand front column. */
export const SECONDARY_COUNT = 3;
/** Stories set side by side under the lead. */
export const PACKAGE_COUNT = 2;
/** Headlines a section front lists before it says how many more it holds. */
export const SECTION_LIMIT = 5;
/** Scheduled runs the Upcoming box lists. */
export const UPCOMING_LIMIT = 4;

/**
 * Front-page news value. A failed run is the most urgent story and a live run
 * the most active, so both outrank replies waiting on the reader.
 */
const FRONT_RANK: Record<ThreadStatus, number> = {
	attention: 0,
	working: 1,
	"your-turn": 2,
	waiting: 3,
	quiet: 4,
};

export interface NewspaperStory {
	agents: InterfaceAgent[];
	/** The project the thread is filed under, else its team. */
	section: InterfaceGroup | undefined;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface NewspaperSection {
	group: InterfaceGroup;
	members: InterfaceAgent[];
	stories: NewspaperStory[];
}

export interface NewspaperEdition {
	/** Every story not on the front page, in news order. */
	briefs: NewspaperStory[];
	lead: NewspaperStory | undefined;
	/** The two stories under the lead. */
	package: NewspaperStory[];
	/** The right-hand front column. */
	secondary: NewspaperStory[];
	/** One front per project or team that has stories. */
	sections: NewspaperSection[];
	/** All stories, in news order. */
	stories: NewspaperStory[];
}

function compareStories(a: NewspaperStory, b: NewspaperStory): number {
	return (
		FRONT_RANK[a.status] - FRONT_RANK[b.status] ||
		Number(b.thread.pinned) - Number(a.thread.pinned) ||
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

function storyFor(
	groups: Map<string, InterfaceGroup>,
	agents: Map<string, InterfaceAgent>,
	thread: InterfaceThread
): NewspaperStory {
	const storyAgents: InterfaceAgent[] = [];
	for (const agentId of thread.agentIds) {
		const agent = agents.get(agentId);
		if (agent) {
			storyAgents.push(agent);
		}
	}
	const section =
		(thread.projectId ? groups.get(thread.projectId) : undefined) ??
		(thread.teamId ? groups.get(thread.teamId) : undefined);
	return {
		agents: storyAgents,
		section,
		status: threadStatus(thread),
		thread,
	};
}

/** Every thread as a story, most newsworthy first. */
export function buildStories(snapshot: InterfaceSnapshot): NewspaperStory[] {
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	return snapshot.threads
		.map((thread) => storyFor(groups, agents, thread))
		.sort(compareStories);
}

/**
 * Lay out today's paper: the lead, the right-hand column, the pair under the
 * lead, then everything else as briefs. Section fronts index every story
 * filed to a project or team, front page included, the way a printed
 * section front points back to A1.
 */
export function buildEdition(snapshot: InterfaceSnapshot): NewspaperEdition {
	const stories = buildStories(snapshot);
	const [lead, ...rest] = stories;
	const secondary = rest.slice(0, SECONDARY_COUNT);
	const packaged = rest.slice(SECONDARY_COUNT, SECONDARY_COUNT + PACKAGE_COUNT);
	const briefs = rest.slice(SECONDARY_COUNT + PACKAGE_COUNT);

	const sections: NewspaperSection[] = [];
	for (const group of snapshot.groups) {
		const filed = stories.filter((story) => story.section?.id === group.id);
		if (filed.length === 0) {
			continue;
		}
		const members = snapshot.agents.filter((agent) =>
			group.memberAgentIds.includes(agent.id)
		);
		sections.push({ group, members, stories: filed });
	}

	return { briefs, lead, package: packaged, secondary, sections, stories };
}

export type NewspaperGlance = Record<ThreadStatus, number>;

/** How many stories sit in each status, in the protocol's urgency order. */
export function glanceCounts(stories: NewspaperStory[]): NewspaperGlance {
	const counts = Object.fromEntries(
		THREAD_STATUS_ORDER.map((status) => [status, 0])
	) as NewspaperGlance;
	for (const story of stories) {
		counts[story.status] += 1;
	}
	return counts;
}

/** Names joined the way a byline reads: "Atlas, Echo and Forge". */
export function joinNames(names: string[]): string {
	if (names.length <= 1) {
		return names[0] ?? "";
	}
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "By Forge", or who else filed it when no agent is on the story. */
export function storyByline(story: NewspaperStory): string {
	if (story.agents.length > 0) {
		return `By ${joinNames(story.agents.map((agent) => agent.name))}`;
	}
	return story.thread.lastMessageRole === "user"
		? "Filed by you"
		: "No agent assigned";
}

/** The status line set above a headline. */
export function storyKicker(story: NewspaperStory): string {
	switch (story.status) {
		case "attention":
			return story.thread.runState === "interrupted"
				? "Run interrupted"
				: "Run failed";
		case "working":
			return "Live";
		case "waiting": {
			const [first] = story.agents;
			return first ? `Waiting on ${first.name}` : "Waiting on an agent";
		}
		default:
			return THREAD_STATUS_LABELS[story.status];
	}
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
});

/** Newsroom-style age: "Just now", "12 min ago", "3 hr ago", "Yesterday". */
export function storyAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE_MS) {
		return "Just now";
	}
	if (elapsed < HOUR_MS) {
		return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
	}
	if (elapsed < DAY_MS && sameDay(new Date(then), new Date(now))) {
		return `${Math.floor(elapsed / HOUR_MS)} hr ago`;
	}
	if (sameDay(new Date(then), new Date(now - DAY_MS))) {
		return "Yesterday";
	}
	if (elapsed < 7 * DAY_MS) {
		return `${Math.max(2, Math.round(elapsed / DAY_MS))} days ago`;
	}
	return SHORT_DATE.format(new Date(then));
}

const MASTHEAD_DATE = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "long",
	weekday: "long",
	year: "numeric",
});

/** "Tuesday, October 13, 2026". */
export function mastheadDate(now: number): string {
	return MASTHEAD_DATE.format(new Date(now));
}

const CLOCK = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** When a scheduled run starts: "Today", "Tomorrow", a weekday, or a date. */
export function eventDay(iso: string, now: number): string {
	const start = new Date(iso);
	if (Number.isNaN(start.getTime())) {
		return "";
	}
	if (sameDay(start, new Date(now))) {
		return "Today";
	}
	if (sameDay(start, new Date(now + DAY_MS))) {
		return "Tomorrow";
	}
	if (start.getTime() - now < 6 * DAY_MS) {
		return WEEKDAY.format(start);
	}
	return SHORT_DATE.format(start);
}

/** "3:00 PM". */
export function eventTime(iso: string): string {
	const start = new Date(iso);
	return Number.isNaN(start.getTime()) ? "" : CLOCK.format(start);
}

/** Upcoming scheduled runs, soonest first. */
export function upcomingEvents(
	events: InterfaceEvent[] | undefined,
	now: number,
	limit: number = UPCOMING_LIMIT
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "upcoming" && Date.parse(event.start) >= now - MINUTE_MS
		)
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, limit);
}

/** "Every hour · 24 runs", "Weekdays at 9 AM". */
export function eventSchedule(event: InterfaceEvent): string {
	const runs = event.count && event.count > 1 ? `${event.count} runs` : null;
	return [event.label, runs].filter(Boolean).join(" · ");
}

/** "10 stories", "1 story". */
export function countLabel(
	count: number,
	singular: string,
	plural = `${singular}s`
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

/** DOM id of a front-page block, so the section bar can jump to it. */
export function newspaperAnchor(key: string): string {
	return `newspaper-${key.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}
