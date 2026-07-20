// apps/desktop/src/hooks/useAgentsCatalog.ts
//
// Backs the Store "Agents" section. The agents catalog (`GET /api/agents/catalog`)
// lists every built-in agent with two independent flags per entry:
//   - `added`: the agent is in the installed set and shows in the chat picker;
//   - `detected`: the agent's CLI binary is on PATH (or null when not detectable).
// Install adds an agent to the installed set (`POST /api/agents/catalog/install`);
// uninstall removes it (`POST /api/agents/catalog/uninstall`). Unlike Engines, the
// catalog payload already carries the per-user `added` state, so this hook is a
// single TanStack Query (no second join), with install/uninstall as mutations that
// revalidate the list in place, mirroring the useMcpCatalog / useAppsCatalog shape.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
	type AgentCatalogEntry,
	fetchAgentCatalog,
	installAgent,
	uninstallAgent,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentsCatalogResult {
	agents: AgentCatalogEntry[];
	error: string | null;
	install: (id: string) => Promise<void>;
	loading: boolean;
	/** Id of the agent whose install/uninstall is currently in flight, or null. */
	pendingId: string | null;
	uninstall: (id: string) => Promise<void>;
}

export function useAgentsCatalog(): UseAgentsCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;
	const qc = useQueryClient();

	const catalogQuery = useQuery({
		queryKey: ["agents", "catalog", url],
		queryFn: () => fetchAgentCatalog({ url, token }),
	});

	const revalidate = useCallback(
		() => qc.invalidateQueries({ queryKey: ["agents", "catalog", url] }),
		[qc, url]
	);

	const installMutation = useMutation({
		mutationFn: (id: string) => installAgent({ url, token }, id),
		onSettled: revalidate,
	});

	const uninstallMutation = useMutation({
		mutationFn: (id: string) => uninstallAgent({ url, token }, id),
		onSettled: revalidate,
	});

	const install = useCallback(
		async (id: string) => {
			await installMutation.mutateAsync(id);
		},
		[installMutation]
	);

	const uninstall = useCallback(
		async (id: string) => {
			await uninstallMutation.mutateAsync(id);
		},
		[uninstallMutation]
	);

	const errorOf = (e: unknown): string | null =>
		e instanceof Error ? e.message : null;
	const pendingId =
		(installMutation.isPending ? installMutation.variables : null) ??
		(uninstallMutation.isPending ? uninstallMutation.variables : null) ??
		null;

	return {
		agents: catalogQuery.data ?? [],
		loading: catalogQuery.isLoading,
		error:
			errorOf(installMutation.error) ??
			errorOf(uninstallMutation.error) ??
			errorOf(catalogQuery.error),
		install,
		uninstall,
		pendingId,
	};
}
