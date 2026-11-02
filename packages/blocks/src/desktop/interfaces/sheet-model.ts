import { activeLocale } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	moveSheetCell,
	SHEET_PAGE_ROWS,
	type SheetCell,
	type SheetMoveKey,
} from "./sheet-model-cursor.ts";
export {
	sheetAbsoluteTime,
	sheetRelativeTime,
} from "./sheet-model-time.ts";

/** Every column the Sheet shows, left to right (the row-number gutter is extra). */
export type SheetColumnId =
	| "agents"
	| "lastMessage"
	| "messages"
	| "pinned"
	| "project"
	| "status"
	| "team"
	| "title"
	| "updated";

export interface SheetColumn {
	align: "center" | "end" | "start";
	/** Width before the user drags its edge. */
	defaultWidth: number;
	id: SheetColumnId;
	label: string;
	minWidth: number;
}

/**
 * Title is the primary field: first, frozen beside the gutter, the way a
 * spreadsheet keeps the record name on screen while the rest scrolls.
 */
export const SHEET_COLUMNS: readonly SheetColumn[] = [
	{
		align: "start",
		defaultWidth: 260,
		id: "title",
		label: "Title",
		minWidth: 140,
	},
	{
		align: "start",
		defaultWidth: 152,
		id: "status",
		label: "Status",
		minWidth: 96,
	},
	{
		align: "start",
		defaultWidth: 172,
		id: "agents",
		label: "Agents",
		minWidth: 112,
	},
	{
		align: "start",
		defaultWidth: 132,
		id: "team",
		label: "Team",
		minWidth: 80,
	},
	{
		align: "start",
		defaultWidth: 152,
		id: "project",
		label: "Project",
		minWidth: 80,
	},
	{
		align: "end",
		defaultWidth: 104,
		id: "messages",
		label: "Messages",
		minWidth: 72,
	},
	{
		align: "start",
		defaultWidth: 228,
		id: "lastMessage",
		label: "Last message",
		minWidth: 120,
	},
	{
		align: "start",
		defaultWidth: 108,
		id: "updated",
		label: "Updated",
		minWidth: 84,
	},
	{
		align: "center",
		defaultWidth: 80,
		id: "pinned",
		label: "Pinned",
		minWidth: 64,
	},
];

/** Width of the row-number gutter, frozen at the far left. */
export const SHEET_GUTTER_WIDTH = 48;
/** Upper bound for a dragged column, so one drag cannot push the rest away. */
export const SHEET_MAX_COLUMN_WIDTH = 720;
/** Title width used when the sheet is too narrow for the default. */
export const SHEET_NARROW_TITLE_WIDTH = 196;

export type SheetWidths = Record<SheetColumnId, number>;

export function defaultSheetWidths(narrow = false): SheetWidths {
	const widths = {} as SheetWidths;
	for (const column of SHEET_COLUMNS) {
		widths[column.id] = column.defaultWidth;
	}
	if (narrow) {
		widths.title = SHEET_NARROW_TITLE_WIDTH;
	}
	return widths;
}

export function sheetColumn(id: SheetColumnId): SheetColumn {
	const found = SHEET_COLUMNS.find((column) => column.id === id);
	if (!found) {
		throw new Error(`Unknown sheet column: ${id}`);
	}
	return found;
}

