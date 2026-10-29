import { BaseEditorKit } from "@ryu/ui/components/editor/editor-base-kit.tsx";
import { MarkdownKit } from "@ryu/ui/components/editor/plugins/markdown-kit.tsx";
import { EditorStatic } from "@ryu/ui/components/editor/ui/editor-static.tsx";
import { createSlateEditor } from "platejs";
import { useMemo } from "react";

const markdownPlugin = MarkdownKit.find((plugin) => plugin.key === "markdown")!;

export function PagePreview({ source }: { source: string }) {
	const editor = useMemo(
		() =>
			createSlateEditor({
				plugins: BaseEditorKit,
				value: (currentEditor) =>
					currentEditor
						.getApi(markdownPlugin)
						.markdown.deserialize(source || ""),
			}),
		[source]
	);
	return (
		<div className="px-4 py-3 text-sm [&_.slate-p]:leading-5">
			<EditorStatic
				className="pointer-events-none max-h-44 overflow-hidden [&_.slate-p]:my-0"
				editor={editor}
				variant="none"
			/>
		</div>
	);
}
