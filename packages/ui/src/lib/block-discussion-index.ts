"use client";

import { CommentPlugin } from "@platejs/comment/react";
import type {
	BaseSuggestionConfig,
	TResolvedSuggestion,
} from "@platejs/suggestion";
import { getSuggestionKey, keyId2SuggestionId } from "@platejs/suggestion";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
	discussionPlugin,
	type TDiscussion,
} from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import type { TComment } from "@ryu/ui/components/editor/ui/comment.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { formatDate, resolveTimeZone } from "@ryu/ui/lib/timezone.ts";
import {
	ElementApi,
	KEYS,
	NodeApi,
	type NodeEntry,
	type Path,
	PathApi,
	type TCommentText,
	type TElement,
	TextApi,
	type TSuggestionElement,
	type TSuggestionText,
	type TText,
} from "platejs";
import type { PlateEditor } from "platejs/react";
import { useEditorRef, useEditorVersion, usePluginOption } from "platejs/react";
import { useMemo } from "react";
import { z } from "zod";

export interface ResolvedSuggestion extends TResolvedSuggestion {
	comments: TComment[];
}

export const BLOCK_SUGGESTION_TOKEN = "__block__";

type BlockDiscussionEntry = NodeEntry<
	TCommentText | TElement | TSuggestionText
>;
type SuggestionEntry = NodeEntry<TElement | TText>;
type SuggestionApi = BaseSuggestionConfig["api"]["suggestion"];
type TimestampProjection<T> = {
	[K in keyof T]: K extends "createdAt" ? Date | number | string : T[K];
};
type IndexSuggestionData = TimestampProjection<
	NonNullable<ReturnType<SuggestionApi["suggestionData"]>>
> &
	Pick<TSuggestionElement["suggestion"], "isLineBreak">;
/** Plate's installed readers accept ordinary Text leaves, including leaves without a suggestion mark. */
interface NativeTextSuggestionApi extends SuggestionApi {
	dataList: (node: TText) => ReturnType<SuggestionApi["dataList"]>;
	nodeId: (node: TElement | TText) => ReturnType<SuggestionApi["nodeId"]>;
	suggestionData: (
		node: TElement | TText
	) => ReturnType<SuggestionApi["suggestionData"]>;
}
const inlineTextSchema = z.string();
const isInlineText = (value: TElement["value"]): value is string =>
	inlineTextSchema.safeParse(value).success;

interface SuggestionAccumulator {
	newProperties: object;
	newText: string;
	properties: object;
	text: string;
}

interface BlockDiscussionIndex {
	discussionsByBlock: Map<string, TDiscussion[]>;
	suggestionsByBlock: Map<string, ResolvedSuggestion[]>;
}

interface DiscussionEntryScan {
	commentIds: Set<string>;
	commentOwnerById: Map<string, Path>;
	suggestionEntriesById: Map<string, SuggestionEntry[]>;
	suggestionOwnerById: Map<string, Path>;
}

interface BuildBlockDiscussionIndexOptions {
	discussions: TDiscussion[];
	entries: BlockDiscussionEntry[];
	getCommentId: (node: TCommentText) => string | undefined;
	getSuggestionData: (
		node: TElement | TText
	) => IndexSuggestionData | undefined;
	getSuggestionDataList: NativeTextSuggestionApi["dataList"];
	getSuggestionId: NativeTextSuggestionApi["nodeId"];
	isBlockSuggestion: (node: TElement | TSuggestionText) => boolean;
}

const discussionIndexCache = new WeakMap<
	PlateEditor,
	{
		/** Display-day revision the cached suggestion labels were built for. */
		day: string;
		discussions: TDiscussion[];
		index: BlockDiscussionIndex;
		version: number;
	}
>();

interface BlockTypeLabels {
	[type: string]: (node?: TElement) => string;
}

