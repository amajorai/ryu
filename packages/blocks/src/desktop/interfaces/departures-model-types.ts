/** Departures view model: board, status, and flight types and constants. */

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

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

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
