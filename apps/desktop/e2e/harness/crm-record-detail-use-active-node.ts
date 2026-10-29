const activeNode = { token: null, url: window.location.origin, userJwt: null };

export function useActiveNode() {
	return activeNode;
}
