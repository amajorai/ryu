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

export {
	DAY,
	type RecordsActivityDay,
	type RecordsActivityItem,
	recordsActivity,
	recordsDayLabel,
} from "./records-model-activity.ts";
export {
	type RecordsBoardColumn,
	recordsBoard,
} from "./records-model-board.ts";
export {
	recordsClockTime,
	recordsFullTime,
	recordsLatestLine,
	recordsRelativeTime,
	recordsRunTime,
	recordsSortLabel,
	recordsStartInput,
	recordsStatusLabel,
	recordsThreadAgents,
	recordsThreadTitle,
	recordsTimeUntil,
} from "./records-model-format.ts";

/** The three record objects, in the order the nav lists them. */
export const RECORDS_OBJECTS = ["agents", "teams", "projects"] as const;
export type RecordsObject = (typeof RECORDS_OBJECTS)[number];

export const RECORDS_OBJECT_LABELS: Record<
	RecordsObject,
	{ plural: string; singular: string }
> = {
	agents: { plural: "Agents", singular: "Agent" },
	projects: { plural: "Projects", singular: "Project" },
	teams: { plural: "Teams", singular: "Team" },
};

/** An object's plural and singular names in the UI language. */
export function recordsObjectLabels(object: RecordsObject): {
	plural: string;
	singular: string;
} {
	switch (object) {
		case "agents":
			return { plural: tr("Agents"), singular: tr("Agent") };
		case "projects":
			return { plural: tr("Projects"), singular: tr("Project") };
		default:
			return { plural: tr("Teams"), singular: tr("Team") };
	}
}

export function isRecordsObject(value: unknown): value is RecordsObject {
	return RECORDS_OBJECTS.some((object) => object === value);
}

/**
 * A record's stage, most pressing first. A live run outranks "your turn" on a
 * record (unlike a single thread) because "Delta is working" is the freshest
 * fact about Delta; replies still waiting on you are counted in `needsYou`.
 */
export const RECORDS_STATUS_ORDER: readonly ThreadStatus[] = [
	"attention",
	"working",
	"your-turn",
	"waiting",
	"quiet",
];

