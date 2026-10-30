import {
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	airlineCodes,
	boardDate,
	boardTime,
	flightDuration,
	flightNumber,
	HOUSE_AIRLINE,
	parseTime,
	relativeDay,
	shortDate,
	typicalFlightMs,
} from "./departures-model-format.ts";
import {
	AT_GATE_WINDOW_MS,
	type BoardSection,
	DEPARTURES_BOARDS,
	type DeparturesBoard,
	type DeparturesBoards,
	FLIGHT_STATUS_LABELS,
	type Flight,
	type FlightStatus,
	LANDED_WINDOW_MS,
	type RemarkPart,
} from "./departures-model-types.ts";

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

export {
	airlineCodes,
	boardDate,
	boardTime,
	flightDuration,
	flightNumber,
	HOUSE_AIRLINE,
	relativeDay,
	shortDate,
	typicalFlightMs,
} from "./departures-model-format.ts";
export {
	flightTimeline,
	stampFor,
	type TimelineState,
	type TimelineStep,
} from "./departures-model-timeline.ts";
export {
	AT_GATE_WINDOW_MS,
	BLINKING_STATUSES,
	BOARD_LABELS,
	type BoardSection,
	DEPARTURES_BOARDS,
	type DeparturesBoard,
	type DeparturesBoards,
	FLIGHT_LAMPS,
	FLIGHT_STATUS_CODES,
	FLIGHT_STATUS_LABELS,
	type Flight,
	type FlightLamp,
	type FlightStatus,
	LANDED_WINDOW_MS,
	type RemarkPart,
	STATUS_FLAP_LENGTH,
} from "./departures-model-types.ts";

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
