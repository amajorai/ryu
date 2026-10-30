import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	statusCounts,
	type WikiAgentArticle,
	wikiAgentArticle,
} from "./wiki-model-articles.ts";
import {
	agentLink,
	groupLink,
	joinSegments,
	plural,
	text,
	threadLink,
	type WikiSegment,
	wikiDate,
} from "./wiki-model-prose.ts";
import {
	byName,
	byRecency,
	type WikiIndex,
	type WikiRoute,
	wikiAgent,
	wikiThreadTitle,
} from "./wiki-model-routes.ts";

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
