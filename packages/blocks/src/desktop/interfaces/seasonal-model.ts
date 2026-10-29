import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type SeasonalParams,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** A season the board can be dressed for (`auto` resolved to one of these). */
export type Season = Exclude<SeasonalParams["season"], "auto">;

export const SEASONS: readonly Season[] = [
	"advent",
	"halloween",
	"lunar-new-year",
];

/** How many doors the board has; conversations past this go to "More gifts". */
export const DOOR_COUNT = 24;

/** The words each season uses for its board and its doors. */
export interface SeasonCopy {
	/** Header button and composer heading for starting a conversation. */
	add: string;
	/** Name of the board in the header. */
	board: string;
	/** Singular and plural nouns for one door. */
	door: string;
	doors: string;
	/** Picker label. */
	label: string;
	/** Overflow list button and heading. */
	more: string;
}

export const SEASON_COPY: Record<Season, SeasonCopy> = {
	advent: {
		add: "Add a door",
		board: "Advent calendar",
		door: "door",
		doors: "doors",
		label: "Advent",
		more: "More gifts",
	},
	halloween: {
		add: "Add a pumpkin",
		board: "Pumpkin patch",
		door: "pumpkin",
		doors: "pumpkins",
		label: "Halloween",
		more: "More pumpkins",
	},
	"lunar-new-year": {
		add: "Add a lantern",
		board: "Lantern festival",
		door: "lantern",
		doors: "lanterns",
		label: "Lunar New Year",
		more: "More lanterns",
	},
};

export function isSeason(value: unknown): value is Season {
	return SEASONS.some((season) => season === value);
}

/**
 * The season for a date: Halloween through October, Advent from the 20th of
 * November through December, Lunar New Year from mid January through
 * February, and Advent as the showcase the rest of the year.
 */
export function seasonForDate(date: Date): Season {
	const month = date.getMonth();
	const day = date.getDate();
	if (month === 9) {
		return "halloween";
	}
	if ((month === 10 && day >= 20) || month === 11) {
		return "advent";
	}
	if ((month === 0 && day >= 15) || month === 1) {
		return "lunar-new-year";
	}
	return "advent";
}

export function resolveSeason(
	season: SeasonalParams["season"] | undefined,
	date: Date
): Season {
	return isSeason(season) ? season : seasonForDate(date);
}

/** The month each season's board counts through (0-based, as `Date` uses). */
const SEASON_MONTHS: Record<Season, readonly number[]> = {
	advent: [11],
	halloween: [9],
	"lunar-new-year": [0, 1],
};

/**
 * Today's door: the day of the month while the date falls in the season's
 * own month (December for Advent, October for the pumpkin patch, January and
 * February for the lantern festival) and the day has a door. Outside its season
 * a board has no today.
 */
export function todayDoor(
	date: Date,
	season: Season = "advent"
): number | null {
	if (!SEASON_MONTHS[season].includes(date.getMonth())) {
		return null;
	}
	const day = date.getDate();
	return day >= 1 && day <= DOOR_COUNT ? day : null;
}

/**
 * The order doors are handed out in: today's door first (so the most urgent
 * conversation sits behind it), then the rest from 1 upward.
 */
export function doorOrder(today: number | null): number[] {
	const order: number[] = today ? [today] : [];
	for (let number = 1; number <= DOOR_COUNT; number += 1) {
		if (number !== today) {
			order.push(number);
		}
	}
	return order;
}

/**
 * What a door shows before it is opened. "stopped" is the act layer's
 * frost: a run that stopped and counts (a failure or an interruption).
 */
export type DoorMark = "needs-you" | "stopped" | "working" | null;

export interface SeasonDoor {
	/**
	 * With the act layer, what it says of the conversation ("needs you",
	 * "working", "stopped: Tests failed"), in place of the thread status.
	 */
	actWords?: string;
	agents: InterfaceAgent[];
	/** The ribbon, glow, or twinkle the closed door carries. */
	mark: DoorMark;
	number: number;
	/** Opened by this viewer since its latest reply. */
	opened: boolean;
	status: ThreadStatus | null;
	thread: InterfaceThread | null;
}

export interface SeasonBoard {
	doors: SeasonDoor[];
	/** Conversations past the 24th door, most urgent first. */
	overflow: InterfaceThread[];
	totals: {
		needsYou: number;
		threads: number;
		working: number;
	};
}

