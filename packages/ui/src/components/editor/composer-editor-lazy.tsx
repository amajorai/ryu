"use client";

import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback } from "react";
import type { ComposerEditorProps } from "./composer-editor.tsx";

// The rich (Plate) composer carries slate, KaTeX, the emoji dataset, the MDX
// parser and every editor plugin: several megabytes the default plain-textarea
// composer never needs. It loads only where the markdown composer is switched on.
const composerEditor = preloadableLazy<ComposerEditorProps>(() =>
	import("./composer-editor.tsx").then((module) => module.ComposerEditor)
);

/** Start fetching the rich composer without rendering it. */
export function preloadComposerEditor(): void {
	composerEditor.preload().catch(() => undefined);
}

/**
 * Same box and type metrics as the editor surface, so the swap to the live
 * editor does not move the composer. It holds `editorRef` while the editor
 * loads, so a focus request (autofocus on mount, a container click) lands
 * here and is handed to the live editor once it replaces the fallback.
 */
function ComposerEditorFallback({
	disabled,
	editorRef,
	markdown,
	placeholder,
}: Pick<
	ComposerEditorProps,
	"disabled" | "editorRef" | "markdown" | "placeholder"
>) {
	const attachRef = useCallback(
		(node: HTMLDivElement | null) => {
			if (editorRef) {
				editorRef.current = node;
			}
			if (!node) {
				return;
			}
			return () => {
				if (editorRef?.current === node) {
					editorRef.current = null;
				}
				// Detached while still in the document, so a focused fallback is
				// still the active element. The live editor commits in the same
				// pass; hand it the focus once its ref is attached.
				if (document.activeElement === node) {
					requestAnimationFrame(() => editorRef?.current?.focus());
				}
			};
		},
		[editorRef]
	);
	return (
		<div
			aria-busy="true"
			className={cn(
				"max-h-[240px] min-h-[40px] overflow-hidden whitespace-pre-wrap break-words px-0 py-1.5 text-[14px] leading-[1.6] outline-none",
				markdown ? "text-foreground" : "text-muted-foreground",
				disabled && "opacity-50"
			)}
			data-slot="composer-editor-fallback"
			ref={attachRef}
			tabIndex={-1}
		>
			{markdown || placeholder}
		</div>
	);
}

export function LazyComposerEditor(props: ComposerEditorProps) {
	return (
		<composerEditor.Render
			{...props}
			fallback={
				<ComposerEditorFallback
					disabled={props.disabled}
					editorRef={props.editorRef}
					markdown={props.markdown}
					placeholder={props.placeholder}
				/>
			}
		/>
	);
}
