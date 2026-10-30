import { File01Icon } from "@hugeicons/core-free-icons";
import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { ArtifactRenderer } from "@/src/components/chat/ArtifactRenderer.tsx";
import { PartInspector } from "@/src/components/chat/PartInspector.tsx";
import { GitGraphPanel } from "@/src/components/git/GitGraphPanel.tsx";
import {
	ContextPanel,
	type ContextPanelView,
} from "@/src/components/panels/ContextPanel.tsx";
import {
	CoworkContextPanel,
	SourcesWorkspacePanel,
	SubagentsWorkspacePanel,
} from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	findDockPanel,
	isPluginTabKind,
	isRouteTabKind,
	restoreDockTabKind,
	routeTabPath,
} from "@/src/components/panels/dock-panels.ts";
import { MissionControlPanel } from "@/src/components/panels/MissionControlPanel.tsx";
import { useProjectDockSlots } from "@/src/components/panels/project-dock-context.tsx";
import {
	SessionBoxChildScreens,
	SessionBoxPanel,
} from "@/src/components/panels/SessionBoxPanel.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import {
	useCurrentTabId,
	useIsActiveTab,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useSessionBoxScreenRequest } from "@/src/hooks/useSessionBox.ts";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";
import type { ProjectDockTab } from "@/src/store/useProjectDockStore.ts";
import type { ConversationPanelSource } from "@/src/workbench/conversation-panel-registry.ts";
import { ARTIFACT_PANEL_PREFIX } from "@/src/workbench/shell-panels.ts";
import type { WorkbenchDockBridge } from "@/src/workbench/workbench-dock-bridge.tsx";
import { DockRoutePage } from "./dock-route-page.tsx";
import {
	type CoworkData,
	DockPanelPlaceholder,
	PluginDockTabContent,
	type SubagentView,
} from "./native-dock-panels.tsx";
import { TabIcon, type TabIconSpec, tabTypeIcon } from "./panel-tab-bar.tsx";
import { type FileReviewRequest, PatchDiffPanel } from "./patch-diff-panel.tsx";
import { SimpleTerminal } from "./simple-terminal.tsx";
import {
	BUILTIN_TAB_ICONS,
	contributedTabType,
	NATIVE_SHELL_TAB_KINDS,
	type PanelTab,
	routeAppIcon,
} from "./tab-model.ts";

// The file tree pulls in @pierre/trees; it loads when a Files tab first opens.
const FileTreePanel = lazy(() =>
	import("./file-tree-panel.tsx").then((module) => ({
		default: module.FileTreePanel,
	}))
);

/**
 * The Subagents tab with the conversation's sub-agent Boxes listed above it:
 * each parallel sub-agent that runs on a Box of its own gets a View screen
 * action. Without sub-agent Boxes it renders the Subagents panel alone.
 */
function SubagentsWithBoxScreens({
	children,
	contextView,
}: {
	children: ReactNode;
	contextView?: ContextPanelView | null;
}) {
	if (!contextView?.conversationId) {
		return <>{children}</>;
	}
	return (
		<div className="flex h-full min-h-0 flex-col">
			<SessionBoxChildScreens
				conversationId={contextView.conversationId}
				target={contextView.target}
			/>
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	);
}

/** Open the Box screen as a workbench tab when the chat asks for it. */
export function SessionBoxWorkbenchBridge({
	bridge,
	conversationId,
}: {
	bridge: WorkbenchDockBridge;
	conversationId: string;
}) {
	const request = useSessionBoxScreenRequest(conversationId);
	const { tabs: windowTabs } = useTabsContext();
	const currentTabId = useCurrentTabId();
	const title =
		windowTabs.find((tab) => tab.id === currentTabId)?.title || "Chat";
	const handled = useRef(request?.nonce);
	const openPanel = bridge.openPanel;
	useEffect(() => {
		if (!request || handled.current === request.nonce) {
			return;
		}
		handled.current = request.nonce;
		openPanel(
			{
				conversation: { id: conversationId, title },
				id: "box-screen",
				label: "Box screen",
				region: "right",
			},
			{ preserveFocus: true }
		);
	}, [conversationId, openPanel, request, title]);
	return null;
}