function needsYou(status: ThreadStatus): boolean {
	return status === "attention" || status === "your-turn";
}

function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	const rank =
		THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
		THREAD_STATUS_ORDER.indexOf(threadStatus(b));
	if (rank !== 0) {
		return rank;
	}
	if (a.pinned !== b.pinned) {
		return a.pinned ? -1 : 1;
	}
	return b.updatedAt.localeCompare(a.updatedAt);
}

/** Conversations most urgent first: needs you, working, waiting, quiet. */
export function sortByUrgency(threads: InterfaceThread[]): InterfaceThread[] {
	return [...threads].sort(byUrgency);
}

/**
 * Opened doors, by thread id, with the activity time they were opened at. A
 * door that needs you closes again (re-wrapped) when a newer reply arrives.
 */
export type OpenedDoors = Record<string, string>;

export function isOpened(
	thread: InterfaceThread,
	opened: OpenedDoors
): boolean {
	const at = opened[thread.id];
	if (at === undefined) {
		return false;
	}
	return !(needsYou(threadStatus(thread)) && thread.updatedAt > at);
}

/**
 * What the act layer says about the threads (when the snapshot carries
 * acts): which wait on you (a blocking ask or a stopped run that counts)
 * and which are being worked on. With it, a door is opened once its
 * thread has no unread answer (`thread.unread`), never from storage.
 */
export interface DoorActs {
	/** Threads with a blocking ask: the needs-you mark. */
	needsYou: ReadonlySet<string>;
	/** Threads whose run stopped and counts: the frost mark. */
	stopped: ReadonlySet<string>;
	/** What the act layer says of each thread, for its words. */
	words: ReadonlyMap<string, string>;
	working: ReadonlySet<string>;
}

/** A door's mark and opened state from the act layer. */
function actDoor(
	thread: InterfaceThread,
	acts: DoorActs
): { mark: DoorMark; opened: boolean } {
	const opened = (thread.unread ?? 0) === 0;
	if (acts.needsYou.has(thread.id)) {
		return { mark: "needs-you", opened };
	}
	if (acts.stopped.has(thread.id)) {
		return { mark: "stopped", opened };
	}
	return { mark: acts.working.has(thread.id) ? "working" : null, opened };
}

/**
 * Number every conversation onto the board, most urgent at today's door when
 * there is one, then from door 1 upward.
 */
export function buildBoard(
	snapshot: InterfaceSnapshot,
	opened: OpenedDoors,
	today: number | null = null,
	acts?: DoorActs
): SeasonBoard {
	const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const sorted = sortByUrgency(snapshot.threads);
	const doors: SeasonDoor[] = [];
	for (const [index, number] of doorOrder(today).entries()) {
		const thread = sorted[index] ?? null;
		if (!thread) {
			doors.push({
				agents: [],
				mark: null,
				number,
				opened: false,
				status: null,
				thread: null,
			});
			continue;
		}
		const status = threadStatus(thread);
		let wasOpened = isOpened(thread, opened);
		let mark: DoorMark = null;
		if (acts) {
			({ mark, opened: wasOpened } = actDoor(thread, acts));
		} else if (status === "working") {
			mark = "working";
		} else if (needsYou(status) && !wasOpened) {
			mark = "needs-you";
		}
		const actWords = acts?.words.get(thread.id);
		doors.push({
			...(actWords ? { actWords } : {}),
			agents: thread.agentIds
				.map((id) => agentsById.get(id))
				.filter((agent): agent is InterfaceAgent => agent !== undefined),
			mark,
			number,
			opened: wasOpened,
			status,
			thread,
		});
	}
	doors.sort((a, b) => a.number - b.number);
	let needs = 0;
	let working = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (needsYou(status)) {
			needs += 1;
		} else if (status === "working") {
			working += 1;
		}
	}
	return {
		doors,
		overflow: sorted.slice(DOOR_COUNT),
		totals: { needsYou: needs, threads: snapshot.threads.length, working },
	};
}

