import {
	type DocLinkItem,
	setDocLinkProvider,
} from "@ryu/ui/lib/editor-doc-links";
import { useEffect, useRef } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createPage as apiCreatePage,
	fetchDocuments,
} from "@/src/lib/api/spaces.ts";
import { useActiveNode } from "./useActiveNode.ts";

const MAX_SUGGESTIONS = 20;

/**
 * Registers the editor's document-link provider for a Space, so `[[wikilinks]]`
 * and `@mentions` resolve to real documents: the `[[`/`@` comboboxes search this
 * Space's pages, chips resolve titles synchronously, pending links create a page
 * on click, and navigation opens the target's editor tab.
 *
 * The provider is a single global seam in `@ryu/ui`, so the most-recently-mounted
 * document editor wins — fine for the common single-Space workflow. Mount this in
 * the page editor.
 */
export function useRegisterDocLinks(spaceId: string): void {
	const activeNode = useActiveNode();
	const { url } = activeNode;
	const token = activeNode.token ?? null;
	const { openTab } = useTabsContext();

	// Synchronous title→doc cache for `resolveByTitle` (used during render).
	const docsRef = useRef<DocLinkItem[]>([]);

	useEffect(() => {
		let cancelled = false;
		const target: ApiTarget = { url, token };

		fetchDocuments(target, spaceId)
			.then((docs) => {
				if (!cancelled) {
					docsRef.current = docs.map((d) => ({ id: d.id, title: d.title }));
				}
			})
			.catch(() => {
				// keep the last cache on failure.
			});

		setDocLinkProvider({
			search: (query) => {
				const q = query.trim().toLowerCase();
				const items = docsRef.current;
				const matched = q
					? items.filter((d) => d.title.toLowerCase().includes(q))
					: items;
				return Promise.resolve(matched.slice(0, MAX_SUGGESTIONS));
			},
			resolveByTitle: (title) => {
				const t = title.trim().toLowerCase();
				return docsRef.current.find((d) => d.title.toLowerCase() === t) ?? null;
			},
			createPage: async (title) => {
				const id = await apiCreatePage(target, spaceId, title);
				const item: DocLinkItem = { id, title };
				docsRef.current = [...docsRef.current, item];
				return item;
			},
			openDoc: (id) => {
				openTab(`/spaces/${spaceId}/doc/${id}`);
			},
		});

		return () => {
			cancelled = true;
			setDocLinkProvider(null);
		};
	}, [url, token, spaceId, openTab]);
}
