// apps/desktop/src/hooks/useAppsCatalog.ts
//
// Backs the Store "Apps" section. Unlike the model/skill catalogs, an app row
// has three lifecycle states (install / enable / disable), and the registry
// catalog carries only discovery metadata — no installed/enabled flags. So this
// hook fetches BOTH the catalog and the live app records (`/api/apps`, `AppInfo[]`)
// and joins them by `id`: the matched AppInfo is the source of truth for installed/enabled
// state and the grants to confirm at enable time. Mutations (install / enable / disable /
// install-from-URL) revalidate both queries so the buttons update in place.
//
// Catalog browsing is source-aware: "Ryu Marketplace" (default) is one UNIFIED
// view Core merges from the open git catalog, the hosted commerce server's paid
// listings, the loaded built-ins and the legacy registry; federated sources
// (integrations.sh) use server-side search + pagination. Both go through
// `/api/plugins/catalog/browse`, and the source rides on the REQUEST (`?source=`)
// rather than a node-global preference — see `sourceOverride` below.

import {
	ALL_PLUGIN_SOURCES_ID,
	type CatalogVersion,
} from "@ryu/marketplace/catalog/types";
import {
	type DefaultError,
	keepPreviousData,
	skipToken,
	type UseQueryOptions,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchInstalledPortablePackages,
	installPortablePackage,
	setPortablePackageEnabled,
} from "@/src/lib/api/marketplace.ts";
import {
	type AddMarketplaceParams,
	type AppInfo,
	type AppToggleResult,
	addMarketplaceSource,
	type CatalogEntry,
	disableApp,
	enableApp,
	fetchApps,
	fetchPluginCatalogDetail,
	fetchPluginSources,
	installAppFromUrl,
	installPluginFromCatalogAtVersion,
	type PluginCatalogDetail,
	type PluginCatalogSource,
	searchPluginCatalog,
	updateInstalledPlugin,
	updateInstalledPluginAtVersion,
} from "@/src/lib/api/plugins.ts";
import {
	installCatalogEntry,
	portablePackageTarget,
	readBuyerToken,
} from "@/src/lib/catalog-entry-install.ts";
import { beginInstall, endInstall } from "@/src/store/useInstallStore.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";
import { useOrgFeatures } from "./useOrgFeatures.ts";

/** A catalog entry joined with its live lifecycle record (if any). */
export interface AppCatalogItem {
	/** The release train this install follows (`stable`, `beta`, …); null when the
	 *  listing is not installed. */
	channel: string | null;
	enabled: boolean;
	entry: CatalogEntry;
	/** Grants to confirm at enable time — authoritative from AppInfo, else the
	 *  catalog entry's declared grants for a not-yet-installed app. */
	grants: string[];
	/** Live record from `/api/apps`; null when the app isn't installed. */
	info: AppInfo | null;
	installed: boolean;
	/** The version the lifecycle record holds; null when not installed. */
	installedVersion: string | null;
}

