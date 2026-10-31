import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";
import type { RichPatchDiffProps } from "./RichPatchDiff.tsx";

// The review renderer (@pierre/diffs with its editor and Shiki) only matters
// once a diff pane opens, so the chat route does not carry it.
const richPatchDiff = preloadableLazy<RichPatchDiffProps>(() =>
	import("./RichPatchDiff.tsx").then((module) => module.RichPatchDiff)
);

/** `RichPatchDiff`, loaded on first use behind skeleton rows. */
export function LazyRichPatchDiff(props: RichPatchDiffProps) {
	return (
		<richPatchDiff.Render
			{...props}
			fallback={<SkeletonRows rows={6} spacing="review" />}
		/>
	);
}
