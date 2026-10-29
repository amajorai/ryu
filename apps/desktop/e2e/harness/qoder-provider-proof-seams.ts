export function useActiveNode() {
	return {
		id: "qoder-proof",
		name: "Regional CLI fixture node",
		url: window.location.origin,
		token: null,
		userJwt: null,
		managed: false,
	};
}
