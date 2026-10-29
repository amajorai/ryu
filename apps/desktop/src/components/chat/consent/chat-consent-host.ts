import type {
	ConsentActions,
	ConsentHostValue,
} from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import {
	type ConnectAppInfo,
	type ConnectAppRequest,
	type ConsentPluginCandidate,
	type PluginInstallRequest,
	pluginTrustTier,
} from "@ryu/blocks/desktop/agent-elements/tools/consent-tool.ts";
import { ALL_PLUGIN_SOURCES_ID } from "@ryu/marketplace/catalog/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useContext, useMemo, useRef } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { installedAppsQuery } from "@/src/hooks/useAppsCatalog.ts";
import { useOrgFeatures } from "@/src/hooks/useOrgFeatures.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ComposioToolkit,
	fetchComposioConnectionStatus,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import { fetchInstalledPortablePackages } from "@/src/lib/api/marketplace.ts";
import {
	connectMcpOAuth,
	fetchMcpOAuth,
	fetchMcpOAuthFlow,
} from "@/src/lib/api/mcp-oauth.ts";
import {
	type AppInfo,
	type CatalogEntry,
	fetchApps,
	fetchPluginSources,
	searchPluginCatalog,
} from "@/src/lib/api/plugins.ts";
import {
	catalogInstallRefusal,
	installCatalogEntry,
	portablePackageTarget,
} from "@/src/lib/catalog-entry-install.ts";
import {
	CONNECTION_ACCESS_OPTIONS,
	normalizeConnectionAccessLevel,
} from "@/src/lib/connection-permissions.ts";
import { beginInstall, endInstall } from "@/src/store/useInstallStore.ts";

/**
 * Desktop side of the in-chat consent cards (`consent.connect_app` /
 * `consent.install_plugin`). Every action here runs from the user's click on a
 * card and goes through the same routes as the Store and the Connections page:
 * signed catalog installs, org install policy, Composio and MCP OAuth.
 */

/** OAuth profile the card connects. The Connections page offers others. */
const DEFAULT_PROFILE_ID = "personal";
const SEARCH_LIMIT = 8;
const POLL_INTERVAL_MS = 2000;
/** Give up waiting for a browser sign-in after this long. */
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;
const TOOLKITS_STALE_MS = 5 * 60 * 1000;
const STATUS_REQUEST_TIMEOUT_MS = 15_000;
const FAILED_COMPOSIO_STATUSES = new Set(["FAILED", "EXPIRED", "INACTIVE"]);

function abortError(): DOMException {
	return new DOMException("The connection was cancelled.", "AbortError");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Poll `check` until it reports done. `check` returns true when connected and
 * throws when the flow failed. Rejects on abort or after the timeout.
 */
async function pollUntilConnected(
	check: () => Promise<boolean>,
	signal: AbortSignal,
	appName: string
): Promise<void> {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await wait(POLL_INTERVAL_MS, signal);
		// Each status request is bounded too: a stalled request must not hold
		// the card past the deadline or ignore "Stop waiting".
		const remaining = Math.max(0, deadline - Date.now());
		if (
			await boundedCheck(
				check,
				signal,
				Math.min(STATUS_REQUEST_TIMEOUT_MS, remaining)
			)
		) {
			return;
		}
	}
	throw new Error(
		`Timed out waiting for ${appName}. Try again when you're ready to sign in.`
	);
}

/** One status check that settles on abort or after `timeoutMs`, as "not yet". */
function boundedCheck(
	check: () => Promise<boolean>,
	signal: AbortSignal,
	timeoutMs: number
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);
		function onAbort() {
			cleanup();
			reject(abortError());
		}
		function cleanup() {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
		signal.addEventListener("abort", onAbort, { once: true });
		check().then(
			(done) => {
				cleanup();
				resolve(done);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			}
		);
	});
}

function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first https link a user can review the listing at: its repository,
 *  an integration descriptor's source, or its homepage. */