/** Keep a dragged width between the column's minimum and the global cap. */
export function clampColumnWidth(id: SheetColumnId, width: number): number {
	const { minWidth } = sheetColumn(id);
	return Math.round(
		Math.min(SHEET_MAX_COLUMN_WIDTH, Math.max(minWidth, width))
	);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface SheetRow {
	agents: InterfaceAgent[];
	/** Position in the unsorted order (pinned first, then most recent). */
	defaultIndex: number;
	project: string | null;
	status: ThreadStatus;
	team: string | null;
	thread: InterfaceThread;
	title: string;
	updatedAt: number;
}

export const UNTITLED_THREAD = "Untitled thread";

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** One row per thread, in the sheet's resting order (pinned, then newest). */
export function buildSheetRows(snapshot: InterfaceSnapshot): SheetRow[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const ordered = [...snapshot.threads].sort(pinnedThenRecent);
	return ordered.map((thread, index) => {
		const rowAgents: InterfaceAgent[] = [];
		for (const agentId of thread.agentIds) {
			const agent = agents.get(agentId);
			if (agent) {
				rowAgents.push(agent);
			}
		}
		const parsed = Date.parse(thread.updatedAt);
		return {
			agents: rowAgents,
			defaultIndex: index,
			project: thread.projectId
				? (groups.get(thread.projectId)?.name ?? null)
				: null,
			status: threadStatus(thread),
			team: thread.teamId ? (groups.get(thread.teamId)?.name ?? null) : null,
			thread,
			title: thread.title.trim() || UNTITLED_THREAD,
			updatedAt: Number.isNaN(parsed) ? 0 : parsed,
		};
	});
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function normalize(value: string): string {
	return value.toLocaleLowerCase().trim();
}

/** True when every word of the query appears somewhere in the row. */
export function matchesSheetQuery(row: SheetRow, query: string): boolean {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return true;
	}
	const haystack = normalize(
		[
			row.title,
			row.thread.lastMessage ?? "",
			row.team ?? "",
			row.project ?? "",
			...row.agents.map((agent) => agent.name),
		].join(" ")
	);
	return words.every((word) => haystack.includes(word));
}

export function filterSheetRows(
	rows: readonly SheetRow[],
	query: string,
	status: ThreadStatus | null
): SheetRow[] {
	return rows.filter(
		(row) =>
			(status === null || row.status === status) &&
			matchesSheetQuery(row, query)
	);
}

/** How many rows sit in each status (zero for statuses with none). */
export function countSheetStatuses(
	rows: readonly SheetRow[]
): Record<ThreadStatus, number> {
	const counts = {} as Record<ThreadStatus, number>;
	for (const status of THREAD_STATUS_ORDER) {
		counts[status] = 0;
	}
	for (const row of rows) {
		counts[row.status] += 1;
	}
	return counts;
}

export interface SheetTotals {
	messages: number;
	pinned: number;
}

export function sheetTotals(rows: readonly SheetRow[]): SheetTotals {
	let messages = 0;
	let pinned = 0;
	for (const row of rows) {
		messages += row.thread.messageCount;
		pinned += row.thread.pinned ? 1 : 0;
	}
	return { messages, pinned };
}

export interface MatchSegment {
	match: boolean;
	text: string;
}

/** Split text around case-insensitive matches of the query's words. */
export function splitMatches(text: string, query: string): MatchSegment[] {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0 || text.length === 0) {
		return [{ match: false, text }];
	}
	const lower = text.toLocaleLowerCase();
	const marks = new Array<boolean>(text.length).fill(false);
	for (const word of words) {
		let from = lower.indexOf(word);
		while (from !== -1) {
			marks.fill(true, from, from + word.length);
			from = lower.indexOf(word, from + word.length);
		}
	}
	const segments: MatchSegment[] = [];
	let start = 0;
	for (let index = 1; index <= text.length; index += 1) {
		if (index === text.length || marks[index] !== marks[start]) {
			segments.push({
				match: marks[start] ?? false,
				text: text.slice(start, index),
			});
			start = index;
		}
	}
	return segments;
}

/** How far into a cell a search hit may sit before the text is trimmed to show it. */
export const SHEET_SNIPPET_LEAD = 40;
/** Characters of context kept before the hit in a trimmed snippet. */
const SNIPPET_CONTEXT = 18;

/**
 * Text a truncated cell should show so a search hit stays visible: the text
 * itself when the first match is near the start, else an ellipsis-led snippet
 * that begins on a word boundary a few words before the match.
 */
