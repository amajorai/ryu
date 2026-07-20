"use client";

import { useAIChatEditor } from "@platejs/ai/react";
import { BaseEditorKit } from "@ryu/ui/components/editor/editor-base-kit.tsx";
import { usePlateEditor } from "platejs/react";
import { memo } from "react";

import { EditorStatic } from "./editor-static.tsx";

export const AIChatEditor = memo(function AIChatEditor({
	content,
}: {
	content: string;
}) {
	const aiEditor = usePlateEditor({
		plugins: BaseEditorKit,
	});

	const value = useAIChatEditor(aiEditor, content);

	return <EditorStatic editor={aiEditor} value={value} variant="aiChat" />;
});
