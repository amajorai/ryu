import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DashboardGrid } from "@/src/components/dashboard/DashboardGrid.tsx";
import { SplitDropZones } from "@/src/components/layout/SplitDropZones.tsx";
import {
	computeCenterGroupLayout,
	type PaneRect,
	paneRectPx,
} from "@/src/components/layout/SplitView.tsx";
import {
	TabDndProvider,
	useTabDnd,
	useTabDragProps,
} from "@/src/components/layout/tabDnd.tsx";
import type { Tab, TabsContextValue } from "@/src/contexts/TabsContext.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { Widget } from "@/src/lib/api/dashboard.ts";
import {
	DesktopWorkbenchProvider,
	useDesktopWorkbench,
} from "@/src/workbench/DesktopWorkbenchContext.tsx";
import proofStyles from "./dashboard-tabs-motion-proof.module.css";
import type {} from "./proof-css-custom-properties.d.ts";
import "../../src/index.css";
import "./dashboard-tabs-motion-proof.css";

const WIDGETS: Widget[] = [
	{
		config: { delta_key: "delta", label: "Tasks closed", unit: "/wk" },
		dashboard_id: "motion-proof",
		id: "throughput",
		kind: "stat",
		last_value: { delta: 12, value: 128 },
		layout: { h: 3, w: 3, x: 0, y: 0 },
		source: { type: "static", data: null },
		title: "Throughput",
	},
	{
		config: { label_key: "label" },
		dashboard_id: "motion-proof",
		id: "focus",
		kind: "list",
		last_value: [
			{ label: "Review the open pull request" },
			{ label: "Prepare the customer handoff" },
			{ label: "Update the runbook" },
		],
		layout: { h: 4, w: 5, x: 3, y: 0 },
		source: { type: "static", data: null },
		title: "Next up",
	},
	{
		config: {
			markdown:
				"A calm board with just enough movement to make each change legible.",
		},
		dashboard_id: "motion-proof",
		id: "note",
		kind: "text",
		last_value: null,
		layout: { h: 3, w: 4, x: 8, y: 0 },
		source: { type: "static", data: null },
		title: "Workspace note",
	},
];

const INITIAL_TABS: Tab[] = [
	{ id: "tab-a", path: "/chat", title: "Research" },
	{ id: "tab-b", path: "/library", title: "Library" },
];

function DraggableTab({ tab }: { tab: Tab }) {
	const dnd = useTabDnd();
	const { dragHandlers } = useTabDragProps(tab.id);
	return (
		<button
			{...dragHandlers}
			className={cn(
				"rounded-full border px-3 py-1.5 font-medium text-xs transition-all duration-150",
				dnd.draggingId === tab.id
					? "scale-[0.97] opacity-40 shadow-lg"
					: "bg-card hover:bg-muted"
			)}
			data-testid={`drag-${tab.id}`}
			type="button"
		>
			{tab.title}
		</button>
	);
}

interface PaneGeometry {
	height: string;
	left: string;
	paneWidth: string;
	top: string;
	width: string;
}

function DemoPane({ tab, geometry }: { tab: Tab; geometry: PaneGeometry }) {
	return (
		<section
			className={cn(
				proofStyles.pane,
				"absolute z-1 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm duration-200 ease-out"
			)}
			data-testid={`pane-tab-${tab.id.slice(-1)}`}
			style={{
				"--proof-pane-height": geometry.height,
				"--proof-pane-left": geometry.left,
				"--proof-pane-top": geometry.top,
				"--proof-pane-width": geometry.width,
				"--proof-pane-pixel-width": geometry.paneWidth,
			}}
		>
			<div className="flex h-12 items-center gap-2 border-b bg-muted/30 px-4">
				<span className="size-2 rounded-full bg-primary" />
				<span className="font-medium text-sm">{tab.title}</span>
			</div>
			<div className="p-4 text-muted-foreground text-sm">
				{tab.id === "tab-a"
					? "Drag this tab onto the edge of the other pane."
					: "The target pane becomes a split without losing its place."}
			</div>
		</section>
	);
}

function splitPaneStyle(
	rect: PaneRect,
	container: { height: number; width: number }
): PaneGeometry {
	const px = paneRectPx(rect, container);
	return {
		height: `calc(${(rect.height.frac * 100).toFixed(4)}% - ${rect.top.frac === 0 ? 48 : 0}px)`,
		left: `${rect.left.frac * 100}%`,
		top: `calc(${rect.top.frac * 100}% + ${rect.top.frac === 0 ? 48 : 0}px)`,
		width: `${rect.width.frac * 100}%`,
		// Keep the helper's pixel calculation live in the proof so the same
		// pane geometry used by SplitDropZones is exercised.
		paneWidth: `${px.width}px`,
	};
}

