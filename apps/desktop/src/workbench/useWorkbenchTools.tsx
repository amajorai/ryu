import type { WorkbenchRegion } from "@ryu/workbench/model";
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import {
	dockTabKind,
	panelPreferredRegion,
} from "@/src/components/panels/dock-panels.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { useOptionalDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { queuePanelCommand } from "./panel-commands.ts";
import {
	CONVERSATION_TOOL_PANELS,
	countOpenToolItems,
	findOpenToolItem,
	PROJECT_TOOL_PANELS,
	workbenchToolItem,
} from "./shell-panels.ts";
import {
	DESKTOP_SHELL_REGIONS,
	useWorkbenchToolsContext,
	type WorkbenchToolOption,
	type WorkbenchTools,
	WorkbenchToolsContextProvider,
} from "./workbench-chrome.tsx";
import {
	isDockRegionShown,
	regionHasTabs,
	toggleDockRegion,
	type WorkbenchDockBridge,
} from "./workbench-dock-bridge.tsx";
import { currentWorkbenchViewport } from "./workbench-viewport.tsx";

/**
 * Desktop keeps the left edge for navigation for now, so a panel that prefers
 * Left opens in the other side region instead of an invisible one.
 */
function shellRegion(region: WorkbenchRegion): WorkbenchRegion {
	return DESKTOP_SHELL_REGIONS.includes(region) ? region : "right";
}

function makeToolItemId(): string {
	return `workbench-tool-${crypto.randomUUID()}`;
}

/**
 * The shell tools and enabled app panels that can open as workbench tabs.
 * Native tools appear only where the desktop shell can run them; disabling an
 * app removes its panel from this list (an open tab shows a placeholder).
 */
