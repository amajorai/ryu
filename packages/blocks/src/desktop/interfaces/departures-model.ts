import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Departures view model. Conversations are flights on an airport board:
 * - DEPARTURES lists what is leaving or about to leave: routine runs that are
 *   scheduled, threads boarding (you wrote, the agent has not started), and
 *   threads in flight (a run is live).
 * - ARRIVALS lists what has come back: threads that just landed or are at the
 *   gate (the agent replied, waiting on you), delayed ones (the last run failed
 *   or was interrupted), and arrived ones (finished or never started).
 *
 * Everything here is pure, so the board, the details panel, and the tests
 * read the same flights.
 */

export type DeparturesBoard = "arrivals" | "departures";

export const DEPARTURES_BOARDS: readonly DeparturesBoard[] = [
	"departures",
	"arrivals",
];

export const BOARD_LABELS: Record<DeparturesBoard, string> = {
	arrivals: "Arrivals",
	departures: "Departures",
};

export type FlightStatus =
	| "arrived"
	| "at-gate"
	| "boarding"
	| "delayed"
	| "in-flight"
	| "landed"
	| "scheduled";

export const FLIGHT_STATUS_LABELS: Record<FlightStatus, string> = {
	arrived: "Arrived",
	"at-gate": "At gate",
	boarding: "Boarding",
	delayed: "Delayed",
	"in-flight": "In flight",
	landed: "Landed",
	scheduled: "Scheduled",
};

/**
 * Three-letter status codes for a narrow board, the way a compact FIDS strip
 * abbreviates. The lamp beside them keeps the colour; the code keeps the word,
 * so the status never rests on colour alone.
 */
export const FLIGHT_STATUS_CODES: Record<FlightStatus, string> = {
	arrived: "ARR",
	"at-gate": "GTE",
	boarding: "BRD",
	delayed: "DLY",
	"in-flight": "DEP",
	landed: "LND",
	scheduled: "SCH",
};

/** The widest status label, so the status flaps keep one width. */
export const STATUS_FLAP_LENGTH = Math.max(
	...Object.values(FLIGHT_STATUS_LABELS).map((label) => label.length)
);

/** The lamp beside the status: which theme signal it takes, and whether it blinks. */
export type FlightLamp = "alert" | "go" | "hold" | "off" | "idle";

export const FLIGHT_LAMPS: Record<FlightStatus, FlightLamp> = {
	arrived: "off",
	"at-gate": "hold",
	boarding: "hold",
	delayed: "alert",
	"in-flight": "go",
	landed: "go",
	scheduled: "idle",
};