export interface UseAppsCatalogResult {
	activeSource: string;
	/** Whether a marketplace add is in flight. */
	addingMarketplace: boolean;
	/** Add a custom Claude plugin marketplace as a plugin source. */
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: PluginCatalogDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	/** Add a listing. Pass the id explicitly from a card (the selection is a
	 *  PREVIEW concern); omit it to act on the current selection.
	 *
	 *  `options.channel` adds from a prerelease train and PINS the install to it,
	 *  so later updates follow that train rather than reverting to stable. */
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	installFromUrl: (url: string) => Promise<void>;
	/** The id whose add is in flight for THIS hook instance, else null.
	 *
	 *  It used to be a bare boolean, which carried no identity: the detail panel
	 *  showed "Adding…" for whatever happened to be SELECTED, so changing the
	 *  selection mid-add moved the spinner to an item nobody had added. Surfaces
	 *  that need the cross-instance truth (the Store mounts this hook twice) read
	 *  the shared install store instead — see `useInstallStore`. */
	installing: string | null;
	/** Error from the manual manifest URL install field, shown beside that field. */
	installUrlError: string | null;
	/** Install or update one exact historical version from the Versions tab. */
	installVersion: (id: string, version: CatalogVersion) => Promise<void>;
	items: AppCatalogItem[];
	/** Enable/disable currently running for the selected app. */
	lifecyclePending: boolean;
	loading: boolean;
	loadingMore: boolean;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectedItem: AppCatalogItem | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setEnabled: (enabled: boolean) => Promise<void>;
	setQuery: (q: string) => void;
	sources: PluginCatalogSource[];
	/** Move an installed plugin onto another release train (`null` ⇒ stable) and
	 *  update it to that train's current build. */
	switchChannel: (id: string, channel: string | null) => Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_LIMIT = 40;
/** How long an action may wait on the installed-state refresh before the button
 *  is allowed to go idle anyway. `/api/apps` is a local Core read, so this is a
 *  backstop against a wedged fetch — never the normal path. */
const INSTALLED_REFRESH_DEADLINE_MS = 10_000;

/** Sources the picker must not offer.
 *
 *  - `ryu-marketplace` — the HOSTED commerce backend. It is not a rival catalog to
 *    browse: Core folds its paid listings into the `ryu-catalog` view, so the two
 *    render as ONE "Ryu Marketplace". Offering it as a second row was the confusing
 *    part — picking it showed only the paid subset and hid every free listing, which
 *    read as the store losing most of its contents. It stays registered and
 *    addressable in Core (it owns checkout, entitlement and signed downloads); it
 *    just is not a destination.
 *  - `github-topic` — the Community feed, which has its own store section. Picking
 *    it from an Apps/Plugins picker would render an EMPTY page: those variants
 *    filter unreviewed listings out by design, so every row the source returned
 *    would be dropped. Community stays reachable the one way that works — its own
 *    tab, which addresses the feed through `?origin=community`. */
const HIDDEN_PLUGIN_SOURCES = new Set(["ryu-marketplace", "github-topic"]);

// Query descriptors shared with the Store's warm-up path (`useStorePrefetch`), so
// a prefetch always lands under the key this hook reads. See the same block in
// `useSkillsCatalog.ts`.

export function pluginSourcesQuery(target: ApiTarget) {
	return {
		queryKey: ["plugins", "sources", target.url],
		queryFn: () => fetchPluginSources(target),
	};
}

export function installedAppsQuery(target: ApiTarget) {
	return {
		queryKey: ["apps", "list", target.url],
		queryFn: () => fetchApps(target),
	};
}

export function pluginCatalogQuery(
	target: ApiTarget,
	params: { origin?: "community"; query: string; source: string }
) {
	const { origin } = params;
	return {
		queryKey: [
			"plugins",
			"catalog",
			target.url,
			{ q: params.query, source: params.source, origin: origin ?? null },
		],
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			searchPluginCatalog(target, {
				query: params.query,
				limit: PAGE_LIMIT,
				cursor: pageParam,
				origin,
				// Community addresses its feed through `origin`; every other view
				// names its source explicitly so no two tabs can fight over one
				// server-side preference.
				source: origin ? undefined : params.source,
			}),
		// SAFETY: The initial cursor is the authored undefined literal, already a member of this query's string | undefined pageParam port. This widening seeds the same complete cursor type used by queryFn/getNextPageParam; it makes no claim about decoded HTTP data.
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last: { nextCursor?: string | null }) =>
			last.nextCursor ?? undefined,
	};
}

