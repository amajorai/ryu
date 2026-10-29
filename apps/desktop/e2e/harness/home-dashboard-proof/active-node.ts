export function useActiveNode() {
	return {
		url: window.location.origin,
		token: "home-dashboard-proof-token",
		userJwt: null,
	};
}
