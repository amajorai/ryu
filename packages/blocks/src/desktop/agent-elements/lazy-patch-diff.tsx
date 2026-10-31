"use client";

import type { PatchDiffProps } from "@pierre/diffs/react";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { preloadableLazy } from "@ryu/ui/lib/preloadable-lazy.tsx";

// @pierre/diffs carries Shiki and its grammars. Diff previews live in hover
// cards and review panes, never in the first paint, so the renderer loads the
// first time one opens.
const patchDiff = preloadableLazy<PatchDiffProps<undefined>>(() =>
	import("@pierre/diffs/react").then((module) => module.PatchDiff)
);

/** Start fetching the diff renderer without rendering it. */
export function preloadPatchDiff(): Promise<void> {
	return patchDiff.preload();
}

/** `PatchDiff`, loaded on first use behind a few skeleton rows. */
export function LazyPatchDiff(props: PatchDiffProps<undefined>) {
	return <patchDiff.Render {...props} fallback={<SkeletonRows rows={4} />} />;
}
