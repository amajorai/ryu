import { useCallback } from "react";
import { useCurrentTabId } from "@/src/contexts/TabsContext.tsx";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useNodeTabOverride } from "./useNodeDisplayMode.ts";

// Resolves the node a tab should talk to. When the per-tab override feature is
// on and the surrounding tab has a node override set, returns that node;
// otherwise falls back to the default node. Outside any tab (e.g. the sidebar)
// `useCurrentTabId()` is undefined, so this is equivalent to the default node.
export function useActiveNode(): Node {
	const tabId = useCurrentTabId();
	const overrideEnabled = useNodeTabOverride();
	return useNodeStore((s) =>
		s.getActiveNode(overrideEnabled ? tabId : undefined)
	);
}

// Stable getter form for imperative call sites (effects, event handlers) that
// previously grabbed `getActiveNode` off the store directly. Honors the same
// per-tab override resolution as `useActiveNode`.
export function useActiveNodeGetter(): () => Node {
	const tabId = useCurrentTabId();
	const overrideEnabled = useNodeTabOverride();
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	return useCallback(
		() => getActiveNode(overrideEnabled ? tabId : undefined),
		[getActiveNode, overrideEnabled, tabId]
	);
}
