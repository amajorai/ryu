import { useCallback, useMemo } from "react";
import { type ApiTarget, toTarget } from "../../src/lib/api/client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";

export function useActiveNode() {
	return useNodeStore((state) => state.getActiveNode());
}

export function useActiveNodeGetter() {
	return useCallback(() => useNodeStore.getState().getActiveNode(), []);
}

export function useActiveTarget(): ApiTarget {
	const { url, token, userJwt } = useActiveNode();
	return useMemo(
		() => toTarget({ url, token, userJwt }),
		[url, token, userJwt]
	);
}

export function useActiveTargetGetter(): () => ApiTarget {
	const getNode = useActiveNodeGetter();
	return useCallback(() => toTarget(getNode()), [getNode]);
}
