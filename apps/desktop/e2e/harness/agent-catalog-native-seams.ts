// Host-only seams. Catalog reads and add/remove mutations use the real Core.
// Cloud purchases/templates and settings navigation are outside this proof.
export function useActiveNode() {
	return { url: "http://127.0.0.1:5197/core", token: null, userJwt: null };
}
export async function getRealtimeJwt() {
	return null;
}
export function usePluginSettingsOpener() {
	return () => null;
}
export function useCommunityAgents() {
	return {
		agents: [],
		error: null,
		loading: false,
		pendingId: null,
		refresh: async () => {},
		install: async () => {
			throw new Error("Cloud templates are outside this native runtime proof");
		},
	};
}
export function useMarketplacePurchase() {
	return {
		buying: null,
		buy: async () => {
			throw new Error("Purchases are outside this native runtime proof");
		},
	};
}
