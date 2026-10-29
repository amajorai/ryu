import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { type ComponentProps, lazy, Suspense } from "react";

export type { MarkdownCollab } from "./MarkdownEditorContent.tsx";

type MarkdownEditorProps = ComponentProps<
	typeof import("./MarkdownEditorContent.tsx").MarkdownEditor
>;
const EditorContent = lazy(() =>
	import("./MarkdownEditorContent.tsx").then((module) => ({
		default: module.MarkdownEditor,
	}))
);

/** Load the editor toolkit only when a real editor is mounted. */
export function MarkdownEditor(props: MarkdownEditorProps) {
	return (
		<Suspense fallback={<SkeletonRows rows={6} spacing="library" />}>
			<EditorContent {...props} />
		</Suspense>
	);
}
