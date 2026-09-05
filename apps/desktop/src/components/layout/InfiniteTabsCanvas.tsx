import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Background,
	Controls,
	MiniMap,
	type Node,
	type NodeProps,
	NodeResizer,
	type NodeTypes,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useReactFlow,
	type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TabLayoutMenuItems } from "@/src/components/layout/appearance-context-menu.tsx";
import { TabViewPane } from "@/src/components/layout/TabViewPane.tsx";
import type {
	Split,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { TabGlyph } from "./TitleBar.tsx";
import {
	type CanvasRect,
	createInitialTabCanvasSnapshot,
	reconcileTabCanvasSnapshot,
	TAB_CANVAS_DEFAULT_HEIGHT,
	TAB_CANVAS_DEFAULT_WIDTH,
	TAB_CANVAS_MIN_HEIGHT,
	TAB_CANVAS_MIN_WIDTH,
	type TabCanvasSnapshot,
} from "./tab-canvas-layout.ts";

const TAB_CANVAS_STORAGE_KEY = "ryu:tab-canvas-layout:v1";
const WRITE_DEBOUNCE_MS = 500;

const GROUP_SURFACE_CLASSES: Record<TabGroupColor, string> = {
	grey: "border-slate-500/40 bg-slate-500/10",
	blue: "border-info/45 bg-info/10",
	red: "border-destructive/45 bg-destructive/10",
	yellow: "border-warning/45 bg-warning/10",
	green: "border-success/45 bg-success/10",
	pink: "border-pink-500/45 bg-pink-500/10",
	purple: "border-purple-500/45 bg-purple-500/10",
	cyan: "border-cyan-500/45 bg-cyan-500/10",
	orange: "border-orange-500/45 bg-orange-500/10",
};

interface CanvasRegion {
	color: TabGroupColor;
	id: string;
	label: string;
	memberCount: number;
}

interface TabCanvasNodeData extends Record<string, unknown> {
	focused: boolean;
	onClose: () => void;
	onFocus: () => void;
	persist: () => void;
	tab: Tab;
	tabLayout: ReturnType<typeof useTabLayout>;
}

interface RegionCanvasNodeData extends Record<string, unknown> {
	color: TabGroupColor;
	id: string;
	label: string;
	memberCount: number;
}

type TabCanvasNode = Node<TabCanvasNodeData, "tab">;
type RegionCanvasNode = Node<RegionCanvasNodeData, "region">;
type CanvasNode = TabCanvasNode | RegionCanvasNode;

function readStoredSnapshot(): unknown {
	try {
		const value = localStorage.getItem(TAB_CANVAS_STORAGE_KEY);
		return value ? JSON.parse(value) : null;
	} catch {
		return null;
	}
}

function regionList(
	tabs: Tab[],
	groups: TabGroup[],
	splits: Split[]
): CanvasRegion[] {
	const regions: CanvasRegion[] = [];
	for (const group of groups) {
		const memberCount = tabs.filter((tab) => tab.groupId === group.id).length;
		if (memberCount > 0) {
			regions.push({
				color: group.color,
				id: `group:${group.id}`,
				label: group.name,
				memberCount,
			});
		}
	}
	for (const split of splits) {
		const memberCount = tabs.filter((tab) => tab.splitId === split.id).length;
		if (memberCount > 0) {
			regions.push({
				color: split.color,
				id: `split:${split.id}`,
				label: split.name || "Pane group",
				memberCount,
			});
		}
	}
	return regions;
}

function rectForNode(node: CanvasNode, fallback: CanvasRect): CanvasRect {
	return {
		height: node.height ?? fallback.height,
		width: node.width ?? fallback.width,
		x: node.position.x,
		y: node.position.y,
	};
}

function CanvasRegionNodeView({ data }: NodeProps<RegionCanvasNode>) {
	return (
		<div
			className={cn(
				"pointer-events-none h-full w-full rounded-3xl border p-4 shadow-inner",
				GROUP_SURFACE_CLASSES[data.color]
			)}
			data-canvas-region={data.label}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate font-medium text-sm">{data.label}</p>
					<p className="mt-0.5 text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
						Pane group
					</p>
				</div>
				<span className="shrink-0 rounded-full bg-background/70 px-2 py-1 font-medium text-[10px] text-muted-foreground">
					{data.memberCount} {data.memberCount === 1 ? "tab" : "tabs"}
				</span>
			</div>
		</div>
	);
}

function CanvasTabHeader({
	focused,
	onClose,
	onFocus,
	tab,
	tabLayout,
}: {
	focused: boolean;
	onClose: () => void;
	onFocus: () => void;
	tab: Tab;
	tabLayout: ReturnType<typeof useTabLayout>;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						className="flex min-h-11 items-center gap-2 border-border/60 border-b bg-card/95 px-3 py-2 backdrop-blur"
						data-tab-view-header={tab.id}
					>
						<TabGlyph
							busy={tab.busy}
							busySpeed={tab.busySpeed}
							className={cn(
								"size-4 shrink-0",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
							icon={tab.icon}
							logoSize="16px"
							path={tab.path}
							unloaded={tab.unloaded}
						/>
						<button
							className={cn(
								"min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
							onClick={onFocus}
							type="button"
						>
							<OverflowTooltip
								className="block overflow-hidden whitespace-nowrap font-medium text-xs"
								fade
								forceShow={tab.unloaded}
								text={tab.title}
							/>
						</button>
						<button
							aria-label={`Close ${tab.title}`}
							className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={(event) => {
								event.stopPropagation();
								onClose();
							}}
							type="button"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</button>
					</div>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem disabled={focused} onClick={onFocus}>
					Focus tab
				</ContextMenuItem>
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
				<ContextMenuItem onClick={onClose}>Close tab</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function TabCanvasNodeView({ data, selected }: NodeProps<TabCanvasNode>) {
	return (
		<>
			<NodeResizer
				handleClassName="!size-2 !rounded-[3px] !border-background !bg-primary"
				isVisible={selected}
				lineClassName="!border-primary/40"
				minHeight={TAB_CANVAS_MIN_HEIGHT}
				minWidth={TAB_CANVAS_MIN_WIDTH}
				onResizeEnd={data.persist}
			/>
			<TabViewPane
				className="h-full rounded-2xl border border-border/70 shadow-black/5 shadow-lg"
				focused={data.focused}
				onClose={data.onClose}
				onFocus={data.onFocus}
				tab={data.tab}
			>
				<CanvasTabHeader
					focused={data.focused}
					onClose={data.onClose}
					onFocus={data.onFocus}
					tab={data.tab}
					tabLayout={data.tabLayout}
				/>
			</TabViewPane>
		</>
	);
}

const NODE_TYPES: NodeTypes = {
	region: CanvasRegionNodeView,
	tab: TabCanvasNodeView,
};

function CanvasInner() {
	const { activeTabId, closeTab, focusTab, openTab, tabs, groups, splits } =
		useTabsContext();
	const tabLayout = useTabLayout();
	const regions = useMemo(
		() => regionList(tabs, groups, splits),
		[tabs, groups, splits]
	);
	const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
	const regionIds = useMemo(
		() => regions.map((region) => region.id),
		[regions]
	);
	const [snapshot, setSnapshot] = useState<TabCanvasSnapshot>(() => {
		const stored = readStoredSnapshot();
		return stored
			? reconcileTabCanvasSnapshot(stored, tabIds, regionIds)
			: createInitialTabCanvasSnapshot(tabs, groups, splits);
	});
	const snapshotRef = useRef(snapshot);
	const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
	const nodesRef = useRef<CanvasNode[]>([]);
	const initialFitRef = useRef(false);
	const reactFlow = useReactFlow<CanvasNode>();

	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);

	useEffect(() => {
		return () => {
			if (writeTimerRef.current) {
				clearTimeout(writeTimerRef.current);
			}
		};
	}, []);

	const scheduleSnapshotWrite = useCallback((next: TabCanvasSnapshot) => {
		snapshotRef.current = next;
		setSnapshot(next);
		if (writeTimerRef.current) {
			clearTimeout(writeTimerRef.current);
		}
		writeTimerRef.current = setTimeout(() => {
			writeTimerRef.current = null;
			try {
				localStorage.setItem(
					TAB_CANVAS_STORAGE_KEY,
					JSON.stringify(snapshotRef.current)
				);
			} catch {
				// Canvas geometry is a best-effort local preference.
			}
		}, WRITE_DEBOUNCE_MS);
	}, []);

	useEffect(() => {
		const next = reconcileTabCanvasSnapshot(
			snapshotRef.current,
			tabIds,
			regionIds
		);
		snapshotRef.current = next;
		setSnapshot(next);
	}, [tabIds, regionIds]);

	const persistNode = useCallback(
		(nodeId: string) => {
			const node = nodesRef.current.find(
				(candidate) => candidate.id === nodeId
			);
			if (!node) {
				return;
			}
			const fallback =
				node.type === "tab"
					? {
							height: TAB_CANVAS_DEFAULT_HEIGHT,
							width: TAB_CANVAS_DEFAULT_WIDTH,
							x: node.position.x,
							y: node.position.y,
						}
					: { height: 368, width: 944, x: node.position.x, y: node.position.y };
			const rect = rectForNode(node, fallback);
			const next: TabCanvasSnapshot = {
				...snapshotRef.current,
				groups: { ...snapshotRef.current.groups },
				tabs: { ...snapshotRef.current.tabs },
			};
			if (node.type === "tab") {
				next.tabs[node.data.tab.id] = rect;
			} else {
				next.groups[node.data.id] = rect;
			}
			scheduleSnapshotWrite(next);
		},
		[scheduleSnapshotWrite]
	);

	useEffect(() => {
		setNodes((previous) => {
			const previousById = new Map(previous.map((node) => [node.id, node]));
			const regionNodes: RegionCanvasNode[] = regions.map((region, index) => {
				const id = `region:${region.id}`;
				const rect = snapshot.groups[region.id] ?? {
					height: 368,
					width: 944,
					x: index * 1024,
					y: 460,
				};
				const previousNode = previousById.get(id);
				return {
					id,
					type: "region",
					position: previousNode?.position ?? { x: rect.x, y: rect.y },
					style: {
						height: previousNode?.height ?? rect.height,
						pointerEvents: "none",
						width: previousNode?.width ?? rect.width,
						zIndex: -1,
					},
					data: {
						color: region.color,
						id: region.id,
						label: region.label,
						memberCount: region.memberCount,
					},
					selectable: false,
					draggable: false,
					connectable: false,
					focusable: false,
				} satisfies RegionCanvasNode;
			});
			const tabNodes: TabCanvasNode[] = tabs.map((tab, index) => {
				const id = `tab:${tab.id}`;
				const rect = snapshot.tabs[tab.id] ?? {
					height: TAB_CANVAS_DEFAULT_HEIGHT,
					width: TAB_CANVAS_DEFAULT_WIDTH,
					x: 24 + index * 48,
					y: 64 + index * 48,
				};
				const previousNode = previousById.get(id);
				return {
					id,
					type: "tab",
					position: previousNode?.position ?? { x: rect.x, y: rect.y },
					width: previousNode?.width ?? rect.width,
					height: previousNode?.height ?? rect.height,
					data: {
						focused: tab.id === activeTabId,
						onClose: () => closeTab(tab.id),
						onFocus: () => focusTab(tab.id),
						persist: () => persistNode(id),
						tab,
						tabLayout,
					},
					ariaLabel: `${tab.title} tab`,
					selected: tab.id === activeTabId,
				} satisfies TabCanvasNode;
			});
			return [...regionNodes, ...tabNodes];
		});
	}, [
		activeTabId,
		closeTab,
		focusTab,
		persistNode,
		snapshot.groups,
		snapshot.tabs,
		regions,
		setNodes,
		tabLayout,
		tabs,
	]);

	const fitAll = useCallback(() => {
		reactFlow.fitView({ maxZoom: 1, padding: 0.18 });
	}, [reactFlow]);

	useEffect(() => {
		if (nodes.length === 0 || initialFitRef.current) {
			return;
		}
		initialFitRef.current = true;
		fitAll();
	}, [fitAll, nodes.length]);

	const handleMoveEnd = useCallback(
		(_event: unknown, viewport: Viewport) => {
			if (
				viewport.x === snapshotRef.current.viewport.x &&
				viewport.y === snapshotRef.current.viewport.y &&
				viewport.zoom === snapshotRef.current.viewport.zoom
			) {
				return;
			}
			scheduleSnapshotWrite({
				...snapshotRef.current,
				viewport,
			});
		},
		[scheduleSnapshotWrite]
	);

	return (
		<div
			aria-label="Infinite tab canvas"
			className="h-full min-h-0 min-w-0 pt-12"
			data-tab-layout={tabLayout}
			data-testid="infinite-tabs-canvas"
		>
			<ReactFlow
				defaultViewport={snapshot.viewport}
				deleteKeyCode={null}
				edges={[]}
				fitView={false}
				nodes={nodes}
				nodeTypes={NODE_TYPES}
				onMoveEnd={handleMoveEnd}
				onNodeClick={(_event, node) => {
					if (node.type === "tab") {
						focusTab(node.data.tab.id);
					}
				}}
				onNodeDragStop={(_event, node) => persistNode(node.id)}
				onNodesChange={onNodesChange}
				proOptions={{ hideAttribution: true }}
			>
				<Background />
				<Controls className="workflow-controls" showInteractive={false} />
				<MiniMap
					className="!bottom-3 !right-3 !rounded-xl !bg-muted/60"
					nodeColor={(node) =>
						node.type === "region" ? "var(--muted-foreground)" : "var(--card)"
					}
					pannable
					zoomable
				/>
				<Panel position="top-right">
					<div className="flex items-center gap-2 rounded-xl border border-border/60 bg-popover/90 p-1.5 shadow-sm backdrop-blur">
						<span className="px-2 font-medium text-muted-foreground text-xs">
							Infinite canvas
						</span>
						<button
							className="rounded-lg px-2 py-1.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={fitAll}
							type="button"
						>
							Fit all
						</button>
						<button
							aria-label="New chat tab"
							className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => openTab("/chat", { forceNew: true })}
							type="button"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
						</button>
					</div>
				</Panel>
			</ReactFlow>
		</div>
	);
}

export function InfiniteTabsCanvas() {
	return (
		<ReactFlowProvider>
			<CanvasInner />
		</ReactFlowProvider>
	);
}
