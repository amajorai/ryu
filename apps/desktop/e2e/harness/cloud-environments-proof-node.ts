export function useActiveNode() {
	return {
		url: window.location.origin,
		token: "cloud-proof-node-token",
		userJwt: "cloud-proof-user-identity",
	};
}
