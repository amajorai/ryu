import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	numberFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
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

/**
 * The wiki's locale: British English for an English UI (the encyclopedia's
 * own style: "14 October 2026", "A, B and C"), else the UI locale.
 */
export function wikiLocale(): string {
	const locale = activeLocale();
	return isEnglishLocale(locale) ? "en-GB" : locale;
}

/** "A", "A and B", "A, B and C" with every item a segment, in the UI locale. */
export function joinSegments(items: WikiSegment[]): WikiSegment[] {
	if (items.length < 2) {
		return items;
	}
	const placeholders = items.map((_, index) => `\u0000${index}\u0000`);
	const parts = new Intl.ListFormat(wikiLocale(), {
		type: "conjunction",
	}).formatToParts(placeholders);
	const out: WikiSegment[] = [];
	for (const part of parts) {
		const index =
			part.type === "element"
				? Number(part.value.replaceAll("\u0000", ""))
				: -1;
		const item = items[index];
		out.push(item ?? text(part.value));
	}
	return out;
}

// Values are data: a "<" inside one must never open a tag.
const ESCAPED_LT = "\uE000";
const TAG = /<([A-Za-z][\w-]*)>([\s\S]*?)<\/\1>/u;

/** Message values with "<" escaped, for `tr()` sources that carry tags. */
export function escapeValues(
	values: Record<string, number | string>
): Record<string, number | string> {
	const escaped: Record<string, number | string> = {};
	for (const [name, value] of Object.entries(values)) {
		escaped[name] =
			typeof value === "string" ? value.replaceAll("<", ESCAPED_LT) : value;
	}
	return escaped;
}

function restore(value: string): string {
	return value.replaceAll(ESCAPED_LT, "<");
}

/** Renderers for the tags of a translated message: each tagged span becomes segments. */
export type SegmentTags = Readonly<
	Record<string, (inner: string) => WikiSegment[]>
>;

/**
 * A translated message (from `tr(source, escapeValues(values))`) as
 * segments: plain text stays text, and each `<tag>…</tag>` is rendered by
 * `tags`, so a translator can move the links and bold words.
 */
export function richSegments(
	message: string,
	tags: SegmentTags
): WikiSegment[] {
	const out: WikiSegment[] = [];
	let rest = message;
	while (rest.length > 0) {
		const match = TAG.exec(rest);
		if (!match) {
			out.push(text(restore(rest)));
			break;
		}
		const [whole, name = "", inner = ""] = match;
		if (match.index > 0) {
			out.push(text(restore(rest.slice(0, match.index))));
		}
		const render = tags[name];
		out.push(...(render ? render(restore(inner)) : [text(restore(whole))]));
		rest = rest.slice(match.index + whole.length);
	}
	return out;
}

/** Plain text of segments, for tests and accessible names. */
export function segmentsText(segments: WikiSegment[]): string {
	return segments.map((segment) => segment.text).join("");
}

/** Counts render as digits, so lists and prose compare at a glance. */
export function countWord(count: number): string {
	return numberFormatter(wikiLocale()).format(count);
}

export type WikiNoun =
	| "agent"
	| "comment"
	| "member"
	| "message"
	| "run"
	| "shared group"
	| "shared thread"
	| "thread";

/** "3 threads", "1 message": a count with its noun, in the UI language. */
export function wikiCount(count: number, noun: WikiNoun): string {
	const values = { count, n: countWord(count) };
	switch (noun) {
		case "agent":
			return tr("{count, plural, one {{n} agent} other {{n} agents}}", values);
		case "comment":
			return tr(
				"{count, plural, one {{n} comment} other {{n} comments}}",
				values
			);
		case "member":
			return tr(
				"{count, plural, one {{n} member} other {{n} members}}",
				values
			);
		case "message":
			return tr(
				"{count, plural, one {{n} message} other {{n} messages}}",
				values
			);
		case "run":
			return tr("{count, plural, one {{n} run} other {{n} runs}}", values);
		case "shared group":
			return tr(
				"{count, plural, one {{n} shared team or project} other {{n} shared teams or projects}}",
				values
			);
		case "shared thread":
			return tr(
				"{count, plural, one {{n} shared thread} other {{n} shared threads}}",
				values
			);
		default:
			return tr(
				"{count, plural, one {{n} thread} other {{n} threads}}",
				values
			);
	}
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
		return tr("at an unknown time");
	}
	let value = (then - now) / 1000;
	if (Math.abs(value) < 45) {
		return tr("just now");
	}
	const relative = relativeTimeFormatter(wikiLocale(), "long", "auto");
	for (const [size, unit] of STEPS) {
		if (Math.abs(Math.round(value)) < size) {
			return relative.format(Math.round(value), unit);
		}
		value /= size;
	}
	return "";
}

/** "14 October 2026" in local time. */
export function wikiDate(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then)
		? ""
		: dateFormatter(wikiLocale(), {
				day: "numeric",
				month: "long",
				year: "numeric",
			}).format(then);
}

/** "14:02" in local time. */
export function wikiTime(iso: string): string {
	const then = Date.parse(iso);
	return Number.isNaN(then)
		? ""
		: dateFormatter(wikiLocale(), {
				hour: "2-digit",
				hour12: false,
				minute: "2-digit",
			}).format(then);
}

/** "14:02, 14 October 2026": the revision timestamp format. */
export function wikiStamp(iso: string): string {
	const day = wikiDate(iso);
	return day ? tr("{time}, {day}", { day, time: wikiTime(iso) }) : "";
}

export function wikiMonthDay(now: number): string {
	return dateFormatter(wikiLocale(), { day: "numeric", month: "long" }).format(
		now
	);
}