function reviewUrlFor(entry: CatalogEntry): string | null {
	const links = [
		entry.repo_url,
		entry.repository_url,
		entry.integration_url,
		entry.homepage,
	];
	return links.find((url) => url && /^https:\/\//i.test(url)) ?? null;
}

/** Core serves these two ids as one merged first-party catalog. */
const MERGED_FIRST_PARTY_SOURCES = new Set(["ryu-marketplace", "ryu-catalog"]);

function canonicalSourceId(id: string | null | undefined): string | null {
	if (!id) {
		return null;
	}
	return MERGED_FIRST_PARTY_SOURCES.has(id) ? "ryu-catalog" : id;
}

/** Map a catalog entry to the card's candidate. Trust comes from the entry's
 *  server-derived fields only. */
export function candidateFromEntry(
	entry: CatalogEntry,
	installed: ReadonlyMap<string, { enabled: boolean }>,
	requestedIds: ReadonlySet<string>,
	activeSourceId: string | null = null
): ConsentPluginCandidate {
	const record = installed.get(entry.id);
	const catalogInstallable = catalogInstallRefusal(entry) === null;
	// Core installs by id, trying the node's active marketplace first. A listing
	// browsed from another marketplace (stamped in the all-marketplaces view)
	// could resolve to a different same-id package, so it goes to the Store.
	const storeOnly =
		catalogInstallable &&
		Boolean(entry.catalog_source_id) &&
		canonicalSourceId(entry.catalog_source_id) !==
			canonicalSourceId(activeSourceId);
	return {
		author: entry.author ?? entry.developer ?? null,
		description: entry.tagline ?? entry.description ?? null,
		downloads: finiteOrNull(entry.downloads),
		enabled: record?.enabled ?? false,
		iconUrl: entry.icon_url ?? null,
		id: entry.id,
		installable: catalogInstallable && !storeOnly,
		installed: record !== undefined,
		name: entry.name,
		ratingAverage: finiteOrNull(entry.rating_average),
		ratingCount: finiteOrNull(entry.rating_count),
		requested: requestedIds.has(entry.id),
		reviewed: typeof entry.reviewed === "boolean" ? entry.reviewed : null,
		reviewUrl: reviewUrlFor(entry),
		stars: finiteOrNull(entry.stars),
		storeOnly,
		tier: pluginTrustTier(entry),
		version: entry.version || null,
	};
}

/** Refresh cached queries without making the caller wait on the refetch. */
function refreshInBackground(
	queryClient: QueryClient,
	queryKey: readonly unknown[]
): void {
	queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
}

/**
 * Installed state for each entry, read the way the Store reads it: portable
 * packages from their own registry, everything else from `/api/apps`. A failed
 * read rejects, so the card shows an error instead of offering Install for a
 * plugin that is already there.
 */
async function loadInstalledState(
	target: ApiTarget,
	entries: readonly CatalogEntry[]
): Promise<Map<string, { enabled: boolean }>> {
	const needsPortable = entries.some((entry) => portablePackageTarget(entry));
	const [apps, portable] = await Promise.all([
		fetchApps(target),
		needsPortable ? fetchInstalledPortablePackages(target) : [],
	]);
	const appState = new Map(
		apps
			.filter((app: AppInfo) => app.installed)
			.map((app) => [app.id, { enabled: app.enabled }] as const)
	);
	const portableState = new Map(
		portable.map((pkg) => [`${pkg.kind}:${pkg.id}`, { enabled: pkg.enabled }])
	);
	const installed = new Map<string, { enabled: boolean }>();
	for (const entry of entries) {
		const pkg = portablePackageTarget(entry);
		const state = pkg
			? portableState.get(`${pkg.kind}:${pkg.id}`)
			: appState.get(entry.id);
		if (state) {
			installed.set(entry.id, state);
		}
	}
	return installed;
}

/** How long the post-install "is it on?" read may take before the card
 *  falls back to asking the user to confirm in the Store. */
const ENABLED_CHECK_TIMEOUT_MS = 10_000;

async function readEnabledBounded(
	target: ApiTarget,
	entry: CatalogEntry
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ENABLED_CHECK_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			loadInstalledState(target, [entry]).then(
				(state) => state.get(entry.id)?.enabled ?? false
			),
			timeout,
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Catalog entries matching the request: named ids, the reviewed catalog, and
 *  the community feed. A failed source contributes nothing rather than failing
 *  the card, unless every source failed. */
async function searchEntries(
	target: ApiTarget,
	request: PluginInstallRequest
): Promise<CatalogEntry[]> {
	const searches: Promise<CatalogEntry[]>[] = [];
	// A named id may be a reviewed listing or a community one; the default view
	// leaves community listings out, so look in both.
	for (const id of request.pluginIds) {
		for (const origin of [undefined, "community"] as const) {
			searches.push(
				searchPluginCatalog(target, {
					limit: SEARCH_LIMIT,
					query: id,
					...(origin ? { origin } : { source: ALL_PLUGIN_SOURCES_ID }),
				}).then((page) => page.entries.filter((entry) => entry.id === id))
			);
		}
	}
	if (request.query) {
		const query = request.query;
		searches.push(
			// Every registered marketplace, the Store's default view.
			searchPluginCatalog(target, {
				limit: SEARCH_LIMIT,
				query,
				source: ALL_PLUGIN_SOURCES_ID,
			}).then((page) => page.entries),
			searchPluginCatalog(target, {
				limit: SEARCH_LIMIT,
				origin: "community",
				query,
			}).then((page) => page.entries)
		);
	}
	const settled = await Promise.allSettled(searches);
	const entries: CatalogEntry[] = [];
	let failure: unknown = null;
	let anySucceeded = false;
	for (const result of settled) {
		if (result.status === "fulfilled") {
			anySucceeded = true;
			entries.push(...result.value);
		} else {
			failure ??= result.reason;
		}
	}
	// Only a total failure is an error: one source answering "no matches" while
	// another is down is still a real, empty result.
	if (!anySucceeded && failure) {
		throw failure instanceof Error
			? failure
			: new Error("Couldn't search the plugin catalog.");
	}
	return entries;
}

function toolkitFor(
	toolkits: ComposioToolkit[],
	slug: string
): ComposioToolkit | undefined {
	const wanted = slug.toLowerCase();
	return toolkits.find((toolkit) => toolkit.slug.toLowerCase() === wanted);
}

/** The actions for the chat the card renders in. */
export function useChatConsentActions(): ConsentActions {
	const activeNode = useActiveNode();
	const queryClient = useQueryClient();
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const tabs = useContext(TabsContext);
	const openTab = tabs?.openTab;
	// Entries behind the candidates the card holds, keyed by node and id, so an
	// install uses the full record read from the node the user reviewed.
	const entriesRef = useRef(new Map<string, CatalogEntry>());
	const { token, url, userJwt } = activeNode;
	// Bumps whenever the node or its credentials change (account switch, token
	// rotation), so cards re-review in the scope their clicks will run in. A
	// counter rather than the credential itself keeps secrets out of the key.
	const scopeRef = useRef({ generation: 0, token, url, userJwt });
	const scope = scopeRef.current;
	if (scope.url !== url || scope.token !== token || scope.userJwt !== userJwt) {
		scopeRef.current = {
			generation: scope.generation + 1,
			token,
			url,
			userJwt,
		};
	}
	const nodeKey = `${url}#${scopeRef.current.generation}`;

	return useMemo<ConsentActions>(() => {
		// One node per actions object: when the node changes, `nodeKey` changes
		// and every card reloads from the new node before it can act again.
		const target: ApiTarget = {
			token: token ?? null,
			url,
			userJwt: userJwt ?? null,
		};
		const entryKey = (id: string) => `${nodeKey}\u0000${id}`;
		const orgInstallBlock = (fromCatalog: boolean): string | null => {
			if (fromCatalog && !orgFeatureEnabled("plugins.marketplace")) {
				return "Marketplace plugins are disabled by your organization's administrator.";
			}
			if (!(fromCatalog || orgFeatureEnabled("apps.install"))) {
				return "App installation is disabled by your organization's administrator.";
			}
			return null;
		};

		const describeComposio = async (
			target: ApiTarget,
			request: ConnectAppRequest
		): Promise<ConnectAppInfo> => {
			const status = await fetchComposioStatus(target);
			if (!status.configured) {
				return {
					available: false,
					connected: false,
					logoUrl: null,
					name: request.app,
					unavailableKind: "not_configured",
					unavailableReason:
						"App connections aren't set up yet. Add them under Store → Connections, then ask again.",
				};
			}
			const [toolkits, connections] = await Promise.all([
				queryClient
					.fetchQuery({
						queryFn: () => fetchComposioToolkits(target),
						queryKey: ["chat-consent", "composio-toolkits", target.url],
						staleTime: TOOLKITS_STALE_MS,
					})
					.catch(() => []),
				fetchComposioConnections(target, request.app),
			]);
			const toolkit = toolkitFor(toolkits, request.app);
			return {
				available: true,
				connected: connections.some((connection) => connection.active),
				logoUrl: toolkit?.logo ?? null,
				// Named from the resolved toolkit, never from the agent's words, so
				// the card can't say one app while connecting another.
				name: toolkit?.name ?? request.app,
				unavailableKind: null,
				unavailableReason: null,
			};
		};

		const describeMcp = async (
			target: ApiTarget,
			request: ConnectAppRequest,
			pluginId: string
		): Promise<ConnectAppInfo> => {
			// A failed lookup reaches the card as an error, not as "install first".
			const apps = await queryClient.fetchQuery(installedAppsQuery(target));
			const app = apps.find((candidate) => candidate.id === pluginId);
			if (!app?.installed) {
				return {
					available: false,
					connected: false,
					logoUrl: app?.iconUrl ?? null,
					name: app?.name ?? request.app,
					unavailableKind: "not_installed",
					unavailableReason: `Install ${app?.name ?? pluginId} first, then connect it.`,
				};
			}
			const name = app.name;
			if (!app.enabled) {
				// Core refuses OAuth for a plugin that is off, and its tools are
				// unavailable anyway: the permission review comes first.
				return {
					available: false,
					connected: false,
					logoUrl: app.iconUrl ?? null,
					name,
					unavailableKind: "turned_off",
					unavailableReason: `${name} is turned off. Turn it on in the Store to review its permissions, then connect it.`,
				};
			}
			const servers = await fetchMcpOAuth(target, pluginId);
			const server = servers.find(
				(candidate) => candidate.serverName === request.app
			);
			if (!server) {
				return {
					available: false,
					connected: false,
					logoUrl: app.iconUrl ?? null,
					name,
					unavailableKind: "no_sign_in",
					unavailableReason: `${name} has no sign-in for "${request.app}".`,
				};
			}
			return {
				available: true,
				connected: server.connections.some(
					(connection) =>
						connection.profileId === DEFAULT_PROFILE_ID &&
						connection.status === "connected"
				),
				logoUrl: app.iconUrl ?? null,
				name,
				unavailableKind: null,
				unavailableReason: null,
			};
		};

		return {
			accessOptions: CONNECTION_ACCESS_OPTIONS,
			nodeKey,
			describeApp(request) {
				if (request.provider === "mcp" && request.pluginId) {
					return describeMcp(target, request, request.pluginId);
				}
				return describeComposio(target, request);
			},

			async connectApp(request, accessLevel, signal) {
				const level = normalizeConnectionAccessLevel(accessLevel);
				const appName = request.app;
				if (request.provider === "mcp" && request.pluginId) {
					const pluginId = request.pluginId;
					const started = await connectMcpOAuth(
						target,
						pluginId,
						request.app,
						DEFAULT_PROFILE_ID,
						level
					);
					await openExternal(started.authorizationUrl);
					await pollUntilConnected(
						async () => {
							const flow = await fetchMcpOAuthFlow(
								target,
								pluginId,
								started.flowId
							);
							if (flow.status === "failed") {
								throw new Error(flow.error ?? `Couldn't connect ${appName}.`);
							}
							return flow.status === "connected";
						},
						signal,
						appName
					);
					refreshInBackground(queryClient, ["mcp-oauth", target.url, pluginId]);
					return;
				}
				const started = await initiateComposioConnection(
					target,
					request.app,
					level
				);
				if (!started.redirectUrl) {
					throw new Error(`${appName} did not return a sign-in link.`);
				}
				await openExternal(started.redirectUrl);
				await pollUntilConnected(
					async () => {
						const connection = await fetchComposioConnectionStatus(
							target,
							started.connectionId
						);
						if (
							!connection.active &&
							FAILED_COMPOSIO_STATUSES.has(connection.status.toUpperCase())
						) {
							throw new Error(`Couldn't connect ${appName}.`);
						}
						return connection.active;
					},
					signal,
					appName
				);
				refreshInBackground(queryClient, ["composio", "connections"]);
			},

			async findPlugins(request) {
				const [entries, sources] = await Promise.all([
					searchEntries(target, request),
					fetchPluginSources(target),
				]);
				const installed = await loadInstalledState(target, entries);
				const activeSourceId = sources.active || null;
				const requestedIds = new Set(request.pluginIds);
				// First occurrence wins, matching the card's own de-duplication, so
				// the entry an install uses is the one the user saw.
				const seen = new Set<string>();
				for (const entry of entries) {
					if (!seen.has(entry.id)) {
						seen.add(entry.id);
						entriesRef.current.set(entryKey(entry.id), entry);
					}
				}
				return entries.map((entry) =>
					candidateFromEntry(entry, installed, requestedIds, activeSourceId)
				);
			},

			async installPlugin(candidate) {
				const entry = entriesRef.current.get(entryKey(candidate.id));
				if (!entry) {
					throw new Error(
						"This listing wasn't loaded from the current node. Review it again."
					);
				}
				if (!candidate.installable) {
					throw new Error("Install this plugin from the Store.");
				}
				beginInstall(entry.id);
				try {
					await installCatalogEntry(target, entry, {
						installed: candidate.installed,
						orgInstallBlock,
					});
				} finally {
					endInstall(entry.id);
					// The install already succeeded or failed; a slow refetch must not
					// hold the card on "Installing" or delay the agent's follow-up.
					refreshInBackground(queryClient, ["apps"]);
					refreshInBackground(queryClient, [
						"marketplace",
						"packages",
						"installed",
						url,
					]);
				}
				// The install itself succeeded. Reading whether it is on is a
				// separate, bounded check: if it fails or stalls, report "off" so the
				// card asks the user to confirm in the Store, never a failed install
				// that invites a duplicate one.
				return { enabled: await readEnabledBounded(target, entry) };
			},

			async isPluginEnabled(candidate) {
				const entry = entriesRef.current.get(entryKey(candidate.id));
				if (!entry) {
					return false;
				}
				const state = await loadInstalledState(target, [entry]);
				return state.get(entry.id)?.enabled ?? false;
			},

			openPluginListing(candidate) {
				const entry = entriesRef.current.get(entryKey(candidate.id));
				if (openTab && entry && catalogInstallRefusal(entry) === null) {
					openTab("/marketplace", {
						initialStoreItem: { id: entry.id, kind: entry.type ?? "plugin" },
						initialStoreQuery: entry.name,
					});
					return;
				}
				if (candidate.reviewUrl) {
					openExternal(candidate.reviewUrl).catch(() => undefined);
				}
			},
		};
	}, [nodeKey, openTab, orgFeatureEnabled, queryClient, token, url, userJwt]);
}

/** Constant host value: mounted once at the app root. */
export const chatConsentHost: ConsentHostValue = {
	useActions: useChatConsentActions,
};
