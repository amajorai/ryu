// The ask and blocker halves of the interface act parts: what
// `askAriaLabel`, `blockerAriaLabel` and `askBubble` word, as data.
// Re-exported from `interface-act-parts.ts`.

import {
	ACT_MAX_RISK_TAGS,
	ACT_SHORT_LINE_WORDS,
	ACT_TOOL_VERBS,
	ACT_TRAILING_STOP,
	actCalendarDay,
	actClampWords,
	actIsToolCallWithTarget,
	actParseMs,
	actPlainText,
	type ClockOptions,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceBlockerKind,
	isSuggestion,
	riskTagLabel,
} from "./interfaces.ts";

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** The words that name an ask under redaction (`askKindWords`). */
export type AskKindKey =
	| "approval"
	| "input"
	| "permission"
	| "question"
	| "reply"
	| "suggestion";

/** Which sentence an ask's accessible name uses. */
export type AskAriaVariant =
	| "async-question"
	| "blocking"
	| "reply"
	| "suggestion";

/** A whole duration: minutes, hours or days; null value reads "less than a minute". */
export interface ActDuration {
	unit: "day" | "hour" | "minute";
	value: number;
}

export interface AskAriaParts {
	kind: AskKindKey;
	/** The agent's name; null reads as the Inbox. */
	name: string | null;
	redacted: boolean;
	/** Display risk tags, at most two. */
	riskTags: string[];
	/** The target of a tool_call approval (never under redaction). */
	target: string | null;
	/** The ask's own words without markdown; null under redaction or when empty. */
	text: string | null;
	untilApprox: boolean;
	/** Milliseconds until the ask expires, or null with no deadline. */
	untilMs: number | null;
	variant: AskAriaVariant;
	waitApprox: boolean;
	/** Milliseconds the ask has waited, or null with no start. */
	waitMs: number | null;
}

export interface BlockerAriaParts {
	agoApprox: boolean;
	/** Milliseconds since the failure, or null when unknown. */
	agoMs: number | null;
	clearsAt: string | null;
	/** An inferred blocker reads "stopped, likely …". */
	estimate: boolean;
	kind: InterfaceBlockerKind;
	name: string;
	/** The blocker's title without its trailing stop; null under redaction or when empty. */
	title: string | null;
}

/** A one-line bubble: what an agent or ask shows above a villager. */
export type ActLineParts =
	| { kind: "kind-words"; key: AskKindKey }
	| { kind: "run-target"; target: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; rest: string; verb: string };

/**
 * Whole minutes, hours or days, as `waitLabel` counts them: ages round down
 * (never overstate a wait), countdowns round up. Null under a minute.
 */
export function actDuration(ms: number, roundUp: boolean): ActDuration | null {
	const round = roundUp ? Math.ceil : Math.floor;
	const minutes = round(Math.max(0, ms) / MINUTE_MS);
	if (minutes < 1) {
		return null;
	}
	if (minutes >= MINUTES_PER_DAY) {
		return { unit: "day", value: round(minutes / MINUTES_PER_DAY) };
	}
	if (minutes >= MINUTES_PER_HOUR) {
		const hours = round(minutes / MINUTES_PER_HOUR);
		return hours >= 24
			? { unit: "day", value: 1 }
			: { unit: "hour", value: hours };
	}
	return { unit: "minute", value: minutes };
}

/** Calendar days from `nowMs` to `iso` in the clock's time zone (0 today, 1 tomorrow). */
export function actDayOffset(
	iso: string,
	nowMs: number,
	clock?: ClockOptions
): number | null {
	const at = actParseMs(iso);
	if (at === null) {
		return null;
	}
	return (
		actCalendarDay(at, clock?.timeZone) - actCalendarDay(nowMs, clock?.timeZone)
	);
}

export function askKindKey(ask: InterfaceAsk): AskKindKey {
	if (isSuggestion(ask)) {
		return "suggestion";
	}
	switch (ask.kind) {
		case "approval":
		case "question":
		case "permission":
		case "input":
			return ask.kind;
		default:
			return "reply";
	}
}

export function actMsSince(
	iso: string | null | undefined,
	nowMs: number
): number | null {
	const at = actParseMs(iso);
	return at === null ? null : nowMs - at;
}

function askVariant(ask: InterfaceAsk): AskAriaVariant {
	if (ask.kind === "reply") {
		return "reply";
	}
	if (!ask.blocking) {
		return ask.kind === "question" ? "async-question" : "suggestion";
	}
	return "blocking";
}

/** The parts of `askAriaLabel`. */
export function askAriaParts(
	ask: InterfaceAsk,
	agentName: string | null,
	nowMs: number,
	privacy?: "full" | "redacted"
): AskAriaParts {
	const redacted = privacy === "redacted";
	const text = redacted ? "" : actPlainText(ask.text);
	const until = ask.expiresAt ? actParseMs(ask.expiresAt) : null;
	return {
		kind: askKindKey(ask),
		name: agentName,
		redacted,
		riskTags: (ask.riskTags ?? [])
			.slice(0, ACT_MAX_RISK_TAGS)
			.map(riskTagLabel)
			.filter(Boolean),
		target:
			!redacted && actIsToolCallWithTarget(ask)
				? actPlainText(ask.target)
				: null,
		text: text || null,
		untilApprox: ask.expiresApprox === true,
		untilMs: until === null ? null : until - nowMs,
		variant: askVariant(ask),
		waitApprox: ask.sinceApprox === true,
		waitMs: actMsSince(ask.since, nowMs),
	};
}

/** The parts of `blockerAriaLabel`. */
export function blockerAriaParts(
	blocker: InterfaceBlocker,
	agentName: string,
	nowMs: number,
	privacy?: "full" | "redacted"
): BlockerAriaParts {
	const redacted = privacy === "redacted";
	const title = redacted
		? ""
		: actPlainText(blocker.title).replace(ACT_TRAILING_STOP, "");
	return {
		agoApprox: blocker.atApprox === true,
		agoMs: actMsSince(blocker.at ?? null, nowMs),
		clearsAt: blocker.clearsAt ?? null,
		estimate: blocker.source === "estimate",
		kind: blocker.kind,
		name: agentName,
		title: title || null,
	};
}

/**
 * The parts of `shortLine`: a "Tool: target" label leads with its verb, any
 * other text is only clamped to `maxWords`.
 */
export function actLineParts(
	text: string,
	maxWords = ACT_SHORT_LINE_WORDS,
	colonOptional = false
): ActLineParts | null {
	const words = actPlainText(text).split(" ").filter(Boolean);
	const lead = words[0];
	if (lead && words.length > 1 && (colonOptional || lead.endsWith(":"))) {
		const tool = lead.replace(/:$/, "");
		if (ACT_TOOL_VERBS.has(tool)) {
			return {
				kind: "tool",
				rest: actClampWords(words.slice(1), maxWords - 1),
				verb: tool,
			};
		}
	}
	return words.length > 0
		? { kind: "text", text: actClampWords(words, maxWords) }
		: null;
}

/** The parts of `askBubble`. */
export function askBubbleParts(
	ask: InterfaceAsk,
	privacy?: "full" | "redacted"
): ActLineParts {
	if (privacy === "redacted") {
		return { kind: "kind-words", key: askKindKey(ask) };
	}
	if (actIsToolCallWithTarget(ask)) {
		const words = actPlainText(ask.target).split(" ").filter(Boolean);
		return {
			kind: "run-target",
			target: actClampWords(words, ACT_SHORT_LINE_WORDS - 1),
		};
	}
	return actLineParts(ask.text) ?? { kind: "kind-words", key: askKindKey(ask) };
}