function SplitMotionSurface({
	surfaceRef,
}: {
	surfaceRef: { current: HTMLDivElement | null };
}) {
	const dnd = useTabDnd();
	const { state } = useDesktopWorkbench();
	const layout = computeCenterGroupLayout(state.centerTree);
	const centerGroups = state.groups.filter(
		(group) => group.region === "center"
	);
	const status = centerGroups.length > 1 ? "Two panes" : "One pane";
	const tabs = INITIAL_TABS;
	const size = surfaceRef.current?.getBoundingClientRect();
	const container = size
		? { height: size.height, width: size.width }
		: { height: 360, width: 800 };

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2">
				{tabs.map((tab) => (
					<DraggableTab key={tab.id} tab={tab} />
				))}
				<span
					className="ml-auto text-muted-foreground text-xs"
					data-testid="dnd-state"
				>
					{dnd.draggingId
						? `Dragging ${tabs.find((tab) => tab.id === dnd.draggingId)?.title}`
						: "Ready"}
				</span>
			</div>
			<div
				className="relative h-[360px] overflow-hidden rounded-2xl border border-border/70 bg-muted/10"
				data-testid="split-demo-surface"
				ref={surfaceRef}
			>
				{centerGroups.map((group) => {
					const tab = tabs.find(
						(candidate) => candidate.id === group.activeItemId
					);
					const rect = layout.panes.get(group.id);
					if (!(tab && rect)) {
						return null;
					}
					return (
						<DemoPane
							geometry={splitPaneStyle(rect, container)}
							key={group.id}
							tab={tab}
						/>
					);
				})}
				<SplitDropZones />
			</div>
			<p className="text-muted-foreground text-xs" data-testid="split-status">
				{status}
			</p>
		</div>
	);
}

function SplitMotionDemo() {
	const { dispatch, state } = useDesktopWorkbench();
	const surfaceRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (state.items.some((item) => item.id === "tab-a")) {
			return;
		}
		const centerGroup = state.groups.find((group) => group.region === "center");
		if (!centerGroup) {
			throw new Error("Proof workbench has no center group");
		}
		for (const tab of INITIAL_TABS) {
			dispatch({
				type: "item/open",
				groupId: centerGroup.id,
				item: {
					id: tab.id,
					title: tab.title,
					closable: true,
					duplicable: false,
					pinned: false,
					preferredRegion: "center",
					scope: { kind: "window" },
					source: { kind: "route", path: tab.path },
				},
			});
		}
	}, [dispatch, state.groups, state.items]);
	const contextValue = useMemo(
		() =>
			({
				tabs: INITIAL_TABS,
				activeTabId: "tab-b",
				moveTab: () => undefined,
				closeTab: () => undefined,
				prepareTabForWorkbenchSplit: () => undefined,
			}) satisfies Pick<
				TabsContextValue,
				| "tabs"
				| "activeTabId"
				| "moveTab"
				| "closeTab"
				| "prepareTabForWorkbenchSplit"
			>,
		[]
	);
	// SAFETY: This fixture supplies exactly the tab actions used by the real drag
	// provider. Pane membership and splitting run through the real workbench.
	return (
		<TabsContext.Provider value={contextValue as TabsContextValue}>
			<TabDndProvider>
				<SplitMotionSurface surfaceRef={surfaceRef} />
			</TabDndProvider>
		</TabsContext.Provider>
	);
}

// Keep fixture persistence isolated from the user's desktop and reset on reload.
const proofValues = new Map<string, string>();
const proofStorage: Storage = {
	get length() {
		return proofValues.size;
	},
	clear: () => proofValues.clear(),
	getItem: (key) => proofValues.get(key) ?? null,
	key: (index) => [...proofValues.keys()][index] ?? null,
	removeItem: (key) => {
		proofValues.delete(key);
	},
	setItem: (key, value) => {
		proofValues.set(key, value);
	},
};

function ProofApp() {
	const [saved, setSaved] = useState(
		"Drag a dashboard card or tab to feel the settle."
	);
	return (
		<div className="min-h-screen bg-background p-6 text-foreground">
			<div className="mx-auto flex max-w-6xl flex-col gap-6">
				<header>
					<p className="type-compact font-medium text-muted-foreground uppercase tracking-(--tracking-section)">
						Ryu interaction proof
					</p>
					<h1 className="mt-1 font-semibold text-2xl tracking-tight">
						Dashboard + tab splitting
					</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
						Spatial feedback for drag gestures: the card lifts, the target
						previews, and a new split settles into place.
					</p>
				</header>
				<section
					className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
					data-testid="dashboard-motion-proof"
				>
					<div className="mb-3 flex items-center justify-between">
						<div>
							<h2 className="font-medium text-sm">Work dashboard</h2>
							<p className="text-muted-foreground text-xs">
								Drag from a widget header; the placeholder marks the landing
								slot.
							</p>
						</div>
						<span
							className="text-muted-foreground text-xs"
							data-testid="dashboard-save-status"
						>
							{saved}
						</span>
					</div>
					<div className="h-[340px]">
						<DashboardGrid
							live={{}}
							onLayoutPersist={() => setSaved("Layout saved")}
							onRefresh={() => undefined}
							onRemove={() => undefined}
							widgets={WIDGETS}
						/>
					</div>
				</section>
				<section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
					<div className="mb-3">
						<h2 className="font-medium text-sm">Split drop target</h2>
						<p className="text-muted-foreground text-xs">
							Drag Research onto the right edge of Library.
						</p>
					</div>
					<SplitMotionDemo />
				</section>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<DesktopWorkbenchProvider storage={proofStorage}>
		<ProofApp />
	</DesktopWorkbenchProvider>
);
