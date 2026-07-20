import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useState } from "react";
import { KnowledgeGraph } from "@/src/components/spaces/KnowledgeGraph.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	createPage as apiCreatePage,
	type DocGraph,
	fetchGlobalGraph,
	fetchSpaceGraph,
} from "@/src/lib/api/spaces.ts";

/**
 * The knowledge-graph view: a document-link graph for one Space, or globally
 * across every Space when `spaceId` is omitted. Clicking a node opens the page;
 * clicking a pending (not-yet-created) node creates it first.
 */
export default function KnowledgeGraphPage({ spaceId }: { spaceId?: string }) {
	const node = useActiveNode();
	const { url } = node;
	const token = node.token ?? null;
	const { openTab } = useTabsContext();
	const [graph, setGraph] = useState<DocGraph | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		const target = { url, token };
		try {
			const result = spaceId
				? await fetchSpaceGraph(target, spaceId)
				: await fetchGlobalGraph(target);
			setGraph(result);
		} catch {
			setGraph({ nodes: [], edges: [] });
		} finally {
			setLoading(false);
		}
	}, [url, token, spaceId]);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	const openNode = useCallback(
		(graphNode: DocGraph["nodes"][number]) => {
			if (graphNode.pending) {
				apiCreatePage({ url, token }, graphNode.spaceId, graphNode.title)
					.then((id) => openTab(`/spaces/${graphNode.spaceId}/doc/${id}`))
					.catch(() => undefined);
				return;
			}
			openTab(`/spaces/${graphNode.spaceId}/doc/${graphNode.id}`);
		},
		[url, token, openTab]
	);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
				<h1 className="font-medium text-sm">
					{spaceId ? "Space graph" : "Knowledge graph"}
				</h1>
				<Button onClick={() => load()} size="sm" variant="ghost">
					<HugeiconsIcon className="size-4" icon={RefreshIcon} />
					Refresh
				</Button>
			</div>
			<div className="min-h-0 flex-1">
				{loading || !graph ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : (
					<KnowledgeGraph graph={graph} onOpenNode={openNode} />
				)}
			</div>
		</div>
	);
}
