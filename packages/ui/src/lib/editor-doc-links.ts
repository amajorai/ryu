// Swappable provider that resolves inter-document links (wiki `[[...]]` and
// `@mentions`) to real Space documents. `@ryu/ui` stays Core-agnostic: the host
// app (the desktop) registers a provider that searches the active Space, resolves
// titles, creates pending pages on demand, and navigates to a document.
//
// Default (no host registered): an empty no-op provider, so the editor still runs
// standalone — links simply render as plain, unresolved chips.

export interface DocLinkItem {
	id: string;
	title: string;
}

export interface DocLinkProvider {
	/** Create a page for a pending link target and return it. */
	createPage: (title: string) => Promise<DocLinkItem>;
	/** Navigate to a document (open its editor tab/surface). */
	openDoc: (id: string) => void;
	/** Resolve a title to an existing document, or `null` when it does not exist. */
	resolveByTitle: (title: string) => DocLinkItem | null;
	/** Live search of the current Space's documents by title. */
	search: (query: string) => Promise<DocLinkItem[]>;
}

const noopProvider: DocLinkProvider = {
	search: () => Promise.resolve([]),
	resolveByTitle: () => null,
	createPage: (title) => Promise.resolve({ id: "", title }),
	openDoc: () => {
		// no-op: standalone editor has nowhere to navigate.
	},
};

let activeProvider: DocLinkProvider = noopProvider;

/** Host apps register their document-link provider here. Pass null to reset. */
export function setDocLinkProvider(provider: DocLinkProvider | null): void {
	activeProvider = provider ?? noopProvider;
}

/** Editor nodes read the current provider through this. */
export function getDocLinkProvider(): DocLinkProvider {
	return activeProvider;
}
