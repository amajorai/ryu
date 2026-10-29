import { fetchDocument, updateDocument } from "@/src/lib/api/spaces.ts";

const node = {
	url: window.location.origin,
	token: "column-proof-node-token",
	userJwt: null,
};
const tabs = {
	tabs: [],
	updateTabTitle: () => undefined,
	openTab: () => undefined,
};
const spaces = {
	getDocument: (spaceId: string, documentId: string) =>
		fetchDocument(node, spaceId, documentId),
	saveDocument: async (
		spaceId: string,
		documentId: string,
		title: string,
		source: string
	) => {
		await updateDocument(node, spaceId, documentId, title, source);
	},
};

export function useSpacesContext() {
	return spaces;
}
export function useActiveNode() {
	return node;
}
export function useTabsContext() {
	return tabs;
}
export function useCurrentTabId() {
	return undefined;
}
export function useTabSelector<T>(selector: (state: typeof tabs) => T): T {
	return selector(tabs);
}

// The host access projection is fixture-controlled; the page and Core document client stay real.
export function useDatabaseCollab() {
	return {
		access:
			new URLSearchParams(window.location.search).get("access") === "read"
				? "read"
				: "write",
		collaborative: false,
		getCollabDoc: () => null,
		status: "disconnected",
	};
}