export function useAppsCatalog(
	initialQuery = "",
	options?: { origin?: "community" }
): UseAppsCatalogResult {
	// Community (GitHub topic-discovered) listings are a SEPARATE fetch, not a
	// filter over the first-party pages: Core keeps unreviewed third-party
	// listings out of the default merged catalog, and `?origin=community`
	// addresses the discovery source per-request — without touching the global
	// active-source preference, which would otherwise blank Apps/Plugins.
	const origin = options?.origin;
	const activeNode = useActiveNode();
	// Organization toggles: Core refuses the install routes when an admin turned
	// them off; refusing here first gives the card a clear message instead of a
	// generic lifecycle failure.
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const orgInstallBlock = (fromCatalog: boolean): string | null => {
		if (fromCatalog && !orgFeatureEnabled("plugins.marketplace")) {
			return "Marketplace plugins are disabled by your organization's administrator.";
		}
		if (!(fromCatalog || orgFeatureEnabled("apps.install"))) {
			return "App installation is disabled by your organization's administrator.";
		}
		return null;
	};
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

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const sourcesQuery = useQuery(
		useMemo(() => pluginSourcesQuery(target), [target])
	);
	const sources = useMemo(
		() =>
			(sourcesQuery.data?.sources ?? []).filter(
				(s) => !HIDDEN_PLUGIN_SOURCES.has(s.id)
			),
		[sourcesQuery.data?.sources]
	);

	// The catalog source is PER HOOK INSTANCE, not per node.
	//
	// It used to be a node-global preference written through
	// `/api/catalog/sources/select`, which made source selection leak: picking
	// integrations.sh in one store tab silently repointed every other open store tab
	// — and every other client on the node — at a catalog it never asked for. Worse,
	// the tabs do not all offer the same sources (Community is its own fetch), so the
	// bleed could leave a tab on a source that cannot answer for it at all.
	//
	// So selection is local state, passed per request as `?source=`. The server
	// preference is still read, but only as the INITIAL value — an explicit local
	// pick wins from then on, and nothing is written back.
	//
	// The DEFAULT is now every marketplace at once (`ALL_PLUGIN_SOURCES_ID`) rather
	// than the node's active source. A picker that decides which subset of the store
	// you are allowed to find turns "is X available?" into a question you answer by
	// trying each row in turn; browsing all of them and grouping by marketplace
	// answers it in one page, and the picker becomes a way to narrow instead.
	//
	// So `active` is deliberately no longer read from the sources response. It is a
	// node-global preference, and seeding from it would put two clients on different
	// default views of the same store for a reason neither user set — the same bleed
	// that made this per-instance in the first place. It stays server-side for the
	// routes that still resolve it (a request naming no source at all).
	const [sourceOverride, setSourceOverride] = useState<string | null>(null);
	const activeSource = sourceOverride ?? ALL_PLUGIN_SOURCES_ID;
	const selectSource = useCallback((id: string) => {
		if (id) {
			setSourceOverride(id);
		}
	}, []);

	const addMarketplaceMutation = useMutation({
		mutationFn: (params: AddMarketplaceParams) =>
			addMarketplaceSource({ url, token, userJwt }, params),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["plugins", "sources", url] })
			).catch(() => undefined);
		},
	});
	const addMarketplace = useCallback(
		(params: AddMarketplaceParams) =>
			addMarketplaceMutation.mutateAsync(params),
		[addMarketplaceMutation]
	);

	const appsQuery = useQuery(
		useMemo(() => installedAppsQuery(target), [target])
	);
	const portablePackagesQuery = useQuery(
		useMemo(
			() => ({
				queryKey: ["marketplace", "packages", "installed", url],
				queryFn: () => fetchInstalledPortablePackages(target),
			}),
			[target, url]
		)
	);

	const listQuery = useInfiniteQuery(
		useMemo(
			() => ({
				...pluginCatalogQuery(target, {
					query: debouncedQuery,
					source: activeSource,
					origin,
				}),
				placeholderData: keepPreviousData,
				enabled: activeSource.length > 0,
			}),
			[target, debouncedQuery, activeSource, origin]
		)
	);

	const catalogEntries = useMemo(
		() => listQuery.data?.pages.flatMap((p) => p.entries) ?? [],
		[listQuery.data]
	);

	const items = useMemo<AppCatalogItem[]>(() => {
		const infos = appsQuery.data ?? [];
		const byId = new Map(infos.map((a) => [a.id, a]));
		const portableByKey = new Map(
			(portablePackagesQuery.data ?? []).map((pkg) => [
				`${pkg.kind}:${pkg.id}`,
				pkg,
			])
		);
		return catalogEntries.map((entry) => {
			const info = byId.get(entry.id) ?? null;
			const portableTarget = portablePackageTarget(entry);
			const portable = portableTarget
				? portableByKey.get(`${portableTarget.kind}:${portableTarget.id}`)
				: undefined;
			// Surface plugin dependencies in the catalog detail ("Requires these
			// apps"). Core's catalog source emits `requires`, but fall back to the
			// live app record (list_apps carries it too) so a built-in app's deps
			// show even when the source omits them. Convert the record's camelCase
			// `minVersion` to the catalog entry's snake_case `min_version` shape.
			const requires =
				entry.requires ??
				(info?.requires
					? {
							apps: info.requires.apps.map((d) => ({
								id: d.id,
								min_version: d.minVersion,
							})),
							grants: info.requires.grants,
						}
					: null);
			return {
				entry: requires === entry.requires ? entry : { ...entry, requires },
				info,
				installed: portable ? true : (info?.installed ?? false),
				enabled: portable?.enabled ?? info?.enabled ?? false,
				// The train this install follows, so the detail bar can say "Beta
				// channel" instead of leaving the user to infer it from a version
				// suffix that a channel pin does not always show.
				channel: info?.channel ?? null,
				// What is on the machine, which is what a channel switch is compared
				// against — the entry's own `version` is the newest published one.
				installedVersion: portable?.version ?? info?.installedVersion ?? null,
				grants: info?.permissionGrants ?? entry.permission_grants ?? [],
			};
		});
	}, [catalogEntries, appsQuery.data, portablePackagesQuery.data]);

	const selectedItem = useMemo(
		() => items.find((it) => it.entry.id === selectedId) ?? null,
		[items, selectedId]
	);

	// Detail is fetched for EVERY selected listing.
	//
	// It used to be gated on "descriptor source, or resolvable from a local
	// manifest", which excluded the most common case in the store: a
	// not-yet-installed listing on the first-party catalog. The detail payload is
	// what the README / API / Versions / Dependencies / Health tabs read AND what
	// the trust scorecard grades, so that gate is why Apps and Plugins rendered a
	// bare Overview while Community — which always fetched — showed the full tab set
	// and the health card. Same listings, different depth of page, for a reason no
	// user could see.
	//
	// The gate was there because the marketplace source could not answer for an
	// arbitrary id. Core now resolves detail against the merged first-party view
	// (git catalog, then the hosted server, then the local manifest), so the request
	// is answerable; a source that genuinely has nothing degrades to `detailError`,
	// which the panel already renders inline without losing the Overview.
	const detailQuery = useQuery(
		useMemo(
			() =>
				({
					queryKey: [
						"plugins",
						"detail",
						url,
						selectedId,
						activeSource,
						origin ?? null,
					],
					queryFn:
						selectedId === null || selectedId === undefined
							? skipToken
							: () =>
									fetchPluginCatalogDetail(
										target,
										selectedId,
										origin,
										origin ? undefined : activeSource
									),
					enabled: selectedId !== null,
				}) satisfies UseQueryOptions<
					Awaited<ReturnType<typeof fetchPluginCatalogDetail>>
				>,
			[target, url, selectedId, activeSource, origin]
		)
	);

	// The authoritative installed/enabled refresh — the ONE query whose result
	// decides what the button says next (Add → Enable). Awaited by the mutations,
	// so the busy flag survives exactly until the new state is on screen and the
	// button never flickers back to "Add" for a frame.
	//
	// Bounded, because awaiting a refetch from a mutation is precisely what used to
	// wedge this: `onSettled` returned a `Promise.all` over THREE invalidations,
	// and react-query holds `isPending` until `onSettled` resolves. Two of those
	// three refetch the infinite catalog query — for BOTH mounted sections, since
	// the 3-element key prefix matches the first-party feed AND the community one —
	// so adding a first-party app waited on a GitHub-topic browse it had nothing to
	// do with, over fetches that carry no abort signal. That is why an add sat on
	// "Installing" long after Core had finished.
	const revalidateInstalledState = useCallback(
		() =>
			Promise.race([
				qc.invalidateQueries({ queryKey: ["apps", "list", url] }),
				qc.invalidateQueries({
					queryKey: ["marketplace", "packages", "installed", url],
				}),
				new Promise<void>((resolve) => {
					setTimeout(resolve, INSTALLED_REFRESH_DEADLINE_MS);
				}),
			]).catch(() => undefined),
		[qc, url]
	);

	// Everything the action changed that is BROWSE state, not action state. Fired
	// and forgotten by design — a stale shelf is a cosmetic lag, and nothing here
	// can decide whether the action finished, so nothing here may hold the button.
	const revalidateBrowse = useCallback(() => {
		Promise.all([
			qc.invalidateQueries({ queryKey: ["plugins", "catalog", url] }),
			// A plugin's enabled state drives its declarative contributions
			// (companion routes + slash commands). Invalidate so enabling/disabling
			// from the Store adds/removes its /plugin/<id> route + palette command
			// WITHOUT a reload — the composer/palette query key is prefix-matched.
			qc.invalidateQueries({ queryKey: ["plugin-contributions"] }),
		]).catch(() => undefined);
	}, [qc, url]);

	const installMutation = useMutation({
		mutationFn: async ({
			item,
			channel,
		}: {
			channel?: string | null;
			item: AppCatalogItem;
		}): Promise<void> => {
			await installCatalogEntry({ url, token, userJwt }, item.entry, {
				channel,
				installed: item.installed,
				orgInstallBlock,
			});
		},
		// Both halves of the shared flag live on the mutation lifecycle, never in a
		// component effect: a card that unmounts mid-add (scrolled out of a
		// virtualized grid, or the section switched) must not strand its id as busy.
		onMutate: ({ item }) => beginInstall(item.entry.id),
		onSettled: async (_data, _error, { item }) => {
			revalidateBrowse();
			await revalidateInstalledState();
			endInstall(item.entry.id);
		},
	});

	const installVersionMutation = useMutation({
		mutationFn: async ({
			item,
			version,
		}: {
			item: AppCatalogItem;
			version: CatalogVersion;
		}): Promise<void> => {
			if (item.entry.origin === "community") {
				throw new Error(
					"Community listings are browse-only — open the repository to review it before installing."
				);
			}
			if (item.entry.descriptor_only) {
				throw new Error(
					"Integration descriptors are browse-only — open the link to configure."
				);
			}
			if (item.entry.source === "built-in") {
				throw new Error(
					"Built-in plugins do not have separate version archives."
				);
			}
			const portableTarget = portablePackageTarget(item.entry);
			if (portableTarget) {
				await installPortablePackage({ url, token, userJwt }, portableTarget, {
					update: item.installed,
					version: version.version,
				});
				return;
			}
			if (item.installed) {
				await updateInstalledPluginAtVersion(
					{ url, token, userJwt },
					item.entry.id,
					version.version
				);
				return;
			}
			await installPluginFromCatalogAtVersion(
				{ url, token, userJwt },
				item.entry.id,
				version.version,
				readBuyerToken()
			);
		},
		onMutate: ({ item }) => beginInstall(item.entry.id),
		onSettled: async (_data, _error, { item }) => {
			revalidateBrowse();
			await revalidateInstalledState();
			endInstall(item.entry.id);
		},
	});

	const installUrlMutation = useMutation({
		mutationFn: (appUrl: string) =>
			installAppFromUrl({ url, token, userJwt }, appUrl),
		// No catalog id to key a card by — this one is driven from a URL field that
		// owns its own busy state.
		onSettled: async () => {
			revalidateBrowse();
			await revalidateInstalledState();
		},
	});

	const lifecycleMutation = useMutation<
		| AppToggleResult
		| import("@/src/lib/api/marketplace.ts").PortablePackageState,
		Error,
		{ item: AppCatalogItem; enabled: boolean }
	>({
		mutationFn: ({
			item,
			enabled,
		}: {
			item: AppCatalogItem;
			enabled: boolean;
		}) => {
			const portableTarget = portablePackageTarget(item.entry);
			if (portableTarget) {
				return setPortablePackageEnabled(
					{ url, token, userJwt },
					portableTarget,
					enabled
				);
			}
			return enabled
				? enableApp({ url, token, userJwt }, item.entry.id)
				: disableApp({ url, token, userJwt }, item.entry.id);
		},
		// Enable/disable share the flag with add: the card's control is the same
		// control, and the item is equally un-clickable during either.
		onMutate: ({ item }) => beginInstall(item.entry.id),
		onSettled: async (_data, _error, { item }) => {
			revalidateBrowse();
			await revalidateInstalledState();
			endInstall(item.entry.id);
		},
	});

	// `select("")` is how the section closes the preview — normalise it to null so
	// the detail query stays disabled instead of fetching an empty id.
	const select = useCallback((id: string) => setSelectedId(id || null), []);

	const install = useCallback(
		async (id?: string, options?: { channel?: string | null }) => {
			// An explicit id is what a CARD passes: the card knows which row was
			// clicked, and making it round-trip through the selection is how a
			// mis-timed selection change could send the add to the wrong listing.
			const wanted = id ?? selectedId;
			const item = items.find((it) => it.entry.id === wanted);
			if (!item) {
				return;
			}
			await installMutation.mutateAsync({
				channel: options?.channel ?? null,
				item,
			});
		},
		[items, selectedId, installMutation]
	);

	const setEnabled = useCallback(
		async (enabled: boolean) => {
			if (!selectedId) {
				return;
			}
			const item = items.find((candidate) => candidate.entry.id === selectedId);
			if (!item) {
				return;
			}
			await lifecycleMutation.mutateAsync({ item, enabled });
		},
		[items, selectedId, lifecycleMutation]
	);

	const installFromUrl = useCallback(
		async (appUrl: string) => {
			await installUrlMutation.mutateAsync(appUrl);
		},
		[installUrlMutation]
	);

	const installVersion = useCallback(
		async (id: string, version: CatalogVersion) => {
			const item = items.find((candidate) => candidate.entry.id === id);
			if (!item) {
				return;
			}
			await installVersionMutation.mutateAsync({ item, version });
		},
		[installVersionMutation, items]
	);

	// Switching trains is an UPDATE of something already installed, which is why it
	// goes through the update endpoint rather than install: Core re-resolves the
	// listing on the requested channel, re-runs the signature + bundle-integrity
	// checks, moves the install to that train's current build and
	// persists the new pin. It can move the version BACKWARDS — every prerelease
	// sorts below its stable release — and Core allows that for an explicit switch
	// without a `force`, because the request itself is the authority.
	const switchChannelMutation = useMutation({
		mutationFn: ({ id, channel }: { channel: string | null; id: string }) =>
			updateInstalledPlugin({ url, token, userJwt }, id, channel),
		// Shares the per-listing busy flag with add/enable: it is the same row, and
		// it is equally un-clickable while Core is re-resolving it.
		onMutate: ({ id }) => beginInstall(id),
		onSettled: async (_data, _error, { id }) => {
			revalidateBrowse();
			await revalidateInstalledState();
			endInstall(id);
		},
	});

	const switchChannel = useCallback(
		async (id: string, channel: string | null) => {
			await switchChannelMutation.mutateAsync({ channel, id });
		},
		[switchChannelMutation]
	);

	const errorOf = (e: DefaultError | Error | null): string | null =>
		e instanceof Error ? e.message : null;
	const loadError =
		errorOf(listQuery.error) ??
		errorOf(appsQuery.error) ??
		errorOf(portablePackagesQuery.error);
	const browseNote = listQuery.data?.pages.find((p) => p.note)?.note ?? null;
	const actionError =
		errorOf(lifecycleMutation.error) ??
		errorOf(installUrlMutation.error) ??
		errorOf(installVersionMutation.error) ??
		errorOf(switchChannelMutation.error) ??
		errorOf(installMutation.error);

	return {
		items,
		loading:
			listQuery.isLoading ||
			appsQuery.isLoading ||
			portablePackagesQuery.isLoading,
		error: actionError ?? browseNote ?? loadError,
		installUrlError: errorOf(installUrlMutation.error),
		fetchNextPage: listQuery.fetchNextPage,
		hasNextPage: listQuery.hasNextPage,
		loadingMore: listQuery.isFetchingNextPage,
		query,
		setQuery,
		selectedId,
		select,
		selectedItem,
		detail: detailQuery.data ?? null,
		detailLoading: detailQuery.isLoading && selectedId !== null,
		detailError:
			detailQuery.error instanceof Error ? detailQuery.error.message : null,
		install,
		installVersion,
		installing: installMutation.isPending
			? (installMutation.variables?.item.entry.id ?? null)
			: null,
		setEnabled,
		lifecyclePending: lifecycleMutation.isPending,
		installFromUrl,
		switchChannel,
		sources,
		activeSource,
		selectSource,
		// Selection is local state now, so it never has a request in flight.
		selectingSource: false,
		addMarketplace,
		addingMarketplace: addMarketplaceMutation.isPending,
	};
}
