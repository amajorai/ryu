import {
	channelHandle,
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectArena,
	projectBoard,
	resolveAgentHandle,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentById, agentHandle } from "./interface-renderer.ts";

/**
 * Pure model behind the Terminal interface: listings, completion, and command
 * resolution. Kept free of React so the command language stays predictable.
 */

/**
 * Lowercase status words for monospace columns. They match the `ls` filter
 * names, so whatever a listing prints can be typed back as a filter.
 */
export const TERMINAL_STATUS_WORDS: Record<ThreadStatus, string> = {
	attention: "attention",
	quiet: "quiet",
	waiting: "waiting",
	working: "working",
	"your-turn": "your-turn",
};

/**
 * One glyph per status, so status never relies on color alone (several themes
 * share a hue between primary and success). All come from the Geometric
 * Shapes block so they share one optical size in monospace fonts.
 */
export const TERMINAL_STATUS_GLYPHS: Record<ThreadStatus, string> = {
	attention: "▲",
	quiet: "◌",
	waiting: "○",
	working: "●",
	"your-turn": "◆",
};

/** Commands offered by Tab completion, in the order `help` lists them. */
export const TERMINAL_VERBS = [
	"ls",
	"open",
	"new",
	"agents",
	"close",
	"clear",
	"help",
] as const;

/** `ls` filters offered by Tab completion. */
export const TERMINAL_LIST_FILTERS = [
	"all",
	"working",
	"your-turn",
	"waiting",
	"attention",
	"quiet",
] as const;

export interface TerminalThreadRow {
	agentLabel: string;
	number: number;
	pinned: boolean;
	status: ThreadStatus;
	threadId: string;
	title: string;
	updatedAt: string;
}

export interface TerminalAgentRow {
	agentId: string;
	description: string;
	handle: string;
	name: string;
	needsYou: number;
	status: InterfaceAgent["status"];
	threadCount: number;
}

export interface TerminalCounts {
	agents: number;
	attention: number;
	needsYou: number;
	threads: number;
	working: number;
}

export function threadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled thread";
}

/** Who a thread belongs to, as a terminal would print it. */
export function threadOwnerLabel(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const [first, ...rest] = thread.agentIds;
	const agent = agentById(snapshot, first);
	if (!agent) {
		return "-";
	}
	const more = rest.length > 0 ? ` +${rest.length}` : "";
	return `${agentHandle(agent.name)}${more}`;
}

/**
 * Every thread most urgent first (pinned first within a status), numbered
 * from 1. The numbers are what `open <n>` resolves against.
 */
export function listThreads(
	snapshot: InterfaceSnapshot,
	filter: ThreadStatus | "all"
): TerminalThreadRow[] {
	const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
	const rows: TerminalThreadRow[] = [];
	for (const column of projectBoard(snapshot, { groupBy: "status" })) {
		if (!column.status || (filter !== "all" && column.status !== filter)) {
			continue;
		}
		for (const threadId of column.threadIds) {
			const thread = byId.get(threadId);
			if (!thread) {
				continue;
			}
			rows.push({
				agentLabel: threadOwnerLabel(snapshot, thread),
				number: rows.length + 1,
				pinned: thread.pinned,
				status: column.status,
				threadId,
				title: threadTitle(thread),
				updatedAt: thread.updatedAt,
			});
		}
	}
	return rows;
}

/** Agents by name with their thread and needs-you counts. */
export function listAgents(snapshot: InterfaceSnapshot): TerminalAgentRow[] {
	const descriptions = new Map(
		snapshot.agents.map((agent) => [agent.id, agent.description])
	);
	return projectArena(snapshot)
		.map((card) => ({
			agentId: card.agentId,
			description: descriptions.get(card.agentId) ?? "",
			handle: agentHandle(card.name),
			name: card.name,
			needsYou: card.counts.attention + card.counts["your-turn"],
			status: card.status,
			threadCount: card.threadCount,
		}))
		.sort(
			(a, b) =>
				a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId)
		);
}

/** Threads waiting on the user (attention, then your turn), numbered as in `ls`. */
export function threadsNeedingYou(
	snapshot: InterfaceSnapshot,
	limit: number
): TerminalThreadRow[] {
	return listThreads(snapshot, "all")
		.filter((row) => row.status === "attention" || row.status === "your-turn")
		.slice(0, limit);
}

