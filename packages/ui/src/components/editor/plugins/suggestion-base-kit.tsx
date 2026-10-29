import { BaseSuggestionPlugin } from "@platejs/suggestion";
import {
	SuggestionLeafStatic,
	VoidRemoveSuggestionOverlayStatic,
} from "@ryu/ui/components/editor/ui/suggestion-node-static.tsx";
import type { SlateEditor, TElement, TSuggestionText } from "platejs";
import { KEYS, TextApi } from "platejs";
import { isNativeFunction } from "../../../lib/native-primitive-observation.ts";

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

export const BaseSuggestionKit = [
	BaseSuggestionPlugin.configure({
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
			belowRootNodes: VoidRemoveSuggestionOverlayStatic,
			node: SuggestionLeafStatic,
		},
	}),
];
