import type { Node } from "@/src/store/useNodeStore.ts";

// Synthetic node admission credentials; no real account or Core is contacted.
export function useActiveNode(): Node {
	return {
		name: "selected-calendar-core",
		url: `${window.location.origin}/selected-core/`,
		token: "calendar-node-fixture",
		userJwt: "calendar-delegation-fixture",
	};
}
