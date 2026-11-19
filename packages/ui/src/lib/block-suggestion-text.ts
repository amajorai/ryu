// The text a suggestion summary shows for a suggested change: the block
// names for an added or removed block ("Add: Heading 1"), a date element's
// day, and the accumulated inserted and removed text. Block names stay
// English in the suggestion data, which the summary compares against
// ("Table", "Code Block"); each is marked with `tl` so the catalog extractor
// files it and the DOM localizer translates the rendered text in place. The
// list names reuse the editor's own list labels, so the bullet list never
// reads as the "listing" sense of a bare "List".

import type { BaseSuggestionConfig } from "@platejs/suggestion";
import { keyId2SuggestionId } from "@platejs/suggestion";
import { formatDate, resolveTimeZone } from "@ryu/ui/lib/timezone.ts";
import {
	KEYS,
	NodeApi,
	type TElement,
	type TSuggestionElement,
	type TText,
} from "platejs";
import { z } from "zod";
import type { BuildBlockDiscussionIndexOptions } from "./block-discussion-index.ts";

export const BLOCK_SUGGESTION_TOKEN = "__block__";

type SuggestionApi = BaseSuggestionConfig["api"]["suggestion"];
type TimestampProjection<T> = {
	[K in keyof T]: K extends "createdAt" ? Date | number | string : T[K];
};
export type IndexSuggestionData = TimestampProjection<
	NonNullable<ReturnType<SuggestionApi["suggestionData"]>>
> &
	Pick<TSuggestionElement["suggestion"], "isLineBreak">;

export interface SuggestionAccumulator {
	newProperties: object;
	newText: string;
	properties: object;
	text: string;
}

const inlineTextSchema = z.string();
const isInlineText = (value: TElement["value"]): value is string =>
	inlineTextSchema.safeParse(value).success;

/** Marks catalog copy; the DOM localizer translates it once rendered. */
const tl = (source: string): string => source;

type BlockTypeLabels = Record<string, (node?: TElement) => string>;

const TYPE_TEXT_MAP: BlockTypeLabels = {
	[KEYS.audio]: () => tl("Audio"),
	[KEYS.blockquote]: () => tl("Blockquote"),
	[KEYS.callout]: () => tl("Callout"),
	[KEYS.codeBlock]: () => tl("Code Block"),
	[KEYS.column]: () => tl("Column"),
	[KEYS.equation]: () => tl("Equation"),
	[KEYS.file]: () => tl("File"),
	[KEYS.h1]: () => tl("Heading 1"),
	[KEYS.h2]: () => tl("Heading 2"),
	[KEYS.h3]: () => tl("Heading 3"),
	[KEYS.h4]: () => tl("Heading 4"),
	[KEYS.h5]: () => tl("Heading 5"),
	[KEYS.h6]: () => tl("Heading 6"),
	[KEYS.hr]: () => tl("Divider"),
	[KEYS.img]: () => tl("Image"),
	[KEYS.mediaEmbed]: () => tl("Media"),
	[KEYS.p]: (node) => {
		if (node?.[KEYS.listType] === KEYS.listTodo) {
			return tl("To-do list");
		}
		if (node?.[KEYS.listType] === KEYS.ol) {
			return tl("Numbered list");
		}
		if (node?.[KEYS.listType] === KEYS.ul) {
			return tl("Bulleted list");
		}
		return tl("Paragraph");
	},
	[KEYS.table]: () => tl("Table"),
	[KEYS.toc]: () => tl("Table of Contents"),
	[KEYS.toggle]: () => tl("Toggle"),
	[KEYS.video]: () => tl("Video"),
};

/** The English block name for a suggested block, or its raw type. */
export function suggestionTypeText(node: TElement): string {
	return (TYPE_TEXT_MAP[node.type] ?? (() => node.type))(node);
}

const CANONICAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

interface CivilDate {
	day: number;
	month: number;
	year: number;
}

/** Whole days since 1970-01-01 for a civil date; no time zone is involved. */
const civilDayNumber = ({ year, month, day }: CivilDate) =>
	Date.UTC(year, month - 1, day) / MS_PER_DAY;

/**
 * A date element's civil date. Plate stores `YYYY-MM-DD`, which must never be
 * parsed as UTC midnight (that moves it a day back west of UTC); a legacy
 * `toDateString()` value parses as local midnight.
 */