/** Statuses whose lamp blinks, the way a board flashes "Boarding". */
export const BLINKING_STATUSES: ReadonlySet<FlightStatus> = new Set([
	"boarding",
	"landed",
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A reply younger than this has "Landed"; older ones wait "At gate". */
export const LANDED_WINDOW_MS = 30 * MINUTE;
/**
 * A reply left waiting this long is still at the gate (it still needs you),
 * but its lamp dims and its remark stops shouting "Your turn".
 */
export const AT_GATE_WINDOW_MS = DAY;

/** One part of a remark; the emphasized part takes the status colour. */
export interface RemarkPart {
	emphasis: boolean;
	text: string;
}

/**
 * A run of rows under one day divider. A real board prints the date over
 * next-day departures; this board does the same for every day but today, and
 * lists boarding flights left from earlier days last, under "Held".
 */
export interface BoardSection {
	key: string;
	label: string;
}

export interface Flight {
	/** Every agent on the thread, gate agent first. */
	agentIds: string[];
	/** The board that lists this flight. */
	board: DeparturesBoard;
	/** When a finished routine run left, so its timeline can show both ends. */
	departedAt: number | null;
	/** Estimated landing time for a flight in the air, from past run lengths. */
	etaAt: number | null;
	/** The routine run behind a scheduled flight. */
	eventId: string | null;
	/** "AT 1042": the agent's two-letter code and digits from the id. */
	flightNumber: string;
	/** The gate agent (the thread's first agent), when there is one. */
	gateAgentId: string | null;
	/** Gate column text: the agent name, with "+n" for more agents. */
	gateLabel: string;
	/** Stable row key across both boards. */
	key: string;
	/** A reply that has waited past AT_GATE_WINDOW_MS: the lamp dims. */
	parked: boolean;
	/** A conversation nothing has been said in yet: it never flew. */
	quiet: boolean;
	/** Free text for the Remarks column. */
	remark: string;
	/** The remark in parts, so the actionable part can take the lamp colour. */
	remarkParts: RemarkPart[];
	/** A scheduled run's repeat phrase, e.g. "Weekdays at 9 AM". */
	schedule: string | null;
	/** The day divider this row sits under. */
	section: BoardSection;
	status: FlightStatus;
	/** Terminal column text: the team or project, when there is one. */
	terminal: string | null;
	/** Team or project id behind the terminal. */
	terminalId: string | null;
	terminalKind: "project" | "team" | null;
	/** The conversation behind a thread flight. */
	threadId: string | null;
	/** Scheduled time, departure time, or landing time (epoch ms). */
	time: number;
	/** The destination: the conversation title or the routine name. */
	title: string;
}

export interface DeparturesBoards {
	arrivals: Flight[];
	departures: Flight[];
}

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

function parseTime(iso: string | null | undefined): number | null {
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

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

interface FlightContext {
	codes: Map<string, string>;
	now: number;
	snapshot: InterfaceSnapshot;
}

function agentName(snapshot: InterfaceSnapshot, agentId: string): string {
	return snapshot.agents.find((agent) => agent.id === agentId)?.name ?? "Agent";
}

function gateLabelFor(
	snapshot: InterfaceSnapshot,
	agentIds: readonly string[]
): string {
	const [first, ...rest] = agentIds;
	if (!first) {
		return "";
	}
	const name = agentName(snapshot, first);
	return rest.length > 0 ? `${name} +${rest.length}` : name;
}

function terminalFor(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): Pick<Flight, "terminal" | "terminalId" | "terminalKind"> {
	const groupId = thread.projectId ?? thread.teamId;
	const group = groupId
		? snapshot.groups.find((candidate) => candidate.id === groupId)
		: undefined;
	return group
		? { terminal: group.name, terminalId: group.id, terminalKind: group.kind }
		: { terminal: null, terminalId: null, terminalKind: null };
}

/** A boarding flight from an earlier day is held, not leading the board. */
function isHeld(status: FlightStatus, time: number, now: number): boolean {
	return (
		status === "boarding" &&
		localDayKey(new Date(time)) < localDayKey(new Date(now))
	);
}

const TODAY_SECTION: BoardSection = { key: "today", label: "Today" };
const HELD_SECTION: BoardSection = {
	key: "held",
	label: "Held from earlier days",
};

function daySection(time: number, now: number): BoardSection {
	const key = localDayKey(new Date(time));
	if (key === localDayKey(new Date(now))) {
		return TODAY_SECTION;
	}
	const day = relativeDay(time, now);
	const date = boardDate(time);
	return { key, label: day === date ? date : `${day} · ${date}` };
}

const plain = (text: string): RemarkPart => ({ emphasis: false, text });
const strong = (text: string): RemarkPart => ({ emphasis: true, text });

function inFlightRemark(
	context: FlightContext,
	time: number,
	etaAt: number | null
): RemarkPart[] {
	const airborne = plain(`Airborne ${flightDuration(context.now - time)}`);
	if (etaAt === null) {
		return [airborne];
	}
	// The estimate leads, like every remark's actionable part, so a narrow
	// board truncates the airborne time rather than the ETA.
	if (etaAt < context.now) {
		return [strong("Longer than usual"), airborne];
	}
	return [strong(`ETA ${boardTime(etaAt)} est.`), airborne];
}

function threadStatusFor(thread: InterfaceThread, now: number): FlightStatus {
	const time = parseTime(thread.updatedAt) ?? now;
	const age = now - time;
	switch (threadStatus(thread)) {
		case "working":
			return "in-flight";
		case "waiting":
			return "boarding";
		case "attention":
			return "delayed";
		case "your-turn":
			return age < LANDED_WINDOW_MS ? "landed" : "at-gate";
		default:
			return "arrived";
	}
}

/** A finished trip still says what is on board, so Remarks never reads blank. */
function arrivedRemark(thread: InterfaceThread): RemarkPart[] {
	if (thread.messageCount === 0) {
		return [plain("No messages")];
	}
	const count = thread.messageCount;
	return [plain(`${count} ${count === 1 ? "message" : "messages"}`)];
}

function threadRemark(
	context: FlightContext,
	thread: InterfaceThread,
	status: FlightStatus,
	time: number,
	etaAt: number | null
): RemarkPart[] {
	const { now } = context;
	const waited = flightDuration(now - time);
	switch (status) {
		case "in-flight":
			return inFlightRemark(context, time, etaAt);
		case "boarding": {
			if (thread.agentIds.length === 0) {
				return [strong("No gate assigned"), plain(`Since ${shortDate(time)}`)];
			}
			return isHeld(status, time, now)
				? [strong(`Held ${waited}`), plain(`Since ${shortDate(time)}`)]
				: [strong("Waiting for gate"), plain(waited)];
		}
		case "delayed":
			return [
				strong(
					thread.runState === "interrupted" ? "Run interrupted" : "Run failed"
				),
			];
		case "landed":
			return [strong("Your turn"), plain(waited)];
		case "at-gate":
			return now - time < AT_GATE_WINDOW_MS
				? [strong("Your turn"), plain(waited)]
				: [plain("Reply waiting"), plain(waited)];
		default:
			return arrivedRemark(thread);
	}
}

function joinRemark(parts: readonly RemarkPart[]): string {
	return parts.map((part) => part.text).join(" · ");
}

function threadFlight(context: FlightContext, thread: InterfaceThread): Flight {
	const { codes, now, snapshot } = context;
	const time = parseTime(thread.updatedAt) ?? now;
	const status = threadStatusFor(thread, now);
	const gateAgentId = thread.agentIds[0] ?? null;
	const code = gateAgentId
		? (codes.get(gateAgentId) ?? HOUSE_AIRLINE)
		: HOUSE_AIRLINE;
	let etaAt: number | null = null;
	if (status === "in-flight") {
		const typical = typicalFlightMs(snapshot, gateAgentId);
		etaAt = typical === null ? null : time + typical;
	}
	const remarkParts = threadRemark(context, thread, status, time, etaAt);
	return {
		agentIds: thread.agentIds,
		board:
			status === "boarding" || status === "in-flight"
				? "departures"
				: "arrivals",
		departedAt: null,
		etaAt,
		eventId: null,
		flightNumber: flightNumber(code, thread.id),
		gateAgentId,
		gateLabel: gateLabelFor(snapshot, thread.agentIds),
		key: `thread:${thread.id}`,
		parked: status === "at-gate" && now - time >= AT_GATE_WINDOW_MS,
		quiet: threadStatus(thread) === "quiet",
		remark: joinRemark(remarkParts),
		remarkParts,
		schedule: null,
		section: isHeld(status, time, now) ? HELD_SECTION : daySection(time, now),
		status,
		...terminalFor(snapshot, thread),
		threadId: thread.id,
		time,
		title: thread.title.trim() || "Untitled conversation",
	};
}

function eventRemark(event: InterfaceEvent): RemarkPart[] {
	const parts: RemarkPart[] = [];
	const label = event.label?.trim();
	if (label) {
		parts.push(plain(label));
	}
	if (event.count && event.count > 1) {
		parts.push(plain(`${event.count} runs that day`));
	}
	return parts;
}

/** A past run's remark: a failure is the news; a success says how long it took. */
function pastEventRemark(event: InterfaceEvent): RemarkPart[] {
	if (event.outcome === "failure") {
		return [strong("Run failed")];
	}
	const start = parseTime(event.start);
	const end = parseTime(event.end);
	const parts = [plain("Done")];
	if (start !== null && end !== null && end > start) {
		parts.push(plain(`Ran ${flightDuration(end - start)}`));
	}
	if (event.count && event.count > 1) {
		parts.push(plain(`${event.count} runs that day`));
	}
	return parts;
}

function eventFlight(context: FlightContext, event: InterfaceEvent): Flight {
	const { codes, now, snapshot } = context;
	const past = event.kind === "past";
	const time =
		(past ? parseTime(event.end) : null) ?? parseTime(event.start) ?? now;
	const agentIds = event.agentId ? [event.agentId] : [];
	const code = event.agentId
		? (codes.get(event.agentId) ?? HOUSE_AIRLINE)
		: HOUSE_AIRLINE;
	const remarkParts = past ? pastEventRemark(event) : eventRemark(event);
	let status: FlightStatus = "scheduled";
	if (past) {
		status = event.outcome === "failure" ? "delayed" : "arrived";
	}
	return {
		agentIds,
		board: past ? "arrivals" : "departures",
		departedAt: past ? parseTime(event.start) : null,
		etaAt: null,
		eventId: event.id,
		flightNumber: flightNumber(code, event.id),
		gateAgentId: event.agentId,
		gateLabel: gateLabelFor(snapshot, agentIds),
		key: `event:${event.id}`,
		parked: false,
		quiet: false,
		remark: joinRemark(remarkParts),
		remarkParts,
		schedule: event.label?.trim() || null,
		section: daySection(time, now),
		status,
		terminal: null,
		terminalId: null,
		terminalKind: null,
		threadId: null,
		time,
		title: event.title.trim() || (past ? "Routine run" : "Scheduled run"),
	};
}

/**
 * The latest past run of each routine, so a routine lands once on Arrivals
 * and an old failure does not outlive the success that followed it.
 */
function latestPastRuns(events: readonly InterfaceEvent[]): InterfaceEvent[] {
	const latest = new Map<string, InterfaceEvent>();
	for (const event of events) {
		if (event.kind !== "past") {
			continue;
		}
		const routine = `${event.agentId ?? ""}\u0000${event.title}`;
		const held = latest.get(routine);
		if (!held || Date.parse(event.start) > Date.parse(held.start)) {
			latest.set(routine, event);
		}
	}
	return [...latest.values()];
}

function byTimeThenKey(a: Flight, b: Flight): number {
	return a.time - b.time || a.key.localeCompare(b.key);
}

/**
 * Both boards. Departures run in time order like a real board (earliest
 * first, under a divider for each later day), with boarding flights left from
 * earlier days held at the end; Arrivals put the latest landing first, since
 * conversations pile up there.
 */
export function buildBoards(
	snapshot: InterfaceSnapshot,
	now: number
): DeparturesBoards {
	const context: FlightContext = {
		codes: airlineCodes(snapshot.agents),
		now,
		snapshot,
	};
	const departures: Flight[] = [];
	const arrivals: Flight[] = [];
	for (const thread of snapshot.threads) {
		const flight = threadFlight(context, thread);
		(flight.board === "departures" ? departures : arrivals).push(flight);
	}
	const events = snapshot.events ?? [];
	for (const event of events) {
		if (event.kind === "upcoming") {
			departures.push(eventFlight(context, event));
		}
	}
	for (const event of latestPastRuns(events)) {
		arrivals.push(eventFlight(context, event));
	}
	departures.sort(
		(a, b) =>
			Number(a.section === HELD_SECTION) - Number(b.section === HELD_SECTION) ||
			byTimeThenKey(a, b)
	);
	arrivals.sort((a, b) => byTimeThenKey(b, a));
	return { arrivals, departures };
}

/** Which board shows a thread, so opening one can switch to it. */
export function boardForThread(
	boards: DeparturesBoards,
	threadId: string
): DeparturesBoard | null {
	for (const board of DEPARTURES_BOARDS) {
		if (boards[board].some((flight) => flight.threadId === threadId)) {
			return board;
		}
	}
	return null;
}

export function otherBoard(board: DeparturesBoard): DeparturesBoard {
	return board === "departures" ? "arrivals" : "departures";
}

/** How many flights are in the air, for the board subtitle. */
export function airborneCount(flights: readonly Flight[]): number {
	return flights.filter((flight) => flight.status === "in-flight").length;
}

/**
 * Progress of a flight in the air, 0 to 1, from departure to the estimate.
 * Null without an estimate. Capped below 1 so an overdue flight never reads
 * as landed.
 */
export function flightProgress(flight: Flight, now: number): number | null {
	if (flight.etaAt === null || flight.etaAt <= flight.time) {
		return null;
	}
	const progress = (now - flight.time) / (flight.etaAt - flight.time);
	return Math.min(0.94, Math.max(0.04, progress));
}

/** Next row index for a key press, or null when the key does not move. */
export function nextRowIndex(
	key: string,
	current: number,
	count: number
): number | null {
	if (count === 0) {
		return null;
	}
	switch (key) {
		case "ArrowDown":
			return Math.min(count - 1, current + 1);
		case "ArrowUp":
			return Math.max(0, current - 1);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		case "PageDown":
			return Math.min(count - 1, current + 8);
		case "PageUp":
			return Math.max(0, current - 8);
		default:
			return null;
	}
}

/** The spoken summary of a row, read instead of its tiles. */
export function flightAccessibleName(flight: Flight): string {
	const day =
		flight.section.key === "today" ? "" : `${boardDate(flight.time)} `;
	const parts = [
		`${flight.flightNumber} to ${flight.title}`,
		`${FLIGHT_STATUS_LABELS[flight.status]} ${day}${boardTime(flight.time)}`,
	];
	if (flight.gateLabel) {
		parts.push(`gate ${flight.gateLabel}`);
	}
	if (flight.terminal) {
		parts.push(`terminal ${flight.terminal}`);
	}
	if (flight.remark) {
		parts.push(flight.remark);
	}
	return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Flight details timeline
// ---------------------------------------------------------------------------

export type TimelineState = "current" | "done" | "next";

export interface TimelineStep {
	/** A second line: what the step means, or how long it has lasted. */
	detail: string | null;
	key: string;
	label: string;
	state: TimelineState;
	/** The clock time of the step, with the day when it is not today. */
	time: string | null;
	/** Which lamp colour the step's marker takes. */
	tone: FlightLamp;
}

/** "12:55", or "Mon 5 Oct 12:55" off today. */
export function stampFor(time: number, now: number): string {
	return localDayKey(new Date(time)) === localDayKey(new Date(now))
		? boardTime(time)
		: `${boardDate(time)} ${boardTime(time)}`;
}

/** A finished routine run: when it left, and how it came back. */
function routineRunTimeline(flight: Flight, now: number): TimelineStep[] {
	const steps: TimelineStep[] = [
		{
			detail: flight.schedule,
			key: "departed",
			label: "Departed",
			state: "done",
			time:
				flight.departedAt === null ? null : stampFor(flight.departedAt, now),
			tone: "off",
		},
	];
	if (flight.status === "delayed") {
		steps.push(
			{
				detail: "The run did not finish",
				key: "delayed",
				label: "Delayed",
				state: "current",
				time: stampFor(flight.time, now),
				tone: "alert",
			},
			{
				detail: "Write to the gate to run it again now",
				key: "retry",
				label: "Rebook",
				state: "next",
				time: null,
				tone: "idle",
			}
		);
		return steps;
	}
	steps.push({
		detail: flight.remark || null,
		key: "arrived",
		label: "Arrived",
		state: "done",
		time: stampFor(flight.time, now),
		tone: "off",
	});
	return steps;
}

/**
 * The trip so far, oldest first. Only steps the snapshot can back are timed:
 * a thread carries one timestamp (its last update), so earlier steps are
 * named without a time rather than given an invented one.
 */
export function flightTimeline(flight: Flight, now: number): TimelineStep[] {
	if (flight.eventId !== null && flight.status !== "scheduled") {
		return routineRunTimeline(flight, now);
	}
	const at = stampFor(flight.time, now);
	const elapsed = flightDuration(now - flight.time);
	const gate = flight.gateLabel || null;
	switch (flight.status) {
		case "scheduled":
			return [
				{
					detail: flight.schedule ?? "Runs once",
					key: "scheduled",
					label: "Scheduled",
					state: "done",
					time: null,
					tone: "off",
				},
				{
					detail: "The conversation opens when the run starts",
					key: "departs",
					label: "Departs",
					state: "next",
					time: at,
					tone: "idle",
				},
			];
		case "boarding":
			return [
				{
					detail: "Your message",
					key: "boarded",
					label: "Boarded",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: gate
						? `Waiting for ${gate} · ${elapsed}`
						: "No gate assigned",
					key: "departure",
					label: "Departure",
					state: "current",
					time: null,
					tone: "hold",
				},
			];
		case "in-flight":
			return [
				{
					detail: gate ? `${gate} started the run` : "The run started",
					key: "departed",
					label: "Departed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: elapsed,
					key: "airborne",
					label: "Airborne",
					state: "current",
					time: null,
					tone: "go",
				},
				{
					detail:
						flight.etaAt === null
							? "No finished runs to estimate from yet"
							: "Estimated from recent runs",
					key: "eta",
					label:
						flight.etaAt !== null && flight.etaAt < now ? "Overdue" : "ETA",
					state: "next",
					time:
						flight.etaAt === null ? null : `${boardTime(flight.etaAt)} est.`,
					tone: "idle",
				},
			];
		case "delayed":
			return [
				{
					detail: flight.remark || "The last run did not finish",
					key: "delayed",
					label: "Delayed",
					state: "current",
					time: at,
					tone: "alert",
				},
				{
					detail: "Reply in the conversation to try again",
					key: "retry",
					label: "Rebook",
					state: "next",
					time: null,
					tone: "idle",
				},
			];
		case "landed":
		case "at-gate":
			return [
				{
					detail: gate ? `${gate} replied` : "Reply received",
					key: "landed",
					label: "Landed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: `Waiting on you · ${elapsed}`,
					key: "gate",
					label: "At gate",
					state: "current",
					time: null,
					tone: "hold",
				},
			];
		default:
			if (flight.quiet) {
				// Nothing was sent, so nothing landed: one step, not a landing.
				return [
					{
						detail: "No messages yet",
						key: "not-started",
						label: "Not started",
						state: "current",
						time: at,
						tone: "idle",
					},
				];
			}
			return [
				{
					detail: null,
					key: "landed",
					label: "Landed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: `On the ground ${elapsed}`,
					key: "arrived",
					label: "Arrived",
					state: "done",
					time: null,
					tone: "off",
				},
			];
	}
}
