import { useCallback, useEffect, useRef } from "react";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Fence a dialog operation to its captured node credentials and visible intent.
 * The remote mutation may finish; only its current owner may adopt the result. */
export function useProjectOperationGuard(open: boolean) {
	const getActiveNode = useActiveNodeGetter();
	const epoch = useRef(0);
	const latestGetter = useRef(getActiveNode);
	if (latestGetter.current !== getActiveNode) {
		epoch.current++;
		latestGetter.current = getActiveNode;
	}
	const openRef = useRef(open);
	const disposeActive = useRef<(() => void) | null>(null);
	if (openRef.current !== open) {
		epoch.current++;
		openRef.current = open;
	}
	useEffect(
		() => () => {
			epoch.current++;
			disposeActive.current?.();
		},
		[]
	);
	useEffect(() => {
		if (!open) {
			disposeActive.current?.();
		}
	}, [open]);

	return useCallback(() => {
		disposeActive.current?.();
		const intent = ++epoch.current;
		const node = latestGetter.current();
		const identity = (value: typeof node) =>
			JSON.stringify([value.url, value.token, value.userJwt ?? null]);
		const authority = identity(node);
		let changed = false;
		let disposed = false;
		const unsubscribe = useNodeStore.subscribe(() => {
			if (identity(latestGetter.current()) !== authority) {
				changed = true;
			}
		});
		const dispose = () => {
			if (disposed) {
				return;
			}
			disposed = true;
			unsubscribe();
			if (disposeActive.current === dispose) {
				disposeActive.current = null;
			}
		};
		disposeActive.current = dispose;
		return {
			node,
			getNode: () => latestGetter.current(),
			isCurrent: () =>
				openRef.current &&
				epoch.current === intent &&
				!changed &&
				identity(latestGetter.current()) === authority,
			dispose,
		};
	}, [getActiveNode]);
}