export function useWorkbenchTools(): WorkbenchTools {
	const { canUseNativeShell } = useAppSurface();
	const { dock_panels: dockPanels } = usePluginContributions();
	const folder = useWorkspaceStore((store) => store.folder);
	const workbench = useOptionalDesktopWorkbench();

	// The chat the focused Center pane shows, if it is bound to a conversation:
	// its Context/Sources/Subagents panels can open as workbench tabs.
	const focusedChat = useMemo(() => {
		const state = workbench?.state;
		if (!state) {
			return;
		}
		const focused = state.groups.find(
			(group) => group.id === state.focusedGroupId
		);
		const centerGroup =
			focused?.region === "center"
				? focused
				: state.groups.find((group) => group.region === "center");
		const item = state.items.find(
			(candidate) => candidate.id === centerGroup?.activeItemId
		);
		if (
			item?.source.kind === "route" &&
			item.source.path.startsWith("/chat") &&
			item.scope.kind === "conversation"
		) {
			return { id: item.scope.conversationId, title: item.title };
		}
		return;
	}, [workbench?.state]);

	const tools = useMemo<WorkbenchToolOption[]>(
		() => [
			...(focusedChat
				? CONVERSATION_TOOL_PANELS.map((panel) => ({
						conversation: focusedChat,
						id: panel.kind,
						label: panel.label,
						region: "right" as const,
					}))
				: []),
			...(canUseNativeShell
				? PROJECT_TOOL_PANELS.map((panel) => ({
						id: panel.kind,
						label: panel.label,
						region: panel.region,
					}))
				: []),
			...dockPanels.map((panel) => ({
				id: dockTabKind(panel),
				label: panel.title,
				region: shellRegion(panelPreferredRegion(panel)),
			})),
		],
		[canUseNativeShell, dockPanels, focusedChat]
	);

	// The handlers read the latest workbench and tools through a ref so they
	// stay stable: request consumers can depend on them without re-running.
	const latest = useRef({ folder, tools, workbench });
	latest.current = { folder, tools, workbench };

	const openPanel = useCallback<WorkbenchTools["openPanel"]>(
		(option, options = {}) => {
			const current = latest.current.workbench;
			if (!current) {
				return;
			}
			const { dispatch } = current;
			// Several opens in one handler each see the previous one's tab.
			const state = current.getState();
			const panelFolder =
				options.folder === undefined ? latest.current.folder : options.folder;
			const activate = options.activate ?? true;
			const existing = options.forceNew
				? undefined
				: findOpenToolItem(state, option, panelFolder);
			let itemId = existing?.id;
			if (existing) {
				if (options.groupId) {
					dispatch({
						type: "item/move",
						activate,
						itemId: existing.id,
						toGroupId: options.groupId,
					});
				} else if (activate) {
					dispatch({ type: "item/activate", itemId: existing.id });
				}
			} else {
				const copies = options.forceNew
					? countOpenToolItems(state, option, panelFolder)
					: 0;
				const item = workbenchToolItem(
					copies > 0
						? { ...option, label: `${option.label} ${copies + 1}` }
						: option,
					panelFolder,
					makeToolItemId()
				);
				const groupId =
					options.groupId ??
					state.groups.find((group) => group.region === item.preferredRegion)
						?.id ??
					state.groups.find((group) => group.region === "center")?.id;
				if (!groupId) {
					return;
				}
				dispatch({ type: "item/open", activate, groupId, item });
				itemId = item.id;
			}
			if (
				options.preserveFocus &&
				current.getState().focusedGroupId !== state.focusedGroupId
			) {
				dispatch({ type: "group/focus", groupId: state.focusedGroupId });
			}
			if (itemId && (options.command || options.reviewPaths)) {
				queuePanelCommand(itemId, {
					command: options.command,
					nonce: options.nonce ?? Date.now(),
					reviewPaths: options.reviewPaths,
				});
			}
			return itemId;
		},
		[]
	);

	const openTool = useCallback<WorkbenchTools["openTool"]>(
		(toolId, target) => {
			const option = latest.current.tools.find((tool) => tool.id === toolId);
			if (!option) {
				return;
			}
			// A terminal is a workspace, not a view: "+" always adds another one.
			openPanel(option, {
				forceNew: option.id === "terminal",
				groupId: target?.groupId,
			});
		},
		[openPanel]
	);

	const available = workbench !== null;
	return useMemo(
		() => ({ openPanel, openTool, tools: available ? tools : [] }),
		[available, openPanel, openTool, tools]
	);
}

/** Provides {@link useWorkbenchTools} once for the shell. */
export function WorkbenchToolsProvider({ children }: { children: ReactNode }) {
	const tools = useWorkbenchTools();
	return (
		<WorkbenchToolsContextProvider value={tools}>
			{children}
		</WorkbenchToolsContextProvider>
	);
}

/** Builds the bridge from the shell's workbench and tools. */
export function useWorkbenchDockBridgeValue(): WorkbenchDockBridge | null {
	const workbench = useOptionalDesktopWorkbench();
	const tools = useWorkbenchToolsContext();
	const folder = useWorkspaceStore((store) => store.folder);
	return useMemo(() => {
		if (!(workbench && tools)) {
			return null;
		}
		const { dispatch, getState, state } = workbench;
		return {
			isRegionShown: (region) => isDockRegionShown(state, region),
			openPanel: tools.openPanel,
			toggleRegion: (region, fallbacks) => {
				// In a narrow window a region is a sheet over Center: the toggle
				// opens or closes the sheet without changing the saved layout.
				const viewport = currentWorkbenchViewport();
				const current = getState();
				if (viewport.narrow && regionHasTabs(current, region)) {
					if (viewport.overlayRegion === region) {
						viewport.dismissOverlay();
						return;
					}
					if (!current.openRegions[region]) {
						dispatch({ type: "region/show", region });
					}
					viewport.showOverlay(region);
					return;
				}
				toggleDockRegion(
					{
						dispatch,
						folder,
						openPanel: tools.openPanel,
						state: getState(),
						tools: tools.tools,
					},
					region,
					fallbacks
				);
			},
		};
	}, [folder, tools, workbench]);
}
