// Mounts a THIRD-PARTY plugin's bundled UI through the extension host, inside the
// null-origin sandboxed iframe, gated by the plugin's GATEWAY-APPROVED grants.
//
// This is the trusted-webview side of the third-party code path (the general
// sibling of `ExamplePluginPanel`, which mounts one fixed built-in demo). It:
//   - fetches the plugin's bundled code over the TRUSTED Core API (the host holds
//     the node token; the plugin never does),
//   - builds the granted capability set from the plugin's `approved_grants`
//     (Gateway-validated) — NEVER the manifest's `permission_grants` claim, and
//     DENY-SAFE (empty set) if anything is missing,
//   - implements the privileged host services (`listAgents` projected to
//     `{id,name}` only; `registerRoute` scoped to this plugin's own surface), and
//   - wraps the sandboxed frame in a visible "Plugin" attribution header so it is
//     never mistaken for system chrome (invariant #6).
//
// It renders NOTHING until the caller (PluginCompanionPage) decides the plugin
// actually carries a UI bundle.

import {
	APP_DOWNLOAD_GRANT,
	type ExtensionFrameMessage,
	ExtensionHost,
	shouldEnableCompanionFormEvents,
} from "@ryu/app-host/ExtensionHost";
import { useModelContextStore } from "@ryu/app-host/model-context";
import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
} from "@ryu/app-host/rpc";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "@ryu/app-host/toast-host";
import { browserRecordingHost } from "@ryu/blocks/companion/browser-recording.ts";
import { useI18n, useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	fetchPluginUiBundle,
	type PluginCompanion,
} from "@/src/lib/api/plugins.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { usePluginAssistantBridge } from "./PluginHostPanel-assistant-bridge.ts";
import { useOpenedFilePush } from "./PluginHostPanel-opened-file-push.ts";
import { PanelPlaceholder } from "./PluginHostPanel-placeholder.tsx";
import { buildPluginHostAppServices } from "./PluginHostPanel-services-apps.ts";
import type {
	ApplicationRealtimeSession,
	PluginHostServicesContext,
} from "./PluginHostPanel-services-context.ts";
import { buildPluginHostCoreServices } from "./PluginHostPanel-services-core.ts";
import { buildPluginHostMediaWorkflowServices } from "./PluginHostPanel-services-media-workflows.ts";
import { buildPluginHostRequestServices } from "./PluginHostPanel-services-requests.ts";
import { buildPluginHostShellServices } from "./PluginHostPanel-services-shell.ts";
import { usePluginHostSrcdoc } from "./PluginHostPanel-srcdoc.ts";
import { usePluginHostThemeTokens } from "./PluginHostPanel-theme-tokens.ts";

const PLUGIN_TOAST_RENDERER = createSileoToastRenderer(toast);

/** How long the sandbox bridge may take to connect before the startup state stops
 *  claiming progress and offers a retry. Long enough that a cold, heavy bundle is
 *  not accused of being broken; short enough that a lost handshake is not a
 *  spinner you stare at. */
const STALL_AFTER_MS = 8000;
/** How long Retry stays disabled after a press. A reload is cheap but not free
 *  (re-fetch + re-parse the bundle), and a mashed button only ever makes a slow
 *  frame slower by restarting it. */
const RETRY_COOLDOWN_MS = 15_000;

