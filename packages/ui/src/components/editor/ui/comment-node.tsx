"use client";

import { getCommentCount } from "@platejs/comment";
import { commentPlugin } from "@ryu/ui/components/editor/plugins/comment-kit.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TCommentText } from "platejs";
import type { PlateLeafProps } from "platejs/react";
import { PlateLeaf, useEditorPlugin, usePluginOption } from "platejs/react";

export function CommentLeaf(props: PlateLeafProps<TCommentText>) {
	const { children, leaf } = props;

	const { api, setOption } = useEditorPlugin(commentPlugin);
	const hoverId = usePluginOption(commentPlugin, "hoverId");
	const activeId = usePluginOption(commentPlugin, "activeId");

	const isOverlapping = getCommentCount(leaf) > 1;
	const currentId = api.comment.nodeId(leaf);
	const isActive = activeId === currentId;
	const isHover = hoverId === currentId;

	return (
		<PlateLeaf
			{...props}
			attributes={{
				...props.attributes,
				onClick: () => setOption("activeId", currentId ?? null),
				onMouseEnter: () => setOption("hoverId", currentId ?? null),
				onMouseLeave: () => setOption("hoverId", null),
			}}
			className={cn(
				"ryu-editor-comment border-b-2 transition-colors duration-200",
				(isHover || isActive) && "ryu-editor-comment-active",
				isOverlapping && "ryu-editor-comment-overlap border-b-2",
				(isHover || isActive) &&
					isOverlapping &&
					"ryu-editor-comment-overlap-active"
			)}
		>
			{children}
		</PlateLeaf>
	);
}
