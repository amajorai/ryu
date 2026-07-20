// Sidebar data source for the Canvas app: the list of canvas boards (Space docs of
// kind `app:com.ryu.canvas` in the "Canvas" system space) plus create/delete. The
// built-in file-store client (`lib/api/canvases.ts`) was removed with the port;
// this reads the app's Space documents instead.

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
	CANVAS_DOC_KIND,
	CANVAS_PLUGIN_ID,
	CANVAS_SPACE_NAME,
} from "@/src/lib/canvas/app.ts";

/** One canvas board row for the sidebar. */
export interface CanvasDoc {
	id: string;
	name: string;
	spaceId: string;
}

export interface UseCanvasDocs {
	canvases: CanvasDoc[];
	createCanvas: () => Promise<{ id: string; spaceId: string } | null>;
	deleteCanvas: (id: string) => void;
	isLoading: boolean;
}

/**
 * Resolve the "Canvas" system space id + list its canvas boards. Returns loading
 * state and create/delete actions. The Canvas space is seeded by Core, so it is
 * expected to exist; while it doesn't (first boot race), the list is simply empty.
 */
export function useCanvasDocs(): UseCanvasDocs {
	const node = useActiveNode();
	const target = toTarget(node);
	const queryClient = useQueryClient();

	const spaceQuery = useQuery({
		queryKey: ["canvas-space", node.url, node.token],
		queryFn: async () => {
			const spaces = await fetchSpaces(target);
			return spaces.find((s) => s.name === CANVAS_SPACE_NAME)?.id ?? null;
		},
		staleTime: 60_000,
	});
	const spaceId = spaceQuery.data ?? null;

	const docsQuery = useQuery({
		queryKey: ["canvas-docs", node.url, node.token, spaceId],
		enabled: Boolean(spaceId),
		queryFn: async () => {
			if (!spaceId) {
				return [] as CanvasDoc[];
			}
			const docs = await fetchDocuments(target, spaceId);
			return docs
				.filter((d) => d.rawKind === CANVAS_DOC_KIND)
				.map((d) => ({ id: d.id, name: d.title, spaceId }));
		},
	});

	const invalidate = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["canvas-docs"] });
	}, [queryClient]);

	const createMutation = useMutation({
		mutationFn: async () => {
			if (!spaceId) {
				throw new Error("Canvas space not ready");
			}
			const docId = (await pluginHostInvoke(
				target,
				CANVAS_PLUGIN_ID,
				"spaces.createDoc",
				{ space_id: spaceId, title: "Untitled canvas" }
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

	const createCanvas = useCallback(async () => {
		try {
			return await createMutation.mutateAsync();
		} catch {
			return null;
		}
	}, [createMutation]);

	const deleteCanvas = useCallback(
		(id: string) => {
			deleteMutation.mutate(id);
		},
		[deleteMutation]
	);

	return {
		canvases: docsQuery.data ?? [],
		createCanvas,
		deleteCanvas,
		isLoading: spaceQuery.isLoading || docsQuery.isLoading,
	};
}