const TYPE_TEXT_MAP: BlockTypeLabels = {
	[KEYS.audio]: () => "Audio",
	[KEYS.blockquote]: () => "Blockquote",
	[KEYS.callout]: () => "Callout",
	[KEYS.codeBlock]: () => "Code Block",
	[KEYS.column]: () => "Column",
	[KEYS.equation]: () => "Equation",
	[KEYS.file]: () => "File",
	[KEYS.h1]: () => "Heading 1",
	[KEYS.h2]: () => "Heading 2",
	[KEYS.h3]: () => "Heading 3",
	[KEYS.h4]: () => "Heading 4",
	[KEYS.h5]: () => "Heading 5",
	[KEYS.h6]: () => "Heading 6",
	[KEYS.hr]: () => "Horizontal Rule",
	[KEYS.img]: () => "Image",
	[KEYS.mediaEmbed]: () => "Media",
	[KEYS.p]: (node) => {
		if (node?.[KEYS.listType] === KEYS.listTodo) {
			return "Todo List";
		}
		if (node?.[KEYS.listType] === KEYS.ol) {
			return "Ordered List";
		}
		if (node?.[KEYS.listType] === KEYS.ul) {
			return "List";
		}

		return "Paragraph";
	},
	[KEYS.table]: () => "Table",
	[KEYS.toc]: () => "Table of Contents",
	[KEYS.toggle]: () => "Toggle",
	[KEYS.video]: () => "Video",
};

const appendByKey = <T>(map: Map<string, T[]>, key: string, value: T) => {
	const values = map.get(key);

	if (values) {
		values.push(value);
		return;
	}

	map.set(key, [value]);
};

const getBlockKey = (path: Path) => path.join(",");

const getTopLevelPath = (path: Path): Path | null =>
	path.length > 0 ? path.slice(0, 1) : null;

const getSuggestionIds = (
	node: TCommentText | TElement | TSuggestionText,
	getSuggestionDataList: BuildBlockDiscussionIndexOptions["getSuggestionDataList"],
	getSuggestionId: BuildBlockDiscussionIndexOptions["getSuggestionId"]
) => {
	if (TextApi.isText(node)) {
		const dataList = getSuggestionDataList(node);
		const updateIds = dataList
			.filter((data) => data.type === "update")
			.map((data) => data.id);

		if (updateIds.length > 0) {
			return updateIds;
		}

		const suggestionId = getSuggestionId(node);

		return suggestionId ? [suggestionId] : [];
	}

	if (ElementApi.isElement(node)) {
		const suggestionId = getSuggestionId(node);

		return suggestionId ? [suggestionId] : [];
	}

	return [];
};

const suggestionTypeText = (node: TElement) =>
	(TYPE_TEXT_MAP[node.type] ?? (() => node.type))(node);

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

