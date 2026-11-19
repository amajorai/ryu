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
import {
	accumulateElementSuggestion,
	accumulateTextSuggestion,
	type IndexSuggestionData,
	type SuggestionAccumulator,
} from "@ryu/ui/lib/block-suggestion-text.ts";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import {
	ElementApi,
	type NodeEntry,
	type Path,
	PathApi,
	type TCommentText,
	type TElement,
	TextApi,
	type TSuggestionText,
	type TText,
} from "platejs";
import type { PlateEditor } from "platejs/react";
import { useEditorRef, useEditorVersion, usePluginOption } from "platejs/react";
import { useMemo } from "react";

// The summary token lives with the suggestion text; re-exported for the UI.
export { BLOCK_SUGGESTION_TOKEN } from "@ryu/ui/lib/block-suggestion-text.ts";

export interface ResolvedSuggestion extends TResolvedSuggestion {
	comments: TComment[];
}

type BlockDiscussionEntry = NodeEntry<
	TCommentText | TElement | TSuggestionText
>;
type SuggestionEntry = NodeEntry<TElement | TText>;
type SuggestionApi = BaseSuggestionConfig["api"]["suggestion"];
/** Plate's installed readers accept ordinary Text leaves, including leaves without a suggestion mark. */
interface NativeTextSuggestionApi extends SuggestionApi {
	dataList: (node: TText) => ReturnType<SuggestionApi["dataList"]>;
	nodeId: (node: TElement | TText) => ReturnType<SuggestionApi["nodeId"]>;
	suggestionData: (
		node: TElement | TText
	) => ReturnType<SuggestionApi["suggestionData"]>;
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

export interface BuildBlockDiscussionIndexOptions {
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
