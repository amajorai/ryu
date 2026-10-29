import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Routes: every page the wiki can show
// ---------------------------------------------------------------------------

export type WikiIndex = "agents" | "projects" | "teams" | "threads";

export type WikiRoute =
	| { kind: "agent"; id: string }
	| { kind: "changes" }
	| { kind: "group"; id: string }
	| { kind: "index"; index: WikiIndex }
	| { kind: "main" }
	| { kind: "search"; query: string }
	| { kind: "thread"; id: string };

/** Article / Talk on the left of the toolbar, Read / View history on the right. */
export type WikiTab = "article" | "history" | "talk";

export const WIKI_MAIN: WikiRoute = { kind: "main" };

export const WIKI_INDEX_ORDER: readonly WikiIndex[] = [
	"agents",
	"teams",
	"projects",
	"threads",
];

/** Labels in the main menu's Contents group. */
export const WIKI_INDEX_LABELS: Record<WikiIndex, string> = {
	agents: "Agents",
	projects: "Projects",
	teams: "Teams",
	threads: "Threads",
};

export function sameRoute(a: WikiRoute, b: WikiRoute): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	switch (a.kind) {
		case "agent":
		case "group":
		case "thread":
			return a.id === (b as typeof a).id;
		case "index":
			return a.index === (b as typeof a).index;
		case "search":
			return a.query === (b as typeof a).query;
		default:
			return true;
	}
}

