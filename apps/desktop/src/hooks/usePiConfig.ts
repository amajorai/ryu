// apps/desktop/src/hooks/usePiConfig.ts
//
// Backs the Ryu Pi configuration panel. The current config + the supported
// provider/model catalog are cached per active node; saving runs as a mutation
// that revalidates both. Every decision lives in Core (`/api/pi-config`); this
// hook only holds query state. The config is per-node (it lives in that node's
// isolated PI_CODING_AGENT_DIR), so the cache key includes the node url.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchPiCatalog,
	fetchPiConfig,
	type PiCatalog,
	type PiConfig,
	type PiConfigInput,
	updatePiConfig,
} from "@/src/lib/api/pi-config.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UsePiConfigResult {
	catalog: PiCatalog | null;
	config: PiConfig | null;
	error: string | null;
	loading: boolean;
	reload: () => void;
	save: (input: PiConfigInput) => Promise<PiConfig>;
	saveError: string | null;
	saving: boolean;
}

export function usePiConfig(): UsePiConfigResult {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const queryClient = useQueryClient();

	const configQuery = useQuery({
		queryKey: ["pi-config", node.url],
		queryFn: () => fetchPiConfig(target),
	});

	const catalogQuery = useQuery({
		queryKey: ["pi-config-catalog", node.url],
		queryFn: () => fetchPiCatalog(target),
	});

	const mutation = useMutation({
		mutationFn: (input: PiConfigInput) => updatePiConfig(target, input),
		onSuccess: (config) => {
			queryClient.setQueryData(["pi-config", node.url], config);
			// Routing/credential changes can flip catalog `configured` flags.
			queryClient.invalidateQueries({
				queryKey: ["pi-config-catalog", node.url],
			});
		},
	});

	const save = useCallback(
		(input: PiConfigInput) => mutation.mutateAsync(input),
		[mutation]
	);

	const reload = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["pi-config", node.url] });
		queryClient.invalidateQueries({
			queryKey: ["pi-config-catalog", node.url],
		});
	}, [queryClient, node.url]);

	return {
		config: configQuery.data ?? null,
		catalog: catalogQuery.data ?? null,
		loading: configQuery.isLoading || catalogQuery.isLoading,
		error:
			(configQuery.error as Error | null)?.message ??
			(catalogQuery.error as Error | null)?.message ??
			null,
		saving: mutation.isPending,
		saveError: (mutation.error as Error | null)?.message ?? null,
		save,
		reload,
	};
}
