import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { type WikiRoute, wikiThreadTitle } from "./wiki-model-routes.ts";

// ---------------------------------------------------------------------------
// Prose: rich text as segments, so the view can render real links
// ---------------------------------------------------------------------------

export type WikiSegment =
	| { kind: "bold"; text: string }
	| { kind: "link"; route: WikiRoute; text: string; bold?: boolean }
	| { kind: "text"; text: string };

export const text = (value: string): WikiSegment => ({
	kind: "text",
	text: value,
});
export const bold = (value: string): WikiSegment => ({
	kind: "bold",
	text: value,
});
export const link = (
	route: WikiRoute,
	value: string,
	strong = false
): WikiSegment => ({ bold: strong, kind: "link", route, text: value });

export function agentLink(agent: InterfaceAgent): WikiSegment {
	return link({ id: agent.id, kind: "agent" }, agent.name);
}

export function groupLink(group: InterfaceGroup): WikiSegment {
	return link({ id: group.id, kind: "group" }, group.name);
}

export function threadLink(
	thread: InterfaceThread,
	strong = false
): WikiSegment {
	return link(
		{ id: thread.id, kind: "thread" },
		wikiThreadTitle(thread),
		strong
	);
}

/** "A", "A and B", "A, B and C" with every item a segment. */
export function joinSegments(items: WikiSegment[]): WikiSegment[] {
	const out: WikiSegment[] = [];
	for (const [index, item] of items.entries()) {
		if (index > 0) {
			out.push(text(index === items.length - 1 ? " and " : ", "));
		}
		out.push(item);
	}
	return out;
}

/** Plain text of segments, for tests and accessible names. */
export function segmentsText(segments: WikiSegment[]): string {
	return segments.map((segment) => segment.text).join("");
}

/** Counts render as digits, so lists and prose compare at a glance. */
export function countWord(count: number): string {
	return count.toLocaleString("en");
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${countWord(count)} ${count === 1 ? one : many}`;
}

/** "Digs through papers" -> "digs through papers" (keeps acronyms). */
export function lowerFirst(value: string): string {
	const trimmed = value.trim().replace(/[.\s]+$/, "");
	if (trimmed.length < 2 || trimmed[1] === trimmed[1]?.toUpperCase()) {
		return trimmed;
	}
	return `${trimmed[0]?.toLowerCase() ?? ""}${trimmed.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
	[60, "second"],
	[60, "minute"],
	[24, "hour"],
	[7, "day"],
	[4.345, "week"],
	[12, "month"],
	[Number.POSITIVE_INFINITY, "year"],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function wikiAgo(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "at an unknown time";
	}
	let value = (then - now) / 1000;
	if (Math.abs(value) < 45) {
		return "just now";
	}
	for (const [size, unit] of STEPS) {
		if (Math.abs(Math.round(value)) < size) {
			return RELATIVE.format(Math.round(value), unit);
		}
		value /= size;
	}
	return "";
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
});
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
});

/** "14 October 2026" in local time. */
export function wikiDate(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? "" : DAY_FORMAT.format(then);
}

/** "14:02" in local time. */
export function wikiTime(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then) ? "" : TIME_FORMAT.format(then);
}

/** "14:02, 14 October 2026": the revision timestamp format. */
export function wikiStamp(iso: string): string {
	const day = wikiDate(iso);
	return day ? `${wikiTime(iso)}, ${day}` : "";
}

export function wikiMonthDay(now: number): string {
	return MONTH_DAY_FORMAT.format(now);
}
