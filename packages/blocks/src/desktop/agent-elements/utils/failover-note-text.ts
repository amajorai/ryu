// Renders a reactive-failover note (`data-ryu-failover`) in the reader's locale.
//
// Core sends the verdict with `note`, its sentences already rendered in the
// node's language, and `messages`: the same sentences as Core messages
// (`{ message: <English ICU source>, args }`, see
// apps/core/src/routing_policy/reactive/note.rs). A `wait` verdict's `time` and
// `date` arguments are the node's local clock; they are rewritten here from the
// verdict's RFC3339 `resets_at`, in the reader's own locale and time zone.
// Anything malformed returns null, and the caller shows Core's `note`.

import { activeLocale, dateFormatter, translate } from "@ryu/i18n/lite";
import {
	type CloudTaskTranslate,
	corePhraseText,
} from "./cloud-task-event-text.ts";
import { getFailoverNote } from "./live-message-flags.ts";
import type { NativeSdkValue } from "./native-sdk-observation.ts";

export const FAILOVER_PART_TYPE = "data-ryu-failover";

/** Most sentences one failover note holds. */
const MAX_SENTENCES = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The reset instant's `time` and `date` arguments, in the reader's locale. */
function resetArgs(
	resetsAt: unknown,
	locale: string
): { date: string; time: string } | null {
	if (typeof resetsAt !== "string") {
		return null;
	}
	const instant = new Date(resetsAt);
	if (Number.isNaN(instant.getTime())) {
		return null;
	}
	return {
		date: dateFormatter(locale, {
			day: "numeric",
			month: "long",
			weekday: "long",
		}).format(instant),
		time: dateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(
			instant
		),
	};
}

/** One sentence, with the reset time swapped in when it names one. */
function sentenceText(
	phrase: unknown,
	reset: { date: string; time: string } | null,
	tl: CloudTaskTranslate,
	locale: string
): string | null {
	if (!(isRecord(phrase) && isRecord(phrase.args))) {
		return corePhraseText(phrase, tl, locale);
	}
	const { args } = phrase;
	if (!("date" in args || "time" in args)) {
		return corePhraseText(phrase, tl, locale);
	}
	if (!reset) {
		return null;
	}
	return corePhraseText(
		{ ...phrase, args: { ...args, date: reset.date, time: reset.time } },
		tl,
		locale
	);
}

/** Japanese and Chinese join sentences with no space. */
const joinsWithoutSpace = (locale: string): boolean =>
	/^(ja|zh)\b/i.test(locale);

/** The localized note of one `data-ryu-failover` part, or null. */
export function failoverNoteText(
	part: unknown,
	tl: CloudTaskTranslate = translate,
	locale: string = activeLocale()
): string | null {
	if (!isRecord(part) || part.type !== FAILOVER_PART_TYPE) {
		return null;
	}
	const { data } = part;
	if (!(isRecord(data) && Array.isArray(data.messages))) {
		return null;
	}
	const { messages } = data;
	if (messages.length === 0 || messages.length > MAX_SENTENCES) {
		return null;
	}
	const reset = resetArgs(data.resets_at, locale);
	let note = "";
	for (const phrase of messages) {
		const sentence = sentenceText(phrase, reset, tl, locale);
		if (sentence === null) {
			return null;
		}
		if (note) {
			// A sentence still in English keeps its space, even in Japanese.
			const ascii = /[ -~]$/.test(note);
			note += ascii || !joinsWithoutSpace(locale) ? " " : "";
		}
		note += sentence;
	}
	return note.trim() ? note : null;
}

/**
 * The text of the failover Marker for `part`: the note in the reader's locale,
 * else Core's own `note`. Null when `part` is not a failover verdict.
 */
export function failoverMarkerText(
	part: NativeSdkValue,
	locale: string | null | undefined
): string | null {
	const fallback = getFailoverNote(part);
	if (fallback === null) {
		return null;
	}
	return (
		failoverNoteText(part, translate, locale ?? activeLocale()) ?? fallback
	);
}