export function sheetSnippet(
	text: string,
	query: string,
	lead: number = SHEET_SNIPPET_LEAD
): string {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return text;
	}
	const lower = text.toLocaleLowerCase();
	let first = -1;
	for (const word of words) {
		const index = lower.indexOf(word);
		if (index !== -1 && (first === -1 || index < first)) {
			first = index;
		}
	}
	if (first <= lead) {
		return text;
	}
	const floor = Math.max(0, first - SNIPPET_CONTEXT);
	const space = text.indexOf(" ", floor);
	const start = space !== -1 && space < first ? space + 1 : floor;
	return `…${text.slice(start)}`;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SheetSortDirection = "asc" | "desc";

export interface SheetSort {
	column: SheetColumnId;
	direction: SheetSortDirection;
}

/** A header click cycles ascending, descending, then back to unsorted. */
export function nextSheetSort(
	current: SheetSort | null,
	column: SheetColumnId
): SheetSort | null {
	if (current?.column !== column) {
		return { column, direction: "asc" };
	}
	return current.direction === "asc" ? { column, direction: "desc" } : null;
}

/**
 * The sort direction in words, the way a grid tool's sort pill reads
 * ("A → Z", "high → low", "newest first").
 */
export function sheetSortDirectionLabel(sort: SheetSort): string {
	const asc = sort.direction === "asc";
	switch (sort.column) {
		case "messages":
			return asc ? "low → high" : "high → low";
		case "updated":
			return asc ? "oldest first" : "newest first";
		case "status":
			return asc ? "needs you first" : "quiet first";
		case "pinned":
			return asc ? "pinned first" : "pinned last";
		default:
			return asc ? "A → Z" : "Z → A";
	}
}

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

let cachedCollator: { collator: Intl.Collator; locale: string } | null = null;

/** Compares text the way the UI language orders it, not the OS. */
function collator(): Intl.Collator {
	const locale = activeLocale();
	if (cachedCollator?.locale !== locale) {
		cachedCollator = {
			collator: new Intl.Collator(locale, {
				numeric: true,
				sensitivity: "base",
			}),
			locale,
		};
	}
	return cachedCollator.collator;
}

/**
 * The value a column sorts on. `null` means an empty cell, which sorts last
 * in both directions so blanks never crowd the top of the sheet.
 */
function sortValue(
	row: SheetRow,
	column: SheetColumnId
): number | string | null {
	switch (column) {
		case "agents":
			return row.agents[0]?.name ?? null;
		case "lastMessage":
			return row.thread.lastMessage?.trim() || null;
		case "messages":
			return row.thread.messageCount;
		case "pinned":
			// Ascending puts pinned rows first, like a checked box.
			return row.thread.pinned ? 0 : 1;
		case "project":
			return row.project;
		case "status":
			return STATUS_RANK.get(row.status) ?? THREAD_STATUS_ORDER.length;
		case "team":
			return row.team;
		case "title":
			return row.title;
		case "updated":
			return row.updatedAt;
		default:
			return null;
	}
}

function compareValues(a: number | string, b: number | string): number {
	if (typeof a === "number" && typeof b === "number") {
		return a - b;
	}
	return collator().compare(String(a), String(b));
}

export function sortSheetRows(
	rows: readonly SheetRow[],
	sort: SheetSort | null
): SheetRow[] {
	const sorted = [...rows];
	if (!sort) {
		return sorted.sort((a, b) => a.defaultIndex - b.defaultIndex);
	}
	const sign = sort.direction === "asc" ? 1 : -1;
	return sorted.sort((a, b) => {
		const left = sortValue(a, sort.column);
		const right = sortValue(b, sort.column);
		if (left === null || right === null) {
			if (left === right) {
				return a.defaultIndex - b.defaultIndex;
			}
			return left === null ? 1 : -1;
		}
		return sign * compareValues(left, right) || a.defaultIndex - b.defaultIndex;
	});
}
