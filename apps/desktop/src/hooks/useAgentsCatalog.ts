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

import {
	type DefaultError,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	type AgentCatalogEntry,
	fetchAgentCatalog,
	installAgent,
	uninstallAgent,
} from "@/src/lib/api/agents.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAgentsCatalogResult {
	agents: AgentCatalogEntry[];
	error: string | null;
	install: (id: string) => Promise<void>;
	loading: boolean;
	/** Id of the agent whose install/uninstall is currently in flight, or null. */
	pendingId: string | null;
	reload: () => Promise<void>;
	uninstall: (id: string) => Promise<void>;
}

/** Query descriptor shared with the Store's warm-up path (`useStorePrefetch`), so
 *  a prefetch lands under the key this hook reads. */
export function agentCatalogQuery(target: ApiTarget) {
	return {
		queryKey: ["agents", "catalog", target.url],
		queryFn: () => fetchAgentCatalog(target),
	};
}

export function useAgentsCatalog(): UseAgentsCatalogResult {
	const activeNode = useActiveNode();
	const target = useMemo<ApiTarget>(
		() => ({
			url: activeNode.url,
			token: activeNode.token ?? null,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const { url, token, userJwt } = target;
	const qc = useQueryClient();

	const catalogQuery = useQuery(
		useMemo(() => agentCatalogQuery(target), [target])
	);

	// Install/uninstall changes two things: the catalog's `added` flag (this
	// query) and the node's agent roster (`GET /api/agents`, read by the
	// always-mounted sidebar/picker/Library through `useAgents`). Refresh both,
	// or an agent added from the Store only shows up after a full app refresh.
	const revalidate = useCallback(async () => {
		await qc.invalidateQueries({ queryKey: ["agents", "catalog", url] });
		triggerAgentsRefresh();
	}, [qc, url]);

	const installMutation = useMutation({
		mutationFn: (id: string) => installAgent({ url, token, userJwt }, id),
		onSettled: revalidate,
	});

	const uninstallMutation = useMutation({
		mutationFn: (id: string) => uninstallAgent({ url, token, userJwt }, id),
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

	const errorOf = (e: DefaultError | null): string | null => {
		if (e instanceof ApiError && e.serverMessage) {
			return e.serverMessage;
		}
		return e instanceof Error ? e.message : null;
	};
	const pendingId =
		(installMutation.isPending ? installMutation.variables : null) ??
		(uninstallMutation.isPending ? uninstallMutation.variables : null) ??
		null;
	const reload = useCallback(async () => {
		await catalogQuery.refetch();
	}, [catalogQuery]);

	return {
		agents: catalogQuery.data ?? [],
		loading: catalogQuery.isLoading,
		error:
			errorOf(installMutation.error) ??
			errorOf(uninstallMutation.error) ??
			errorOf(catalogQuery.error),
		install,
		uninstall,
		reload,
		pendingId,
	};
}