export function terminalCounts(snapshot: InterfaceSnapshot): TerminalCounts {
	let working = 0;
	let attention = 0;
	let yourTurn = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "working") {
			working += 1;
		} else if (status === "attention") {
			attention += 1;
		} else if (status === "your-turn") {
			yourTurn += 1;
		}
	}
	return {
		agents: snapshot.agents.length,
		attention,
		needsYou: attention + yourTurn,
		threads: snapshot.threads.length,
		working,
	};
}

export type OpenResolution =
	| { kind: "found"; number: number | null; threadId: string }
	| {
			/** Muted follow-up line: what to run next. */
			hint: string;
			kind: "missing";
			/** Terse shell-style error, e.g. `open: no thread #9`. */
			message: string;
	  };

/**
 * Resolve `open <n|id>`: a number from the last listing (or the full list
 * when nothing was listed yet), an exact thread id, or a unique id prefix.
 */
export function resolveOpenTarget(
	snapshot: InterfaceSnapshot,
	target: string,
	lastListing: readonly string[] | null
): OpenResolution {
	const cleaned = target.replace(/^#/, "");
	if (/^\d+$/.test(cleaned)) {
		const ids =
			lastListing ?? listThreads(snapshot, "all").map((row) => row.threadId);
		const number = Number(cleaned);
		const threadId = ids[number - 1];
		if (threadId && snapshot.threads.some((thread) => thread.id === threadId)) {
			return { kind: "found", number, threadId };
		}
		let scope = `${ids.length} in the last listing`;
		if (!lastListing) {
			scope = ids.length === 1 ? "1 thread" : `${ids.length} threads`;
		}
		return {
			hint: `${scope} · ls to refresh`,
			kind: "missing",
			message: `open: no thread #${number}`,
		};
	}
	const exact = snapshot.threads.find((thread) => thread.id === cleaned);
	if (exact) {
		return { kind: "found", number: null, threadId: exact.id };
	}
	const prefixed =
		cleaned.length >= 3
			? snapshot.threads.filter((thread) => thread.id.startsWith(cleaned))
			: [];
	if (prefixed.length === 1 && prefixed[0]) {
		return { kind: "found", number: null, threadId: prefixed[0].id };
	}
	if (prefixed.length > 1) {
		return {
			hint: "ls, then open <n>",
			kind: "missing",
			message: `open: ${cleaned} matches ${prefixed.length} threads`,
		};
	}
	return {
		hint: "usage: open <n|id> · ls for numbers",
		kind: "missing",
		message: `open: no thread ${cleaned}`,
	};
}

/** Lowercase letters and digits, matching how handles are compared. */
function handleKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export type StartTarget =
	| { agent: InterfaceAgent; kind: "agent" }
	| { group: InterfaceGroup; kind: "group" }
	| { kind: "none" }
	| {
			/** True when the suggestions resemble the typed handle. */
			close: boolean;
			kind: "unknown";
			suggestions: string[];
	  };

/**
 * Who `new @handle` addresses: an agent first, then a team or project by its
 * name, so `@launch-crew` files the thread under that team.
 */
export function resolveStartTarget(
	snapshot: InterfaceSnapshot,
	handle: string | null
): StartTarget {
	if (handle === null) {
		return { kind: "none" };
	}
	const agent = resolveAgentHandle(snapshot, handle);
	if (agent) {
		return { agent, kind: "agent" };
	}
	const key = handleKey(handle);
	const group = key
		? snapshot.groups.find((item) => handleKey(item.name) === key)
		: undefined;
	if (group) {
		return { group, kind: "group" };
	}
	return { kind: "unknown", ...suggestHandles(snapshot, key) };
}

/** Handles that look like a mistyped one, or every handle when none do. */
export function suggestHandles(
	snapshot: InterfaceSnapshot,
	key: string
): { close: boolean; suggestions: string[] } {
	const all = allHandles(snapshot);
	const close = key
		? all.filter((handle) => {
				const candidate = handleKey(handle);
				return (
					candidate.startsWith(key.slice(0, 2)) ||
					candidate.includes(key) ||
					key.includes(candidate)
				);
			})
		: [];
	return close.length > 0
		? { close: true, suggestions: close.slice(0, 8) }
		: { close: false, suggestions: all.slice(0, 8) };
}

/** Every `@handle` the terminal accepts: agents, then teams and projects. */
export function allHandles(snapshot: InterfaceSnapshot): string[] {
	const agents = [...snapshot.agents]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => agentHandle(agent.name));
	const groups = [...snapshot.groups]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((group) => `@${channelHandle(group.name)}`);
	return [...new Set([...agents, ...groups])];
}