/** Whether a page has Talk and history tabs (articles do; special pages do not). */
export function routeHasTalk(route: WikiRoute): boolean {
	return (
		route.kind === "agent" ||
		route.kind === "group" ||
		route.kind === "main" ||
		route.kind === "thread"
	);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function wikiAgent(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceAgent | undefined {
	return id ? snapshot.agents.find((agent) => agent.id === id) : undefined;
}

export function wikiGroup(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceGroup | undefined {
	return id ? snapshot.groups.find((group) => group.id === id) : undefined;
}

export function wikiThread(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceThread | undefined {
	return id ? snapshot.threads.find((thread) => thread.id === id) : undefined;
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

/** A route's display title, as the page heading shows it. */
export function wikiRouteTitle(
	snapshot: InterfaceSnapshot,
	route: WikiRoute
): string {
	switch (route.kind) {
		case "agent":
			return wikiAgent(snapshot, route.id)?.name ?? "Missing agent";
		case "group":
			return wikiGroup(snapshot, route.id)?.name ?? "Missing page";
		case "thread":
			return wikiThreadTitle(wikiThread(snapshot, route.id));
		case "index":
			return route.index === "threads"
				? "List of threads"
				: `Category:${WIKI_INDEX_LABELS[route.index]}`;
		case "changes":
			return "Recent changes";
		case "search":
			return "Search results";
		default:
			return "Main Page";
	}
}

export function wikiThreadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled thread";
}

/** The heading for a route on a given tab ("Talk:Atlas", "Atlas: Revision history"). */
export function wikiPageHeading(
	snapshot: InterfaceSnapshot,
	route: WikiRoute,
	tab: WikiTab
): string {
	const title = wikiRouteTitle(snapshot, route);
	if (!routeHasTalk(route)) {
		return title;
	}
	if (tab === "talk") {
		return `Talk:${title}`;
	}
	if (tab === "history") {
		return `${title}: Revision history`;
	}
	return title;
}

// ---------------------------------------------------------------------------
// Prose: rich text as segments, so the view can render real links
// ---------------------------------------------------------------------------

export type WikiSegment =
	| { kind: "bold"; text: string }
	| { kind: "link"; route: WikiRoute; text: string; bold?: boolean }
	| { kind: "text"; text: string };

const text = (value: string): WikiSegment => ({ kind: "text", text: value });
const bold = (value: string): WikiSegment => ({ kind: "bold", text: value });
const link = (
	route: WikiRoute,
	value: string,
	strong = false
): WikiSegment => ({ bold: strong, kind: "link", route, text: value });

export function agentLink(agent: InterfaceAgent): WikiSegment {
	return link({ id: agent.id, kind: "agent" }, agent.name);
}

export function groupLink(group: InterfaceGroup): WikiSegment {
	return link({ id: group.id, kind: "group" }, group.name);
}

export function threadLink(
	thread: InterfaceThread,
	strong = false
): WikiSegment {
	return link(
		{ id: thread.id, kind: "thread" },
		wikiThreadTitle(thread),
		strong
	);
}

/** "A", "A and B", "A, B and C" with every item a segment. */
export function joinSegments(items: WikiSegment[]): WikiSegment[] {
	const out: WikiSegment[] = [];
	for (const [index, item] of items.entries()) {
		if (index > 0) {
			out.push(text(index === items.length - 1 ? " and " : ", "));
		}
		out.push(item);
	}
	return out;
}

/** Plain text of segments, for tests and accessible names. */
export function segmentsText(segments: WikiSegment[]): string {
	return segments.map((segment) => segment.text).join("");
}

/** Counts render as digits, so lists and prose compare at a glance. */
export function countWord(count: number): string {
	return count.toLocaleString("en");
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${countWord(count)} ${count === 1 ? one : many}`;
}

/** "Digs through papers" -> "digs through papers" (keeps acronyms). */
function lowerFirst(value: string): string {
	const trimmed = value.trim().replace(/[.\s]+$/, "");
	if (trimmed.length < 2 || trimmed[1] === trimmed[1]?.toUpperCase()) {
		return trimmed;
	}
	return `${trimmed[0]?.toLowerCase() ?? ""}${trimmed.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
	[60, "second"],
	[60, "minute"],
	[24, "hour"],
	[7, "day"],
	[4.345, "week"],
	[12, "month"],
	[Number.POSITIVE_INFINITY, "year"],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function wikiAgo(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "at an unknown time";
	}
	let value = (then - now) / 1000;
	if (Math.abs(value) < 45) {
		return "just now";
	}
	for (const [size, unit] of STEPS) {
		if (Math.abs(Math.round(value)) < size) {
			return RELATIVE.format(Math.round(value), unit);
		}
		value /= size;
	}
	return "";
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
});
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
});

/** "14 October 2026" in local time. */
export function wikiDate(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? "" : DAY_FORMAT.format(then);
}

/** "14:02" in local time. */
export function wikiTime(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? "" : TIME_FORMAT.format(then);
}

/** "14:02, 14 October 2026": the revision timestamp format. */
export function wikiStamp(iso: string): string {
	const day = wikiDate(iso);
	return day ? `${wikiTime(iso)}, ${day}` : "";
}

export function wikiMonthDay(now: number): string {
	return MONTH_DAY_FORMAT.format(now);
}

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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/** The most active agent: most threads, then messages, then live runs. */
export function featuredAgent(
	snapshot: InterfaceSnapshot
): WikiAgentArticle | null {
	let best: WikiAgentArticle | null = null;
	for (const agent of snapshot.agents) {
		const article = wikiAgentArticle(snapshot, agent.id);
		if (!article) {
			continue;
		}
		if (
			!best ||
			article.threads.length > best.threads.length ||
			(article.threads.length === best.threads.length &&
				(article.messages > best.messages ||
					(article.messages === best.messages &&
						article.counts.working > best.counts.working)))
		) {
			best = article;
		}
	}
	return best;
}

/** One "In the news" sentence for a thread, in the reference's bold-link style. */
export function newsItem(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): WikiSegment[] {
	const lead = wikiAgent(snapshot, thread.agentIds[0]);
	const title = threadLink(thread, true);
	const who = lead ? agentLink(lead) : text("An agent");
	switch (threadStatus(thread)) {
		case "working":
			return [who, text(" is working on "), title, text(".")];
		case "attention":
			return [text("A run stopped in "), title, text(" and needs attention.")];
		case "your-turn":
			return [who, text(" replied in "), title, text(".")];
		case "waiting":
			return lead
				? [text("You asked "), who, text(" a follow-up in "), title, text(".")]
				: [text("You posted in "), title, text(".")];
		default:
			return [title, text(" was opened.")];
	}
}

/** "Did you know..." facts drawn from the snapshot's counts. */
export function didYouKnow(snapshot: InterfaceSnapshot): WikiSegment[][] {
	const facts: WikiSegment[][] = [];
	const featured = featuredAgent(snapshot);
	if (featured && featured.threads.length > 0) {
		const tied = snapshot.agents.some(
			(agent) =>
				agent.id !== featured.agent.id &&
				snapshot.threads.filter((thread) => thread.agentIds.includes(agent.id))
					.length === featured.threads.length
		);
		facts.push([
			text("... that "),
			agentLink(featured.agent),
			text(
				` has taken part in ${plural(featured.threads.length, "thread")}, ${tied ? "tied for the most of any agent" : "more than any other agent"}?`
			),
		]);
	}
	const longest = [...snapshot.threads].sort(
		(a, b) => b.messageCount - a.messageCount || byRecency(a, b)
	)[0];
	if (longest && longest.messageCount > 1) {
		facts.push([
			text("... that the longest thread, "),
			threadLink(longest),
			text(`, runs to ${plural(longest.messageCount, "message")}?`),
		]);
	}
	const largest = [...snapshot.groups].sort(
		(a, b) => b.memberAgentIds.length - a.memberAgentIds.length || byName(a, b)
	)[0];
	if (largest && largest.memberAgentIds.length > 0) {
		facts.push([
			text("... that the "),
			groupLink(largest),
			text(
				` ${largest.kind} has ${plural(largest.memberAgentIds.length, "member")}?`
			),
		]);
	}
	const counts = statusCounts(snapshot.threads);
	if (counts.working > 0) {
		facts.push([
			text(
				`... that ${plural(counts.working, "run")} ${counts.working === 1 ? "is" : "are"} live right now?`
			),
		]);
	}
	if (counts.attention > 0) {
		facts.push([
			text(
				`... that ${plural(counts.attention, "thread")} ${counts.attention === 1 ? "needs" : "need"} attention after a stopped run?`
			),
		]);
	}
	const idle = snapshot.agents.filter(
		(agent) =>
			!snapshot.threads.some((thread) => thread.agentIds.includes(agent.id))
	);
	if (idle.length > 0 && idle.length < snapshot.agents.length) {
		facts.push([
			text("... that "),
			...joinSegments(idle.slice(0, 3).map(agentLink)),
			text(
				` ${idle.length === 1 ? "has" : "have"} not taken part in a thread yet?`
			),
		]);
	}
	return facts;
}

export interface WikiDayEvent {
	agent: InterfaceAgent | undefined;
	event: InterfaceEvent;
}

/** Scheduled runs on the local day of `now`, in time order. */
export function eventsOnDay(
	snapshot: InterfaceSnapshot,
	now: number
): WikiDayEvent[] {
	const today = localDayKey(new Date(now));
	return (snapshot.events ?? [])
		.filter((event) => {
			const start = Date.parse(event.start);
			return !Number.isNaN(start) && localDayKey(new Date(start)) === today;
		})
		.sort((a, b) => a.start.localeCompare(b.start))
		.map((event) => ({ agent: wikiAgent(snapshot, event.agentId), event }));
}

export function eventOutcome(event: InterfaceEvent): string {
	if (event.kind === "upcoming") {
		return "scheduled";
	}
	if (event.outcome === "failure") {
		return "failed";
	}
	if (event.outcome === "success") {
		return "succeeded";
	}
	return "ran";
}

// ---------------------------------------------------------------------------
// Category and list pages
// ---------------------------------------------------------------------------

export interface WikiEntry {
	/** A short description shown in search and suggestions. */
	description: string;
	id: string;
	kind: "agent" | "project" | "team" | "thread";
	route: WikiRoute;
	title: string;
	updatedAt: string | null;
}

function threadsFor(
	snapshot: InterfaceSnapshot,
	predicate: (thread: InterfaceThread) => boolean
): InterfaceThread[] {
	return snapshot.threads.filter(predicate).sort(byRecency);
}

/** Every page in the wiki, as search and the category pages see them. */
export function wikiEntries(snapshot: InterfaceSnapshot): WikiEntry[] {
	const entries: WikiEntry[] = [];
	for (const agent of snapshot.agents) {
		const threads = threadsFor(snapshot, (thread) =>
			thread.agentIds.includes(agent.id)
		);
		entries.push({
			description: agent.description.trim() || "Agent",
			id: agent.id,
			kind: "agent",
			route: { id: agent.id, kind: "agent" },
			title: agent.name,
			updatedAt: threads[0]?.updatedAt ?? null,
		});
	}
	for (const group of snapshot.groups) {
		const threads = threadsFor(snapshot, (thread) =>
			group.kind === "team"
				? thread.teamId === group.id
				: thread.projectId === group.id
		);
		const noun = group.kind === "team" ? "Team" : "Project";
		entries.push({
			description: `${noun} of ${plural(group.memberAgentIds.length, "agent")}`,
			id: group.id,
			kind: group.kind,
			route: { id: group.id, kind: "group" },
			title: group.name,
			updatedAt: threads[0]?.updatedAt ?? null,
		});
	}
	for (const thread of snapshot.threads) {
		const names = thread.agentIds
			.map((id) => wikiAgent(snapshot, id)?.name)
			.filter((name) => name !== undefined);
		entries.push({
			description:
				names.length > 0 ? `Thread with ${names.join(", ")}` : "Thread",
			id: thread.id,
			kind: "thread",
			route: { id: thread.id, kind: "thread" },
			title: wikiThreadTitle(thread),
			updatedAt: thread.updatedAt,
		});
	}
	return entries;
}

export interface WikiLetterGroup {
	entries: WikiEntry[];
	letter: string;
}

/** A category page's alphabetical columns, keyed by first letter. */
export function categoryLetters(entries: WikiEntry[]): WikiLetterGroup[] {
	const sorted = [...entries].sort((a, b) =>
		a.title.localeCompare(b.title, "en", { sensitivity: "base" })
	);
	const groups: WikiLetterGroup[] = [];
	for (const entry of sorted) {
		const first = entry.title.trim()[0]?.toUpperCase() ?? "#";
		const letter = /[A-Z]/.test(first) ? first : "#";
		const last = groups.at(-1);
		if (last && last.letter === letter) {
			last.entries.push(entry);
		} else {
			groups.push({ entries: [entry], letter });
		}
	}
	return groups;
}

export function indexEntries(
	snapshot: InterfaceSnapshot,
	index: WikiIndex
): WikiEntry[] {
	const kind =
		index === "agents"
			? "agent"
			: index === "teams"
				? "team"
				: index === "projects"
					? "project"
					: "thread";
	return wikiEntries(snapshot).filter((entry) => entry.kind === kind);
}

export type WikiThreadSort =
	| "agents"
	| "messages"
	| "status"
	| "title"
	| "updated";

export interface WikiSortState {
	direction: "ascending" | "descending";
	key: WikiThreadSort;
}

export const DEFAULT_THREAD_SORT: WikiSortState = {
	direction: "descending",
	key: "updated",
};

/** The List of threads table, sorted like a wikitable column header click. */
export function sortThreads(
	snapshot: InterfaceSnapshot,
	threads: InterfaceThread[],
	sort: WikiSortState
): InterfaceThread[] {
	const agentNames = (thread: InterfaceThread) =>
		thread.agentIds.map((id) => wikiAgent(snapshot, id)?.name ?? "").join(", ");
	const compare = (a: InterfaceThread, b: InterfaceThread): number => {
		switch (sort.key) {
			case "title":
				return wikiThreadTitle(a).localeCompare(wikiThreadTitle(b), "en", {
					sensitivity: "base",
				});
			case "status":
				return (
					THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
					THREAD_STATUS_ORDER.indexOf(threadStatus(b))
				);
			case "agents":
				return agentNames(a).localeCompare(agentNames(b), "en", {
					sensitivity: "base",
				});
			case "messages":
				return a.messageCount - b.messageCount;
			default:
				return a.updatedAt.localeCompare(b.updatedAt);
		}
	};
	const sign = sort.direction === "ascending" ? 1 : -1;
	return [...threads].sort((a, b) => sign * compare(a, b) || byRecency(a, b));
}

export function nextSort(
	current: WikiSortState,
	key: WikiThreadSort
): WikiSortState {
	if (current.key === key) {
		return {
			direction: current.direction === "ascending" ? "descending" : "ascending",
			key,
		};
	}
	// Text columns start A to Z; numbers and dates start largest first.
	const descendingFirst = key === "messages" || key === "updated";
	return { direction: descendingFirst ? "descending" : "ascending", key };
}

// ---------------------------------------------------------------------------
// History and recent changes
// ---------------------------------------------------------------------------

export type WikiRevision =
	| { at: string; kind: "thread"; thread: InterfaceThread }
	| { at: string; kind: "run"; event: InterfaceEvent };

export function threadRevisions(threads: InterfaceThread[]): WikiRevision[] {
	return [...threads]
		.sort(byRecency)
		.map((thread) => ({ at: thread.updatedAt, kind: "thread", thread }));
}

/** An agent's history: its threads and its past scheduled runs, newest first. */
export function agentRevisions(article: WikiAgentArticle): WikiRevision[] {
	const rows: WikiRevision[] = [
		...threadRevisions(article.threads),
		...article.pastRuns.map(
			(event): WikiRevision => ({ at: event.start, event, kind: "run" })
		),
	];
	return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export interface WikiChangeDay {
	day: string;
	key: string;
	revisions: WikiRevision[];
}

/** Recent changes grouped under local day headings. */
export function changesByDay(revisions: WikiRevision[]): WikiChangeDay[] {
	const days: WikiChangeDay[] = [];
	for (const revision of revisions) {
		const then = Date.parse(revision.at);
		if (Number.isNaN(then)) {
			continue;
		}
		const key = localDayKey(new Date(then));
		const last = days.at(-1);
		if (last && last.key === key) {
			last.revisions.push(revision);
		} else {
			days.push({ day: wikiDate(revision.at), key, revisions: [revision] });
		}
	}
	return days;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface WikiSearchHit {
	entry: WikiEntry;
	/** Where the match landed: in the title, or only in the body text. */
	inTitle: boolean;
	/** Body text to excerpt in the results list. */
	snippet: string;
}

function normalize(value: string): string {
	return value.toLowerCase().normalize("NFKD");
}

function entryBody(snapshot: InterfaceSnapshot, entry: WikiEntry): string {
	if (entry.kind === "thread") {
		return wikiThread(snapshot, entry.id)?.lastMessage ?? "";
	}
	return entry.description;
}

/**
 * Pages whose title or body contains every word of the query. Title matches
 * come first, then prefix matches, then by recency.
 */
export function wikiSearch(
	snapshot: InterfaceSnapshot,
	query: string
): WikiSearchHit[] {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const hits: (WikiSearchHit & { prefix: boolean })[] = [];
	for (const entry of wikiEntries(snapshot)) {
		const title = normalize(entry.title);
		const body = entryBody(snapshot, entry);
		const haystack = `${title} ${normalize(body)} ${normalize(entry.description)}`;
		if (!words.every((word) => haystack.includes(word))) {
			continue;
		}
		hits.push({
			entry,
			inTitle: words.every((word) => title.includes(word)),
			prefix: title.startsWith(words[0] ?? ""),
			snippet: body,
		});
	}
	hits.sort(
		(a, b) =>
			Number(b.inTitle) - Number(a.inTitle) ||
			Number(b.prefix) - Number(a.prefix) ||
			(b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? "") ||
			a.entry.title.localeCompare(b.entry.title)
	);
	return hits.map(({ prefix: _prefix, ...hit }) => hit);
}

/**
 * Typeahead suggestions, like the reference's prefix search: every query word
 * must start a word of the title. Title starts rank first, then recency.
 */
export function wikiSuggest(
	snapshot: InterfaceSnapshot,
	query: string,
	limit = 6
): WikiEntry[] {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const scored: { entry: WikiEntry; start: boolean }[] = [];
	for (const entry of wikiEntries(snapshot)) {
		const title = normalize(entry.title);
		const titleWords = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
		if (
			!words.every((word) =>
				titleWords.some((titleWord) => titleWord.startsWith(word))
			)
		) {
			continue;
		}
		scored.push({ entry, start: title.startsWith(words[0] ?? "") });
	}
	scored.sort(
		(a, b) =>
			Number(b.start) - Number(a.start) ||
			(b.entry.updatedAt ?? "").localeCompare(a.entry.updatedAt ?? "") ||
			a.entry.title.localeCompare(b.entry.title)
	);
	return scored.slice(0, limit).map((item) => item.entry);
}

export interface WikiMark {
	match: boolean;
	text: string;
}

/** Split text into runs that do and do not match any query word. */
export function markMatches(value: string, query: string): WikiMark[] {
	const words = query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (words.length === 0 || !value) {
		return [{ match: false, text: value }];
	}
	const pattern = new RegExp(`(${words.join("|")})`, "gi");
	const marks: WikiMark[] = [];
	let cursor = 0;
	for (const found of value.matchAll(pattern)) {
		const start = found.index ?? 0;
		if (start > cursor) {
			marks.push({ match: false, text: value.slice(cursor, start) });
		}
		marks.push({ match: true, text: found[0] });
		cursor = start + found[0].length;
	}
	if (cursor < value.length) {
		marks.push({ match: false, text: value.slice(cursor) });
	}
	return marks;
}

/** Trim a body around the first match, with ellipses where it was cut. */
export function excerptAround(
	value: string,
	query: string,
	radius = 90
): string {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	const lower = normalize(value);
	let index = -1;
	for (const word of words) {
		const found = lower.indexOf(word);
		if (found !== -1 && (index === -1 || found < index)) {
			index = found;
		}
	}
	if (index === -1 || value.length <= radius * 2) {
		return value.length > radius * 2
			? `${value.slice(0, radius * 2).trimEnd()}…`
			: value;
	}
	const start = Math.max(0, index - radius);
	const end = Math.min(value.length, index + radius);
	return `${start > 0 ? "…" : ""}${value.slice(start, end).trim()}${end < value.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// Sections (the table of contents)
// ---------------------------------------------------------------------------

export interface WikiSection {
	id: string;
	label: string;
}

export function agentSections(article: WikiAgentArticle): WikiSection[] {
	const sections: WikiSection[] = [{ id: "threads", label: "Threads" }];
	if (article.collaborators.length > 0) {
		sections.push({ id: "collaborators", label: "Collaborators" });
	}
	if (article.teams.length + article.projects.length > 0) {
		sections.push({ id: "teams", label: "Teams and projects" });
	}
	if (article.pastRuns.length + article.upcomingRuns.length > 0) {
		sections.push({ id: "runs", label: "Scheduled runs" });
	}
	sections.push({ id: "see-also", label: "See also" });
	return sections;
}

export function groupSections(article: WikiGroupArticle): WikiSection[] {
	const sections: WikiSection[] = [
		{ id: "members", label: "Members" },
		{ id: "threads", label: "Threads" },
	];
	if (article.related.length > 0 || article.members.length > 0) {
		sections.push({ id: "see-also", label: "See also" });
	}
	return sections;
}

export function threadSections(article: WikiThreadArticle): WikiSection[] {
	const sections: WikiSection[] = [];
	if (article.thread.lastMessage) {
		sections.push({ id: "latest", label: "Latest message" });
	}
	sections.push({ id: "participants", label: "Participants" });
	if (article.related.length > 0) {
		sections.push({ id: "see-also", label: "See also" });
	}
	return sections;
}

/** Status label for infoboxes and tables. */
export function statusLabel(thread: InterfaceThread): string {
	return THREAD_STATUS_LABELS[threadStatus(thread)];
}

/** The categories a page sits in, for the catlinks box at the foot. */
export function pageCategories(
	snapshot: InterfaceSnapshot,
	route: WikiRoute
): WikiSegment[] {
	const agentsIndex = link({ index: "agents", kind: "index" }, "Agents");
	switch (route.kind) {
		case "agent": {
			const article = wikiAgentArticle(snapshot, route.id);
			if (!article) {
				return [];
			}
			const extra = [...article.teams, ...article.projects]
				.filter((group) => group.memberAgentIds.includes(route.id))
				.map((group) => groupLink(group));
			return [agentsIndex, ...extra];
		}
		case "group": {
			const group = wikiGroup(snapshot, route.id);
			if (!group) {
				return [];
			}
			return [
				link(
					{
						index: group.kind === "team" ? "teams" : "projects",
						kind: "index",
					},
					group.kind === "team" ? "Teams" : "Projects"
				),
			];
		}
		case "thread": {
			const article = wikiThreadArticle(snapshot, route.id);
			if (!article) {
				return [];
			}
			const home = [article.project, article.team]
				.filter((group) => group !== undefined)
				.map(groupLink);
			return [link({ index: "threads", kind: "index" }, "Threads"), ...home];
		}
		default:
			return [];
	}
}
