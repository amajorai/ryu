"use client";

import {
	WIKILINK_INPUT_KEY,
	WIKILINK_KEY,
	WikiLinkElement,
	WikiLinkInputElement,
} from "@ryu/ui/components/editor/ui/wikilink-node.tsx";
import { createSlatePlugin, createTSlatePlugin } from "platejs";
import { toPlatePlugin } from "platejs/react";

const BaseWikiLinkInputPlugin = createSlatePlugin({
	key: WIKILINK_INPUT_KEY,
	node: { isElement: true, isInline: true, isVoid: true },
});

// Unlike `@mention` (a single trigger char), Obsidian's `[[` is two characters.
// `@platejs/combobox`'s `withTriggerCombobox` only consumes the trigger char, so
// a plain `[` trigger would leave a stray `[` before the input. Instead we own
// `insertText`: when a second `[` is typed right after a `[`, we delete that
// first bracket and open the combobox input in its place — a clean `[[`.
const BaseWikiLinkPlugin = createTSlatePlugin({
	key: WIKILINK_KEY,
	node: {
		isElement: true,
		isInline: true,
		isMarkableVoid: true,
		isVoid: true,
	},
	plugins: [BaseWikiLinkInputPlugin],
}).overrideEditor(({ editor, tf: { insertText } }) => ({
	transforms: {
		insertText(text, options) {
			if (!options?.at && editor.selection && text === "[") {
				const before = editor.api.range("before", editor.selection);
				const previous = before ? editor.api.string(before) : "";
				if (previous.endsWith("[")) {
					editor.tf.delete({ reverse: true, unit: "character" });
					const inputNode: {
						children: { text: string }[];
						trigger: string;
						type: string;
						userId?: string;
					} = {
						children: [{ text: "" }],
						trigger: "[[",
						type: WIKILINK_INPUT_KEY,
					};
					if (editor.meta.userId) {
						inputNode.userId = editor.meta.userId;
					}
					editor.tf.insertNodes(inputNode, options);
					return;
				}
			}
			insertText(text, options);
		},
	},
}));

const WikiLinkPlugin = toPlatePlugin(BaseWikiLinkPlugin);
const WikiLinkInputPlugin = toPlatePlugin(BaseWikiLinkInputPlugin);

export const WikiLinkKit = [
	WikiLinkPlugin.withComponent(WikiLinkElement),
	WikiLinkInputPlugin.withComponent(WikiLinkInputElement),
];

/**
 * Non-React registration of the wikilink node type, for the static
 * {@link BaseEditorKit} (markdown serialize/deserialize). The markdown handling
 * itself lives in `MarkdownKit`'s rules; this just makes the `wikilink` node type
 * known in base contexts. `BaseWikiLinkInputPlugin` is nested under the parent.
 */
export const BaseWikiLinkKit = [BaseWikiLinkPlugin];
