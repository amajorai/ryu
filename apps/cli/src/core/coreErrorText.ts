// A failed turn's error text in the CLI's locale.
//
// Core persists a failed ACP turn as an `error` part carrying its English
// `title`/`message` plus `i18n`, the Core messages behind them
// (apps/core/src/sidecar/adapters/acp/failure_usage.rs writes them). The live
// stream's `error` frame carries only the English body. This renders the
// `i18n` wire through the CLI catalog when it is present and well formed, and
// otherwise looks the English body up as a literal, so a static Core message
// still translates while an unknown or raw error stays as written.
//
// Wire shape (Core's `AlertText`):
//   { title: Phrase, body: Phrase[], join: "sentences" | "lines" }
// where a Phrase is { message: <English ICU source>, args: { name: value } }
// and a value is a verbatim string (an error chain, a command name) or a
// number. The same contract as the desktop card in
// packages/blocks/src/desktop/agent-elements/utils/core-error-text.ts.

import type { CliTranslator } from "../i18n/translate.ts";

/** The parts of the CLI translator this module uses. */
export type CoreErrorTranslator = Pick<CliTranslator, "locale" | "tf" | "tr">;

export interface LocalizableCoreError {
	i18n?: unknown;
	message: string;
	title?: string;
}

export interface LocalizedCoreError {
	message: string;
	title: string | undefined;
}

/** Most body messages Core writes for one card. */
const MAX_BODY = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function renderPhrase(
	phrase: unknown,
	translator: CoreErrorTranslator
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
		for (const [name, value] of Object.entries(phrase.args)) {
			if (typeof value === "string" || typeof value === "number") {
				values[name] = value;
			} else if (isRecord(value) && typeof value.number === "number") {
				values[name] = value.number;
			} else {
				return null;
			}
		}
	}
	return translator.tf(phrase.message, values);
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
	translator: CoreErrorTranslator
): string | null {
	if (!Array.isArray(body) || body.length === 0 || body.length > MAX_BODY) {
		return null;
	}
	let out = "";
	for (const phrase of body) {
		const sentence = renderPhrase(phrase, translator);
		if (sentence === null) {
			return null;
		}
		if (out !== "") {
			out +=
				join === "lines" ? "\n" : sentenceSeparator(translator.locale, out);
		}
		out += sentence;
	}
	return out;
}

/** A stored English Core message, translated when the catalog knows it. */
function literal(
	text: string | undefined,
	translator: CoreErrorTranslator
): string | undefined {
	return text === undefined ? undefined : translator.tr(text);
}

/**
 * The error's title and message in the CLI's locale, each falling back to
 * the stored English (looked up as a catalog literal) when its messages are
 * missing or malformed.
 */
export function localizeCoreError(
	part: LocalizableCoreError,
	translator: CoreErrorTranslator
): LocalizedCoreError {
	const wire = isRecord(part.i18n) ? part.i18n : null;
	return {
		message:
			(wire && renderBody(wire.body, wire.join, translator)) ??
			translator.tr(part.message),
		title:
			(wire && renderPhrase(wire.title, translator)) ??
			literal(part.title, translator),
	};
}
