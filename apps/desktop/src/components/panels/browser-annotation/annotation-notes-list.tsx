// The saved-annotation list under the browser frame, split out of
// apps/desktop/src/components/panels/BrowserAnnotationSurface.tsx so that file
// stays under the size limit.

import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	BrowserAnnotation,
	BrowserAnnotationSurfaceProps,
} from "./annotation-model.ts";

export function AnnotationNotesList({
	annotations,
	onDeleteAnnotation,
}: {
	annotations: readonly BrowserAnnotation[];
	onDeleteAnnotation: BrowserAnnotationSurfaceProps["onDeleteAnnotation"];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="max-h-32 shrink-0 space-y-1 overflow-y-auto border-border border-t bg-background p-2">
			{annotations.map((annotation, index) => (
				<div
					className="flex items-start gap-2 rounded-lg bg-highlight/10 px-2 py-1.5 text-xs dark:bg-highlight/10"
					key={annotation.id}
				>
					<span className="mt-0.5 rounded-full bg-highlight px-1.5 py-0.5 font-medium text-black text-xs">
						{index + 1}
					</span>
					<p className="min-w-0 flex-1 text-foreground">{annotation.comment}</p>
					<button
						aria-label={tl("Remove annotation {index}", { index: index + 1 })}
						className="text-muted-foreground hover:text-foreground"
						onClick={() =>
							onDeleteAnnotation(annotation.id).catch(() => undefined)
						}
						type="button"
					>
						×
					</button>
				</div>
			))}
		</div>
	);
}
