"use client";

import {
	type BaseCommentConfig,
	BaseCommentPlugin,
	getDraftCommentKey,
} from "@platejs/comment";
import { CommentLeaf } from "@ryu/ui/components/editor/ui/comment-node.tsx";
import type { ExtendConfig, Path } from "platejs";
import { toTPlatePlugin } from "platejs/react";
import { getDiscussionClickTarget } from "./discussion-kit.tsx";

type CommentConfig = ExtendConfig<
	BaseCommentConfig,
	{
		activeId: string | null;
		commentingBlock: Path | null;
		hoverId: string | null;
	}
>;

export const commentPlugin = toTPlatePlugin<CommentConfig>(BaseCommentPlugin, {
	handlers: {
		onClick: ({ api, event, setOption, type }) => {
			const activeTarget = getDiscussionClickTarget({
				selector: `.slate-${type}`,
				target: event.target,
			});

			if (!activeTarget) {
				setOption("activeId", null);
				return;
			}

			const commentEntry = api.comment?.node();

			setOption(
				"activeId",
				commentEntry ? (api.comment?.nodeId(commentEntry[0]) ?? null) : null
			);
		},
	},
	options: {
		activeId: null,
		commentingBlock: null,
		hoverId: null,
	},
})
	.extendTransforms(
		({
			editor,
			setOption,
			tf: {
				comment: { setDraft },
			},
		}) => ({
			setDraft: () => {
				if (editor.api.isCollapsed()) {
					editor.tf.select(editor.api.block()?.[1]);
				}

				setDraft();

				editor.tf.collapse();
				setOption("activeId", getDraftCommentKey());
				setOption("commentingBlock", editor.selection?.focus.path.slice(0, 1));
			},
		})
	)
	.configure({
		node: { component: CommentLeaf },
		shortcuts: {
			setDraft: { keys: "mod+shift+m" },
		},
	});

export const CommentKit = [commentPlugin];
