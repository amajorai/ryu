// apps/desktop/src/hooks/useWorkflowTemplatesCatalog.ts
//
// Backs the Store "Workflow Templates" section. The catalog
// (`GET /api/workflows/catalog`) lists every Core-curated workflow template
// keyed by the agent-design pattern it demonstrates. Unlike Agents/Engines there
// is no per-entry install flag — installing a template MINTS a brand-new
// workflow (fresh ids, `while` bodies patched) and returns its id, so this hook
// is a single TanStack Query for the list plus an install mutation that resolves
// to the created workflow id (the caller navigates to it). Mirrors the
// useAgentsCatalog shape (list query + install mutation + pendingId).

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchWorkflowTemplates,
	installWorkflowTemplate,
	type WorkflowTemplateMeta,
} from "@/src/lib/api/workflows.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseWorkflowTemplatesCatalogResult {
	error: string | null;
	/** Install a template; resolves to the newly created workflow id. */
	install: (id: string) => Promise<string>;
	loading: boolean;
	/** Id of the template whose install is currently in flight, or null. */
	pendingId: string | null;
	templates: WorkflowTemplateMeta[];
}

export function useWorkflowTemplatesCatalog(): UseWorkflowTemplatesCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const catalogQuery = useQuery({
		queryKey: ["workflow-templates", "catalog", url],
		queryFn: () => fetchWorkflowTemplates({ url, token }),
	});

	const installMutation = useMutation({
		mutationFn: (id: string) => installWorkflowTemplate({ url, token }, id),
	});

	const install = useCallback(
		(id: string) => installMutation.mutateAsync(id),
		[installMutation]
	);

	const errorOf = (e: unknown): string | null =>
		e instanceof Error ? e.message : null;
	const pendingId = installMutation.isPending
		? installMutation.variables
		: null;

	return {
		templates: catalogQuery.data ?? [],
		loading: catalogQuery.isLoading,
		error: errorOf(installMutation.error) ?? errorOf(catalogQuery.error),
		install,
		pendingId: pendingId ?? null,
	};
}
