import { useEffect, useState } from "react";
export const TOKEN_KEY = "library-source-proof-session";
export const getRealtimeJwt = async () => null;
export function useActiveNode() {
	const [node, setNode] = useState({
		url: window.location.origin,
		token: "collection-token",
		userJwt: null,
	});
	useEffect(() => {
		const change = (event: Event) =>
			// SAFETY: library-source-proof.spec.ts publishes collection-node with the complete local node fields: origin URL, string token, and null userJwt. This controlled dispatcher is the fixture contract, not foreign event validation.
			setNode((event as CustomEvent<typeof node>).detail);
		window.addEventListener("collection-node", change);
		return () => window.removeEventListener("collection-node", change);
	}, []);
	return node;
}
// One stable state object: the real Tabs store hands `useTabSelector` the same
// `openTab` action on every read, and `ContributedLibrarySection` selects it
// instead of reading the whole context. `useTabsContext` returns the same object
// so a consumer on either hook dispatches the same `collection-open` event.
const tabsState = {
	openTab: <Options>(path: string, options: Options) => {
		window.dispatchEvent(
			new CustomEvent("collection-open", { detail: { path, options } })
		);
		return "opened";
	},
};
export function useTabSelector<Selected>(
	selector: (state: typeof tabsState) => Selected
) {
	return selector(tabsState);
}
export function useTabsContext() {
	return tabsState;
}