export function TabContent({
	active = true,
	agentActivityPanel,
	tab,
	folder,
	fileReviewRequest,
	contextView,
	cowork,
	dockPanels,
	onClearSubagentView,
	subagentView,
	inspectorView,
}: {
	active?: boolean;
	/** Live profile content for the chat-local agent activity tab. */
	agentActivityPanel?: ReactNode | null;
	/** Live (not snapshotted) inputs for the context-breakdown tab. */
	contextView?: ContextPanelView | null;
	cowork?: CoworkData;
	/** The enabled apps' contributed panels, for resolving a `plugin:` tab. */
	dockPanels: PluginDockPanel[];
	fileReviewRequest?: FileReviewRequest | null;
	folder?: string | null;
	inspectorView?: unknown;
	onClearSubagentView?: () => void;
	subagentView?: SubagentView | null;
	tab: PanelTab;
}) {
	const { canUseNativeShell } = useAppSurface();

	if (tab.kind === "unavailable") {
		return (
			<DockPanelPlaceholder text="This panel is unavailable in this version." />
		);
	}
	if (!canUseNativeShell && NATIVE_SHELL_TAB_KINDS.has(tab.kind)) {
		return <DockPanelPlaceholder text="Available in the desktop app." />;
	}

	if (isPluginTabKind(tab.kind)) {
		return (
			<PluginDockTabContent
				active={active}
				dockPanels={dockPanels}
				label={tab.label}
				tabKind={tab.kind}
			/>
		);
	}
	if (isRouteTabKind(tab.kind)) {
		return <DockRoutePage kind={tab.kind} label={tab.label} uid={tab.uid} />;
	}
	if (tab.kind === "terminal") {
		return (
			<SimpleTerminal
				cwd={folder}
				initialCommand={tab.initialCommand}
				initialCommandNonce={tab.initialCommandNonce}
			/>
		);
	}
	if (tab.kind === "context") {
		return <ContextPanel view={contextView} />;
	}
	if (tab.kind === "agent-activity") {
		return (
			agentActivityPanel ?? (
				<DockPanelPlaceholder text="Choose an individual agent to view its activity." />
			)
		);
	}
	if (tab.kind === "sources") {
		return cowork ? (
			<SourcesWorkspacePanel messages={cowork.messages} />
		) : (
			<DockPanelPlaceholder text="Open a chat to see its sources here." />
		);
	}
	if (tab.kind === "subagents") {
		return cowork ? (
			<SubagentsWithBoxScreens contextView={contextView}>
				<SubagentsWorkspacePanel
					messages={cowork.messages}
					onClearRequestedSubagent={onClearSubagentView}
					requestedSubagent={subagentView}
				/>
			</SubagentsWithBoxScreens>
		) : (
			<DockPanelPlaceholder text="Open a chat to see its subagents here." />
		);
	}
	if (tab.kind === "box-screen") {
		return contextView?.conversationId ? (
			<SessionBoxPanel
				active={active}
				conversationId={contextView.conversationId}
				target={contextView.target}
			/>
		) : (
			<DockPanelPlaceholder text="Open a chat to see its Box screen here." />
		);
	}
	if (tab.kind === "inspector") {
		if (inspectorView == null) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					This part is no longer available.
				</div>
			);
		}
		return <PartInspector part={inspectorView} />;
	}
	if (tab.kind === "subagent") {
		return cowork ? (
			<SubagentsWithBoxScreens contextView={contextView}>
				<SubagentsWorkspacePanel
					messages={cowork.messages}
					onClearRequestedSubagent={onClearSubagentView}
					requestedSubagent={subagentView}
				/>
			</SubagentsWithBoxScreens>
		) : (
			<DockPanelPlaceholder text="Open a chat to see its subagents here." />
		);
	}
	if (tab.kind === "artifact") {
		if (!tab.artifact) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					This artifact is no longer available.
				</div>
			);
		}
		return <ArtifactRenderer artifact={tab.artifact} />;
	}
	if (tab.kind === "codereview") {
		return (
			<PatchDiffPanel
				fileReviewRequest={fileReviewRequest}
				folder={folder}
				key={`${tab.uid}-${folder}`}
			/>
		);
	}
	if (tab.kind === "files") {
		return (
			<Suspense fallback={null} key={`${tab.uid}-${folder}`}>
				<FileTreePanel active={active} folder={folder} />
			</Suspense>
		);
	}
	if (tab.kind === "gitgraph") {
		return (
			<GitGraphPanel compact folder={folder} key={`${tab.uid}-${folder}`} />
		);
	}
	if (tab.kind === "mission") {
		// Reuses the chat's `cowork` payload rather than taking a prop of its own:
		// the digest is derived entirely from `messages[].parts`, which that payload
		// already carries for the Context tab and the pinned summary.
		if (!cowork) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					Open a chat to see what it did here.
				</div>
			);
		}
		return <MissionControlPanel messages={cowork.messages} />;
	}
	if (tab.kind === "cowork") {
		// Outside a chat (no cowork data) there is nothing to summarise.
		if (!cowork) {
			return (
				<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
					Open a chat to see its context here.
				</div>
			);
		}
		return <CoworkContextPanel {...cowork} />;
	}
	// Every built-in kind is handled above; a tab that reaches here carries a kind
	// this build no longer knows (a shell panel retired between sessions).
	return <DockPanelPlaceholder text="This panel is no longer available." />;
}

