// apps/desktop/src/hooks/useLlmProviders.ts
//
// Backs the standalone "LLM Providers" settings page — a Zed-style surface that
// lists every provider Pi can reach, lets the user store BYOK credentials for
// many at once, pick one active, toggle per-provider routing, and discover
// models dynamically. It sits alongside `usePiConfig` (which backs the older,
// agent-scoped editor) and DELIBERATELY reuses the same TanStack Query cache
// keys (`pi-config` / `pi-config-catalog`, keyed by full node authority) so both surfaces
// stay in sync: a change here invalidates the catalog the agent-edit view reads.
//
// Every decision lives in Core (`/api/pi-config/*`); this hook only holds query
// + mutation state. Config is per-node (Core's isolated PI_CODING_AGENT_DIR), so
// the cache key includes URL and an opaque token/delegation authority identity.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useProviderQueryScope } from "./provider-query-scope.ts";
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
	type ProviderAccountTarget,
	type ProviderConfigInput,
	removeProviderAccount,
	renameProviderAccount,
	setModelEnabled,
	switchProviderAccount,
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
	/** Remove one saved account without removing the provider. */
	removeAccount: (provider: string, accountId: string) => Promise<PiCatalog>;
	/** Rename one saved account in the provider's sealed account list. */
	renameAccount: (
		provider: string,
		accountId: string,
		label: string
	) => Promise<PiCatalog>;
	/** Switch one saved provider account for yourself or the Gateway. */
	switchAccount: (
		provider: string,
		accountId: string,
		target?: ProviderAccountTarget
	) => Promise<PiCatalog>;
	/** Enable/disable a single model within a provider. */
	toggleModelEnabled: (
		provider: string,
		model: string,
		enabled: boolean
	) => Promise<PiCatalog>;
}

export function useLlmProviders(): UseLlmProvidersResult {
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

	// Every mutation revalidates the shared config + catalog so the agent-edit
	// view (which reads the same keys) reflects the change immediately.
	const invalidate = useCallback(() => {
		scope.invalidateConfig();
		scope.invalidateCatalog();
	}, [scope]);

	const activateMutation = useMutation({
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
	const configureMutation = useMutation({
		mutationFn: async ({
			input,
			owner,
		}: {
			input: ProviderConfigInput;
			owner: typeof scope;
		}) => ({
			value: await owner.write(() => configureProvider(owner.target, input)),
			owner,
		}),
		onSuccess: ({ value, owner }) => {
			owner.publishCatalog(value);
			owner.invalidateConfig();
		},
	});
	const removeMutation = useMutation({
		mutationFn: async ({ id, owner }: { id: string; owner: typeof scope }) => ({
			value: await owner.write(() => deleteProvider(owner.target, id)),
			owner,
		}),
		onSuccess: ({ value, owner }) => {
			owner.publishCatalog(value);
			owner.invalidateConfig();
		},
	});
	const modelEnabledMutation = useMutation({
		mutationFn: async ({
			input,
			owner,
		}: {
			input: { enabled: boolean; model: string; provider: string };
			owner: typeof scope;
		}) => ({
			value: await owner.write(() => setModelEnabled(owner.target, input)),
			owner,
		}),
		onSuccess: ({ value, owner }) => owner.publishCatalog(value),
	});

	const activate = useCallback(
		(input: PiConfigInput) =>
			activateMutation
				.mutateAsync({ input, owner: scope })
				.then((result) => result.value),
		[activateMutation, scope]
	);
	const configure = useCallback(
		(input: ProviderConfigInput) =>
			configureMutation
				.mutateAsync({ input, owner: scope })
				.then((result) => result.value),
		[configureMutation, scope]
	);
	const remove = useCallback(
		(id: string) =>
			removeMutation
				.mutateAsync({ id, owner: scope })
				.then((result) => result.value),
		[removeMutation, scope]
	);
	const switchAccount = useCallback(
		(
			provider: string,
			accountId: string,
			accountTarget: ProviderAccountTarget = "self"
		) =>
			scope
				.write(() =>
					switchProviderAccount(target, provider, accountId, accountTarget)
				)
				.then((catalog) => {
					scope.publishCatalog(catalog);
					return catalog;
				}),
		[target, scope]
	);
	const removeAccount = useCallback(
		(provider: string, accountId: string) =>
			scope
				.write(() => removeProviderAccount(target, provider, accountId))
				.then((catalog) => {
					scope.publishCatalog(catalog);
					return catalog;
				}),
		[target, scope]
	);
	const renameAccount = useCallback(
		async (provider: string, accountId: string, label: string) => {
			const catalog = await scope.write(() =>
				renameProviderAccount(target, provider, accountId, label)
			);
			scope.publishCatalog(catalog);
			scope.invalidateConfig();
			return catalog;
		},
		[target, scope]
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
			modelEnabledMutation
				.mutateAsync({ input: { provider, model, enabled }, owner: scope })
				.then((result) => result.value),
		[modelEnabledMutation, scope]
	);

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
		mutating: scope.pending,
		activate,
		check,
		configure,
		remove,
		switchAccount,
		removeAccount,
		renameAccount,
		discover,
		toggleModelEnabled,
		reload: invalidate,
	};
}