export interface Completion {
	/** Candidates to print when the input could not be extended. */
	candidates: string[];
	value: string;
}

function commonPrefix(values: readonly string[]): string {
	const [first = "", ...rest] = values;
	let prefix = first;
	for (const value of rest) {
		while (!value.toLowerCase().startsWith(prefix.toLowerCase())) {
			prefix = prefix.slice(0, -1);
		}
	}
	return prefix;
}

/**
 * Tab completion for the last word of the input: verbs first, `ls` filters
 * after `ls`, and `@handles` anywhere a word starts with `@`. One match is
 * completed with a trailing space; several are extended to their common
 * prefix, and when that adds nothing the candidates come back to print.
 */
export function completeInput(
	snapshot: InterfaceSnapshot,
	input: string
): Completion {
	const words = input.split(" ");
	const current = words.at(-1) ?? "";
	const before = words.slice(0, -1);
	const verb = before[0]?.toLowerCase();
	let pool: readonly string[] = [];
	if (current.startsWith("@")) {
		pool = allHandles(snapshot);
	} else if (before.length === 0) {
		pool = TERMINAL_VERBS;
	} else if (before.length === 1 && (verb === "ls" || verb === "list")) {
		pool = TERMINAL_LIST_FILTERS;
	} else if (before.length === 1 && verb === "new") {
		pool = allHandles(snapshot);
	}
	const lower = current.toLowerCase();
	const matches = pool.filter((candidate) =>
		candidate.toLowerCase().startsWith(lower)
	);
	if (matches.length === 0) {
		return { candidates: [], value: input };
	}
	const head = before.length > 0 ? `${before.join(" ")} ` : "";
	if (matches.length === 1) {
		return { candidates: [], value: `${head}${matches[0]} ` };
	}
	const prefix = commonPrefix(matches);
	if (prefix.length > current.length) {
		return { candidates: [], value: `${head}${prefix}` };
	}
	return { candidates: matches, value: input };
}

const PROMPT_SLUG_LIMIT = 24;

/** Path segment for the open thread, shown in the prompt (`~/launch-week`). */
export function promptPath(thread: InterfaceThread | undefined): string {
	if (!thread) {
		return "~";
	}
	const slug = channelHandle(threadTitle(thread));
	if (slug.length <= PROMPT_SLUG_LIMIT) {
		return `~/${slug}`;
	}
	// Cut at a word boundary so the path reads as words, not a fragment.
	const cut = slug.slice(0, PROMPT_SLUG_LIMIT + 1);
	const boundary = cut.lastIndexOf("-");
	return `~/${boundary > 8 ? cut.slice(0, boundary) : cut.slice(0, PROMPT_SLUG_LIMIT)}`;
}

/** Statuses that changed since the previous snapshot, for live notices. */
export function statusChanges(
	previous: ReadonlyMap<string, ThreadStatus>,
	snapshot: InterfaceSnapshot
): { status: ThreadStatus; thread: InterfaceThread }[] {
	const changes: { status: ThreadStatus; thread: InterfaceThread }[] = [];
	for (const thread of snapshot.threads) {
		const before = previous.get(thread.id);
		const status = threadStatus(thread);
		if (before !== undefined && before !== status) {
			changes.push({ status, thread });
		}
	}
	return changes.sort(
		(a, b) =>
			THREAD_STATUS_ORDER.indexOf(a.status) -
			THREAD_STATUS_ORDER.indexOf(b.status)
	);
}

export function statusMap(
	snapshot: InterfaceSnapshot
): Map<string, ThreadStatus> {
	return new Map(
		snapshot.threads.map((thread) => [thread.id, threadStatus(thread)])
	);
}
