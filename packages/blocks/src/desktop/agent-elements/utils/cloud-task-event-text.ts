// Renders a cloud-task status message (a Ryu Box run or finish, a plan run's
// start reply or result) in the reader's locale.
//
// Core saves each one as an assistant message whose text part is the English
// rendering, plus a `data-ryu-cloud-task` part
// (apps/core/src/server/subscription_cloud/chat_event.rs) carrying the Core
// message sources and their values:
//
//   { kind, prefix?, lead?, messages: Phrase[], ...facts }
//
// where a Phrase is { message: <English ICU source>, args: { name: value } } and
// a value is a verbatim string or a number ({ number, min_fraction,
// max_fraction }, formatted with the reader's separators, or a bare number). `lead` is verbatim text (the agent's own
// summary) and `prefix` a verbatim account tag. A message without the part, or
// with a malformed one, keeps its stored English text.

import { activeLocale, numberFormatter, translate } from "@ryu/i18n/lite";

export const CLOUD_TASK_PART_TYPE = "data-ryu-cloud-task";

/** Translate an English ICU source with values, in the active locale. */
export type CloudTaskTranslate = (
	source: string,
	values: Record<string, string | number>
) => string;

/** Most sentences Core writes for one status message. */
const MAX_MESSAGES = 16;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const fraction = (value: unknown): number =>
	typeof value === "number" && Number.isInteger(value)
		? Math.min(Math.max(value, 0), 6)
		: 0;

/** A value as the message gets it: Core's numbers keep the locale's separators. */
function argValue(value: unknown, locale: string): string | number | null {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (
		isRecord(value) &&
		typeof value.number === "number" &&
		Number.isFinite(value.number)
	) {
		const maximumFractionDigits = fraction(value.max_fraction);
		return numberFormatter(locale, {
			maximumFractionDigits,
			minimumFractionDigits: Math.min(
				fraction(value.min_fraction),
				maximumFractionDigits
			),
		}).format(value.number);
	}
	return null;
}

/** One Core message (`{ message, args }`) in the active locale, or null when malformed. */
export function corePhraseText(
	phrase: unknown,
	tl: CloudTaskTranslate = translate,
	locale: string = activeLocale()
): string | null {
	if (
		!isRecord(phrase) ||
		typeof phrase.message !== "string" ||
		phrase.message === ""
	) {
		return null;
	}
	const values: Record<string, string | number> = {};
	if (phrase.args !== undefined) {
		if (!isRecord(phrase.args)) {
			return null;
		}
		for (const [name, raw] of Object.entries(phrase.args)) {
			const value = argValue(raw, locale);
			if (value === null) {
				return null;
			}
			values[name] = value;
		}
	}
	return tl(phrase.message, values);
}

const optionalText = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value : null;

/** The localized body of one `data-ryu-cloud-task` part's data, or null. */
export function cloudTaskEventText(
	data: unknown,
	tl: CloudTaskTranslate = translate,
	locale: string = activeLocale()
): string | null {
	if (!(isRecord(data) && Array.isArray(data.messages))) {
		return null;
	}
	if (data.messages.length > MAX_MESSAGES) {
		return null;
	}
	const paragraphs: string[] = [];
	const lead = optionalText(data.lead);
	if (lead) {
		paragraphs.push(lead);
	}
	for (const phrase of data.messages) {
		const sentence = corePhraseText(phrase, tl, locale);
		if (sentence === null) {
			return null;
		}
		paragraphs.push(sentence);
	}
	if (paragraphs.length === 0) {
		return null;
	}
	const body = paragraphs.join("\n\n");
	const prefix = optionalText(data.prefix);
	return prefix ? `${prefix}: ${body}` : body;
}

interface PartLike {
	data?: unknown;
	text?: unknown;
	type?: unknown;
}

/**
 * A message's parts with a cloud-task status rendered in the reader's locale:
 * the stored English text parts are replaced by one text part holding the
 * localized body. Parts without a (valid) status part come back unchanged, so
 * the memo that calls this keeps its identity.
 */
export function localizeCloudTaskParts<Part>(
	parts: Part[],
	tl: CloudTaskTranslate = translate,
	locale: string = activeLocale()
): Part[] {
	const event = parts.find(
		(part) => isRecord(part) && (part as PartLike).type === CLOUD_TASK_PART_TYPE
	) as PartLike | undefined;
	if (!event) {
		return parts;
	}
	const text = cloudTaskEventText(event.data, tl, locale);
	if (text === null) {
		// Keep the English text part; drop only the part nothing renders.
		return parts.filter((part) => part !== (event as unknown));
	}
	const localized = { text, type: "text" } as unknown as Part;
	const out: Part[] = [];
	for (const part of parts) {
		if (part === (event as unknown)) {
			out.push(localized);
		} else if (!(isRecord(part) && (part as PartLike).type === "text")) {
			out.push(part);
		}
	}
	return out;
}
