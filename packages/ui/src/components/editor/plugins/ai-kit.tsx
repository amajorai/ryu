"use client";

import { BaseAIPlugin, withAIBatch } from "@platejs/ai";
import {
	AIChatPlugin,
	AIPlugin,
	applyAISuggestions,
	getInsertPreviewStart,
	streamInsertChunk,
	useChatChunk,
} from "@platejs/ai/react";
import { AILoadingBar, AIMenu } from "@ryu/ui/components/editor/ui/ai-menu.tsx";
import {
	AIAnchorElement,
	AILeaf,
} from "@ryu/ui/components/editor/ui/ai-node.tsx";
import cloneDeep from "lodash/cloneDeep.js";
import { ElementApi, getPluginType, KEYS, PathApi } from "platejs";
import { usePluginOption } from "platejs/react";

import { useChat } from "../use-chat.ts";
import { CursorOverlayKit } from "./cursor-overlay-kit.tsx";
import { MarkdownKit } from "./markdown-kit.tsx";

export const aiChatPlugin = AIChatPlugin.extend({
	options: {
		chatOptions: {
			// NEVER FETCHED. `use-chat.ts` installs a transport `fetch` that names its
			// URL parameter `_input` and never reads it, calling the Gateway provider
			// directly instead. `DefaultChatTransport` does not require this field —
			// it defaults to `/api/chat` — so this string is an override of one dead
			// value with another, kept only because it names the intent at the call
			// site. It is not a route, and no server has ever served it.
			//
			// It has already cost a full audit lane: a reachability scan over `/api/…`
			// string literals cannot see a `fetch` override, so this line reads as an
			// orphaned client route every time someone runs one. If that keeps
			// happening, delete the field rather than allowlisting it.
			api: "/api/ai/command",
			body: {},
		},
	},
	render: {
		afterContainer: AILoadingBar,
		afterEditable: AIMenu,
		node: AIAnchorElement,
	},
	shortcuts: { show: { keys: "mod+j" } },
	useHooks: ({ editor, getOption }) => {
		useChat();

		const mode = usePluginOption(AIChatPlugin, "mode");
		const toolName = usePluginOption(AIChatPlugin, "toolName");
		useChatChunk({
			onChunk: ({ chunk, isFirst, nodes, text: content }) => {
				if (isFirst && mode === "insert") {
					const { startBlock, startInEmptyParagraph } =
						getInsertPreviewStart(editor);

					editor.getTransforms(BaseAIPlugin).ai.beginPreview({
						originalBlocks:
							startInEmptyParagraph &&
							startBlock &&
							ElementApi.isElement(startBlock)
								? [cloneDeep(startBlock)]
								: [],
					});

					editor.tf.withoutSaving(() => {
						const selectionPath = editor.selection?.focus.path;
						if (!selectionPath) {
							return;
						}
						editor.tf.insertNodes(
							{
								children: [{ text: "" }],
								type: getPluginType(editor, KEYS.aiChat),
							},
							{
								at: PathApi.next(selectionPath.slice(0, 1)),
							}
						);
					});
					editor.setOption(AIChatPlugin, "streaming", true);
				}

				if (mode === "insert" && nodes.length > 0) {
					editor.tf.withoutSaving(() => {
						if (!getOption("streaming")) {
							return;
						}

						editor.tf.withScrolling(() => {
							streamInsertChunk(editor, chunk, {
								textProps: {
									[getPluginType(editor, KEYS.ai)]: true,
								},
							});
						});
					});
				}

				if (toolName === "edit" && mode === "chat") {
					withAIBatch(
						editor,
						() => {
							applyAISuggestions(editor, content);
						},
						{
							split: isFirst,
						}
					);
				}
			},
			onFinish: () => {
				editor.getApi(AIChatPlugin).aiChat.stop();
			},
		});
	},
});

export const AIKit = [
	...CursorOverlayKit,
	...MarkdownKit,
	AIPlugin.withComponent(AILeaf),
	aiChatPlugin,
];
