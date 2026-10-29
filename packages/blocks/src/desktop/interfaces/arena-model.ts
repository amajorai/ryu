import {
	type ArenaCard,
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectArena,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Where one agent stands on the wall. `failed` is an idle agent whose last
 * run failed; it still counts as needing you.
 */
export type ArenaAgentState = "failed" | "idle" | "needs-you" | "working";

/** The wall's filter chips. */
export type ArenaFilter = "all" | "idle" | "needs-you" | "working";

export const ARENA_FILTERS: readonly ArenaFilter[] = [
	"all",
	"working",
	"needs-you",
	"idle",
];

export const ARENA_FILTER_LABELS: Record<ArenaFilter, string> = {
	all: "All",
	idle: "Idle",
	"needs-you": "Needs you",
	working: "Working",
};

export const ARENA_STATE_LABELS: Record<ArenaAgentState, string> = {
	failed: "Failed",
	idle: "Idle",
	"needs-you": "Needs you",
	working: "Working",
};

export function isArenaFilter(value: unknown): value is ArenaFilter {
	return ARENA_FILTERS.some((filter) => filter === value);
}

/** One card on the wall: the protocol projection plus what the card shows. */
export interface ArenaCardView extends ArenaCard {
	agent: InterfaceAgent | undefined;
	/**
	 * The focus thread is a shared one an earlier card already shows, and the
	 * agent has nothing of its own to show instead: the card names it without
	 * repeating its preview.
	 */
	focusRepeat: boolean;
	focusThread: InterfaceThread | undefined;
	/**
	 * Who else is on the focus thread: the team's name for a team thread, or
	 * "+N" for an ad-hoc group. Null when the agent is on it alone.
	 */
	focusWith: string | null;
	/** Newest thread in each status, so a count can open the right thread. */
	latestByStatus: Partial<Record<ThreadStatus, string>>;
	/** Threads where the user is the blocker: a failed run or an agent reply. */
	needsYou: number;
	/** Per status, how many of the counted threads are shared with other agents. */
	shared: Partial<Record<ThreadStatus, number>>;
	state: ArenaAgentState;
}

export interface ArenaStats {
	agentCount: number;
	agentsWorking: number;
	failed: number;
	needsYou: number;
	threadCount: number;
	/** Threads with no agent on them; the wall lists them under the grid. */
	unassigned: number;
	waiting: number;
	yourTurn: number;
}

function newestFirst(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function cardState(card: ArenaCard, needsYou: number): ArenaAgentState {
	if (card.status === "working") {
		return "working";
	}
	if (card.counts.attention > 0) {
		return "failed";
	}
	return needsYou > 0 ? "needs-you" : "idle";
}

function focusWith(
	thread: InterfaceThread | undefined,
	groups: readonly InterfaceGroup[]
): string | null {
	if (!thread || thread.agentIds.length < 2) {
		return null;
	}
	const team = thread.teamId
		? groups.find((group) => group.id === thread.teamId)
		: undefined;
	return team?.name ?? `+${thread.agentIds.length - 1}`;
}

/**
 * The thread a card shows. A live run always wins. Otherwise a shared thread
 * another card already shows gives way to the agent's newest thread that no
 * card shows yet, so team threads do not repeat across the wall.
 */
function pickFocus(
	projected: InterfaceThread | undefined,
	threads: readonly InterfaceThread[],
	shown: ReadonlySet<string>
): { repeat: boolean; thread: InterfaceThread | undefined } {
	if (!projected || projected.running || !shown.has(projected.id)) {
		return { repeat: false, thread: projected };
	}
	const own = threads.find((thread) => !shown.has(thread.id));
	return own
		? { repeat: false, thread: own }
		: { repeat: true, thread: projected };
}

/**
 * Cards in the protocol's order (working, then needing you, then by name),
 * each with its focus thread and the newest thread per status resolved.
 */
export function buildArenaCards(snapshot: InterfaceSnapshot): ArenaCardView[] {
	const threadsById = new Map(
		snapshot.threads.map((thread) => [thread.id, thread])
	);
	const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const shown = new Set<string>();
	return projectArena(snapshot).map((card): ArenaCardView => {
		const latestByStatus: Partial<Record<ThreadStatus, string>> = {};
		const shared: Partial<Record<ThreadStatus, number>> = {};
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(card.agentId))
			.sort(newestFirst);
		for (const thread of threads) {
			const status = threadStatus(thread);
			latestByStatus[status] ??= thread.id;
			if (thread.agentIds.length > 1) {
				shared[status] = (shared[status] ?? 0) + 1;
			}
		}
		const needsYou = card.counts.attention + card.counts["your-turn"];
		const focus = pickFocus(
			card.focusThreadId ? threadsById.get(card.focusThreadId) : undefined,
			threads,
			shown
		);
		if (focus.thread) {
			shown.add(focus.thread.id);
		}
		return {
			...card,
			agent: agentsById.get(card.agentId),
			focusRepeat: focus.repeat,
			focusThread: focus.thread,
			focusThreadId: focus.thread?.id ?? card.focusThreadId,
			focusWith: focusWith(focus.thread, snapshot.groups),
			latestByStatus,
			needsYou,
			shared,
			state: cardState(card, needsYou),
		};
	});
}

/**
 * Whether a card shows under a filter chip. The chips partition the wall by
 * the badge each card wears, so every agent sits under exactly one of
 * Working, Needs you (which includes failed runs) or Idle. A working agent
 * with a reply waiting stays under Working; its count chip still says so.
 */
export function matchesArenaFilter(
	card: ArenaCardView,
	filter: ArenaFilter
): boolean {
	switch (filter) {
		case "all":
			return true;
		case "working":
			return card.state === "working";
		case "needs-you":
			return card.state === "failed" || card.state === "needs-you";
		case "idle":
			return card.state === "idle";
		default:
			return true;
	}
}

/** The single most urgent thread: the newest failed run, else the newest reply. */
export interface ArenaNextUp {
	agentId: string | null;
	status: "attention" | "your-turn";
	thread: InterfaceThread;
}

export function arenaNextUp(snapshot: InterfaceSnapshot): ArenaNextUp | null {
	const sorted = [...snapshot.threads].sort(newestFirst);
	for (const status of ["attention", "your-turn"] as const) {
		const thread = sorted.find((item) => threadStatus(item) === status);
		if (thread) {
			return { agentId: thread.agentIds[0] ?? null, status, thread };
		}
	}
	return null;
}

/** Aggregate numbers for the header tiles, counted over every thread. */
export function arenaStats(snapshot: InterfaceSnapshot): ArenaStats {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of snapshot.threads) {
		counts[threadStatus(thread)] += 1;
	}
	return {
		agentCount: snapshot.agents.length,
		agentsWorking: snapshot.agents.filter((agent) => agent.status === "working")
			.length,
		failed: counts.attention,
		needsYou: counts.attention + counts["your-turn"],
		threadCount: snapshot.threads.length,
		unassigned: unassignedThreads(snapshot.threads).length,
		waiting: counts.waiting,
		yourTurn: counts["your-turn"],
	};
}