export function doorOfThread(
	board: SeasonBoard,
	threadId: string | null
): SeasonDoor | null {
	if (!threadId) {
		return null;
	}
	return board.doors.find((door) => door.thread?.id === threadId) ?? null;
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The accessible name of a door: number, whether it is today's and whether
 * it is opened, then the conversation and where it stands.
 */
export function doorLabel(
	door: SeasonDoor,
	copy: SeasonCopy,
	today = false
): string {
	const parts = [`${capitalize(copy.door)} ${door.number}`];
	if (today) {
		parts.push("today");
	}
	if (!door.thread) {
		return `${parts.join(", ")}, empty. ${copy.add}`;
	}
	if (door.opened) {
		parts.push("opened");
	}
	parts.push(door.thread.title || "Untitled");
	if (door.actWords) {
		parts.push(door.actWords);
	} else if (door.status) {
		parts.push(STATUS_SPOKEN[door.status]);
	}
	return parts.join(", ");
}

const STATUS_SPOKEN: Record<ThreadStatus, string> = {
	attention: "needs attention",
	quiet: "not started",
	waiting: "waiting on agent",
	working: "working",
	"your-turn": "your turn",
};

/** The header's one-line summary. */
export function boardSummary(board: SeasonBoard, copy: SeasonCopy): string {
	const parts = [plural(board.totals.threads, copy.door, copy.doors)];
	if (board.totals.needsYou > 0) {
		parts.push(`${board.totals.needsYou} need you`);
	}
	if (board.totals.working > 0) {
		parts.push(`${board.totals.working} working`);
	}
	return parts.join(" · ");
}

export const OPENED_KEY = "ryu:seasonal-opened";
const OPENED_LIMIT = 400;

/** Parse stored opened doors, dropping anything malformed. */
export function parseOpened(raw: string | null): OpenedDoors {
	if (!raw) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const result: OpenedDoors = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (typeof value === "string") {
				result[id] = value;
			}
		}
		return result;
	} catch {
		return {};
	}
}

/** Serialize opened doors, keeping the most recent few hundred. */
export function serializeOpened(opened: OpenedDoors): string {
	const entries = Object.entries(opened)
		.sort((a, b) => b[1].localeCompare(a[1]))
		.slice(0, OPENED_LIMIT);
	return JSON.stringify(Object.fromEntries(entries));
}

export function readOpened(): OpenedDoors {
	try {
		return parseOpened(window.localStorage.getItem(OPENED_KEY));
	} catch {
		return {};
	}
}

export function writeOpened(opened: OpenedDoors): void {
	try {
		window.localStorage.setItem(OPENED_KEY, serializeOpened(opened));
	} catch {
		// Storage can be blocked; doors then stay open for this visit only.
	}
}

/** The latest message as one line, with "You:" when the user wrote last. */
export function latestLine(thread: InterfaceThread): string | null {
	const text = thread.lastMessage?.replace(/\s+/g, " ").trim();
	if (!text) {
		return null;
	}
	return thread.lastMessageRole === "user" ? `You: ${text}` : text;
}

/** A door's rectangle on the plain grid, in grid units. */
export interface BoardRect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** How far a door may reach past a row's edge and still count as above or below. */
const EDGE_SLACK = 24;

/**
 * The door straight above or below another on the plain grid: the
 * nearest one in that direction, preferring doors in the same column.
 */
export function doorInDirection(
	slots: ReadonlyMap<number, BoardRect>,
	from: number,
	direction: "down" | "up"
): number | null {
	const origin = slots.get(from);
	if (!origin) {
		return null;
	}
	const centerX = origin.x + origin.width / 2;
	const centerY = origin.y + origin.height / 2;
	let best: { number: number; score: number } | null = null;
	for (const [number, rect] of slots) {
		if (number === from) {
			continue;
		}
		// Only doors wholly above (or below) count, give or take a gutter.
		const clear =
			direction === "down"
				? rect.y >= origin.y + origin.height - EDGE_SLACK
				: rect.y + rect.height <= origin.y + EDGE_SLACK;
		if (!clear) {
			continue;
		}
		const y = rect.y + rect.height / 2;
		const ahead = Math.abs(y - centerY);
		const sideways = Math.max(
			0,
			Math.abs(rect.x + rect.width / 2 - centerX) -
				(rect.width + origin.width) / 4
		);
		const score = ahead + sideways * 3;
		if (!best || score < best.score) {
			best = { number, score };
		}
	}
	return best?.number ?? null;
}
