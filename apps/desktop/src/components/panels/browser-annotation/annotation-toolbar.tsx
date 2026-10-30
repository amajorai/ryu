// The annotation toolbar above the browser frame, split out of
// apps/desktop/src/components/panels/BrowserAnnotationSurface.tsx so that file
// stays under the size limit.

import { Comment01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { BrowserAnnotationSurfaceProps } from "./annotation-model.ts";

export function AnnotationToolbar({
	annotationCount,
	askRyuPending,
	isAnnotating,
	onAskRyu,
	onClearAnnotations,
	onToggleAnnotating,
}: Pick<
	BrowserAnnotationSurfaceProps,
	"isAnnotating" | "onAskRyu" | "onClearAnnotations" | "onToggleAnnotating"
> & {
	annotationCount: number;
	askRyuPending: boolean;
}) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-border border-b bg-background/90 px-2 py-1.5 text-xs">
			<button
				aria-pressed={isAnnotating}
				className={cn(
					"rounded-lg border px-2 py-1 transition-colors",
					isAnnotating
						? "border-primary/50 bg-primary/10 text-primary"
						: "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
				)}
				onClick={onToggleAnnotating}
				type="button"
			>
				<HugeiconsIcon
					className="mr-1 inline-block size-3.5"
					icon={Comment01Icon}
				/>
				{isAnnotating ? "Annotation mode on" : "Annotate"}
			</button>
			<span className="text-muted-foreground">
				{isAnnotating
					? "Click an element or drag an area · Shift-click adds targets"
					: "Add visual feedback to the live browser frame"}
			</span>
			<div className="ml-auto flex items-center gap-1">
				{annotationCount > 0 && (
					<button
						className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						onClick={() => onClearAnnotations().catch(() => undefined)}
						type="button"
					>
						Clear notes
					</button>
				)}
				<button
					className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					disabled={askRyuPending || annotationCount === 0}
					onClick={onAskRyu}
					type="button"
				>
					{askRyuPending ? "Preparing notes…" : "Ask Ryu to address notes"}
				</button>
			</div>
		</div>
	);
}