/** Threads with no agent on them, newest first. */
export function unassignedThreads(
	threads: readonly InterfaceThread[]
): InterfaceThread[] {
	return threads
		.filter((thread) => thread.agentIds.length === 0)
		.sort(newestFirst);
}

/** Which unassigned threads a filter chip shows (none under "Idle"). */
export function matchesUnassignedFilter(
	thread: InterfaceThread,
	filter: ArenaFilter
): boolean {
	const status = threadStatus(thread);
	switch (filter) {
		case "all":
			return true;
		case "working":
			return status === "working";
		case "needs-you":
			return status === "attention" || status === "your-turn";
		default:
			return false;
	}
}

/**
 * The header's numbers, in the same unit as the filter chips under it
 * (agents), so "4 need you" up top and "Needs you 4" below always agree.
 */
export interface ArenaAgentTally {
	failed: number;
	needsYou: number;
	total: number;
	working: number;
}

export function arenaAgentTally(
	cards: readonly ArenaCardView[]
): ArenaAgentTally {
	const tally: ArenaAgentTally = {
		failed: 0,
		needsYou: 0,
		total: cards.length,
		working: 0,
	};
	for (const card of cards) {
		tally.working += Number(card.state === "working");
		tally.failed += Number(card.state === "failed");
		tally.needsYou += Number(matchesArenaFilter(card, "needs-you"));
	}
	return tally;
}

/** Upcoming scheduled runs, soonest first, capped for the wall. */
export function arenaUpcomingRuns(
	events: readonly InterfaceEvent[] | undefined,
	now: number,
	limit = 5
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) => event.kind === "upcoming" && Date.parse(event.start) >= now
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "in 5m", "in 3h", "in 2d": how soon a scheduled run starts. */
export function untilLabel(start: string, now: number): string {
	const delta = Math.max(0, Date.parse(start) - now);
	const minutes = Math.max(1, Math.round(delta / MINUTE_MS));
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(delta / HOUR_MS);
	if (hours < 24) {
		return `in ${hours}h`;
	}
	return `in ${Math.round(delta / DAY_MS)}d`;
}
