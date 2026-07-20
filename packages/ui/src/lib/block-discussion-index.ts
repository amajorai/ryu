"use client";

import { CommentPlugin } from "@platejs/comment/react";
import type { TResolvedSuggestion } from "@platejs/suggestion";
import { getSuggestionKey, keyId2SuggestionId } from "@platejs/suggestion";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import {
	discussionPlugin,
	type TDiscussion,
} from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import type { TComment } from "@ryu/ui/components/editor/ui/comment.tsx";
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
	type TSuggestionText,
} from "platejs";
import type { PlateEditor } from "platejs/react";
import { useEditorRef, useEditorVersion, usePluginOption } from "platejs/react";
import { useMemo } from "react";

export interface ResolvedSuggestion extends TResolvedSuggestion {
	comments: TComment[];
}

export const BLOCK_SUGGESTION_TOKEN = "__block__";

type BlockDiscussionEntry = NodeEntry<
	TCommentText | TElement | TSuggestionText
>;
type SuggestionEntry = NodeEntry<TElement | TSuggestionText>;

interface SuggestionAccumulator {
	newProperties: Record<string, unknown>;
	newText: string;
	properties: Record<string, unknown>;
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
	getSuggestionData: (node: TElement | TSuggestionText) =>
		| {
				createdAt: Date | number | string;
				id: string;
				isLineBreak?: boolean;
				newProperties?: Record<string, unknown>;
				properties?: Record<string, unknown>;
				type: "insert" | "remove" | "update";
				userId: string;
		  }
		| undefined;
	getSuggestionDataList: (node: TSuggestionText) => Array<{
		id: string;
		newProperties?: Record<string, unknown>;
		properties?: Record<string, unknown>;
		type: "insert" | "remove" | "update";
	}>;
	getSuggestionId: (node: TElement | TSuggestionText) => string | undefined;
	isBlockSuggestion: (node: TElement | TSuggestionText) => boolean;
}

const discussionIndexCache = new WeakMap<
	PlateEditor,
	{
		discussions: TDiscussion[];
		index: BlockDiscussionIndex;
		version: number;
	}
>();

const TYPE_TEXT_MAP: Record<string, (node?: TElement) => string> = {
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
		const dataList = getSuggestionDataList(node as TSuggestionText);
		const updateIds = dataList
			.filter((data) => data.type === "update")
			.map((data) => data.id);

		if (updateIds.length > 0) {
			return updateIds;
		}

		const suggestionId = getSuggestionId(node as TSuggestionText);

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

const formatSuggestionDateText = (date: string) => {
	const elementDate = new Date(date);

	if (Number.isNaN(elementDate.getTime())) {
		return date;
	}

	const today = new Date();
	const yesterday = new Date(today);
	const tomorrow = new Date(today);

	yesterday.setDate(today.getDate() - 1);
	tomorrow.setDate(today.getDate() + 1);

	const sameDay = (left: Date, right: Date) =>
		left.getDate() === right.getDate() &&
		left.getMonth() === right.getMonth() &&
		left.getFullYear() === right.getFullYear();

	if (sameDay(elementDate, today)) {
		return "Today";
	}
	if (sameDay(elementDate, yesterday)) {
		return "Yesterday";
	}
	if (sameDay(elementDate, tomorrow)) {
		return "Tomorrow";
	}

	return elementDate.toLocaleDateString(undefined, {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
};

const getInlineSuggestionElementText = (node: TElement) => {
	if (typeof node.value === "string" && node.value.length > 0) {
		return node.value;
	}

	if (typeof node.date === "string" && node.date.length > 0) {
		return formatSuggestionDateText(node.date);
	}

	if (
		node.type === KEYS.inlineEquation &&
		typeof (node as TElement & { texExpression?: unknown }).texExpression ===
			"string" &&
		(node as TElement & { texExpression: string }).texExpression.length > 0
	) {
		return (node as TElement & { texExpression: string }).texExpression;
	}

	const nodeText = NodeApi.string(node);

	if (nodeText.length > 0) {
		return nodeText;
	}
};

function applySuggestionData(
	accumulator: SuggestionAccumulator,
	text: string,
	data: {
		newProperties?: Record<string, unknown>;
		properties?: Record<string, unknown>;
		type: "insert" | "remove" | "update";
	}
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
	node: TSuggestionText;
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
				node: node as TSuggestionText,
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

	const suggestionData = getSuggestionData(sortedEntries[0][0]);

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

			appendByKey(suggestionEntriesById, suggestionId, [
				node as TElement | TSuggestionText,
				path,
			]);
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
	version: number
) => {
	const cached = discussionIndexCache.get(editor);

	if (
		cached &&
		cached.version === version &&
		cached.discussions === discussions
	) {
		return cached.index;
	}

	const commentApi = editor.getApi(CommentPlugin).comment;
	const suggestionApi = editor.getApi(SuggestionPlugin).suggestion;

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

	discussionIndexCache.set(editor, { discussions, index, version });

	return index;
};

export const useBlockDiscussionItems = (blockPath: Path) => {
	const editor = useEditorRef();
	const discussions = usePluginOption(discussionPlugin, "discussions");
	const version = useEditorVersion() ?? 0;

	return useMemo(() => {
		const index = getDiscussionIndex(editor, discussions, version);
		const blockKey = getBlockKey(blockPath);

		return {
			resolvedDiscussions: index.discussionsByBlock.get(blockKey) ?? [],
			resolvedSuggestions: index.suggestionsByBlock.get(blockKey) ?? [],
		};
	}, [blockPath, discussions, editor, version]);
};
