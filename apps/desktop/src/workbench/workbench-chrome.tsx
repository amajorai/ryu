import type { WorkbenchItem, WorkbenchRegion } from "@ryu/workbench/model";
import {
	createContext,
	type DragEvent,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";

/** The one drag format shared by every tab surface (title bar, sidebar, strips). */
export const WORKBENCH_ITEM_DRAG_MIME = "application/x-ryu-tab";

/** The shell's tab drag session, bridged in so strips can join it. */
export interface WorkbenchDragBridge {
	draggingId: string | null;
	/** Ends the session; with the native event it may tear the tab into a window. */
	end: (event?: DragEvent) => void;
	start: (itemId: string) => void;
}

/** A tool or app panel that can open as a workbench tab. */
export interface WorkbenchToolOption {
	/** The chat a chat-bound panel (Context, Sources …) belongs to. */
	conversation?: { id: string; title: string };
	/** The dock tab kind (`terminal`, `plugin:<plugin>:<panel>` …). */
	id: string;
	label: string;
	region: WorkbenchRegion;
}

/** How {@link WorkbenchTools.openPanel} places a panel. */
export interface OpenPanelOptions {
	/** Focus the tab (default true); false opens it in the background. */
	activate?: boolean;
	/** A command for a terminal tab to run. */
	command?: TerminalCommandRequest;
	/** The project the panel belongs to, when not the open workspace folder. */
	folder?: string | null;
	/** Always open a new tab, even when one for this panel is open. */
	forceNew?: boolean;
	/** The group to open in, instead of the panel's preferred region. */
	groupId?: string;
	/** Bumped per request so a repeated command or review runs again. */
	nonce?: number;
	/**
	 * Reveal the tab but leave keyboard focus (and the title bar) with the
	 * pane that asked, as a chat does when it opens one of its panels.
	 */
	preserveFocus?: boolean;
	/** Files a Changes tab should review. */
	reviewPaths?: string[];
}

/** The openable tools, provided once by the shell so light consumers (the
 *  command palette) need not import the panel and plugin modules. */
export interface WorkbenchTools {
	/**
	 * Open any panel (a tool, page, app panel, or a chat's panel), or focus the
	 * open tab for the same panel and scope. Returns the tab id.
	 */
	openPanel: (
		option: WorkbenchToolOption,
		options?: OpenPanelOptions
	) => string | undefined;
	/** Open a tool, or focus its existing instance for this project. */
	openTool: (
		toolId: string,
		target?: { groupId?: string; region?: WorkbenchRegion }
	) => void;
	tools: WorkbenchToolOption[];
}

const WorkbenchToolsContext = createContext<WorkbenchTools | null>(null);

export const WorkbenchToolsContextProvider = WorkbenchToolsContext.Provider;

export function useWorkbenchToolsContext(): WorkbenchTools | null {
	return useContext(WorkbenchToolsContext);
}

/** Tools a region's "+" menu can open, besides a new chat. */
export interface WorkbenchAddMenu {
	openTool: (toolId: string, groupId: string) => void;
	tools: ReadonlyArray<{ id: string; label: string }>;
}

export interface WorkbenchChromeValue {
	addMenu?: WorkbenchAddMenu;
	drag?: WorkbenchDragBridge;
	/** Regions a tab can be moved to from strip menus and drag targets. */
	movableRegions: readonly WorkbenchRegion[];
	/**
	 * Clears route-only presentation (legacy split, group, pin) before a tab
	 * joins a new Center split, so the route list and the workbench agree.
	 */
	prepareItemForSplit?: (itemId: string) => void;
	/** The glyph a tab shows before its title, when the shell provides one. */
	renderItemIcon?: (item: WorkbenchItem) => ReactNode;
}

const ALL_REGIONS: readonly WorkbenchRegion[] = [
	"left",
	"center",
	"right",
	"bottom",
];

/**
 * Regions the Desktop shell offers today. AppSidebar still owns navigation on
 * the left edge, so Left is not a move target yet.
 */
export const DESKTOP_SHELL_REGIONS: readonly WorkbenchRegion[] =
	ALL_REGIONS.filter((region) => region !== "left");

const WorkbenchChromeContext = createContext<WorkbenchChromeValue>({
	movableRegions: ALL_REGIONS,
});

export function WorkbenchChromeProvider({
	addMenu,
	children,
	drag,
	leftAvailable = true,
	prepareItemForSplit,
	renderItemIcon,
}: {
	addMenu?: WorkbenchAddMenu;
	children: ReactNode;
	drag?: WorkbenchDragBridge;
	leftAvailable?: boolean;
	prepareItemForSplit?: (itemId: string) => void;
	renderItemIcon?: (item: WorkbenchItem) => ReactNode;
}) {
	const value = useMemo<WorkbenchChromeValue>(
		() => ({
			addMenu,
			drag,
			movableRegions: leftAvailable
				? ALL_REGIONS
				: ALL_REGIONS.filter((region) => region !== "left"),
			prepareItemForSplit,
			renderItemIcon,
		}),
		[addMenu, drag, leftAvailable, prepareItemForSplit, renderItemIcon]
	);
	return (
		<WorkbenchChromeContext.Provider value={value}>
			{children}
		</WorkbenchChromeContext.Provider>
	);
}

export function useWorkbenchChrome(): WorkbenchChromeValue {
	return useContext(WorkbenchChromeContext);
}
