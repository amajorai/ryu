import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Background,
	Controls,
	MiniMap,
	type OnMoveEnd,
	Panel,
	ReactFlow,
	ReactFlowProvider,
	useNodesState,
	useReactFlow,
	type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";
import { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import layoutStyles from "./InfiniteTabsCanvas.module.css";
import {
	type CanvasNode,
	type RegionCanvasNode,
	readStoredSnapshot,
	rectForNode,
	regionList,
	TAB_CANVAS_STORAGE_KEY,
	type TabCanvasNode,
	WRITE_DEBOUNCE_MS,
} from "./InfiniteTabsCanvas-model.ts";
import { NODE_TYPES } from "./InfiniteTabsCanvas-nodes.tsx";
import {
	createInitialTabCanvasSnapshot,
	reconcileTabCanvasSnapshot,
	TAB_CANVAS_DEFAULT_HEIGHT,
	TAB_CANVAS_DEFAULT_WIDTH,
	type TabCanvasSnapshot,
} from "./tab-canvas-layout.ts";

function CanvasInner() {
	const { activeTabId, closeTab, focusTab, openTab, tabs, groups, splits } =
		useTabsContext();
	const tabLayout = useTabLayout();
	const { animationsEnabled } = useChatDisplayPrefs();
	const prefersReducedMotion = usePrefersReducedMotion();
	const motionEnabled = animationsEnabled && !prefersReducedMotion;
	const regions = useMemo(
		() => regionList(tabs, groups, splits),
		[tabs, groups, splits]
	);
	const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
	const regionIds = useMemo(
		() => regions.map((region) => region.id),
		[regions]
	);
	const initialFitRef = useRef(false);
	const [snapshot, setSnapshot] = useState<TabCanvasSnapshot>(() => {
		const stored = readStoredSnapshot();
		initialFitRef.current = stored !== null;
		return stored
			? reconcileTabCanvasSnapshot(stored, tabIds, regionIds)
			: createInitialTabCanvasSnapshot(tabs, groups, splits);
	});
	const snapshotRef = useRef(snapshot);
	const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
	const nodesRef = useRef<CanvasNode[]>([]);
	const reactFlow = useReactFlow<CanvasNode>();

	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);

	useEffect(() => {
		return () => {
			if (writeTimerRef.current) {
				clearTimeout(writeTimerRef.current);
				try {
					localStorage.setItem(
						TAB_CANVAS_STORAGE_KEY,
						JSON.stringify(snapshotRef.current)
					);
				} catch {
					// Canvas geometry is a best-effort local preference.
				}
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
						motionEnabled,
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
		motionEnabled,
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
		(_event: Parameters<OnMoveEnd>[0], viewport: Viewport) => {
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
			className={cn("h-full min-h-0 min-w-0", layoutStyles.authored4)}
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
					<div className="flex items-center gap-1 rounded-xl border border-border bg-background p-1">
						<span className="px-2 text-muted-foreground text-xs">
							Infinite canvas
						</span>
						<Button onClick={fitAll} size="sm" variant="ghost-muted">
							Fit all
						</Button>
						<Button
							aria-label="New chat tab"
							onClick={() => openTab("/chat", { forceNew: true })}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
						</Button>
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
