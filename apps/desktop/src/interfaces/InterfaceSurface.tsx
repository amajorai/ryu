// Full-bleed host for a non-OS workspace interface (Channels, Feed, the 2D/3D
// worlds, and Marketplace interfaces that select one of those renderers).
//
// The renderers are pure presentation. This host owns the two halves of the
// Interface Protocol for the desktop:
//
//   - the read model: `useInterfaceSnapshot()` over the shared chat history,
//     agents, teams, and workspace projects;
//   - the write side: an `InterfacePort` over the tab system, so opening or
//     starting a thread goes through the same `openTab` path the sidebar and the
//     OS desktop use, and the open thread renders through the real `ChatPage`
//     (`RouteOutlet`) with the same providers the OS window adapter uses.
//
// No interface sends a message on its own: a prompt only reaches `startThread`
// when the user typed and submitted it in the interface's composer.

import {
	GameKitSettingsContext,
	HostReducedMotionContext,
} from "@ryu/blocks/desktop/interfaces/game3d-settings.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	type InterfaceDescriptor,
	type InterfacePort,
	type InterfaceSettingValue,
	interfaceParamsWithOverrides,
	interfaceSettingsFor,
	settingValueFits,
} from "@ryuhq/protocol/interfaces";
import { MotionConfig } from "motion/react";
import {
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	subscribeTabOpenRequests,
	type Tab,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApprovals } from "@/src/hooks/useApprovals.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { respondQuestion } from "@/src/lib/api/acp.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
} from "@/src/lib/appearance-settings.ts";
import {
	getLivePermission,
	getQuestionHolder,
} from "@/src/store/useInterfaceDetailStore.ts";
import { InterfaceFrame } from "./InterfaceFrame.tsx";
import { answerAskWith, snapshotAsk } from "./InterfaceSurface-answer-ask.ts";
import { interfaceBody } from "./InterfaceSurface-body.tsx";
import {
	InterfaceErrorBoundary,
	RendererFallback,
	SnapshotUnavailable,
} from "./InterfaceSurface-fallbacks.tsx";
import { InterfacePageOverlay } from "./InterfaceSurface-page-overlay.tsx";
import {
	headerDescription,
	type OverviewState,
	projectFolder,
	tabKey,
} from "./InterfaceSurface-tab-state.ts";
import { backToChat } from "./interface-switcher.ts";
import { isPendingInterface } from "./registry.ts";
import {
	RetainedChatTrees,
	RetainedThreadSlot,
} from "./retained-chat-trees.tsx";
import { MAX_INTERFACE_THREADS } from "./snapshot.ts";
import { isChatTabPath, resolveSurfaceRenderer } from "./surface-renderer.ts";
import { useInterfaceActive } from "./use-interface-active.ts";
import { useInterfaceSettings } from "./use-interface-settings.ts";
import { useInterfaceSnapshot } from "./use-interface-snapshot.ts";

export type { AnswerAskDeps } from "./InterfaceSurface-answer-ask.ts";
export { answerAskWith, snapshotAsk } from "./InterfaceSurface-answer-ask.ts";
export { SLOW_MOUNT_MS } from "./InterfaceSurface-fallbacks.tsx";

/**
 * Renderers that show the usage account, so only they read the wallet: Bank's
 * ledger and Town's HUD funds readout.
 */
const ACCOUNT_RENDERERS: ReadonlySet<string> = new Set(["bank", "town"]);

/**
 * Renderers that show scheduled runs, so only they make Core list schedules.
 * `interface-data-sets.test.ts` fails when a renderer reads `snapshot.events`
 * without being listed here.
 */
