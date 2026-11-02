// packages/core-client/src/approval-text.ts
//
// Renders an approval card's title, question and summary in the reader's
// locale from the Core messages a request carries in `i18n`
// (apps/core/src/approvals/text.rs writes them). A request without them (a
// row from an older Core) or with a malformed part keeps its stored English.
//
// Wire shape:
//   { title: Phrase, question?: Phrase, summary: (Phrase | { text })[] }
// where a Phrase is { message: <English ICU source>, args: { name: value } }
// and a value is a verbatim string (ids, names, addresses), a number object
// ({ number }), a date object ({ date }), or a nested Phrase.

import { translate } from "@ryu/i18n/lite";

/** Translate an English ICU source with values, in the active locale. */
export type ApprovalTranslate = (
	source: string,
	values: Record<string, string | number>
) => string;

export interface ApprovalI18nPhrase {
	args?: Record<string, unknown>;
	message: string;
}

export interface ApprovalI18n {
	question?: ApprovalI18nPhrase | null;
	summary?: Array<ApprovalI18nPhrase | { text: string }>;
	title: ApprovalI18nPhrase;
}

/** The fields of an approval request this module reads. */
export interface LocalizableApproval {
	i18n?: unknown;
	question?: string | null;
	summary: string;
	title: string;
}

export interface LocalizedApprovalText {
	question: string | null;
	summary: string;
	title: string;
}

/** Phrases nest one level today; anything deeper is not Core's. */
const MAX_DEPTH = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function renderValue(
	value: unknown,
	tl: ApprovalTranslate,
	depth: number
): string | number | null {
	if (typeof value === "string" || typeof value === "number") {
		return value;
	}
	if (!isRecord(value)) {
		return null;
	}
	if (typeof value.message === "string") {
		return renderPhrase(value, tl, depth + 1);
	}
	if (typeof value.number === "number") {
		return value.number;
	}
	return typeof value.date === "string" ? value.date : null;
}

function renderPhrase(
	phrase: unknown,
	tl: ApprovalTranslate,
	depth = 0
): string | null {
	if (
		depth > MAX_DEPTH ||
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
			const value = renderValue(raw, tl, depth);
			if (value === null) {
				return null;
			}
			values[name] = value;
		}
	}
	return tl(phrase.message, values);
}

function renderSummary(summary: unknown, tl: ApprovalTranslate): string | null {
	if (!Array.isArray(summary)) {
		return null;
	}
	let out = "";
	for (const piece of summary) {
		if (isRecord(piece) && typeof piece.text === "string") {
			out += piece.text;
			continue;
		}
		const rendered = renderPhrase(piece, tl);
		if (rendered === null) {
			return null;
		}
		out += rendered;
	}
	return out;
}

const defaultTranslate: ApprovalTranslate = (source, values) =>
	translate(source, values);

/**
 * The approval's title, question and summary in the active locale, each
 * falling back to the stored English when its messages are missing or
 * malformed.
 */
export function localizeApproval(
	approval: LocalizableApproval,
	tl: ApprovalTranslate = defaultTranslate
): LocalizedApprovalText {
	const fallback = {
		question: approval.question ?? null,
		summary: approval.summary,
		title: approval.title,
	};
	const wire = approval.i18n;
	if (!isRecord(wire)) {
		return fallback;
	}
	const question =
		wire.question === undefined || wire.question === null
			? fallback.question
			: (renderPhrase(wire.question, tl) ?? fallback.question);
	return {
		question,
		summary: renderSummary(wire.summary, tl) ?? fallback.summary,
		title: renderPhrase(wire.title, tl) ?? fallback.title,
	};
}
