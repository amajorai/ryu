"use client";
import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";
import { cn } from "@ryu/ui/lib/utils";
import styles from "./markdown.module.css";
import type { MarkdownProps } from "./markdown-content.ts";

export type { FileReference, MarkdownProps } from "./markdown-content.ts";
export { MarkdownResponseImages } from "./markdown-response-images.ts";

// Streamdown and everything behind it (remark/rehype, Shiki, KaTeX, Mermaid's
// loader) is several megabytes that no first paint needs: a new chat has no
// reply to render. The renderer loads on the first reply, and the desktop
// shell warms it in idle time so an opened conversation renders straight away.
const streamdownMarkdown = preloadableLazy<MarkdownProps>(() =>
	import("./markdown-streamdown.tsx").then(
		(module) => module.StreamdownMarkdown
	)
);

/**
 * Fetch the Markdown renderer now. Once it resolves, every `Markdown` mounted
 * afterwards renders synchronously, with no fallback frame.
 */
export function preloadMarkdown(): Promise<void> {
	return streamdownMarkdown.preload();
}

/** The reply's raw text in the renderer's box while the renderer loads. */
function MarkdownFallback({
	className,
	content,
}: Pick<MarkdownProps, "className" | "content">) {
	return (
		<div
			className={cn(
				styles.markdown,
				"wrap-break-word overflow-hidden whitespace-pre-wrap",
				className
			)}
			data-ryu-i18n="off"
		>
			{content}
		</div>
	);
}

export function Markdown(props: MarkdownProps) {
	return (
		<streamdownMarkdown.Render
			{...props}
			fallback={
				<MarkdownFallback className={props.className} content={props.content} />
			}
		/>
	);
}
