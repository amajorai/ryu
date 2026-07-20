// Sidebar data source for the Whiteboard app: the list of whiteboards (Space docs
// of kind `app:com.ryu.whiteboard` in the "Whiteboard" system space) plus
// create/delete. Mirrors `useCanvasDocs.ts`; reads the app's Space documents.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import {
	deleteDocument,
	fetchDocuments,
	fetchSpaces,
} from "@/src/lib/api/spaces.ts";
import {
	WHITEBOARD_DOC_KIND,
	WHITEBOARD_PLUGIN_ID,
	WHITEBOARD_SPACE_NAME,
} from "@/src/lib/whiteboard/app.ts";

/** One whiteboard row for the sidebar. */
export interface WhiteboardDoc {
	id: string;
	name: string;
	spaceId: string;
}

export interface UseWhiteboardDocs {
	whiteboards: WhiteboardDoc[];
	createWhiteboard: () => Promise<{ id: string; spaceId: string } | null>;
	deleteWhiteboard: (id: string) => void;
	isLoading: boolean;
}

/**
 * Resolve the "Whiteboard" system space id + list its whiteboards. Returns loading
 * state and create/delete actions. The Whiteboard space is seeded by Core, so it is
 * expected to exist; while it doesn't (first boot race), the list is simply empty.
 */
export function useWhiteboardDocs(): UseWhiteboardDocs {
	const node = useActiveNode();
	const target = toTarget(node);
	const queryClient = useQueryClient();

	const spaceQuery = useQuery({
		queryKey: ["whiteboard-space", node.url, node.token],
		queryFn: async () => {
			const spaces = await fetchSpaces(target);
			return spaces.find((s) => s.name === WHITEBOARD_SPACE_NAME)?.id ?? null;
		},
		staleTime: 60_000,
	});
	const spaceId = spaceQuery.data ?? null;

	const docsQuery = useQuery({
		queryKey: ["whiteboard-docs", node.url, node.token, spaceId],
		enabled: Boolean(spaceId),
		queryFn: async () => {
			if (!spaceId) {
				return [] as WhiteboardDoc[];
			}
			const docs = await fetchDocuments(target, spaceId);
			return docs
				.filter((d) => d.rawKind === WHITEBOARD_DOC_KIND)
				.map((d) => ({ id: d.id, name: d.title, spaceId }));
		},
	});

	const invalidate = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["whiteboard-docs"] });
	}, [queryClient]);

	const createMutation = useMutation({
		mutationFn: async () => {
			if (!spaceId) {
				throw new Error("Whiteboard space not ready");
			}
			const docId = (await pluginHostInvoke(
				target,
				WHITEBOARD_PLUGIN_ID,
				"spaces.createDoc",
				{ space_id: spaceId, title: "Untitled whiteboard" }
			)) as string;
			return { id: docId, spaceId };
		},
		onSuccess: invalidate,
	});

	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			if (!spaceId) {
				return;
			}
			await deleteDocument(target, spaceId, id);
		},
		onSuccess: invalidate,
	});

	const createWhiteboard = useCallback(async () => {
		try {
			return await createMutation.mutateAsync();
		} catch {
			return null;
		}
	}, [createMutation]);

	const deleteWhiteboard = useCallback(
		(id: string) => {
			deleteMutation.mutate(id);
		},
		[deleteMutation]
	);

	return {
		whiteboards: docsQuery.data ?? [],
		createWhiteboard,
		deleteWhiteboard,
		isLoading: spaceQuery.isLoading || docsQuery.isLoading,
	};
}
