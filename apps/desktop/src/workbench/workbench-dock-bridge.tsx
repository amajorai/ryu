import type { WorkbenchState } from "@ryu/workbench/model";
import type { WorkbenchAction } from "@ryu/workbench/reducer";
import {
	createContext,
	useContext,
	useEffect,
	useSyncExternalStore,
} from "react";
import type {
	WorkbenchToolOption,
	WorkbenchTools,
} from "./workbench-chrome.tsx";

/** The two regions a chat's panel buttons show and hide. */
export type DockRegion = "bottom" | "right";

/**
 * How a page reaches the workbench's Right and Bottom panes. Provided only
 * while the workbench frame is mounted: a chat then opens its panels as
 * workbench tabs instead of in docks of its own.
 */
export interface WorkbenchDockBridge {
	/** Whether the region is open and has tabs to show. */
	isRegionShown: (region: DockRegion) => boolean;
	openPanel: WorkbenchTools["openPanel"];
	/**
	 * Show or hide a region. Showing an empty one opens a panel there (see
	 * {@link emptyRegionPanel}); focus stays where it was.
	 */
	toggleRegion: (
		region: DockRegion,
		fallbacks?: readonly WorkbenchToolOption[]
	) => void;
}

const WorkbenchDockBridgeContext = createContext<WorkbenchDockBridge | null>(
	null
);

export const WorkbenchDockBridgeProvider = WorkbenchDockBridgeContext.Provider;

/** The bridge, or null where a page keeps its own docks. */
export function useWorkbenchDockBridge(): WorkbenchDockBridge | null {
	return useContext(WorkbenchDockBridgeContext);
}

export function regionHasTabs(
	state: WorkbenchState,
	region: DockRegion
): boolean {
	return state.groups.some(
		(group) => group.region === region && group.itemIds.length > 0
	);
}

export function isDockRegionShown(
	state: WorkbenchState,
	region: DockRegion
): boolean {
	return state.openRegions[region] && regionHasTabs(state, region);
}

const DEFAULT_REGION_PANELS: Record<DockRegion, string> = {
	bottom: "terminal",
	right: "files",
};

/** Tools that show nothing useful until a project is open. */
const PROJECT_ONLY_TOOLS = new Set(["codereview", "files", "gitgraph"]);

/**
 * What showing an empty region opens: its default tool, then the caller's
 * fallbacks, then any other tool that prefers the region.
 */
export function emptyRegionPanel(
	tools: readonly WorkbenchToolOption[],
	region: DockRegion,
	folder: string | null,
	fallbacks: readonly WorkbenchToolOption[] = []
): WorkbenchToolOption | undefined {
	const usable = (tool: WorkbenchToolOption) =>
		folder !== null || !PROJECT_ONLY_TOOLS.has(tool.id);
	return (
		tools.find(
			(tool) => tool.id === DEFAULT_REGION_PANELS[region] && usable(tool)
		) ??
		fallbacks[0] ??
		tools.find((tool) => tool.region === region && usable(tool))
	);
}

/**
 * Show or hide a region. Pure apart from the callbacks, so the hotkeys, the
 * chat's panel buttons, and tests share one rule.
 */
export function toggleDockRegion(
	{
		dispatch,
		folder,
		openPanel,
		state,
		tools,
	}: {
		dispatch: (action: WorkbenchAction) => void;
		folder: string | null;
		openPanel: WorkbenchTools["openPanel"];
		state: WorkbenchState;
		tools: readonly WorkbenchToolOption[];
	},
	region: DockRegion,
	fallbacks: readonly WorkbenchToolOption[] = []
): void {
	if (isDockRegionShown(state, region)) {
		dispatch({ type: "region/hide", region });
		return;
	}
	if (regionHasTabs(state, region)) {
		dispatch({ type: "region/show", region });
		return;
	}
	const panel = emptyRegionPanel(tools, region, folder, fallbacks);
	const groupId = state.groups.find((group) => group.region === region)?.id;
	if (panel && groupId) {
		openPanel({ ...panel, region }, { groupId, preserveFocus: true });
	}
}

// Whether a workbench frame is mounted anywhere in this window. The legacy
// project-dock host sits above the frame, so it reads this flag instead of
// the context: while the frame shows tool tabs it must not run hidden copies.
let mountedFrames = 0;
const frameListeners = new Set<() => void>();

function notifyFrames(): void {
	for (const listener of frameListeners) {
		listener();
	}
}

function subscribeFrames(listener: () => void): () => void {
	frameListeners.add(listener);
	return () => frameListeners.delete(listener);
}

const readFramesMounted = () => mountedFrames > 0;
const NO_FRAMES = () => false;

/** Marks the workbench frame mounted for as long as the caller is. */
export function useMarkWorkbenchDocksActive(): void {
	useEffect(() => {
		mountedFrames += 1;
		notifyFrames();
		return () => {
			mountedFrames -= 1;
			notifyFrames();
		};
	}, []);
}

/** True while the workbench frame hosts the docks' panels. */
export function useWorkbenchDocksActive(): boolean {
	return useSyncExternalStore(subscribeFrames, readFramesMounted, NO_FRAMES);
}