const formatSuggestionDateText = (date: string, now = Date.now()) => {
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

function accumulateTextSuggestion({
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

function accumulateElementSuggestion({
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

const toResolvedSuggestion = ({
	discussionsById,
	entries,
	getSuggestionData,
	getSuggestionDataList,
	id,
	isBlockSuggestion,
}: {
	discussionsById: Map<string, TDiscussion>;
	entries: SuggestionEntry[];
	getSuggestionData: BuildBlockDiscussionIndexOptions["getSuggestionData"];
	getSuggestionDataList: BuildBlockDiscussionIndexOptions["getSuggestionDataList"];
	id: string;
	isBlockSuggestion: BuildBlockDiscussionIndexOptions["isBlockSuggestion"];
}): ResolvedSuggestion | null => {
	const sortedEntries = [...entries].sort(([, path1], [, path2]) =>
		PathApi.isChild(path1, path2) ? -1 : 1
	);

	if (sortedEntries.length === 0) {
		return null;
	}

	const accumulator: SuggestionAccumulator = {
		newProperties: {},
		newText: "",
		properties: {},
		text: "",
	};

	for (const [node] of sortedEntries) {
		if (TextApi.isText(node)) {
			accumulateTextSuggestion({
				accumulator,
				getSuggestionDataList,
				id,
				node,
			});
			continue;
		}

		if (!ElementApi.isElement(node)) {
			continue;
		}

		accumulateElementSuggestion({
			accumulator,
			getSuggestionData,
			id,
			isBlockSuggestion,
			node,
		});
	}

	const firstEntry = sortedEntries[0];
	if (!firstEntry) {
		return null;
	}

	const suggestionData = getSuggestionData(firstEntry[0]);

	if (!suggestionData) {
		return null;
	}

	const keyId = getSuggestionKey(id);
	const comments = discussionsById.get(id)?.comments ?? [];
	const createdAt = new Date(suggestionData.createdAt);
	const suggestionId = keyId2SuggestionId(id);

	if (suggestionData.type === "update") {
		return {
			comments,
			createdAt,
			keyId,
			newProperties: accumulator.newProperties,
			newText: accumulator.newText,
			properties: accumulator.properties,
			suggestionId,
			type: "update",
			userId: suggestionData.userId,
		};
	}

	if (accumulator.newText.length > 0 && accumulator.text.length > 0) {
		return {
			comments,
			createdAt,
			keyId,
			newText: accumulator.newText,
			suggestionId,
			text: accumulator.text,
			type: "replace",
			userId: suggestionData.userId,
		};
	}

	if (accumulator.newText.length > 0) {
		return {
			comments,
			createdAt,
			keyId,
			newText: accumulator.newText,
			suggestionId,
			type: "insert",
			userId: suggestionData.userId,
		};
	}

	if (accumulator.text.length > 0) {
		return {
			comments,
			createdAt,
			keyId,
			suggestionId,
			text: accumulator.text,
			type: "remove",
			userId: suggestionData.userId,
		};
	}

	return null;
};

function scanDiscussionEntries({
	entries,
	getCommentId,
	getSuggestionDataList,
	getSuggestionId,
}: Pick<
	BuildBlockDiscussionIndexOptions,
	"entries" | "getCommentId" | "getSuggestionDataList" | "getSuggestionId"
>): DiscussionEntryScan {
	const commentOwnerById = new Map<string, Path>();
	const suggestionOwnerById = new Map<string, Path>();
	const commentIds = new Set<string>();
	const suggestionEntriesById = new Map<string, SuggestionEntry[]>();

	for (const [node, path] of entries) {
		const blockPath = getTopLevelPath(path);

		if (!blockPath) {
			continue;
		}

		if (TextApi.isText(node)) {
			const commentId = getCommentId(node);

			if (commentId) {
				commentIds.add(commentId);

				if (!commentOwnerById.has(commentId)) {
					commentOwnerById.set(commentId, blockPath);
				}
			}
		}

		for (const suggestionId of getSuggestionIds(
			node,
			getSuggestionDataList,
			getSuggestionId
		)) {
			if (!suggestionOwnerById.has(suggestionId)) {
				suggestionOwnerById.set(suggestionId, blockPath);
			}

			appendByKey(suggestionEntriesById, suggestionId, [node, path]);
		}
	}

	return {
		commentIds,
		commentOwnerById,
		suggestionEntriesById,
		suggestionOwnerById,
	};
}

function groupDiscussionsByBlock(
	discussions: TDiscussion[],
	scan: DiscussionEntryScan
): Map<string, TDiscussion[]> {
	const discussionsByBlock = new Map<string, TDiscussion[]>();

	for (const discussion of discussions) {
		const ownerPath = scan.commentOwnerById.get(discussion.id);

		if (
			!(ownerPath && scan.commentIds.has(discussion.id)) ||
			discussion.isResolved
		) {
			continue;
		}

		appendByKey(discussionsByBlock, getBlockKey(ownerPath), {
			...discussion,
			createdAt: new Date(discussion.createdAt),
		});
	}

	return discussionsByBlock;
}

function groupSuggestionsByBlock({
	discussionsById,
	getSuggestionData,
	getSuggestionDataList,
	isBlockSuggestion,
	scan,
}: {
	discussionsById: Map<string, TDiscussion>;
	getSuggestionData: BuildBlockDiscussionIndexOptions["getSuggestionData"];
	getSuggestionDataList: BuildBlockDiscussionIndexOptions["getSuggestionDataList"];
	isBlockSuggestion: BuildBlockDiscussionIndexOptions["isBlockSuggestion"];
	scan: DiscussionEntryScan;
}): Map<string, ResolvedSuggestion[]> {
	const suggestionsByBlock = new Map<string, ResolvedSuggestion[]>();

	for (const [suggestionId, suggestionEntries] of scan.suggestionEntriesById) {
		const ownerPath = scan.suggestionOwnerById.get(suggestionId);

		if (!ownerPath) {
			continue;
		}

		const resolvedSuggestion = toResolvedSuggestion({
			discussionsById,
			entries: suggestionEntries,
			getSuggestionData,
			getSuggestionDataList,
			id: suggestionId,
			isBlockSuggestion,
		});

		if (resolvedSuggestion) {
			appendByKey(
				suggestionsByBlock,
				getBlockKey(ownerPath),
				resolvedSuggestion
			);
		}
	}

	return suggestionsByBlock;
}

export const buildBlockDiscussionIndex = ({
	discussions,
	entries,
	getCommentId,
	getSuggestionData,
	getSuggestionDataList,
	getSuggestionId,
	isBlockSuggestion,
}: BuildBlockDiscussionIndexOptions): BlockDiscussionIndex => {
	const discussionsById = new Map(
		discussions.map((discussion) => [discussion.id, discussion])
	);
	const scan = scanDiscussionEntries({
		entries,
		getCommentId,
		getSuggestionDataList,
		getSuggestionId,
	});

	return {
		discussionsByBlock: groupDiscussionsByBlock(discussions, scan),
		suggestionsByBlock: groupSuggestionsByBlock({
			discussionsById,
			getSuggestionData,
			getSuggestionDataList,
			isBlockSuggestion,
			scan,
		}),
	};
};

const getDiscussionIndex = (
	editor: PlateEditor,
	discussions: TDiscussion[],
	version: number,
	day: string
) => {
	const cached = discussionIndexCache.get(editor);

	if (
		cached &&
		cached.version === version &&
		cached.discussions === discussions &&
		cached.day === day
	) {
		return cached.index;
	}

	const commentApi = editor.getApi(CommentPlugin).comment;
	// SAFETY: Plate 53's dataList/nodeId/suggestionData implementations read suggestion-key slots on any native Text leaf;
	// none require suggestion:true. This adapter widens only that installed, verified input ABI and retains all SDK outputs.
	const suggestionApi = editor.getApi(SuggestionPlugin)
		.suggestion as NativeTextSuggestionApi;

	const index = buildBlockDiscussionIndex({
		discussions,
		entries: [...editor.api.nodes({ at: [], mode: "all" })],
		getCommentId: (node) => commentApi.nodeId(node),
		getSuggestionData: (node) => suggestionApi.suggestionData(node),
		getSuggestionDataList: (node) => suggestionApi.dataList(node),
		getSuggestionId: (node) => suggestionApi.nodeId(node),
		isBlockSuggestion: (node) =>
			ElementApi.isElement(node) && suggestionApi.isBlockSuggestion(node),
	});

	discussionIndexCache.set(editor, { day, discussions, index, version });

	return index;
};

export const useBlockDiscussionItems = (blockPath: Path) => {
	const editor = useEditorRef();
	const discussions = usePluginOption(discussionPlugin, "discussions");
	const version = useEditorVersion() ?? 0;
	// Suggested date chips read "Today"/"Yesterday" relative to the display
	// zone, so the index is rebuilt at each display-zone midnight.
	const day = useDisplayDayRevision();

	return useMemo(() => {
		const index = getDiscussionIndex(editor, discussions, version, day);
		const blockKey = getBlockKey(blockPath);

		return {
			resolvedDiscussions: index.discussionsByBlock.get(blockKey) ?? [],
			resolvedSuggestions: index.suggestionsByBlock.get(blockKey) ?? [],
		};
	}, [blockPath, day, discussions, editor, version]);
};
