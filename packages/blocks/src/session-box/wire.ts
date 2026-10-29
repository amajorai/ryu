// packages/blocks/src/session-box/wire.ts
//
// The wire shapes of Core's session Box routes, shared by the desktop and web
// clients: `GET /api/session-boxes/{id}` (status, cost, caps),
// `POST /api/session-boxes/{id}/screen` (a screen grant) and
// `POST /api/session-boxes/{id}/cost-notice` (the one-time acknowledgement of
// the computer-use Box cost). `CloudTaskStatus.box` carries the same view.
//
// Every status field is parsed optional-tolerant. An older Core that predates a
// field (or the whole `box` object) still parses, and an unknown enum value
// degrades to `null` instead of hiding a panel. A malformed top-level body is
// still an error. Screen grants are strict: a direct grant must be an absolute
// WebSocket URL (a relative one is never resolved against the page), and a
// relay grant must name a session-box relay path.

export type SessionBoxSize = "small" | "default" | "large";
export type SessionBoxState =
	| "provisioning"
	| "ready"
	| "parked"
	| "stopped"
	| "error";
export type SessionBoxSource = "cloud_task" | "session" | "sub_agent";
export type SessionBoxWarning = "none" | "low" | "critical";
/** Why a Box stopped or parked. Unknown future reasons stay readable as text. */
export type SessionBoxStopReason =
	| "user"
	| "idle"
	| "ttl"
	| "balance"
	| "budget"
	| "accounting"
	| "liveness"
	| "suspended"
	| "restart";

export interface SessionBoxPlacement {
	isolation: string | null;
	location: string | null;
	provider: string | null;
	tier: string | null;
}

export interface SessionBoxDesktop {
	ready: boolean;
	viewers: number;
}

/** One Box as the session UI shows it (shared with `CloudTaskStatus.box`). */
export interface SessionBoxView {
	accruedMicroUsd: number | null;
	balanceMicroUsd: number | null;
	/** Sub-agent child number, for a child Box. */
	child: number | null;
	desktop: SessionBoxDesktop | null;
	/** When a live Box is parked for its lifetime. */
	expiresAt: string | null;
	id: string | null;
	minutesRemaining: number | null;
	placement: SessionBoxPlacement | null;
	ratePerHourMicroUsd: number | null;
	runningSeconds: number | null;
	runningSince: string | null;
	size: SessionBoxSize | null;
	source: SessionBoxSource | null;
	/** Null only when Core sent a state this build does not know. */
	state: SessionBoxState | null;
	stopReason: string | null;
	warning: SessionBoxWarning;
}

/** The owner's running Boxes against the plan cap. */
export interface SessionBoxCaps {
	max: number | null;
	running: number;
}

/**
 * The one-time computer-use cost notice: a Box of this conversation waits
 * until the owner acknowledges its hourly cost (Core refuses it with
 * `session_box_cost_notice_required` until then).
 */
export interface SessionBoxCostNotice {
	/**
	 * Each start (and each resume of a parked Box) bills at least this many
	 * seconds; after it, whole minutes.
	 */
	minimumSecondsPerStart: number;
	/** The Gateway's live hourly rate, micro-USD; null when it is unknown. */
	ratePerHourMicroUsd: number | null;
	size: SessionBoxSize | null;
	/**
	 * A computer-use call is held for the answer: allowing the cost starts the
	 * Box and the turn goes on. False once that call gave up.
	 */
	waiting: boolean;
}

/**
 * The published per-start minimum (5 minutes), used when an older Core leaves
 * `minimumSecondsPerStart` out of the notice.
 */
export const DEFAULT_MINIMUM_SECONDS_PER_START = 300;

export interface SessionBoxStatus {
	box: SessionBoxView | null;
	caps: SessionBoxCaps | null;
	children: SessionBoxView[];
	conversationId: string;
	/** Present while a Box waits for the one-time cost acknowledgement. */
	costNotice: SessionBoxCostNotice | null;
}

/** The refusal code Core answers a Box that waits for the cost notice with. */
export const COST_NOTICE_REQUIRED_CODE = "session_box_cost_notice_required";

/** How a viewer reaches a Box screen. */
export type DesktopGrant =
	| {
			expiresAt: string | null;
			mode: "direct";
			protocols: string[];
			url: string;
	  }
	| {
			expiresAt: string | null;
			mode: "relay";
			path: string;
			protocols: string[];
	  };

/** A dialable screen endpoint for `VncCanvas`. */
export interface SessionBoxEndpoint {
	protocols: string[];
	url: string;
}