export function PluginHostPanel({
	companion,
	mountContext,
	onMessage,
	onRequestClose,
	fileAccess,
}: {
	companion: PluginCompanion;
	/** Optional host-supplied context baked into the frame as `window.ryu.context`
	 *  (e.g. `{ spaceId, docId }` when the app is opened as a Space document). */
	mountContext?: unknown;
	/** Optional messages emitted by this companion's sandboxed frame. */
	onMessage?: (data: ExtensionFrameMessage) => void;
	/** Supplied only by the host-owned dialog that contains this frame. */
	onRequestClose?: () => void;
	fileAccess?: OpenedFileAccess;
}) {
	const closeOnEscape = onRequestClose !== undefined;
	const node = useActiveNode();
	const getActiveNode = useActiveNodeGetter();
	useEffect(
		() => () => browserRecordingHost.release(companion.pluginId),
		[companion.pluginId]
	);
	const i18n = useI18n();
	const tl = useLiteralMessages();
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const [connectedNonce, setConnectedNonce] = useState<string | null>(null);
	const realtimeLifetimeRef = useRef<AbortController | null>(null);
	const realtimeSessionsRef = useRef(
		new Map<string, ApplicationRealtimeSession>()
	);

	const { initialThemeTokens, themeTokens } = usePluginHostThemeTokens();
	// The shell Settings dialog opener — the `@ryu/quests` companion's detection-
	// settings gear opens Settings → Quests through the `questsOpenDetectionSettings`
	// bridge verb (the QuestsSettings tab stays a shell surface; the extracted page's
	// gear reaches it via this host-side navigation, preserving the old behavior).
	// Quests is an app: its settings render under the Apps header in the node-scoped
	// Gateway dialog, addressed by its `app:<id>` entity value.
	const openGateway = useGatewayDialog((s) => s.openGateway);
	// The shell tab opener — the `@ryu/activity` companion's clickable rows open the
	// chat tab for an item's session through the `activityOpenSession` bridge verb (the
	// extracted page used `useTabsContext().openTab` directly; the sandboxed frame reaches
	// it here). PluginHostPanel renders as tab content, so it sits under TabsProvider.
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	// The current tab id — the `@ryu/skill-editor` companion's `skills.setTitle` verb
	// renames its own owning tab (the desktop page's `updateTabTitle(currentTabId, …)`).
	const currentTabId = useCurrentTabId();
	// The signed-in user id, resolved HOST-SIDE for the `@ryu/approvals` companion's
	// Notifications section: the per-user feed is scoped by user id, but the sandboxed
	// frame has no Better Auth session, so the host reads it (the session query, falling
	// back to the local account vault) exactly as the deleted `useNotifications` hook did.
	const { streamingPrivacyActive } = useUserAvailability();
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);

	// Fetch the plugin's bundled code over the trusted API. `null` (no bundle /
	// not enabled) or an error means we render the benign fallback, never code.
	const bundleQueryOptions = useMemo(
		() => ({
			queryKey: [
				"plugin-ui-bundle",
				target.url,
				target.token,
				target.userJwt,
				companion.pluginId,
			],
			// Fetch by the OWNING plugin id (the store key), not the companion id.
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchPluginUiBundle(target, companion.pluginId, signal),
			retry: false,
			staleTime: 60_000,
		}),
		[companion.pluginId, target]
	);
	const {
		data: code,
		isPending,
		isError,
		refetch,
	} = useQuery(bundleQueryOptions);

	// Retry generation. Bumping it mints a fresh nonce → a fresh `srcdoc` → the
	// iframe genuinely reloads (a re-render alone would not: React leaves an
	// unchanged `srcDoc` attribute alone, so the dead document would just sit
	// there). The nonce is also the ExtensionHost effect's key, so the bridge
	// listener is rebuilt in step with the document it is waiting on.
	const [attempt, setAttempt] = useState(0);
	const grantsKey = [...new Set(companion.approvedGrants)].sort().join(" ");
	// The approved grants as a content-stable list (same set ⇒ same array), for
	// host services that check a specific grant (the cross-app `app.request`).
	const approvedGrantList = useMemo(
		() => (grantsKey ? grantsKey.split(" ") : []),
		[grantsKey]
	);
	const documentScope = JSON.stringify([
		node.url,
		node.token,
		node.userJwt,
		companion.id,
		mountContext ?? null,
		companion.csp ?? null,
		companion.defaultCspEnforced,
	]);
	// One nonce per document and authorization scope. Cosmetic renders keep it stable.
	// code and serialized scope deliberately reset the document handshake.
	const nonce = useMemo(
		() =>
			globalThis.crypto?.randomUUID === undefined
				? `nonce-${attempt}-${Date.now()}-${Math.round(Math.random() * 1e9)}`
				: crypto.randomUUID(),
		[attempt, grantsKey, code, documentScope]
	);
	const connected = connectedNonce === nonce;
	// document replacement owns realtime connection cleanup.
	useEffect(() => {
		const lifetime = new AbortController();
		realtimeLifetimeRef.current = lifetime;
		return () => {
			lifetime.abort();
			for (const session of realtimeSessionsRef.current.values()) {
				session.connection.close();
				session.queue.end();
			}
			realtimeSessionsRef.current.clear();
		};
	}, [nonce]);

	// Startup progress: `stalled` flips when the bridge has not connected within
	// STALL_AFTER_MS, which is what turns the honest "Starting…" state into an
	// actionable one. Reset per attempt.
	const [stalled, setStalled] = useState(false);
	useEffect(() => {
		if (connected) {
			return;
		}
		setStalled(false);
		const id = setTimeout(() => setStalled(true), STALL_AFTER_MS);
		return () => clearTimeout(id);
	}, [connected, nonce]);

	// Retry cooldown, ticked only while it runs (an idle panel must not re-render
	// once a second forever). Armed on press, not on success: the press is what
	// costs a reload, whether or not the reload then works.
	const [cooldownUntil, setCooldownUntil] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const cooldownLeftMs = Math.max(0, cooldownUntil - now);
	const cooldownSeconds = Math.ceil(cooldownLeftMs / 1000);
	const mediaPermission =
		companion.pluginId === "@ryu/voice"
			? "voice.studio.generate"
			: companion.pluginId === "@ryu/canvas" ||
					companion.pluginId === "@ryu/slides"
				? `${companion.pluginId.slice("@ryu/".length)}.generate`
				: undefined;
	useEffect(() => {
		if (cooldownLeftMs <= 0) {
			return;
		}
		const id = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(id);
	}, [cooldownLeftMs]);

	const retry = useCallback(() => {
		setCooldownUntil(Date.now() + RETRY_COOLDOWN_MS);
		setNow(Date.now());
		setConnectedNonce(null);
		setAttempt((n) => n + 1);
		// Re-fetch too: a bundle that failed (or was served by a node still booting)
		// must be re-read, not re-mounted from the same cached miss.
		refetch();
	}, [refetch]);

	// The granted set comes from the plugin's GATEWAY-APPROVED grants, mapped to
	// capabilities (unmapped grants dropped). DENY-SAFE: an empty approved list
	// yields an empty set, so a plugin with no validated grants can call nothing.
	//
	// Keyed by grant CONTENT, not by the array's identity. `granted` is one of the
	// two ExtensionHost effect deps, and that effect's cleanup closes the live RPC
	// port — while the iframe, whose `srcdoc` did not change, never re-announces to
	// get a new one (`handshakeAnnounceScript` clears its retry interval once the
	// port lands, and again after HANDSHAKE_RETRY_WINDOW_MS). So an identity-only
	// change — the contributions query refetching on window focus hands back an
	// equal-but-new `approvedGrants` array — would silently kill the bridge of every
	// open app the first time the window is refocused. Same set ⇒ same Set ⇒ no
	// teardown.
	// grantsKey is the content hash of approvedGrants.
	const granted = useMemo<ReadonlySet<Capability>>(() => {
		const capabilities = new Set(
			capabilitiesFromGrants(companion.approvedGrants)
		);
		if (fileAccess) {
			capabilities.add("file.access");
		}
		return capabilities;
	}, [grantsKey, fileAccess]);
	const filePushRef = useOpenedFilePush(fileAccess, connectedNonce, nonce);

	// This app's assistant-context slice + takeover token. Scoped to the plugin id
	// so two companions of the same app share one slice (they are one app to the
	// user) while different apps stay isolated.
	const assistantOwner = `plugin:${companion.pluginId}:${companion.id}:${nonce}`;
	const modelContext = useModelContextStore(
		(store) => store.entries[assistantOwner]?.state ?? null
	);
	useEffect(() => {
		filePushRef.current?.({
			kind: "ryu-widget-set-globals",
			globals: { modelContext },
		});
	}, [modelContext]);
	const toastHost = useMemo(
		() =>
			createScopedToastHost({
				renderer: PLUGIN_TOAST_RENDERER,
				sourceId: `${companion.pluginId}:${companion.id}`,
			}),
		[companion.id, companion.pluginId]
	);

	useEffect(() => () => toastHost.dispose(), [toastHost]);

	const { assistantContextRef, assistantSurfaceRef, isActiveTabRef } =
		usePluginAssistantBridge(assistantOwner);

	// The privileged services. `listAgents` holds the token and returns a minimal
	// projection; `registerRoute` accepts ONLY this plugin's own `/plugin/<id>`
	// path (anti-phishing), rejecting system/other-plugin paths.
	const services = useMemo<HostServices>(() => {
		const context: PluginHostServicesContext = {
			approvedGrantList,
			assistantContextRef,
			assistantOwner,
			assistantSurfaceRef,
			companion,
			currentTabId,
			distributeInstalledSkill,
			fileAccess,
			getActiveNode,
			i18n,
			isActiveTabRef,
			mediaPermission,
			meId,
			node,
			onRequestClose,
			openGateway,
			openTab,
			realtimeLifetimeRef,
			realtimeSessionsRef,
			toastHost,
			updateTabTitle,
			updateTabsIconWhere,
		};
		return {
			...buildPluginHostCoreServices(context),
			...buildPluginHostMediaWorkflowServices(context),
			...buildPluginHostAppServices(context),
			...buildPluginHostRequestServices(context),
			...buildPluginHostShellServices(context),
		};
	}, [
		node,
		distributeInstalledSkill,
		companion.id,
		companion.name,
		companion.pluginId,
		approvedGrantList,
		assistantOwner,
		openGateway,
		openTab,
		updateTabTitle,
		updateTabsIconWhere,
		currentTabId,
		meId,
		getActiveNode,
		i18n,
		toastHost,
		onRequestClose,
		fileAccess,
	]);

	const isHtmlBundle = Boolean(code && /^\s*<(?:!doctype|html)\b/i.test(code));
	const allowForms = shouldEnableCompanionFormEvents(
		companion.firstParty === true,
		isHtmlBundle
	);
	const srcdoc = usePluginHostSrcdoc({
		closeOnEscape,
		code,
		companion,
		initialThemeTokens,
		isHtmlBundle,
		mountContext,
		nonce,
	});

	const panelTitle = companion.label || companion.name;

	// The bundle fetch failed (`retry: false`, so this is terminal). Distinct from
	// "no bundle": saying "does not provide a runnable UI" for a failed fetch is a
	// lie about the app, and it hides the one thing that would fix it — retrying.
	if (isError) {
		return (
			<PanelPlaceholder
				description="The app's interface could not be fetched from this node. It may still be starting up."
				onRetry={retry}
				retryDisabledFor={cooldownSeconds}
				title={tl("Couldn't load {panelTitle}", { panelTitle })}
			/>
		);
	}

	if (isPending) {
		return (
			<PanelPlaceholder
				busy
				description="Fetching the app's interface from this node."
				title={tl("Loading {panelTitle}…", { panelTitle })}
			/>
		);
	}

	if (!srcdoc) {
		return (
			<PanelPlaceholder
				description="This app has no interface of its own — it works through the rest of Ryu."
				title={tl("{panelTitle} has nothing to show here", { panelTitle })}
			/>
		);
	}

	return (
		// `data-plugin-*` rather than a header strip. The strip that used to sit here
		// spent a whole row of every app's height restating what the tab already
		// says (which plugin this is) plus a status that is only ever "connected" by
		// the time you can read it — the not-connected case is the opaque
		// PanelPlaceholder below, which covers the frame entirely. Attribution now
		// rides the tab; these attributes are what a tab-strip status dot reads.
		<div
			className="relative flex h-full flex-col overflow-hidden"
			data-plugin-id={companion.pluginId}
			data-plugin-state={connected ? "connected" : "starting"}
			data-plugin-title={panelTitle}
		>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					allowDownloads={companion.approvedGrants.includes(APP_DOWNLOAD_GRANT)}
					allowForms={allowForms}
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnectedNonce(nonce)}
					onMessage={onMessage}
					pushRef={filePushRef}
					services={services}
					srcdoc={srcdoc}
					streamingPrivacyActive={streamingPrivacyActive}
					themeTokens={themeTokens}
					title={tl("Plugin: {name}", { name: companion.name })}
				/>
			</div>
			{/* The startup state, centered over the frame rather than a word in a
			    header: until the sandbox bridge connects the frame is blank anyway (a
			    Path-A bundle does not even evaluate before the port lands), so this IS
			    the panel's content, not a decoration on it. Opaque so the blank frame
			    behind it never flashes through. */}
			{connected ? null : (
				<div className="absolute inset-0 z-10 bg-background">
					<PanelPlaceholder
						busy={!stalled}
						description={
							stalled
								? "The sandboxed interface hasn't connected yet. Retry to reload it."
								: "Runs sandboxed, with only the permissions you approved."
						}
						onRetry={stalled ? retry : undefined}
						retryDisabledFor={cooldownSeconds}
						title={
							stalled
								? tl("{panelTitle} is taking a while", { panelTitle })
								: tl("Starting {panelTitle}…", { panelTitle })
						}
					/>
				</div>
			)}
		</div>
	);
}
