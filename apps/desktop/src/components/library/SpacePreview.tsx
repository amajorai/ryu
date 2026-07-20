// apps/desktop/src/components/library/SpacePreview.tsx
//
// A mini markdown preview of a Space's first page, rendered inside its Library
// card (grid view only). Fetches the Space's document list, picks the first
// `page` (markdown) document, and renders a truncated snippet of its source with
// the same Markdown renderer the editor uses — so the card shows real content,
// not just a doc count.
//
// The fetch is two requests per Space (list + document), so it is only ever
// mounted on the dedicated Spaces tab (never on the mixed Recents/Favorites tabs
// that land on launch) and its result is memoised in a module-level cache so a
// tab re-render or a grid/list toggle does not refetch.

import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown";
import { useEffect, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";

/** Longest markdown snippet we render — keeps the renderer cheap per card. */
const PREVIEW_CHARS = 400;

/** Per-space cache of the resolved snippet (or `null` when there is no page to
 * preview), shared across mounts so switching view/tab never refetches. */
const previewCache = new Map<string, string | null>();

export function SpacePreview({
	spaceId,
	documentCount,
}: {
	spaceId: string;
	documentCount: number;
}) {
	const { listDocuments, getDocument } = useSpacesContext();
	const [snippet, setSnippet] = useState<string | null>(() =>
		previewCache.has(spaceId) ? (previewCache.get(spaceId) ?? null) : null
	);
	const [loading, setLoading] = useState(
		() => documentCount > 0 && !previewCache.has(spaceId)
	);

	useEffect(() => {
		if (documentCount === 0 || previewCache.has(spaceId)) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		(async () => {
			try {
				const docs = await listDocuments(spaceId);
				const page = docs.find((d) => d.kind === "page") ?? docs[0];
				if (!page) {
					previewCache.set(spaceId, null);
					if (!cancelled) {
						setSnippet(null);
					}
					return;
				}
				const content = await getDocument(spaceId, page.id);
				const source = content.source.trim().slice(0, PREVIEW_CHARS);
				const value = source.length > 0 ? source : null;
				previewCache.set(spaceId, value);
				if (!cancelled) {
					setSnippet(value);
				}
			} catch {
				// Best-effort preview: on any error just show nothing.
				if (!cancelled) {
					setSnippet(null);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [spaceId, documentCount, listDocuments, getDocument]);

	if (loading) {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="h-2 w-4/5 animate-pulse rounded bg-muted" />
				<div className="h-2 w-3/5 animate-pulse rounded bg-muted" />
			</div>
		);
	}

	if (!snippet) {
		return null;
	}

	return (
		<div className="pointer-events-none relative max-h-24 overflow-hidden rounded-md border bg-muted/30 px-3 py-2 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
			<Markdown
				className="prose-sm text-muted-foreground text-xs"
				content={snippet}
			/>
		</div>
	);
}
