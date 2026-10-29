import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/** A classic board: six categories of up to five clues. */
export const QUIZ_COLUMNS = 6;
export const QUIZ_ROWS = 5;
/** Contestant podiums on the stage. */
export const QUIZ_PODIUMS = 4;
/** More conversations than this and the values double, like a second round. */
export const DOUBLE_ROUND_THRESHOLD = 20;
/** Clues are read aloud: anything longer is cut at a word boundary. */
export const CLUE_LIMIT = 220;
export const REVEALED_STORAGE_KEY = "ryu:quiz-revealed";

/**
 * What a board row is worth, as on the show: 100 on the top row up to 500 on
 * the bottom, doubled in a big round. Every column has the same five values.
 */
export function rowValue(row: number, double: boolean): number {
	return (row + 1) * 100 * (double ? 2 : 1);
}

export type QuizCategoryKind = "agent" | "project" | "team" | "unassigned";

export const CATEGORY_KIND_LABELS: Record<QuizCategoryKind, string> = {
	agent: "Agent",
	project: "Project",
	team: "Team",
	unassigned: "Unassigned",
};

export interface QuizTile {
	/** The agent who answers in this conversation (its first agent). */
	agentId: string | null;
	categoryName: string;
	/** True when the status asks the user to act. */
	needsYou: boolean;
	/** Board row, 0 at the top; the row sets the value. */
	row: number;
	status: ThreadStatus;
	/**
	 * With the act layer, the clue's status word from the acts ("Needs
	 * you", "Answer ready", "Working", "Stopped", "Done"), in place of the
	 * thread status.
	 */
	statusWord?: string;
	thread: InterfaceThread;
	value: number;
}

export interface QuizCategory {
	id: string;
	kind: QuizCategoryKind;
	name: string;
	/**
	 * Top to bottom, at most five, least pressing first: the most pressing
	 * conversation takes the bottom, highest-value slot. A short column fills
	 * from the bottom; the cheap slots above it read as already played.
	 */
	tiles: QuizTile[];
}

export interface QuizBoard {
	/** Always six entries: real categories first, then null for unused columns. */
	columns: (QuizCategory | null)[];
	double: boolean;
	/** Conversations that did not fit on the board. */
	offBoard: number;
	round: string;
	/** Rows on the board: always five, like the show's grid. */
	rows: number;
	threadCount: number;
}

interface Bucket {
	id: string;
	kind: QuizCategoryKind;
	latest: string;
	name: string;
	threads: InterfaceThread[];
}

function urgency(status: ThreadStatus): number {
	return THREAD_STATUS_ORDER.indexOf(status);
}