const SIZES: readonly SessionBoxSize[] = ["small", "default", "large"];
const STATES: readonly SessionBoxState[] = [
	"provisioning",
	"ready",
	"parked",
	"stopped",
	"error",
];
const SOURCES: readonly SessionBoxSource[] = [
	"cloud_task",
	"session",
	"sub_agent",
];
const WARNINGS: readonly SessionBoxWarning[] = ["none", "low", "critical"];
const RELAY_PATH = /^\/api\/session-boxes\/[^?#]+\/screen\/ws$/;

function invalid(what: string): never {
	throw new Error(`Invalid session Box response: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optStr(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function optNum(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optCount(value: unknown): number | null {
	const parsed = optNum(value);
	return parsed !== null && Number.isInteger(parsed) && parsed >= 0
		? parsed
		: null;
}

function optOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[]
): T | null {
	return allowed.find((candidate) => candidate === value) ?? null;
}

function parsePlacement(value: unknown): SessionBoxPlacement | null {
	if (!isRecord(value)) {
		return null;
	}
	return {
		provider: optStr(value.provider),
		location: optStr(value.location),
		tier: optStr(value.tier),
		isolation: optStr(value.isolation),
	};
}

function parseDesktop(value: unknown): SessionBoxDesktop | null {
	if (!isRecord(value)) {
		return null;
	}
	return {
		ready: value.ready === true,
		viewers: optCount(value.viewers) ?? 0,
	};
}

/**
 * Parse one `SessionBoxView`. Returns null for a missing (`null`/absent) Box
 * and throws only when the value is present but not an object.
 */
export function parseSessionBoxView(value: unknown): SessionBoxView | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (!isRecord(value)) {
		invalid("box is not an object");
	}
	return {
		id: optStr(value.id),
		size: optOneOf(value.size, SIZES),
		state: optOneOf(value.state, STATES),
		source: optOneOf(value.source, SOURCES),
		child: optCount(value.child),
		placement: parsePlacement(value.placement),
		desktop: parseDesktop(value.desktop),
		runningSince: optStr(value.runningSince),
		runningSeconds: optCount(value.runningSeconds),
		accruedMicroUsd: optCount(value.accruedMicroUsd),
		ratePerHourMicroUsd: optCount(value.ratePerHourMicroUsd),
		balanceMicroUsd: optNum(value.balanceMicroUsd),
		minutesRemaining: optCount(value.minutesRemaining),
		warning: optOneOf(value.warning, WARNINGS) ?? "none",
		stopReason: optStr(value.stopReason),
		expiresAt: optStr(value.expiresAt),
	};
}

/** Parse optional caps; absent or malformed caps read as null. */
export function parseSessionBoxCaps(value: unknown): SessionBoxCaps | null {
	if (!isRecord(value)) {
		return null;
	}
	const running = optCount(value.running);
	if (running === null) {
		return null;
	}
	return { running, max: optCount(value.max) };
}

/** Parse the optional cost notice; anything but a required notice reads as null. */
export function parseSessionBoxCostNotice(
	value: unknown
): SessionBoxCostNotice | null {
	if (!isRecord(value) || value.required !== true) {
		return null;
	}
	const rate = optCount(value.ratePerHourMicroUsd);
	const minimum = optCount(value.minimumSecondsPerStart);
	return {
		minimumSecondsPerStart:
			minimum !== null && minimum > 0
				? minimum
				: DEFAULT_MINIMUM_SECONDS_PER_START,
		ratePerHourMicroUsd: rate !== null && rate > 0 ? rate : null,
		size: optOneOf(value.size, SIZES),
		waiting: value.waiting === true,
	};
}

/**
 * An hourly rate in micro-USD as dollars with at least cents and no trailing
 * zeros past them: `25000` is `$0.025`, `40000` is `$0.04`.
 */
export function formatHourlyRate(microUsd: number): string {
	const whole = Math.floor(microUsd / 1_000_000);
	const fraction = String(microUsd % 1_000_000)
		.padStart(6, "0")
		.replace(/0+$/, "")
		.padEnd(2, "0");
	return `$${whole}.${fraction}`;
}

const SIZE_SPECS: Record<SessionBoxSize, string> = {
	small: "2 vCPU, 4 GB",
	default: "4 vCPU, 8 GB",
	large: "8 vCPU, 16 GB",
};

/** `5-minute`, `90-second`: a per-start minimum as a compound adjective. */
export function minimumStartWords(seconds: number): string {
	return seconds % 60 === 0 && seconds > 0
		? `${seconds / 60}-minute`
		: `${seconds}-second`;
}

/** The notice's heading: what starts, at what rate, with the minimum. */
export function costNoticeHeading(notice: SessionBoxCostNotice): string {
	const minimum = minimumStartWords(notice.minimumSecondsPerStart);
	return notice.ratePerHourMicroUsd === null
		? "Computer use starts a paid cloud Box"
		: `Computer use starts a cloud Box at ${formatHourlyRate(notice.ratePerHourMicroUsd)}/hour, ${minimum} minimum per start`;
}

/** The notice's sentence about what starts and what it costs. */
export function costNoticeText(notice: SessionBoxCostNotice): string {
	const size = notice.size ?? "small";
	const box = `a cloud Box of its own (${size}: ${SIZE_SPECS[size]})`;
	const cost =
		notice.ratePerHourMicroUsd === null
			? "Ryu could not read its hourly rate right now"
			: `it costs ${formatHourlyRate(notice.ratePerHourMicroUsd)} an hour while it runs, from your credits`;
	const minimum = minimumStartWords(notice.minimumSecondsPerStart);
	return `Computer use and the browser run on ${box}, and ${cost}. Time is billed in whole minutes with a ${minimum} minimum each time the Box starts; a resume within the hour already paid owes no new minimum. It parks when idle and stops when credits run out. Ryu asks once.`;
}

/**
 * `GET /api/session-boxes/cost-notice`: the caller's own acknowledgement of
 * the computer-use Box cost, which a settings screen can give ahead of any
 * conversation (a routine's run has nobody to answer the notice).
 */
export interface SessionBoxCostNoticeState {
	acknowledged: boolean;
	acknowledgedAt: string | null;
	minimumSecondsPerStart: number;
	ratePerHourMicroUsd: number | null;
	size: SessionBoxSize | null;
}

/** Validate a `GET /api/session-boxes/cost-notice` body. */
export function parseSessionBoxCostNoticeState(
	value: unknown
): SessionBoxCostNoticeState {
	if (!isRecord(value) || typeof value.acknowledged !== "boolean") {
		invalid("cost notice state has no acknowledged flag");
	}
	const notice = parseSessionBoxCostNotice({ ...value, required: true });
	return {
		acknowledged: value.acknowledged,
		acknowledgedAt: optStr(value.acknowledgedAt),
		minimumSecondsPerStart:
			notice?.minimumSecondsPerStart ?? DEFAULT_MINIMUM_SECONDS_PER_START,
		ratePerHourMicroUsd: notice?.ratePerHourMicroUsd ?? null,
		size: notice?.size ?? null,
	};
}

/** Validate a `GET /api/session-boxes/{id}` body. */
export function parseSessionBoxStatus(value: unknown): SessionBoxStatus {
	if (!isRecord(value)) {
		invalid("status is not an object");
	}
	const conversationId = optStr(value.conversationId);
	if (!conversationId) {
		invalid("conversationId is missing");
	}
	const children = Array.isArray(value.children)
		? value.children.flatMap((child) => {
				const parsed = isRecord(child) ? parseSessionBoxView(child) : null;
				return parsed ? [parsed] : [];
			})
		: [];
	return {
		conversationId,
		box: parseSessionBoxView(value.box),
		children,
		caps: parseSessionBoxCaps(value.caps),
		costNotice: parseSessionBoxCostNotice(value.costNotice),
	};
}

function parseProtocols(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(protocol): protocol is string =>
			typeof protocol === "string" && protocol.length > 0
	);
}

/**
 * Validate a `POST /api/session-boxes/{id}/screen` body. A direct grant must
 * carry an absolute `wss:` (or loopback `ws:`) URL; a relative one is never
 * resolved against the page. A relay grant must name a session-box relay path.
 */
export function parseDesktopGrant(value: unknown): DesktopGrant {
	if (!isRecord(value)) {
		invalid("screen grant is not an object");
	}
	const expiresAt = optStr(value.expiresAt);
	const protocols = parseProtocols(value.protocols);
	if (value.mode === "direct") {
		const url = optStr(value.url);
		if (!url) {
			invalid("direct grant has no url");
		}
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			invalid("direct grant url is not absolute");
		}
		if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
			invalid("direct grant url is not a WebSocket URL");
		}
		if (parsed.username || parsed.password) {
			invalid("direct grant url carries credentials");
		}
		return { mode: "direct", url, protocols, expiresAt };
	}
	if (value.mode === "relay") {
		const path = optStr(value.path);
		if (!(path && RELAY_PATH.test(path))) {
			invalid("relay grant has no session-box path");
		}
		return { mode: "relay", path, protocols, expiresAt };
	}
	return invalid("unknown screen grant mode");
}

/** The route segment for a Box: the conversation, or `<id>#sub:<n>` for a child. */
export function sessionBoxKey(conversationId: string, child?: number | null) {
	return child === null || child === undefined
		? conversationId
		: `${conversationId}#sub:${child}`;
}

/** The new deadline from a `POST …/extend` answer, or null. */
export function parseExtendedDeadline(value: unknown): string | null {
	return isRecord(value) ? optStr(value.expiresAt) : null;
}

/** Readable text for a session Box refusal, by Core's error code. */
export function sessionBoxRefusalText(code: string | undefined): string | null {
	switch (code) {
		case "session_box_limit_reached":
			return "Your plan's Box limit is reached. Stop another session's Box to start this one.";
		case "session_box_insufficient_credits":
			return "Not enough credits to run a Box. Top up to continue.";
		case "session_box_capacity":
		case "cloud_task_capacity":
			return "No Box capacity right now. Try again in a minute.";
		case "session_box_forbidden":
			return "This Box belongs to another person in this conversation.";
		case "session_box_not_found":
			return "This conversation has no Box.";
		case "session_box_not_live":
			return "This session's Box is parked. Ask for its screen again to resume it.";
		case COST_NOTICE_REQUIRED_CODE:
			return "Computer use starts a paid cloud Box. Review its hourly cost in this conversation and allow it first.";
		case "session_box_rate_changed":
			return "The Box rate changed. Review the new rate and allow it again.";
		case "session_box_rate_unavailable":
			return "Ryu could not read the Box rate. Try again shortly.";
		default:
			return null;
	}
}
