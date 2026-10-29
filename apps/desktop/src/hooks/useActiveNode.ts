import { useCallback, useMemo } from "react";
import { useNodeScope } from "@/src/contexts/NodeScopeContext.tsx";
import { useCurrentTabId } from "@/src/contexts/TabsContext.tsx";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useNodeTabOverride } from "./useNodeDisplayMode.ts";

type NodeResolutionState = Pick<
	ReturnType<typeof useNodeStore.getState>,
	"getActiveNode" | "nodes"
>;

// Precedence: dialog scope (when it names a known node) -> tab override ->
// auto-select -> default -> LOCAL_FALLBACK. Always returns an element of
// `nodes` or the LOCAL_FALLBACK constant, so it is safe as a zustand selector.
export function resolveScopedNode(
	state: NodeResolutionState,
	scope: string | undefined,
	tabId: string | undefined
): Node {
	if (scope !== undefined) {
		const scoped = state.nodes.find((n) => n.name === scope);
		if (scoped) {
			return scoped;
		}
	}
	return state.getActiveNode(tabId);
}

// Resolves the node a surface should talk to. Inside a `NodeScopeProvider`
// (the node settings dialog) that is the dialog's chosen computer. Otherwise,
// when the per-tab override feature is on and the surrounding tab has a node
// override set, returns that node; otherwise falls back to the default node.
// Outside any tab (e.g. the sidebar) `useCurrentTabId()` is undefined, so this
// is equivalent to the default node.
export function useActiveNode(): Node {
	const scope = useNodeScope();
	const tabId = useCurrentTabId();
	const overrideEnabled = useNodeTabOverride();
	return useNodeStore((s) =>
		resolveScopedNode(s, scope, overrideEnabled ? tabId : undefined)
	);
}

// Stable getter form for imperative call sites (effects, event handlers) that
// previously grabbed `getActiveNode` off the store directly. Honors the same
// scope and per-tab override resolution as `useActiveNode`.
export function useActiveNodeGetter(): () => Node {
	const scope = useNodeScope();
	const tabId = useCurrentTabId();
	const overrideEnabled = useNodeTabOverride();
	return useCallback(
		() =>
			resolveScopedNode(
				useNodeStore.getState(),
				scope,
				overrideEnabled ? tabId : undefined
			),
		[scope, overrideEnabled, tabId]
	);
}

/** `useActiveNode()` narrowed to an {@link ApiTarget}, stable per credential. */
export function useActiveTarget(): ApiTarget {
	const { url, token, userJwt } = useActiveNode();
	return useMemo(
		() => toTarget({ url, token, userJwt }),
		[url, token, userJwt]
	);
}

/** Getter form of {@link useActiveTarget} for effects and event handlers. */
export function useActiveTargetGetter(): () => ApiTarget {
	const getNode = useActiveNodeGetter();
	return useCallback(() => toTarget(getNode()), [getNode]);
}