/** One row in an object table: an agent, a team, or a project. */
export interface RecordsRow {
	agent: InterfaceAgent | null;
	/** Plain description (agents) or a derived line (teams and projects). */
	description: string;
	group: InterfaceGroup | null;
	id: string;
	/** ISO time of the newest thread, or null when there are none. */
	lastInteraction: string | null;
	/** Team members or project agents; empty for agents. */
	members: InterfaceAgent[];
	messageCount: number;
	name: string;
	/** Threads where the user is up: a failed run or an agent reply. */
	needsYou: number;
	/** Start of the agent's next scheduled run, or null when none is due. */
	nextRun: string | null;
	object: RecordsObject;
	/** Projects an agent belongs to; empty for teams and projects. */
	projects: InterfaceGroup[];
	/** The agent's past scheduled runs, newest first; empty for groups. */
	runs: InterfaceEvent[];
	status: ThreadStatus;
	/** Teams an agent belongs to; empty for teams and projects. */
	teams: InterfaceGroup[];
	/** This record's threads, newest first. */
	threads: InterfaceThread[];
	/** The agent's upcoming scheduled runs, soonest first; empty for groups. */
	upcoming: InterfaceEvent[];
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Rank in {@link RECORDS_STATUS_ORDER}; lower is more pressing. */
export function recordsStatusRank(status: ThreadStatus): number {
	const index = RECORDS_STATUS_ORDER.indexOf(status);
	return index === -1 ? RECORDS_STATUS_ORDER.length : index;
}

/** The most pressing stage across a record's threads. */
export function recordsStatus(
	threads: readonly InterfaceThread[],
	live = false
): ThreadStatus {
	let best: ThreadStatus = live ? "working" : "quiet";
	for (const thread of threads) {
		const status = threadStatus(thread);
		if (recordsStatusRank(status) < recordsStatusRank(best)) {
			best = status;
		}
	}
	return best;
}

function needsYouCount(threads: readonly InterfaceThread[]): number {
	let count = 0;
	for (const thread of threads) {
		const status = threadStatus(thread);
		if (status === "attention" || status === "your-turn") {
			count += 1;
		}
	}
	return count;
}

function sumMessages(threads: readonly InterfaceThread[]): number {
	let total = 0;
	for (const thread of threads) {
		total += thread.messageCount;
	}
	return total;
}

/** Threads that belong to a record: an agent's, a team's or a project's. */
export function recordsThreadsFor(
	snapshot: InterfaceSnapshot,
	object: RecordsObject,
	id: string
): InterfaceThread[] {
	const threads = snapshot.threads.filter((thread) => {
		if (object === "agents") {
			return thread.agentIds.includes(id);
		}
		if (object === "teams") {
			return thread.teamId === id;
		}
		return thread.projectId === id;
	});
	return threads.sort(byRecency);
}

function rowFromThreads(
	base: Pick<
		RecordsRow,
		| "agent"
		| "description"
		| "group"
		| "id"
		| "members"
		| "name"
		| "object"
		| "projects"
		| "teams"
	>,
	threads: InterfaceThread[],
	live: boolean,
	events: readonly InterfaceEvent[] = []
): RecordsRow {
	const runs = events
		.filter((event) => event.kind === "past")
		.sort((a, b) => b.start.localeCompare(a.start));
	const upcoming = events
		.filter((event) => event.kind === "upcoming")
		.sort((a, b) => a.start.localeCompare(b.start));
	return {
		...base,
		lastInteraction: threads[0]?.updatedAt ?? null,
		messageCount: sumMessages(threads),
		needsYou: needsYouCount(threads),
		nextRun: upcoming[0]?.start ?? null,
		runs,
		status: recordsStatus(threads, live),
		threads,
		upcoming,
	};
}

/** Every record of one object, in snapshot order (sorting happens later). */
export function recordsRows(
	snapshot: InterfaceSnapshot,
	object: RecordsObject
): RecordsRow[] {
	if (object === "agents") {
		return snapshot.agents.map((agent) => {
			const groups = snapshot.groups.filter((group) =>
				group.memberAgentIds.includes(agent.id)
			);
			return rowFromThreads(
				{
					agent,
					description: agent.description.trim(),
					group: null,
					id: agent.id,
					members: [],
					name: agent.name,
					object,
					projects: groups.filter((group) => group.kind === "project"),
					teams: groups.filter((group) => group.kind === "team"),
				},
				recordsThreadsFor(snapshot, object, agent.id),
				agent.status === "working",
				(snapshot.events ?? []).filter((event) => event.agentId === agent.id)
			);
		});
	}
	const kind = object === "teams" ? "team" : "project";
	return snapshot.groups
		.filter((group) => group.kind === kind)
		.map((group) => {
			const members = group.memberAgentIds
				.map((agentId) => snapshot.agents.find((agent) => agent.id === agentId))
				.filter((agent): agent is InterfaceAgent => agent !== undefined);
			const threads = recordsThreadsFor(snapshot, object, group.id);
			return rowFromThreads(
				{
					agent: null,
					description: threads[0]?.title ?? "",
					group,
					id: group.id,
					members,
					name: group.name,
					object,
					projects: [],
					teams: [],
				},
				threads,
				false
			);
		});
}

/** How many records each object has, for the nav. */
export function recordsObjectCounts(
	snapshot: InterfaceSnapshot
): Record<RecordsObject, number> {
	return {
		agents: snapshot.agents.length,
		projects: snapshot.groups.filter((group) => group.kind === "project")
			.length,
		teams: snapshot.groups.filter((group) => group.kind === "team").length,
	};
}

// ---------------------------------------------------------------------------
// Sorting, filtering, saved views
// ---------------------------------------------------------------------------

export const RECORDS_SORT_KEYS = [
	"name",
	"status",
	"threads",
	"needsYou",
	"lastInteraction",
] as const;
export type RecordsSortKey = (typeof RECORDS_SORT_KEYS)[number];

export const RECORDS_SORT_LABELS: Record<RecordsSortKey, string> = {
	get lastInteraction() {
		return tr("Last interaction");
	},
	get name() {
		return tr("Name");
	},
	get needsYou() {
		return tr("Needs you");
	},
	get status() {
		return tr("Status");
	},
	get threads() {
		return tr("Threads");
	},
};

export interface RecordsSort {
	direction: "asc" | "desc";
	key: RecordsSortKey;
}

export const RECORDS_DEFAULT_SORT: RecordsSort = {
	direction: "desc",
	key: "lastInteraction",
};

/** The direction a column sorts in when first chosen. */
export function recordsNaturalDirection(
	key: RecordsSortKey
): RecordsSort["direction"] {
	return key === "name" || key === "status" ? "asc" : "desc";
}

/** Clicking a header: first click sorts naturally, a second click flips it. */
export function recordsNextSort(
	current: RecordsSort,
	key: RecordsSortKey
): RecordsSort {
	if (current.key === key) {
		return {
			direction: current.direction === "asc" ? "desc" : "asc",
			key,
		};
	}
	return { direction: recordsNaturalDirection(key), key };
}

function compareBy(key: RecordsSortKey, a: RecordsRow, b: RecordsRow): number {
	switch (key) {
		case "name":
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		case "status":
			return recordsStatusRank(a.status) - recordsStatusRank(b.status);
		case "threads":
			return a.threads.length - b.threads.length;
		case "needsYou":
			return a.needsYou - b.needsYou;
		default:
			return (a.lastInteraction ?? "").localeCompare(b.lastInteraction ?? "");
	}
}

/** Sorted copy; ties fall back to name so the order never jitters. */
export function recordsSorted(
	rows: readonly RecordsRow[],
	sort: RecordsSort
): RecordsRow[] {
	const sign = sort.direction === "asc" ? 1 : -1;
	return [...rows].sort(
		(a, b) =>
			sign * compareBy(sort.key, a, b) ||
			compareBy("name", a, b) ||
			a.id.localeCompare(b.id)
	);
}

export interface RecordsFilter {
	/** Only records with at least one thread that needs the user. */
	needsYou: boolean;
	/** Only records active within this many hours, when set. */
	recentHours: number | null;
	/** Only records in these stages; empty means every stage. */
	statuses: ThreadStatus[];
}

export const RECORDS_EMPTY_FILTER: RecordsFilter = {
	needsYou: false,
	recentHours: null,
	statuses: [],
};

export function recordsFilterCount(filter: RecordsFilter): number {
	return (
		filter.statuses.length +
		Number(filter.needsYou) +
		Number(filter.recentHours !== null)
	);
}

export const HOUR = 3_600_000;

function matchesQuery(row: RecordsRow, query: string): boolean {
	if (!query) {
		return true;
	}
	const haystack = [
		row.name,
		row.description,
		...row.members.map((agent) => agent.name),
		...row.teams.map((group) => group.name),
		...row.projects.map((group) => group.name),
	]
		.join(" ")
		.toLowerCase();
	return haystack.includes(query);
}

export function recordsFiltered(
	rows: readonly RecordsRow[],
	filter: RecordsFilter,
	query: string,
	now: number
): RecordsRow[] {
	const needle = query.trim().toLowerCase();
	return rows.filter((row) => {
		if (filter.statuses.length > 0 && !filter.statuses.includes(row.status)) {
			return false;
		}
		if (filter.needsYou && row.needsYou === 0) {
			return false;
		}
		if (filter.recentHours !== null) {
			const then = row.lastInteraction ? Date.parse(row.lastInteraction) : 0;
			if (now - then > filter.recentHours * HOUR) {
				return false;
			}
		}
		return matchesQuery(row, needle);
	});
}

/** A saved view: an object plus a filter and a sort, listed in the nav. */
export interface RecordsView {
	filter: RecordsFilter;
	id: string;
	label: string;
	object: RecordsObject;
	sort: RecordsSort;
}

export const RECORDS_VIEWS: readonly RecordsView[] = [
	{
		filter: { ...RECORDS_EMPTY_FILTER, needsYou: true },
		id: "view-needs-you",
		get label() {
			return tr("Needs you");
		},
		object: "agents",
		sort: { direction: "desc", key: "needsYou" },
	},
	{
		filter: { ...RECORDS_EMPTY_FILTER, statuses: ["working"] },
		id: "view-working",
		get label() {
			return tr("Working now");
		},
		object: "agents",
		sort: RECORDS_DEFAULT_SORT,
	},
	{
		filter: { ...RECORDS_EMPTY_FILTER, recentHours: 24 },
		id: "view-recent",
		get label() {
			return tr("Active in the last 24 hours");
		},
		object: "agents",
		sort: RECORDS_DEFAULT_SORT,
	},
];

export function findRecordsView(id: string | null): RecordsView | undefined {
	return id ? RECORDS_VIEWS.find((view) => view.id === id) : undefined;
}

/** Records a saved view would show right now. */
export function recordsViewRows(
	snapshot: InterfaceSnapshot,
	view: RecordsView,
	now: number
): RecordsRow[] {
	return recordsFiltered(
		recordsRows(snapshot, view.object),
		view.filter,
		"",
		now
	);
}
