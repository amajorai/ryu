// apps/desktop/src/hooks/useLlmProviders.ts
//
// Backs the standalone "LLM Providers" settings page — a Zed-style surface that
// lists every provider Pi can reach, lets the user store BYOK credentials for
// many at once, pick one active, toggle per-provider routing, and discover
// models dynamically. It sits alongside `usePiConfig` (which backs the older,
// agent-scoped editor) and DELIBERATELY reuses the same TanStack Query cache
// keys (`pi-config` / `pi-config-catalog`, keyed by node url) so both surfaces
// stay in sync: a change here invalidates the catalog the agent-edit view reads.
//
// Every decision lives in Core (`/api/pi-config/*`); this hook only holds query
// + mutation state. Config is per-node (Core's isolated PI_CODING_AGENT_DIR), so
// the cache key includes the node url.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type CheckProviderInput,
	type CheckProviderResult,
	checkProvider,
	configureProvider,
	type DiscoverModelsInput,
	type DiscoverModelsResult,
	deleteProvider,
	discoverModels,
	fetchPiCatalog,
	fetchPiConfig,
	type PiCatalog,
	type PiConfig,
	type PiConfigInput,
	type ProviderConfigInput,
	setModelEnabled,
	updatePiConfig,
} from "@/src/lib/api/pi-config.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseLlmProvidersResult {
	/** Make a provider active (PUT /api/pi-config). */
	activate: (input: PiConfigInput) => Promise<PiConfig>;
	catalog: PiCatalog | null;
	/** Live-check a provider's connectivity (latency + model count). */
	check: (input: CheckProviderInput) => Promise<CheckProviderResult>;
	config: PiConfig | null;
	/** Store credentials/routing for a provider without activating it. */
	configure: (input: ProviderConfigInput) => Promise<PiCatalog>;
	/** Enumerate a provider's models (live, with a suggested fallback). */
	discover: (input: DiscoverModelsInput) => Promise<DiscoverModelsResult>;
	error: string | null;
	loading: boolean;
	mutating: boolean;
	reload: () => void;
	/** Remove a stored credential / custom provider. */
	remove: (id: string) => Promise<PiCatalog>;
	/** Enable/disable a single model within a provider. */
	toggleModelEnabled: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<PiCatalog>;
}

export function useLlmProviders(): UseLlmProvidersResult {
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

	// Every mutation revalidates the shared config + catalog so the agent-edit
	// view (which reads the same keys) reflects the change immediately.
	const invalidate = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["pi-config", node.url] });
		queryClient.invalidateQueries({
			queryKey: ["pi-config-catalog", node.url],
		});
	}, [queryClient, node.url]);

	const activateMutation = useMutation({
		mutationFn: (input: PiConfigInput) => updatePiConfig(target, input),
		onSuccess: (config) => {
			queryClient.setQueryData(["pi-config", node.url], config);
			queryClient.invalidateQueries({
				queryKey: ["pi-config-catalog", node.url],
			});
		},
	});

	const configureMutation = useMutation({
		mutationFn: (input: ProviderConfigInput) =>
			configureProvider(target, input),
		onSuccess: (catalog) => {
			queryClient.setQueryData(["pi-config-catalog", node.url], catalog);
			// Routing overrides live on the config too — refetch to stay honest.
			queryClient.invalidateQueries({ queryKey: ["pi-config", node.url] });
		},
	});

	const removeMutation = useMutation({
		mutationFn: (id: string) => deleteProvider(target, id),
		onSuccess: (catalog) => {
			queryClient.setQueryData(["pi-config-catalog", node.url], catalog);
			queryClient.invalidateQueries({ queryKey: ["pi-config", node.url] });
		},
	});

	const modelEnabledMutation = useMutation({
		mutationFn: (input: {
			enabled: boolean;
			model: string;
			provider: string;
		}) => setModelEnabled(target, input),
		onSuccess: (catalog) => {
			queryClient.setQueryData(["pi-config-catalog", node.url], catalog);
		},
	});

	const activate = useCallback(
		(input: PiConfigInput) => activateMutation.mutateAsync(input),
		[activateMutation]
	);
	const configure = useCallback(
		(input: ProviderConfigInput) => configureMutation.mutateAsync(input),
		[configureMutation]
	);
	const remove = useCallback(
		(id: string) => removeMutation.mutateAsync(id),
		[removeMutation]
	);
	// Discovery is not a cache mutation — it's a live lookup the caller awaits.
	const discover = useCallback(
		(input: DiscoverModelsInput) => discoverModels(target, input),
		[target]
	);
	// A connectivity probe — like discovery, a live lookup, not a cache write.
	const check = useCallback(
		(input: CheckProviderInput) => checkProvider(target, input),
		[target]
	);
	const toggleModelEnabled = useCallback(
		(provider: string, model: string, enabled: boolean) =>
			modelEnabledMutation.mutateAsync({ provider, model, enabled }),
		[modelEnabledMutation]
	);

	return {
		config: configQuery.data ?? null,
		catalog: catalogQuery.data ?? null,
		loading: configQuery.isLoading || catalogQuery.isLoading,
		error:
			(configQuery.error as Error | null)?.message ??
			(catalogQuery.error as Error | null)?.message ??
			null,
		mutating:
			activateMutation.isPending ||
			configureMutation.isPending ||
			removeMutation.isPending,
		activate,
		check,
		configure,
		remove,
		discover,
		toggleModelEnabled,
		reload: invalidate,
	};
}
