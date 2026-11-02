// Renders a failed turn's error card (Core's persisted `error` part) in the
// reader's locale from the Core messages it carries in `i18n`
// (apps/core/src/sidecar/adapters/acp/failure_usage.rs writes them). A part
// without them (a row from an older Core) or with a malformed message keeps
// its stored English title and message.
//
// Wire shape (Core's `AlertText`):
//   { title: Phrase, body: Phrase[], join: "sentences" | "lines" }
// where a Phrase is { message: <English ICU source>, args: { name: value } }
// and a value is a verbatim string (an error chain, a command name) or a
// number. An empty body means the stored message is a relayed raw error.

import { activeLocale, translate } from "@ryu/i18n/lite";

/** Translate an English ICU source with values, in the active locale. */
export type CoreErrorTranslate = (
	source: string,
	values: Record<string, string | number>
) => string;

export interface LocalizedCoreError {
	message: string;
	title: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Most body messages Core writes for one card. */
const MAX_BODY = 32;

function renderPhrase(phrase: unknown, tl: CoreErrorTranslate): string | null {
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
		for (const [name, value] of Object.entries(phrase.args)) {
			if (typeof value !== "string" && typeof value !== "number") {
				return null;
			}
			values[name] = value;
		}
	}
	return tl(phrase.message, values);
}

/** Japanese and Simplified Chinese join sentences without a space, like Core. */
function sentenceSeparator(locale: string, previous: string): string {
	// A sentence still in English (no translation yet) keeps its space.
	const asciiEnd = previous.charCodeAt(previous.length - 1) < 128;
	return !asciiEnd && /^(ja\b|zh(-(cn|hans|sg)\b|$))/iu.test(locale) ? "" : " ";
}

function renderBody(
	body: unknown,
	join: unknown,
	tl: CoreErrorTranslate,
	locale: string
): string | null {
	if (!Array.isArray(body) || body.length === 0 || body.length > MAX_BODY) {
		return null;
	}
	let out = "";
	for (const phrase of body) {
		const sentence = renderPhrase(phrase, tl);
		if (sentence === null) {
			return null;
		}
		if (out !== "") {
			out += join === "lines" ? "\n" : sentenceSeparator(locale, out);
		}
		out += sentence;
	}
	return out;
}

const defaultTranslate: CoreErrorTranslate = (source, values) =>
	translate(source, values);

/**
 * The error card's title and message in the active locale, each falling back
 * to the stored English when its messages are missing or malformed.
 */
export function localizeCoreError(
	part: { i18n?: unknown; message: string; title?: string },
	tl: CoreErrorTranslate = defaultTranslate,
	locale: string = activeLocale()
): LocalizedCoreError {
	const wire = part.i18n;
	if (!isRecord(wire)) {
		return { message: part.message, title: part.title };
	}
	return {
		message: renderBody(wire.body, wire.join, tl, locale) ?? part.message,
		title: renderPhrase(wire.title, tl) ?? part.title,
	};
}
