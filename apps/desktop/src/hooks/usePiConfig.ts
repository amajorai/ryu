// apps/desktop/src/hooks/usePiConfig.ts
//
// Backs the Ryu Pi configuration panel. The current config + the supported
// provider/model catalog are cached per active node; saving runs as a mutation
// that revalidates both. Every decision lives in Core (`/api/pi-config`); this
// hook only holds query state. The config is per-node (it lives in that node's
// isolated PI_CODING_AGENT_DIR), so the cache key includes URL and an opaque token/delegation authority identity.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useProviderQueryScope } from "./provider-query-scope.ts";
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
	const scope = useProviderQueryScope(node);
	const target = scope.target;

	const configQuery = useQuery({
		queryKey: scope.configKey,
		queryFn: async () => {
			await scope.waitForWrite();
			return fetchPiConfig(target);
		},
	});

	const catalogQuery = useQuery({
		queryKey: scope.catalogKey,
		queryFn: async () => {
			await scope.waitForWrite();
			return fetchPiCatalog(target);
		},
	});

	const mutation = useMutation({
		mutationFn: async ({
			input,
			owner,
		}: {
			input: PiConfigInput;
			owner: typeof scope;
		}) => ({
			value: await owner.write(() => updatePiConfig(owner.target, input)),
			owner,
		}),
		onSuccess: ({ value, owner }) => {
			owner.publishConfig(value);
			owner.invalidateCatalog();
		},
	});
	const save = useCallback(
		(input: PiConfigInput) =>
			mutation
				.mutateAsync({ input, owner: scope })
				.then((result) => result.value),
		[mutation, scope]
	);

	const reload = useCallback(() => {
		scope.invalidateConfig();
		scope.invalidateCatalog();
	}, [scope]);

	const waitingForRefresh =
		(scope.pending && scope.resource.owner !== scope.generation) ||
		(scope.waitForRefresh &&
			(!configQuery.isFetchedAfterMount ||
				!catalogQuery.isFetchedAfterMount ||
				!configQuery.isSuccess ||
				!catalogQuery.isSuccess));
	return {
		config: waitingForRefresh ? null : (configQuery.data ?? null),
		catalog: waitingForRefresh ? null : (catalogQuery.data ?? null),
		loading:
			(scope.pending && scope.resource.owner !== scope.generation) ||
			(waitingForRefresh && !configQuery.isError && !catalogQuery.isError) ||
			configQuery.isLoading ||
			catalogQuery.isLoading,
		error:
			(configQuery.error as Error | null)?.message ??
			(catalogQuery.error as Error | null)?.message ??
			null,
		saving: scope.pending,
		saveError:
			mutation.variables?.owner.generation === scope.generation
				? ((mutation.error as Error | null)?.message ?? null)
				: null,
		save,
		reload,
	};
}
