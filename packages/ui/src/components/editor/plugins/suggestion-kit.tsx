"use client";

import {
	type BaseSuggestionConfig,
	BaseSuggestionPlugin,
} from "@platejs/suggestion";
import {
	SuggestionLeaf,
	SuggestionLineBreak,
	VoidRemoveSuggestionOverlay,
} from "@ryu/ui/components/editor/ui/suggestion-node.tsx";
import type {
	ExtendConfig,
	SlateEditor,
	TElement,
	TSuggestionText,
} from "platejs";
import { KEYS, TextApi, TrailingBlockPlugin } from "platejs";
import { toTPlatePlugin } from "platejs/react";
import { isNativeFunction } from "../../../lib/native-primitive-observation.ts";
import {
	discussionPlugin,
	getDiscussionBlockClickTarget,
	getDiscussionClickTarget,
} from "./discussion-kit.tsx";

export type SuggestionConfig = ExtendConfig<
	BaseSuggestionConfig,
	{
		activeId: string | null;
		hoverId: string | null;
	}
>;

const INLINE_SUGGESTION_TARGET_PLUGINS = [
	KEYS.date,
	KEYS.inlineEquation,
	KEYS.link,
	KEYS.mention,
];

function getInlineSuggestionData(editor: SlateEditor, element: TElement) {
	const suggestionApi = editor.getApi(BaseSuggestionPlugin).suggestion;
	const data = suggestionApi.suggestionData(element);

	if (data) {
		return data;
	}
	if (!isNativeFunction(suggestionApi.dataList)) {
		return;
	}

	for (const child of element.children) {
		if (!TextApi.isText(child)) {
			continue;
		}

		// SAFETY: Plate dataList declares the marked TSuggestionText, but its native implementation only enumerates suggestion_* keys of the complete text object. The existing TextApi guard supplies that entire object; its marks, getters and method receiver are forwarded unchanged.
		const childData = suggestionApi.dataList(child as TSuggestionText).at(-1);

		if (childData) {
			return childData;
		}
	}
}

export const suggestionPlugin = toTPlatePlugin<SuggestionConfig>(
	BaseSuggestionPlugin,
	({ editor }) => ({
		options: {
			activeId: null,
			currentUserId: editor.getOption(discussionPlugin, "currentUserId"),
			hoverId: null,
		},
	})
).configure({
	handlers: {
		// unset active suggestion when clicking outside of suggestion
		onClick: ({ api, event, setOption, type }) => {
			const markTarget = getDiscussionClickTarget({
				selector: `.slate-${type}`,
				target: event.target,
			});
			const blockTarget = markTarget
				? null
				: getDiscussionBlockClickTarget({
						target: event.target,
					});

			if (!(markTarget || blockTarget)) {
				setOption("activeId", null);
				return;
			}

			const suggestionEntry = api.suggestion?.node({
				isText: !blockTarget,
			});

			setOption(
				"activeId",
				suggestionEntry
					? (api.suggestion?.nodeId(suggestionEntry[0]) ?? null)
					: null
			);
		},
	},
	inject: {
		isElement: true,
		nodeProps: {
			nodeKey: "",
			styleKey: "cssText",
			transformProps: ({ editor, element, props }) => {
				if (!element) {
					return props;
				}

				const suggestionData = getInlineSuggestionData(editor, element);

				if (!suggestionData) {
					return props;
				}

				return {
					...props,
					"data-inline-suggestion": suggestionData.type,
				};
			},
			// SAFETY: Plate declares CSSStyleDeclaration here, while its native injection implementation forwards this result as a plain React style object (and defaults to a plain object). This complete empty object clears injected styles; no DOM declaration methods or fields are used.
			transformStyle: () => ({}) as CSSStyleDeclaration,
		},
		targetPlugins: INLINE_SUGGESTION_TARGET_PLUGINS,
	},
	render: {
		belowNodes: SuggestionLineBreak,
		belowRootNodes: VoidRemoveSuggestionOverlay,
		node: SuggestionLeaf,
	},
});

const trailingBlockPlugin = TrailingBlockPlugin.configure({
	options: {
		insert: (editor, { insert }) => {
			editor.getApi(suggestionPlugin).suggestion.withoutSuggestions(insert);
		},
	},
});

export const SuggestionKit = [suggestionPlugin, trailingBlockPlugin];
