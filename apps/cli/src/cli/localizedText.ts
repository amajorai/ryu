// Error copy that stays English for machines and renders in the CLI locale for
// people. A thrown error keeps its English text in `.message` (what `--json`
// envelopes and logs carry) plus the ICU source and values, so `formatError`
// can translate the whole sentence at display time.

import { formatMessage } from "@ryu/i18n/core";
import { tf } from "../i18n/translate.ts";

type LocalizedValue = string | number | LocalizedText;

/** An ICU message (`"Unknown --kind '{kind}'."`) with its placeholder values. */
export interface LocalizedText {
	/** The message rendered in English, for `--json` and logs. */
	readonly english: string;
	readonly source: string;
	readonly values: Readonly<Record<string, LocalizedValue>>;
}

function resolveValues(
	values: Readonly<Record<string, LocalizedValue>>,
	render: (text: LocalizedText) => string
): Record<string, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [name, value] of Object.entries(values)) {
		resolved[name] = typeof value === "object" ? render(value) : value;
	}
	return resolved;
}

/**
 * Build error copy whose source the extractor collects (`localize` is an ICU
 * call). A value may itself be localized text, such as a translated noun.
 */
export function localize(
	source: string,
	values: Readonly<Record<string, LocalizedValue>> = {}
): LocalizedText {
	const english = formatMessage(
		source,
		resolveValues(values, (text) => text.english),
		"en"
	);
	return { english, source, values };
}

type Formatter = (
	source: string,
	values: Readonly<Record<string, string | number>>
) => string;

/** Render localized text in the CLI locale (human output only). */
export function renderLocalized(
	text: LocalizedText,
	format: Formatter = tf
): string {
	return format(
		text.source,
		resolveValues(text.values, (value) => renderLocalized(value, format))
	);
}

/** An error whose message is English, with a translation for human output. */
export class LocalizedError extends Error {
	readonly localized: LocalizedText | null;

	constructor(message: string | LocalizedText) {
		super(typeof message === "string" ? message : message.english);
		this.localized = typeof message === "string" ? null : message;
	}
}

/** The localized copy carried by an error, if it was built with `localize`. */
export function localizedTextOf(error: Error): LocalizedText | null {
	return error instanceof LocalizedError ? error.localized : null;
}
