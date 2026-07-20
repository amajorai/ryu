"use client";

import { commentPlugin } from "@ryu/ui/components/editor/plugins/comment-kit.tsx";

import { MessageSquareTextIcon } from "lucide-react";
import { useEditorRef } from "platejs/react";

import { ToolbarButton } from "./toolbar.tsx";

export function CommentToolbarButton() {
	const editor = useEditorRef();

	return (
		<ToolbarButton
			data-plate-prevent-overlay
			onClick={() => {
				editor.getTransforms(commentPlugin).comment.setDraft();
			}}
			tooltip="Comment"
		>
			<MessageSquareTextIcon />
		</ToolbarButton>
	);
}