export const EVENT_RENDERERS: ReadonlySet<string> = new Set([
	"aquarium",
	"arcade",
	"arena",
	"calendar",
	"card-table",
	"dashboard",
	"departures",
	"farm",
	"flow",
	"glance",
	"hologram",
	"hub",
	"journal",
	"kitchen",
	"live",
	"lobby",
	"market",
	"mission-control",
	"newspaper",
	"notebook",
	"panels",
	"passport",
	"path",
	"persona",
	"planets",
	"quiz",
	"records",
	"rides",
	"seasonal",
	"status",
	"ticker",
	"town",
	"tracking",
	"warehouse",
	"wiki",
	"workers",
	"world-2d",
	"world-3d",
]);

interface InterfaceSurfaceProps {
	canSwitchToConsole: boolean;
	descriptor: InterfaceDescriptor;
}

/** Renders the active workspace interface in place of the OS desktop. */
export function InterfaceSurface({
	canSwitchToConsole,
	descriptor,
}: InterfaceSurfaceProps) {
	const tl = useLiteralMessages();
	const { activeTabId, closeTab, openTab, tabs } = useTabsContext();
	const setInterfaceActive = useInterfaceActive((state) => state.setActive);
	useEffect(() => {
		setInterfaceActive(true);
		return () => setInterfaceActive(false);
	}, [setInterfaceActive]);
	const { loading, omittedThreads, retry, snapshot, unavailable } =
		useInterfaceSnapshot({
			account: ACCOUNT_RENDERERS.has(descriptor.renderer),
			events: EVENT_RENDERERS.has(descriptor.renderer),
			live: true,
		});
	// The full-history list is never mounted here: same pending query as the snapshot.
	const { approve, reject } = useApprovals({ status: "pending" });
	const latestSnapshot = useRef(snapshot);
	latestSnapshot.current = snapshot;
	const decide = useRef({ approve, reject });
	decide.current = { approve, reject };
	const node = useActiveNode();
	const apiTarget = useRef(toTarget(node));
	apiTarget.current = toTarget(node);
	// The user's own settings for this interface, over its descriptor's params.
	const overrides = useInterfaceSettings(
		(state) => state.overrides[descriptor.id]
	);
	const resolved = useMemo(
		() =>
			resolveSurfaceRenderer({
				...descriptor,
				params: interfaceParamsWithOverrides(descriptor, overrides),
			}),
		[descriptor, overrides]
	);
	const latestDescriptor = useRef(descriptor);
	latestDescriptor.current = descriptor;
	// Every interface follows the app's Motion setting: animations off reads
	// as reduced motion, as the system preference does.
	const [animationsEnabled] = usePersistedToggle(
		APPEARANCE_KEYS.animationsEnabled,
		APPEARANCE_DEFAULTS.animationsEnabled
	);
	const kitParams = ("params" in resolved ? resolved.params : {}) as {
		overlayDensity?: "full" | "minimal";
		workBubbles?: boolean;
	};
	const kitSettings = useMemo(
		() => ({
			overlayDensity: kitParams.overlayDensity ?? "full",
			workBubbles: kitParams.workBubbles ?? true,
		}),
		[kitParams.overlayDensity, kitParams.workBubbles]
	);

	const activeTab = tabs.find((tab) => tab.id === activeTabId);
	const activeKey = tabKey(activeTab);

	// Closing a thread focuses a neighbouring tab, which may be another chat or
	// a page; the overview keeps that one revealed tab hidden until the user
	// navigates anywhere else. A page that was active when the interface
	// mounted (the OS home, an app) starts hidden the same way; an open chat
	// shows as the interface's thread.
	const [overview, setOverview] = useState<OverviewState | null>(() =>
		activeTab && !isChatTabPath(activeTab.path)
			? { closedId: "", revealedKey: activeKey }
			: null
	);
	useEffect(() => {
		setOverview((current) => {
			if (!current) {
				return current;
			}
			if (current.revealedKey === null) {
				// Still closing: wait until the closed tab is gone.
				return tabs.some((tab) => tab.id === current.closedId)
					? current
					: { ...current, revealedKey: activeKey };
			}
			return activeKey === current.revealedKey ? current : null;
		});
	}, [activeKey, tabs]);
	// Reopening the hidden tab (a deep link, a notification, or a shortcut to
	// the Settings page that is already active) changes no tab state, so the
	// effect above cannot tell it from staying put. Any explicit open request
	// is the user navigating, which ends the overview.
	useEffect(
		() =>
			subscribeTabOpenRequests(() => {
				setOverview(null);
			}),
		[]
	);

	const hidden =
		overview !== null &&
		(overview.revealedKey === null || overview.revealedKey === activeKey);
	const visibleTab: Tab | null =
		activeTab && !activeTab.unloaded && !hidden ? activeTab : null;
	const shownChatTab =
		visibleTab && isChatTabPath(visibleTab.path) ? visibleTab : null;
	// Anything else the user opened (Settings, the Marketplace, an app, a deep
	// link) shows as a page over the interface instead of disappearing.
	const shownPageTab = visibleTab && !shownChatTab ? visibleTab : null;

	// The port stays referentially stable for the renderers; this ref gives it
	// the latest tab state without re-creating it on every tab change.
	const latest = useRef(shownChatTab);
	latest.current = shownChatTab;

	const leaveTab = useCallback(
		(id: string) => {
			setOverview({ closedId: id, revealedKey: null });
			closeTab(id);
		},
		[closeTab]
	);

	const port = useMemo<InterfacePort>(() => {
		const openThread = (threadId: string) => {
			setOverview(null);
			// Reuses the tab already showing this conversation, if any.
			openTab("/chat", { conversationId: threadId });
		};
		const openInbox = () => {
			setOverview(null);
			openTab("/inbox");
		};
		return {
			answerAsk: (askId, choiceId) =>
				answerAskWith(
					{
						approve: (id) => decide.current.approve(id),
						livePermission: (ask) =>
							getLivePermission(ask, apiTarget.current.url)?.respond ?? null,
						openInbox,
						openThread,
						questionHolder: (ask) =>
							getQuestionHolder(ask, apiTarget.current.url),
						reject: (id) => decide.current.reject(id),
						respondQuestion: (conversationId, toolCallId, answers) =>
							respondQuestion(
								apiTarget.current,
								conversationId,
								toolCallId,
								answers
							),
						currentAsk: (id) => snapshotAsk(latestSnapshot.current.asks, id),
						redacted: () => latestSnapshot.current.privacy === "redacted",
					},
					askId,
					choiceId
				),
			closeThread: () => {
				const open = latest.current;
				if (open) {
					leaveTab(open.id);
				}
			},
			openInbox,
			openThread,
			startThread: ({ agentId, projectId, prompt, teamId }) => {
				setOverview(null);
				const typed = prompt?.trim() ? prompt : undefined;
				openTab("/chat", {
					forceNew: true,
					initialAgent: agentId,
					initialProject: projectFolder(projectId),
					initialPrompt: typed,
					// Only a prompt the user typed and submitted here is sent.
					initialSubmit: typed ? true : undefined,
					initialTeamId: teamId,
				});
			},
			updateSettings: (patch) => {
				// Only the settings this interface shows, with values that fit.
				const current = latestDescriptor.current;
				const fields = new Map(
					interfaceSettingsFor(current).map((field) => [field.key, field])
				);
				const kept: Record<string, InterfaceSettingValue> = {};
				for (const [key, value] of Object.entries(patch)) {
					const field = fields.get(key);
					if (field && settingValueFits(field, value)) {
						kept[key] = value;
					}
				}
				if (Object.keys(kept).length > 0) {
					useInterfaceSettings.getState().setSettings(current.id, kept);
				}
			},
			resetSettings: () => {
				useInterfaceSettings
					.getState()
					.resetSettings(latestDescriptor.current.id);
			},
		};
	}, [leaveTab, openTab]);

	const openPage = (path: string, title: string) => {
		setOverview(null);
		openTab(path, { title });
	};

	const pending = isPendingInterface(descriptor);
	const leaveForChat = () => backToChat(canSwitchToConsole);
	const label = descriptor.label || "Interface";

	// Every open chat tab stays mounted (in a hidden container) so switching
	// threads does not unmount the others and abort their resumed streams; the
	// shown one is moved into the renderer's thread slot.
	const retainedChatTabs = useMemo(
		() => tabs.filter((tab) => isChatTabPath(tab.path) && !tab.unloaded),
		[tabs]
	);
	const threadView = shownChatTab ? (
		<RetainedThreadSlot tabId={shownChatTab.id} />
	) : null;

	const common = {
		activeThreadId: shownChatTab?.conversationId ?? null,
		loading,
		port,
		snapshot,
		threadView,
	};

	// Lazily loaded layouts share the quiet loading fallback.
	const lazyLayout = (node: ReactNode) => (
		<Suspense
			fallback={
				<RendererFallback
					label={descriptor.label}
					onBackToChat={leaveForChat}
				/>
			}
		>
			{node}
		</Suspense>
	);
	let body: ReactNode = interfaceBody(resolved, common, lazyLayout);
	if (pending) {
		// A remembered Marketplace interface whose plugin list is still loading.
		body = <RendererFallback label={label} onBackToChat={leaveForChat} />;
	} else if (unavailable && !shownChatTab) {
		body = <SnapshotUnavailable label={label} onRetry={retry} />;
	}

	const pageOverlay = shownPageTab ? (
		<InterfacePageOverlay
			label={label}
			leaveTab={leaveTab}
			shownPageTab={shownPageTab}
		/>
	) : null;

	return (
		<InterfaceFrame
			canSwitchToConsole={canSwitchToConsole}
			description={pending ? null : headerDescription(descriptor)}
			interfaceId={descriptor.id}
			label={label}
			notice={
				omittedThreads > 0 ? (
					<p
						className="hidden shrink-0 text-muted-foreground text-xs md:block"
						data-testid="ryu-interface-omitted-threads"
					>
						{tl(
							"Showing the {max} most recent threads. {omitted} older {count, plural, one {one is} other {ones are}} in Agent and search.",
							{
								count: omittedThreads,
								max: String(MAX_INTERFACE_THREADS),
								omitted: String(omittedThreads),
							}
						)}
					</p>
				) : null
			}
			onOpenPage={openPage}
			overlay={pageOverlay}
		>
			{/* The interface stays mounted under a page (so its state survives)
			    but is inert there: no focus, clicks, or document-level
			    shortcuts reach it until the page closes. */}
			<div
				className="contents"
				data-testid="ryu-interface-body"
				inert={shownPageTab ? true : undefined}
			>
				<RetainedChatTrees
					renderTab={(tab) => (
						<RouteOutlet onClose={() => leaveTab(tab.id)} tab={tab} />
					)}
					shownTabId={shownChatTab?.id ?? null}
					tabs={retainedChatTabs}
				>
					<InterfaceErrorBoundary
						key={descriptor.id}
						label={label}
						onBackToChat={leaveForChat}
						onGiveUp={() => {
							toast.error(
								tl("{label} crashed and was switched off", { label })
							);
							leaveForChat();
						}}
					>
						<HostReducedMotionContext.Provider value={!animationsEnabled}>
							{/* Plain motion components follow the app's Motion setting too;
							    the renderers' own hook reads the context above. */}
							<MotionConfig
								reducedMotion={animationsEnabled ? "user" : "always"}
							>
								<GameKitSettingsContext.Provider value={kitSettings}>
									{body}
								</GameKitSettingsContext.Provider>
							</MotionConfig>
						</HostReducedMotionContext.Provider>
					</InterfaceErrorBoundary>
				</RetainedChatTrees>
			</div>
		</InterfaceFrame>
	);
}
