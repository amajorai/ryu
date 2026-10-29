import { Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect, useState } from "react";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { fetchBacklinks, type SpaceDocLink } from "@/src/lib/api/spaces.ts";

/**
 * "Linked references" — the documents that link to this page (Obsidian/Notion
 * backlinks). Rendered under the editor; hidden when there are none. Clicking a
 * reference opens the linking document.
 */
export function BacklinksPanel({
	spaceId,
	documentId,
}: {
	spaceId: string;
	documentId: string;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const { url } = node;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const openTab = useTabSelector((state) => state.openTab);
	const [links, setLinks] = useState<SpaceDocLink[]>([]);

	useEffect(() => {
		let cancelled = false;
		fetchBacklinks({ url, token, userJwt }, spaceId, documentId)
			.then((result) => {
				if (!cancelled) {
					setLinks(result);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLinks([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [url, token, userJwt, spaceId, documentId]);

	if (links.length === 0) {
		return null;
	}

	return (
		<section className="shrink-0 border-t bg-muted/20 px-4 py-3">
			<h2 className="mb-2 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				<HugeiconsIcon className="size-3.5" icon={Link01Icon} />
				{tl(
					"{referenceCount, plural, one {# linked reference} other {# linked references}}",
					{ referenceCount: links.length }
				)}
			</h2>
			<ul className="flex flex-col gap-1">
				{links.map((link) => (
					<li key={`${link.srcDocId}:${link.kind}`}>
						<button
							className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
							onClick={() => openTab(`/spaces/${spaceId}/doc/${link.srcDocId}`)}
							type="button"
						>
							<span className="block font-medium text-sm">
								{link.srcTitle || "Untitled"}
							</span>
							{link.snippet ? (
								<span
									className="block truncate text-muted-foreground text-xs"
									title={link.snippet}
								>
									{link.snippet}
								</span>
							) : null}
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
