import {
	createPage,
	fetchDocument,
	updateDocument,
} from "@/src/lib/api/spaces.ts";

const node = {
	url: window.location.origin,
	token: "row-proof-node-token",
	userJwt: null,
};
interface TabOpen {
	options?: unknown;
	path: string;
}
const tabOpens: TabOpen[] = [];
const tabs = {
	tabs: [],
	updateTabTitle: () => undefined,
	openTab: <Options>(path: string, options?: Options) => {
		tabOpens.push({ path, options });
		window.dispatchEvent(
			new CustomEvent("row-proof-open-tab", { detail: path })
		);
	},
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
	createPage: (spaceId: string, title: string, parentId?: string) =>
		createPage(node, spaceId, title, parentId),
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
Object.assign(window, { __databaseRowProof: { tabOpens } });
