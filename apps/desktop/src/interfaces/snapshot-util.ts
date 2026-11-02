// Small shared helpers of the interface snapshot adapter (`snapshot.ts`).

import { formatMessage, messageIdForLiteral, translate } from "@ryu/i18n/core";

/**
 * Translates an English ICU source with values in the reader's locale. The
 * snapshot localizes the copy it writes itself (ask labels, blocker titles)
 * so every interface shows it whole, never an English word spliced into a
 * translated template. Defaults to the locale the UI shows.
 */
export type SnapshotTranslate = (
	source: string,
	values?: Record<string, string | number>
) => string;

/** The active-locale translator, the snapshot's default. */
export const activeTranslate: SnapshotTranslate = (source, values) =>
	translate(source, values);

/** What {@link snapshotTranslator} reads from a mounted i18n provider. */
export interface SnapshotI18n {
	formatLocale?: string;
	locale: string;
	t(
		id: string,
		values?: Record<string, string | number>,
		fallback?: string
	): string;
}

/**
 * A translator bound to one provider value. The provider hands out a new
 * value whenever its language or catalog changes, so a snapshot memoized on
 * the translator is rebuilt in the new language instead of keeping copy
 * written in the old one.
 */
export function snapshotTranslator(
	i18n: SnapshotI18n | null
): SnapshotTranslate {
	if (!i18n) {
		return activeTranslate;
	}
	return (source, values = {}) => {
		const translated = i18n.t(messageIdForLiteral(source), values, source);
		// The runtime returns unknown literal copy verbatim; format it here.
		return translated === source
			? formatMessage(source, values, i18n.formatLocale ?? i18n.locale)
			: translated;
	};
}

const EPOCH_ISO = new Date(0).toISOString();

/** RFC 3339 UTC; an out-of-range timestamp sorts as the oldest thread. */
export function toIso(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? EPOCH_ISO : date.toISOString();
}

const PATH_SEPARATOR = /[\\/]/;

export function basename(path: string): string {
	const parts = path.split(PATH_SEPARATOR).filter(Boolean);
	return parts.at(-1) ?? "";
}

export function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function stringField(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

export function isoOrNull(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? toIso(ms) : null;
}