/** Most urgent first, then most recent, then id for a stable order. */
function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	return (
		urgency(threadStatus(a)) - urgency(threadStatus(b)) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

function addTo(
	buckets: Map<string, Bucket>,
	key: string,
	seed: Omit<Bucket, "latest" | "threads">,
	thread: InterfaceThread
) {
	const bucket = buckets.get(key) ?? { ...seed, latest: "", threads: [] };
	bucket.threads.push(thread);
	if (thread.updatedAt > bucket.latest) {
		bucket.latest = thread.updatedAt;
	}
	buckets.set(key, bucket);
}

/**
 * Sort every conversation into one category: its project, else its team,
 * else its first agent, else "Unassigned". Projects and teams lead (by
 * size), then agents with the most conversations, then the unassigned pile.
 */
function categoryBuckets(snapshot: InterfaceSnapshot): Bucket[] {
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const buckets = new Map<string, Bucket>();
	for (const thread of snapshot.threads) {
		const group =
			groups.get(thread.projectId ?? "") ?? groups.get(thread.teamId ?? "");
		if (group) {
			addTo(
				buckets,
				`group:${group.id}`,
				{ id: group.id, kind: group.kind, name: group.name },
				thread
			);
			continue;
		}
		const agent = agents.get(thread.agentIds[0] ?? "");
		if (agent) {
			addTo(
				buckets,
				`agent:${agent.id}`,
				{ id: agent.id, kind: "agent", name: agent.name },
				thread
			);
			continue;
		}
		addTo(
			buckets,
			"unassigned",
			{ id: "unassigned", kind: "unassigned", name: "Unassigned" },
			thread
		);
	}
	const rank: Record<QuizCategoryKind, number> = {
		agent: 1,
		project: 0,
		team: 0,
		unassigned: 2,
	};
	return [...buckets.values()].sort(
		(a, b) =>
			rank[a.kind] - rank[b.kind] ||
			b.threads.length - a.threads.length ||
			b.latest.localeCompare(a.latest) ||
			a.name.localeCompare(b.name)
	);
}

/** The game board for a snapshot: six categories of up to five clues. */
export function buildQuizBoard(
	snapshot: InterfaceSnapshot,
	/** The "Round" setting: `auto` doubles once the board is busy. */
	round: "auto" | "double" | "single" = "auto"
): QuizBoard {
	const threadCount = snapshot.threads.length;
	const double =
		round === "auto"
			? threadCount > DOUBLE_ROUND_THRESHOLD
			: round === "double";
	const picked = categoryBuckets(snapshot)
		.slice(0, QUIZ_COLUMNS)
		.map((bucket) => ({
			bucket,
			// The five most pressing, then cheapest first so values rise downward.
			threads: [...bucket.threads]
				.sort(byUrgency)
				.slice(0, QUIZ_ROWS)
				.reverse(),
		}));
	let onBoard = 0;
	const columns: (QuizCategory | null)[] = picked.map(({ bucket, threads }) => {
		onBoard += threads.length;
		return {
			id: `${bucket.kind}:${bucket.id}`,
			kind: bucket.kind,
			name: bucket.name,
			tiles: threads.map((thread, index): QuizTile => {
				const status = threadStatus(thread);
				const row = QUIZ_ROWS - threads.length + index;
				return {
					agentId: thread.agentIds[0] ?? null,
					categoryName: bucket.name,
					needsYou: status === "attention" || status === "your-turn",
					row,
					status,
					thread,
					value: rowValue(row, double),
				};
			}),
		};
	});
	while (columns.length < QUIZ_COLUMNS) {
		columns.push(null);
	}
	return {
		columns,
		double,
		offBoard: threadCount - onBoard,
		round: double ? "Double Round" : "Round 1",
		rows: QUIZ_ROWS,
		threadCount,
	};
}

/** Every tile on the board, column by column. */
export function boardTiles(board: QuizBoard): QuizTile[] {
	return board.columns.flatMap((column) => column?.tiles ?? []);
}

/** Where a tile sits on the board, or null when the thread is off the board. */
export function tilePosition(
	board: QuizBoard,
	threadId: string | null
): { column: number; row: number } | null {
	if (!threadId) {
		return null;
	}
	for (const [column, category] of board.columns.entries()) {
		const tile = category?.tiles.find((entry) => entry.thread.id === threadId);
		if (tile) {
			return { column, row: tile.row };
		}
	}
	return null;
}

/** The tile at a board position, if that cell holds one. */
export function tileAt(
	board: QuizBoard,
	position: { column: number; row: number }
): QuizTile | undefined {
	return board.columns[position.column]?.tiles.find(
		(tile) => tile.row === position.row
	);
}

export type BoardKey =
	| "ArrowDown"
	| "ArrowLeft"
	| "ArrowRight"
	| "ArrowUp"
	| "End"
	| "Home"
	| "PageDown"
	| "PageUp";

export function isBoardKey(key: string): key is BoardKey {
	return (
		key === "ArrowDown" ||
		key === "ArrowLeft" ||
		key === "ArrowRight" ||
		key === "ArrowUp" ||
		key === "End" ||
		key === "Home" ||
		key === "PageDown" ||
		key === "PageUp"
	);
}

/** The rows a column's tiles occupy, or null for a column without tiles. */
function rowSpan(
	board: QuizBoard,
	column: number
): { first: number; last: number } | null {
	const tiles = board.columns[column]?.tiles ?? [];
	const first = tiles[0];
	const last = tiles.at(-1);
	return first && last ? { first: first.row, last: last.row } : null;
}

/**
 * The tile a key moves to, following grid conventions. Up/down stay in the
 * column; left/right go to the nearest column that has tiles, landing on
 * the closest row it has. Home/End go to the first/last column that has a
 * tile in the current row (staying put when none does), or with `toBoardEdge` (Ctrl) to the first/last tile on the board.
 * PageUp/PageDown go to the top/bottom of the column. Undealt slots under a
 * short column are never stops, and nothing wraps.
 */
export function moveOnBoard(
	board: QuizBoard,
	from: { column: number; row: number },
	key: BoardKey,
	toBoardEdge = false
): { column: number; row: number } {
	const filled = board.columns
		.map((_, index) => index)
		.filter((index) => rowSpan(board, index) !== null);
	const firstColumn = filled[0];
	const lastColumn = filled.at(-1);
	if (firstColumn === undefined || lastColumn === undefined) {
		return from;
	}
	const clampTo = (column: number, row: number) => {
		const span = rowSpan(board, column);
		return {
			column,
			row: span ? Math.min(span.last, Math.max(span.first, row)) : row,
		};
	};
	if (key === "Home" || key === "End") {
		if (toBoardEdge) {
			return key === "Home"
				? clampTo(firstColumn, 0)
				: clampTo(lastColumn, rowSpan(board, lastColumn)?.last ?? 0);
		}
		// Plain Home/End never leave the row: only columns whose tiles reach
		// this row are stops, and with none the focus stays put.
		const inRow = filled.filter((column) => {
			const span = rowSpan(board, column);
			return span !== null && from.row >= span.first && from.row <= span.last;
		});
		const column = key === "Home" ? inRow[0] : inRow.at(-1);
		return column === undefined ? from : { column, row: from.row };
	}
	const span = rowSpan(board, from.column);
	if (key === "PageUp" || key === "PageDown") {
		return span
			? { column: from.column, row: key === "PageUp" ? span.first : span.last }
			: from;
	}
	if (key === "ArrowUp" || key === "ArrowDown") {
		const row = from.row + (key === "ArrowUp" ? -1 : 1);
		return span && row >= span.first && row <= span.last
			? { column: from.column, row }
			: from;
	}
	const step = key === "ArrowLeft" ? -1 : 1;
	for (
		let column = from.column + step;
		column >= 0 && column < board.columns.length;
		column += step
	) {
		if (rowSpan(board, column)) {
			return clampTo(column, from.row);
		}
	}
	return from;
}

/** The clue read out for a tile: the latest message, cut to a readable length. */
export function clueText(thread: InterfaceThread): string {
	const text = (thread.lastMessage ?? "").replace(/\s+/g, " ").trim();
	if (!text) {
		return thread.title.trim() || "Untitled conversation";
	}
	if (text.length <= CLUE_LIMIT) {
		return text;
	}
	const cut = text.slice(0, CLUE_LIMIT);
	const space = cut.lastIndexOf(" ");
	return `${(space > CLUE_LIMIT * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export function threadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled conversation";
}

export interface Contestant {
	agent: InterfaceAgent;
	/** Messages across every conversation the agent is in. */
	score: number;
	working: boolean;
}

/** Up to four agents with the most messages, highest score first. */
export function buildContestants(
	snapshot: InterfaceSnapshot,
	limit: number = QUIZ_PODIUMS
): Contestant[] {
	const scores = new Map<string, number>();
	for (const thread of snapshot.threads) {
		for (const agentId of new Set(thread.agentIds)) {
			scores.set(agentId, (scores.get(agentId) ?? 0) + thread.messageCount);
		}
	}
	return snapshot.agents
		.map((agent) => ({
			agent,
			score: scores.get(agent.id) ?? 0,
			working: agent.status === "working",
		}))
		.sort(
			(a, b) =>
				b.score - a.score ||
				Number(b.working) - Number(a.working) ||
				a.agent.name.localeCompare(b.agent.name)
		)
		.slice(0, limit);
}

/** Revealed clues: thread id to the `updatedAt` the user saw it at. */
export type RevealedMap = Record<string, string>;

/** Parse stored reveals; anything malformed counts as a fresh game. */
export function parseRevealed(raw: string | null): RevealedMap {
	if (!raw) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return {};
		}
		const result: RevealedMap = {};
		for (const [id, seen] of Object.entries(parsed)) {
			if (typeof seen === "string") {
				result[id] = seen;
			}
		}
		return result;
	} catch {
		return {};
	}
}

/**
 * A clue stays blank until its conversation moves on: new activity puts the
 * tile back in play, the way a new round refills the board.
 */
export function isRevealed(
	revealed: RevealedMap,
	thread: InterfaceThread
): boolean {
	return revealed[thread.id] === thread.updatedAt;
}

/** Drop reveals for threads that no longer exist, so storage stays small. */
export function pruneRevealed(
	revealed: RevealedMap,
	threads: InterfaceThread[]
): RevealedMap {
	const live = new Set(threads.map((thread) => thread.id));
	const result: RevealedMap = {};
	for (const [id, seen] of Object.entries(revealed)) {
		if (live.has(id)) {
			result[id] = seen;
		}
	}
	return result;
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}
