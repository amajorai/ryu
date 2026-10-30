import { useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type MessageSearchHit,
	searchConversations,
} from "@/src/lib/api/conversation-search.ts";
import {
	type MarketplaceCard,
	searchMarketplaceCatalog,
} from "@/src/lib/api/marketplace.ts";
import { type ShadowSearchResult, searchShadow } from "@/src/lib/api/shadow.ts";
import {
	type SpaceLexicalHit,
	searchSpaceDocuments,
} from "@/src/lib/api/spaces.ts";

/** The palette's debounced search lanes (Shadow, messages, pages, Marketplace). */
export function useCommandPaletteSearch(
	query: string,
	target: ApiTarget,
	isCurrentTarget: () => boolean
) {
	const [shadowResults, setShadowResults] = useState<ShadowSearchResult[]>([]);
	const [messageResults, setMessageResults] = useState<MessageSearchHit[]>([]);
	const [spaceResults, setSpaceResults] = useState<SpaceLexicalHit[]>([]);
	const [marketplaceResults, setMarketplaceResults] = useState<
		MarketplaceCard[]
	>([]);
	const searchAbort = useRef<AbortController | null>(null);
	const messageAbort = useRef<AbortController | null>(null);
	const spaceAbort = useRef<AbortController | null>(null);
	const marketplaceAbort = useRef<AbortController | null>(null);

	// Debounced "search everything" against Shadow's captured context (window
	// titles, clipboard, files, git, terminal, OCR). Resolves to [] when Shadow
	// is not running so the palette still works as a plain command launcher.
	useEffect(() => {
		const q = query.trim();
		searchAbort.current?.abort();
		if (q.length < 2) {
			setShadowResults([]);
			return;
		}
		const controller = new AbortController();
		searchAbort.current = controller;
		const handle = setTimeout(async () => {
			const results = await searchShadow(q, 8, controller.signal);
			if (results && !controller.signal.aborted) {
				setShadowResults(results);
			}
		}, 200);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query]);

	// Debounced exact + semantic search over past chat messages. Core puts lexical
	// FTS hits first and semantic hits after them, so literal recall stays
	// predictable without losing meaning-based matches when embeddings exist.
	// `target` is a fresh object every render; depending on its primitive fields avoids an infinite update loop (see comment on the deps array below).
	useEffect(() => {
		const q = query.trim();
		messageAbort.current?.abort();
		if (q.length < 2) {
			setMessageResults([]);
			return;
		}
		setMessageResults([]);
		const controller = new AbortController();
		messageAbort.current = controller;
		const handle = setTimeout(async () => {
			const result = await searchConversations(target, q, 8, controller.signal);
			if (result && !controller.signal.aborted && isCurrentTarget()) {
				setMessageResults(result.hits);
			}
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
		// Primitive deps only — `target` is a fresh object every render, so listing
		// it would re-run this effect each render and the early `setMessageResults([])`
		// (a fresh array, never bailed) would spin into an infinite update loop.
	}, [query, target.url, target.token, target.userJwt]);

	// Page/Space lexical search is separate from per-Space RAG search: the palette
	// needs predictable literal recall over visible metadata, page source, and
	// extracted chunks, even when no embedding model is available.
	// `target` is a fresh object every render; primitive fields are the stable request identity.
	useEffect(() => {
		const q = query.trim();
		spaceAbort.current?.abort();
		if (q.length < 2) {
			setSpaceResults([]);
			return;
		}
		setSpaceResults([]);
		const controller = new AbortController();
		spaceAbort.current = controller;
		const handle = setTimeout(async () => {
			const results = await searchSpaceDocuments(
				target,
				q,
				8,
				controller.signal
			);
			if (results && !controller.signal.aborted && isCurrentTarget()) {
				setSpaceResults(results);
			}
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query, target.url, target.token, target.userJwt]);

	// The control-plane Marketplace is a separate public catalog from the
	// node-scoped Store feed. Search it only after the user has typed a real query,
	// and keep failures isolated so an unavailable Marketplace never breaks local
	// commands, messages, pages, or captured context.
	useEffect(() => {
		const q = query.trim();
		marketplaceAbort.current?.abort();
		if (q.length < 2) {
			setMarketplaceResults([]);
			return;
		}
		setMarketplaceResults([]);
		const controller = new AbortController();
		marketplaceAbort.current = controller;
		const handle = setTimeout(() => {
			searchMarketplaceCatalog(q, 8, controller.signal)
				.then((results) => {
					if (!controller.signal.aborted) {
						setMarketplaceResults(results);
					}
				})
				.catch(() => {
					// Marketplace search is an optional palette lane.
				});
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query]);
	return {
		marketplaceResults,
		messageResults,
		setMarketplaceResults,
		setMessageResults,
		setShadowResults,
		setSpaceResults,
		shadowResults,
		spaceResults,
	};
}
