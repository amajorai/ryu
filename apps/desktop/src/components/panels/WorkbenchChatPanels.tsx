// apps/desktop/src/components/panels/WorkbenchChatPanels.tsx
//
// A chat's panels when the workbench frame is mounted. The chat no longer
// keeps docks of its own: every panel request (Files, Changes, Context, a
// subagent, an artifact, the inspector …) opens or focuses a workbench tab in
// the shared Right/Bottom panes, and the chat publishes its live data for those
// tabs to read. Only the chat column and its Pinned summary render here.

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { emptyWorkspaceSessionState } from "@/src/lib/workspace-session.ts";
import { usePublishConversationPanelSource } from "@/src/workbench/conversation-panel-registry.ts";
import {
	hasDockSessionTabs,
	migrateDockSession,
} from "@/src/workbench/dock-migration.ts";
import { ARTIFACT_PANEL_PREFIX } from "@/src/workbench/shell-panels.ts";
import type { WorkbenchDockBridge } from "@/src/workbench/workbench-dock-bridge.tsx";
import panelStyles from "./WorkspacePanels.module.css";
import type { SubagentView, WorkspacePanelsProps } from "./WorkspacePanels.tsx";

interface PinnedStyle extends CSSProperties {
	"--workspace-display"?: string;
	"--workspace-right"?: string;
	"--workspace-transition"?: string;
	"--workspace-width"?: string;
}

// The Pinned summary column: the panel's fixed w-72 plus a 12px gutter. When
// docking it would leave the chat narrower than MIN_CHAT_WIDTH it floats.
const PINNED_PANEL_WIDTH = 288;
const PANEL_GUTTER = 12;
const MIN_CHAT_WIDTH = 520;
const DOCK_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Run `handle` once per new request. The request present at mount is old
 * (the chat keeps its last request in state), so it never replays.
 */
function useNewRequest<T extends { nonce: number }>(
	request: T | null | undefined,
	handle: (request: T) => void
): void {
	const handled = useRef(request?.nonce);
	const handleRef = useRef(handle);
	handleRef.current = handle;
	useEffect(() => {
		if (!request || handled.current === request.nonce) {
			return;
		}
		handled.current = request.nonce;
		handleRef.current(request);
	}, [request]);
}

export function WorkbenchChatPanels({
	agentActivityPanel,
	agentActivityRequest,
	artifactRequest,
	bridge,
	children,
	collectionRequest,
	contextRequest,
	contextView,
	cowork,
	fileReviewRequest,
	fileSearchRequest,
	folder,
	inspectorRequest,
	renderPinnedSummary,
	subagentRequest,
}: WorkspacePanelsProps & { bridge: WorkbenchDockBridge }) {
	const { openPanel } = bridge;
	const { tabs: windowTabs, updateTabWorkspaceSession } = useTabsContext();
	const currentTabId = useCurrentTabId();
	const currentWindowTab = windowTabs.find((tab) => tab.id === currentTabId);
	const conversationId = contextView?.conversationId ?? null;
	const conversationTitle = currentWindowTab?.title || "Chat";
	const conversation = useMemo(
		() =>
			conversationId
				? { id: conversationId, title: conversationTitle }
				: undefined,
		[conversationId, conversationTitle]
	);

	const [subagentView, setSubagentView] = useState<SubagentView | null>(null);
	const [inspectorView, setInspectorView] = useState<unknown>(null);
	const [artifacts, setArtifacts] = useState<
		Readonly<Record<string, ArtifactView>>
	>({});
	const clearSubagentView = useCallback(() => setSubagentView(null), []);
	useEffect(() => {
		setSubagentView(null);
	}, [cowork?.runId]);

	const source = useMemo(
		() => ({
			agentActivityPanel,
			artifacts,
			contextView: contextView ?? null,
			cowork,
			inspectorView,
			onClearSubagentView: clearSubagentView,
			subagentView,
		}),
		[
			agentActivityPanel,
			artifacts,
			clearSubagentView,
			contextView,
			cowork,
			inspectorView,
			subagentView,
		]
	);
	usePublishConversationPanelSource(conversationId, source);

	// The chat keeps focus (and its title bar actions) while its panels open
	// beside it.
	const openChatPanel = (id: string, label: string) => {
		if (conversation) {
			openPanel(
				{ conversation, id, label, region: "right" },
				{ preserveFocus: true }
			);
		}
	};
	const projectFolder = folder ?? undefined;

	useNewRequest(fileSearchRequest, () => {
		openPanel(
			{ id: "files", label: "Files", region: "right" },
			{ folder: projectFolder, preserveFocus: true }
		);
	});
	useNewRequest(fileReviewRequest, (request) => {
		openPanel(
			{ id: "codereview", label: "Changes", region: "right" },
			{
				folder: projectFolder,
				nonce: request.nonce,
				preserveFocus: true,
				reviewPaths: request.paths,
			}
		);
	});
	useNewRequest(subagentRequest, (request) => {
		setSubagentView({ id: request.id, nonce: request.nonce });
		openChatPanel("subagents", "Subagents");
	});
	useNewRequest(artifactRequest, ({ artifact }) => {
		setArtifacts((current) => ({ ...current, [artifact.id]: artifact }));
		openChatPanel(`${ARTIFACT_PANEL_PREFIX}${artifact.id}`, artifact.title);
	});
	useNewRequest(inspectorRequest, ({ part }) => {
		setInspectorView(part);
		openChatPanel("inspector", "Inspector");
	});
	useNewRequest(contextRequest, () => openChatPanel("context", "Context"));
	useNewRequest(agentActivityRequest, () =>
		openChatPanel("agent-activity", "Agent activity")
	);
	useNewRequest(collectionRequest, ({ kind }) => {
		if (kind === "subagents") {
			setSubagentView(null);
		}
		openChatPanel(kind, kind === "sources" ? "Sources" : "Subagents");
	});

	// Move the chat's saved dock tabs into the workbench once.
	const migratedRef = useRef(false);
	const session = currentWindowTab?.workspaceSession;
	useEffect(() => {
		if (migratedRef.current || !currentTabId || !hasDockSessionTabs(session)) {
			return;
		}
		migratedRef.current = true;
		migrateDockSession(session, { conversation, folder, openPanel });
		updateTabWorkspaceSession(currentTabId, emptyWorkspaceSessionState());
	}, [
		conversation,
		currentTabId,
		folder,
		openPanel,
		session,
		updateTabWorkspaceSession,
	]);

	return (
		<PinnedSummaryLayout renderPinnedSummary={renderPinnedSummary}>
			{children}
		</PinnedSummaryLayout>
	);
}