function elementCivilDate(value: string): CivilDate | null {
	const canonical = CANONICAL_DATE.exec(value);
	if (canonical) {
		const civil = {
			year: Number(canonical[1]),
			month: Number(canonical[2]),
			day: Number(canonical[3]),
		};
		const check = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
		return check.getUTCMonth() === civil.month - 1 &&
			check.getUTCDate() === civil.day
			? civil
			: null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? null
		: {
				year: parsed.getFullYear(),
				month: parsed.getMonth() + 1,
				day: parsed.getDate(),
			};
}

/** Today's civil date in the selected display zone (machine zone for System). */
function displayCivilToday(now: number): CivilDate {
	const read = (timeZone: string | undefined) => {
		const parts = new Intl.DateTimeFormat("en-US", {
			day: "numeric",
			month: "numeric",
			numberingSystem: "latn",
			timeZone,
			year: "numeric",
		}).formatToParts(now);
		const field = (type: Intl.DateTimeFormatPartTypes) =>
			Number(parts.find((part) => part.type === type)?.value);
		return { year: field("year"), month: field("month"), day: field("day") };
	};
	try {
		return read(resolveTimeZone());
	} catch {
		// An unsupported stored zone falls back to the machine zone.
		return read(undefined);
	}
}

export const formatSuggestionDateText = (date: string, now = Date.now()) => {
	const civil = elementCivilDate(date);
	if (!civil) {
		return date;
	}
	const offset = civilDayNumber(civil) - civilDayNumber(displayCivilToday(now));
	if (offset === 0) {
		return "Today";
	}
	if (offset === -1) {
		return "Yesterday";
	}
	if (offset === 1) {
		return "Tomorrow";
	}
	const pad = (part: number) => String(part).padStart(2, "0");
	// A calendar string formats as that civil date in the display locale.
	return formatDate(`${civil.year}-${pad(civil.month)}-${pad(civil.day)}`, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
};

const getInlineSuggestionElementText = (node: TElement) => {
	if (isInlineText(node.value) && node.value.length > 0) {
		return node.value;
	}
	if (isInlineText(node.date) && node.date.length > 0) {
		return formatSuggestionDateText(node.date);
	}
	if (
		node.type === KEYS.inlineEquation &&
		isInlineText(node.texExpression) &&
		node.texExpression.length > 0
	) {
		return node.texExpression;
	}
	const nodeText = NodeApi.string(node);
	if (nodeText.length > 0) {
		return nodeText;
	}
};

function applySuggestionData(
	accumulator: SuggestionAccumulator,
	text: string,
	data: IndexSuggestionData
): void {
	switch (data.type) {
		case "insert": {
			accumulator.newText += text;
			break;
		}
		case "remove": {
			accumulator.text += text;
			break;
		}
		case "update": {
			accumulator.properties = {
				...accumulator.properties,
				...data.properties,
			};
			accumulator.newProperties = {
				...accumulator.newProperties,
				...data.newProperties,
			};
			accumulator.newText += text;
			break;
		}
		default:
			break;
	}
}

export function accumulateTextSuggestion({
	accumulator,
	getSuggestionDataList,
	id,
	node,
}: {
	accumulator: SuggestionAccumulator;
	getSuggestionDataList: BuildBlockDiscussionIndexOptions["getSuggestionDataList"];
	id: string;
	node: TText;
}): void {
	for (const data of getSuggestionDataList(node)) {
		if (data.id === id) {
			applySuggestionData(accumulator, node.text, data);
		}
	}
}

export function accumulateElementSuggestion({
	accumulator,
	getSuggestionData,
	id,
	isBlockSuggestion,
	node,
}: {
	accumulator: SuggestionAccumulator;
	getSuggestionData: BuildBlockDiscussionIndexOptions["getSuggestionData"];
	id: string;
	isBlockSuggestion: BuildBlockDiscussionIndexOptions["isBlockSuggestion"];
	node: TElement;
}): void {
	const suggestionData = getSuggestionData(node);
	if (suggestionData?.id !== keyId2SuggestionId(id)) {
		return;
	}

	const inlineSuggestionText = getInlineSuggestionElementText(node);
	if (inlineSuggestionText) {
		applySuggestionData(accumulator, inlineSuggestionText, suggestionData);
		return;
	}

	if (!isBlockSuggestion(node)) {
		return;
	}

	const nextText = suggestionData.isLineBreak
		? BLOCK_SUGGESTION_TOKEN
		: `${BLOCK_SUGGESTION_TOKEN}${suggestionTypeText(node)}`;
	applySuggestionData(accumulator, nextText, suggestionData);
}

/** A formatting change's label: the mark name when added, a whole phrase when removed. */
const MARK_LABELS: Record<string, readonly [added: string, removed: string]> = {
	[KEYS.backgroundColor]: [
		tl("Background color"),
		tl("Remove background color"),
	],
	[KEYS.bold]: [tl("Bold"), tl("Remove bold")],
	[KEYS.code]: [tl("Code"), tl("Remove code formatting")],
	[KEYS.color]: [tl("Text color"), tl("Remove text color")],
	[KEYS.fontFamily]: [tl("Font"), tl("Remove font")],
	[KEYS.fontSize]: [tl("Font size"), tl("Remove font size")],
	[KEYS.highlight]: [tl("Highlight"), tl("Remove highlight")],
	[KEYS.italic]: [tl("Italic"), tl("Remove italic")],
	[KEYS.strikethrough]: [tl("Strikethrough"), tl("Remove strikethrough")],
	[KEYS.sub]: [tl("Subscript"), tl("Remove subscript")],
	[KEYS.sup]: [tl("Superscript"), tl("Remove superscript")],
	[KEYS.underline]: [tl("Underline"), tl("Remove underline")],
};

/**
 * The English label of a formatting suggestion for `mark` (rendered as its
 * own text node, so the DOM localizer translates it). Unknown marks keep the
 * raw property name.
 */
export function suggestionMarkLabel(mark: string, removed: boolean): string {
	const labels = MARK_LABELS[mark];
	if (labels) {
		return removed ? labels[1] : labels[0];
	}
	return removed ? `Un${mark}` : mark.charAt(0).toUpperCase() + mark.slice(1);
}
