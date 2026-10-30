import type {
	ConsentActions,
	ConsentHostValue,
} from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import type {
	ConnectAppInfo,
	ConnectAppRequest,
} from "@ryu/blocks/desktop/agent-elements/tools/consent-tool.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import {
	connectMcpOAuth,
	fetchMcpOAuth,
	fetchMcpOAuthFlow,
} from "@/src/lib/api/mcp-oauth.ts";
import {
	type CatalogEntry,
	fetchPluginSources,
} from "@/src/lib/api/plugins.ts";
import {
	catalogInstallRefusal,
	installCatalogEntry,
} from "@/src/lib/catalog-entry-install.ts";
import {
	CONNECTION_ACCESS_OPTIONS,
	normalizeConnectionAccessLevel,
} from "@/src/lib/connection-permissions.ts";
import { beginInstall, endInstall } from "@/src/store/useInstallStore.ts";
import {
	candidateFromEntry,
	loadInstalledState,
	readEnabledBounded,
	searchEntries,
} from "./chat-consent-host-catalog.ts";
import { pollUntilConnected } from "./chat-consent-host-polling.ts";

export { candidateFromEntry } from "./chat-consent-host-catalog.ts";

/**
 * Desktop side of the in-chat consent cards (`consent.connect_app` /
 * `consent.install_plugin`). Every action here runs from the user's click on a
 * card and goes through the same routes as the Store and the Connections page:
 * signed catalog installs, org install policy, Composio and MCP OAuth.
 */

/** OAuth profile the card connects. The Connections page offers others. */
const DEFAULT_PROFILE_ID = "personal";
const TOOLKITS_STALE_MS = 5 * 60 * 1000;
const FAILED_COMPOSIO_STATUSES = new Set(["FAILED", "EXPIRED", "INACTIVE"]);

/** Refresh cached queries without making the caller wait on the refetch. */
function refreshInBackground(
	queryClient: QueryClient,
	queryKey: readonly unknown[]
): void {
	queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
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
	const tl = useLiteralMessages();
	// Read through a ref so a new translator each render keeps the actions stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
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
					unavailableReason: tlRef.current(
						"Install {name} first, then connect it.",
						{
							name: app?.name ?? pluginId,
						}
					),
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
					unavailableReason: tlRef.current(
						"{name} is turned off. Turn it on in the Store to review its permissions, then connect it.",
						{ name }
					),
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
					unavailableReason: tlRef.current(
						'{name} has no sign-in for "{app}".',
						{
							app: request.app,
							name,
						}
					),
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
