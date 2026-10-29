import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchPiCatalog,
	type PiCatalog,
	type PiConfig,
} from "@/src/lib/api/pi-config.ts";

interface Resource {
	id: number;
	listeners: Set<() => void>;
	owner: object | null;
	pending: Promise<void> | null;
}
const resources = new WeakMap<QueryClient, Map<string, Resource>>();
let nextId = 0;
function resourceFor(client: QueryClient, target: ApiTarget): Resource {
	let entries = resources.get(client);
	if (!entries) {
		entries = new Map();
		resources.set(client, entries);
	}
	const identity = JSON.stringify([
		target.url,
		target.token,
		target.userJwt ?? null,
	]);
	let resource = entries.get(identity);
	if (!resource) {
		resource = {
			id: ++nextId,
			pending: null,
			owner: null,
			listeners: new Set(),
		};
		entries.set(identity, resource);
	}
	return resource;
}
// Credentials stay private; query keys and React lifetimes use opaque identities.
export function useProviderQueryScope(target: ApiTarget) {
	const client = useQueryClient();
	const owner = useRef<object | null>(null);
	const scope = useMemo(() => {
		const captured = toTarget(target);
		const resource = resourceFor(client, captured);
		const generation = {};
		const configKey = ["pi-config", captured.url, resource.id] as const;
		const catalogKey = [
			"pi-config-catalog",
			captured.url,
			resource.id,
		] as const;

		const waitsForRefresh = resource.pending !== null;
		const configReadCount =
			client.getQueryState(configKey)?.dataUpdateCount ?? 0;
		const catalogReadCount =
			client.getQueryState(catalogKey)?.dataUpdateCount ?? 0;
		const freshRead = (key: readonly unknown[], before: number) => {
			const state = client.getQueryState(key);
			return (
				state?.status === "success" &&
				state.fetchStatus === "idle" &&
				state.dataUpdateCount > before
			);
		};
		const invalidateConfig = () => {
			void client.invalidateQueries({ queryKey: configKey, exact: true });
		};
		const invalidateCatalog = () => {
			void client.invalidateQueries({ queryKey: catalogKey, exact: true });
		};
		return {
			target: captured,
			configKey,
			catalogKey,
			generation,
			resource,
			waitForRefresh: waitsForRefresh,
			invalidateConfig,
			invalidateCatalog,
			async waitForWrite() {
				await resource.pending;
			},
			async write<T>(operation: () => Promise<T>): Promise<T> {
				if (resource.pending) {
					throw new Error("A provider change is already pending for this node");
				}
				if (
					waitsForRefresh &&
					!(
						freshRead(configKey, configReadCount) &&
						freshRead(catalogKey, catalogReadCount)
					)
				) {
					throw new Error(
						"Reload provider settings before making another change"
					);
				}
				let release = () => {};
				resource.pending = new Promise<void>((resolve) => {
					release = resolve;
				});
				resource.owner = generation;
				for (const listener of resource.listeners) {
					listener();
				}
				try {
					await Promise.all([
						client.cancelQueries({ queryKey: configKey, exact: true }),
						client.cancelQueries({ queryKey: catalogKey, exact: true }),
					]);
					return await operation();
				} finally {
					if (owner.current !== generation) {
						invalidateConfig();
						invalidateCatalog();
					}
					resource.pending = null;
					resource.owner = null;
					release();
					for (const listener of resource.listeners) {
						listener();
					}
				}
			},
			publishConfig(value: PiConfig) {
				if (owner.current === generation) {
					client.setQueryData(configKey, value);
				} else {
					invalidateConfig();
				}
			},
			publishCatalog(value: PiCatalog) {
				if (owner.current === generation) {
					client.setQueryData(catalogKey, value);
				} else {
					invalidateCatalog();
				}
			},
			subscribe(listener: () => void) {
				resource.listeners.add(listener);
				return () => {
					resource.listeners.delete(listener);
				};
			},
			pendingSnapshot() {
				return resource.pending !== null;
			},
		};
	}, [client, target.url, target.token, target.userJwt]);
	owner.current = scope.generation;
	useLayoutEffect(() => {
		owner.current = scope.generation;
		return () => {
			if (owner.current === scope.generation) {
				owner.current = null;
			}
		};
	}, [scope]);
	const pending = useSyncExternalStore(
		scope.subscribe,
		scope.pendingSnapshot,
		scope.pendingSnapshot
	);
	return useMemo(() => ({ ...scope, pending }), [scope, pending]);
}

export function useProviderCatalog(
	target: ApiTarget,
	options: {
		enabled?: boolean;
		staleTime?: number;
		refetchOnWindowFocus?: boolean;
	} = {}
) {
	const scope = useProviderQueryScope(target);
	const query = useQuery({
		queryKey: scope.catalogKey,
		queryFn: async () => {
			await scope.waitForWrite();
			return fetchPiCatalog(scope.target);
		},
		...options,
	});
	const waiting =
		(scope.pending && scope.resource.owner !== scope.generation) ||
		(scope.waitForRefresh && !(query.isFetchedAfterMount && query.isSuccess));
	return {
		...query,
		data: waiting ? undefined : query.data,
		isLoading:
			(scope.pending && scope.resource.owner !== scope.generation) ||
			(waiting && !query.isError) ||
			query.isLoading,
	};
}