/**
 * Content for a project-store dock tab. Mounted once by {@link ProjectDockHost}
 * and portaled into the focused chat's dock slot so pin/share never remounts
 * the live panel (terminal history, browser session, …).
 */
export function ProjectDockTabContent({
	active = true,
	request,
	tab,
	folder,
	dockPanels,
}: {
	active?: boolean;
	dockPanels: PluginDockPanel[];
	folder?: string | null;
	/**
	 * A one-shot request: a command for a terminal tab to run, or the files a
	 * Changes tab reviews. A new nonce runs it again.
	 */
	request?: {
		command?: TerminalCommandRequest;
		nonce: number;
		reviewPaths?: string[];
	};
	tab: Pick<ProjectDockTab, "kind" | "label" | "uid">;
}) {
	const fileReviewRequest = useMemo(
		() =>
			request?.reviewPaths
				? { nonce: request.nonce, paths: request.reviewPaths }
				: null,
		[request]
	);
	return (
		<TabContent
			active={active}
			dockPanels={dockPanels}
			fileReviewRequest={fileReviewRequest}
			folder={folder}
			tab={{
				uid: tab.uid,
				...restoreDockTabKind(tab.kind),
				initialCommand: request?.command,
				initialCommandNonce: request?.command ? request.nonce : undefined,
				label: tab.label,
				projectHosted: true,
			}}
		/>
	);
}

/**
 * Content for a chat-bound panel (Context, Sources, Subagents …) hosted as a
 * workbench tab outside its chat. Reads the chat's published live source, so
 * the same renderers as the chat's own dock show the same data.
 */
export function ConversationPanelContent({
	active = true,
	kind,
	label,
	source,
	uid,
}: {
	active?: boolean;
	kind: string;
	label: string;
	source: ConversationPanelSource;
	uid: string;
}) {
	// An artifact panel's kind carries the artifact id (`artifact:<id>`); the
	// artifact itself comes from the chat that opened it.
	if (kind.startsWith(ARTIFACT_PANEL_PREFIX)) {
		const artifact =
			source.artifacts?.[kind.slice(ARTIFACT_PANEL_PREFIX.length)];
		return (
			<TabContent
				active={active}
				dockPanels={[]}
				tab={{ artifact, kind: "artifact", label, uid }}
			/>
		);
	}
	return (
		<TabContent
			active={active}
			agentActivityPanel={source.agentActivityPanel}
			contextView={source.contextView}
			cowork={source.cowork}
			dockPanels={[]}
			inspectorView={source.inspectorView}
			onClearSubagentView={source.onClearSubagentView}
			subagentView={source.subagentView}
			tab={{ uid, ...restoreDockTabKind(kind), label }}
		/>
	);
}

/**
 * The glyph a dock tab kind shows (built-in, app panel, page, or artifact),
 * for the same panel hosted as a workbench tab.
 */
export function DockKindIcon({ kind }: { kind: string }) {
	const { dock_panels: dockPanels } = usePluginContributions();
	const { apps } = useApps();
	const resolved = kind.startsWith(ARTIFACT_PANEL_PREFIX)
		? "artifact"
		: restoreDockTabKind(kind).kind;
	let spec: TabIconSpec = {};
	if (resolved === "unavailable") {
		spec = {};
	} else if (isPluginTabKind(resolved)) {
		const panel = findDockPanel(dockPanels, resolved);
		spec = panel ? tabTypeIcon(contributedTabType(panel)) : {};
	} else if (isRouteTabKind(resolved)) {
		const appIcon = routeAppIcon(routeTabPath(resolved), apps);
		spec = appIcon ? { iconId: appIcon } : { glyph: File01Icon };
	} else {
		spec = { glyph: BUILTIN_TAB_ICONS[resolved] };
	}
	return <TabIcon className="size-3.5" size={14} spec={spec} />;
}

/** Portal target for a project-hosted tab. Only the focused chat pane registers
 *  so split views don't fight over the single live content tree. */
export function ProjectDockContentSlot({
	uid,
	active,
}: {
	active: boolean;
	uid: string;
}) {
	const isActiveTab = useIsActiveTab();
	const { registerSlot, unregisterSlot } = useProjectDockSlots();
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!(el && active && isActiveTab)) {
			return;
		}
		registerSlot(uid, el);
		return () => unregisterSlot(uid, el);
	}, [uid, active, isActiveTab, registerSlot, unregisterSlot]);

	return <div className="h-full min-h-0" ref={ref} />;
}
