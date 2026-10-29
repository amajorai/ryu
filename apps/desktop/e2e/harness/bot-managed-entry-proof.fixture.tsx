import { create } from "zustand";

const node = {
	name: "Managed Bot proof",
	url: window.location.origin,
	token: "bot-proof-admission",
	managed: true,
};
const entitlement = { managedInference: true };
export const useNodeStore = create<{
	cloudNodes: (typeof node)[];
	nodes: (typeof node)[];
	defaultNode: string;
	getActiveNode: () => typeof node;
	hydrateCloudNodes: () => Promise<void>;
}>(() => ({
	cloudNodes: [],
	nodes: [],
	defaultNode: "",
	getActiveNode: () =>
		useNodeStore
			.getState()
			.nodes.find(
				(candidate) => candidate.name === useNodeStore.getState().defaultNode
			) ?? node,
	hydrateCloudNodes: async () => {
		useNodeStore.setState({ cloudNodes: [node] });
	},
}));
export function useCreditsWallet() {
	return { entitlement, loading: false, refresh: async () => undefined };
}
export const TOKEN_KEY = "bot-proof-account-token";
export async function getRealtimeJwt() {
	return null;
}
export async function openExternal() {
	/* Native external navigation is outside this entry proof. */
}

// The entry card/handler and preference client are production. Full chat layout
// is a separate host proof; reaching this marker only records the dispatch.
export default function ReadyHostBoundary() {
	return (
		<main data-testid="bot-ready-host-boundary">
			Bot entry confirmed; chat host is outside this fixture.
		</main>
	);
}