/**
 * The chat column with its Pinned summary docked at the right edge, or
 * floating over the chat when docking would leave it too narrow.
 */
function PinnedSummaryLayout({
	children,
	renderPinnedSummary,
}: Pick<WorkspacePanelsProps, "children" | "renderPinnedSummary">) {
	const [sidebarVariant] = useSidebarVariant();
	const floatingChrome = sidebarVariant === "floating";
	const titleBarClearsContent = useTitleBarClearsContent();
	const dockTop =
		titleBarClearsContent && floatingChrome
			? "top-[58px]"
			: titleBarClearsContent
				? "top-14"
				: "top-0";

	const containerRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	useEffect(() => {
		const element = containerRef.current;
		if (!element) {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) {
				setContainerWidth(rect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const pinnedRequested = Boolean(renderPinnedSummary);
	const pinnedColumnWidth = PINNED_PANEL_WIDTH + PANEL_GUTTER;
	const pinnedFloating =
		pinnedRequested &&
		containerWidth > 0 &&
		containerWidth - pinnedColumnWidth < MIN_CHAT_WIDTH;
	const pinnedDocked = pinnedRequested && !pinnedFloating;

	return (
		<div className="relative flex h-full overflow-hidden" ref={containerRef}>
			<div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
			</div>
			<div
				className={cn("shrink-0", panelStyles.widthSpacer)}
				style={
					// SAFETY: satisfies validates React CSSProperties plus the workspace CSS variable slots; the cast only drops fresh-literal metadata.
					{
						"--workspace-width": `${pinnedDocked ? pinnedColumnWidth : 0}px`,
						"--workspace-transition": `width 300ms ${DOCK_EASE}`,
					} satisfies PinnedStyle as PinnedStyle
				}
			/>
			<div
				className={cn(
					"absolute bottom-0 z-10",
					dockTop,
					panelStyles.pinnedPanel
				)}
				style={
					// SAFETY: satisfies validates React CSSProperties plus the workspace CSS variable slots; the cast only drops fresh-literal metadata.
					{
						"--workspace-display": pinnedDocked ? "block" : "none",
						"--workspace-right": "0px",
						"--workspace-width": `${pinnedColumnWidth}px`,
					} satisfies PinnedStyle as PinnedStyle
				}
			>
				<div
					className={cn(
						"h-full overflow-y-auto border-border border-l px-3 pt-6",
						floatingChrome && "pb-2"
					)}
				>
					{pinnedDocked && renderPinnedSummary?.({ floating: false })}
				</div>
			</div>
			{pinnedFloating && (
				<div
					className={cn(
						"pointer-events-none absolute z-20",
						panelStyles.floatingPinned,
						titleBarClearsContent ? "top-[64px]" : "top-0"
					)}
					style={
						// SAFETY: satisfies validates React CSSProperties plus the workspace CSS variable slots; the cast only drops fresh-literal metadata.
						{
							"--workspace-right": `${PANEL_GUTTER}px`,
						} satisfies PinnedStyle as PinnedStyle
					}
				>
					{renderPinnedSummary?.({ floating: true })}
				</div>
			)}
		</div>
	);
}
