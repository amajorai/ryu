import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { DAY, HOUR, MINUTE } from "./departures-model-types.ts";

/** Departures view model: flight numbers, board times, and flight lengths. */

// ---------------------------------------------------------------------------
// Flight numbers
// ---------------------------------------------------------------------------

const LETTERS = /[A-Z]/g;

function lettersOf(name: string): string[] {
	return name.toUpperCase().match(LETTERS) ?? [];
}

/** Candidate airline codes for a name, in preference order. */
function codeCandidates(name: string): string[] {
	const letters = lettersOf(name);
	const first = letters[0] ?? "R";
	const candidates: string[] = [];
	for (const next of letters.slice(1)) {
		candidates.push(`${first}${next}`);
	}
	for (const next of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		candidates.push(`${first}${next}`);
	}
	return candidates;
}

/** The code for flights with no agent. */
export const HOUSE_AIRLINE = "RY";

/**
 * A unique two-letter airline code per agent: its first two letters, or the
 * first letter and a later one when another agent already took the pair.
 * Agents are coded in id order so a code never depends on list order.
 */
export function airlineCodes(
	agents: readonly InterfaceAgent[]
): Map<string, string> {
	const taken = new Set<string>([HOUSE_AIRLINE]);
	const codes = new Map<string, string>();
	const ordered = [...agents].sort((a, b) => a.id.localeCompare(b.id));
	for (const agent of ordered) {
		const code =
			codeCandidates(agent.name).find((candidate) => !taken.has(candidate)) ??
			HOUSE_AIRLINE;
		taken.add(code);
		codes.set(agent.id, code);
	}
	return codes;
}

function hashId(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 33 + (char.codePointAt(0) ?? 0)) % 1_000_003;
	}
	return hash;
}

/** "AT 1042": the airline code and four stable digits from the id. */
export function flightNumber(code: string, id: string): string {
	const digits = 1000 + (hashId(id) % 9000);
	return `${code} ${digits}`;
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Board clock time, 24-hour like an airport: "09:05". */
export function boardTime(time: number): string {
	const date = new Date(time);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	weekday: "short",
});

/** "Wed 14 Oct". */
export function boardDate(time: number): string {
	return DAY_FORMAT.format(new Date(time)).replace(",", "");
}

const SHORT_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
});

/** "5 Oct". */
export function shortDate(time: number): string {
	return SHORT_DAY_FORMAT.format(new Date(time));
}

/** "Today", "Tomorrow", "Yesterday", or "Wed 14 Oct". */
export function relativeDay(time: number, now: number): string {
	const key = localDayKey(new Date(time));
	if (key === localDayKey(new Date(now))) {
		return "Today";
	}
	if (key === localDayKey(new Date(now + DAY))) {
		return "Tomorrow";
	}
	if (key === localDayKey(new Date(now - DAY))) {
		return "Yesterday";
	}
	return boardDate(time);
}

/** "45s", "12m", "3h 05m", "2d 4h". */
export function flightDuration(ms: number): string {
	const total = Math.max(0, ms);
	if (total < MINUTE) {
		return `${Math.floor(total / 1000)}s`;
	}
	if (total < HOUR) {
		return `${Math.floor(total / MINUTE)}m`;
	}
	if (total < DAY) {
		const hours = Math.floor(total / HOUR);
		const minutes = Math.floor((total % HOUR) / MINUTE);
		return minutes === 0 ? `${hours}h` : `${hours}h ${pad(minutes)}m`;
	}
	const days = Math.floor(total / DAY);
	const hours = Math.floor((total % DAY) / HOUR);
	return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function parseTime(iso: string | null | undefined): number | null {
	if (!iso) {
		return null;
	}
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : time;
}

function median(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] ?? 0;
	if (sorted.length % 2 === 1) {
		return upper;
	}
	return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

function runLengths(events: readonly InterfaceEvent[]): number[] {
	const lengths: number[] = [];
	for (const event of events) {
		if (event.kind !== "past") {
			continue;
		}
		const start = parseTime(event.start);
		const end = parseTime(event.end);
		if (start !== null && end !== null && end > start) {
			lengths.push(end - start);
		}
	}
	return lengths;
}

/**
 * How long an agent typically takes to answer. Ideally this is the gap
 * between your message and the agent's reply in its other threads, but the
 * snapshot only carries each thread's last update, not per-message times, so
 * that gap cannot be measured. The closest real signal is the length of the
 * agent's finished routine runs: this agent's first, then every agent's when
 * it has none. Null when nothing has finished yet, so the board shows no ETA
 * rather than a made-up one. The panel labels the estimate "from recent runs".
 */
export function typicalFlightMs(
	snapshot: InterfaceSnapshot,
	agentId: string | null
): number | null {
	const events = snapshot.events ?? [];
	if (agentId) {
		const own = median(
			runLengths(events.filter((event) => event.agentId === agentId))
		);
		if (own !== null) {
			return own;
		}
	}
	return median(runLengths(events));
}
