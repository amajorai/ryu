import { type ApiTarget, toTarget } from "../../src/lib/api/client.ts";

function liveProofNode() {
	return {
		id: "provider-runtime-live-proof",
		name: "Isolated provider runtime verification",
		url: window.location.origin,
		token: null,
		userJwt: null,
		managed: false,
	};
}
// Stable like the real hooks' memoized target and `useCallback` getters: the
// settings sections key their reads on these, so a fresh identity per render
// would refetch in a loop.
const liveProofTarget = toTarget(liveProofNode());
function getLiveProofTarget(): ApiTarget {
	return liveProofTarget;
}

export function useActiveNodeGetter() {
	return liveProofNode;
}

export function useActiveNode() {
	return liveProofNode();
}

export function useActiveTarget(): ApiTarget {
	return liveProofTarget;
}

export function useActiveTargetGetter(): () => ApiTarget {
	return getLiveProofTarget;
}

export function useGatewayConfigurable() {
	return true;
}

// The real hook fails open for a local node without org permissions loaded,
// which is what this isolated profile is; the Gateway still enforces writes.
export function useCanManagePermission() {
	return true;
}
