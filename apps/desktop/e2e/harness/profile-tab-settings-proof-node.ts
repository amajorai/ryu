import type { Node } from "../../src/store/useNodeStore.ts";

const localProfileProofNode: Node = {
	name: "local-profile-proof",
	url: window.location.origin,
	token: null,
	userJwt: null,
};

export function useActiveNode(): Node {
	return localProfileProofNode;
}
