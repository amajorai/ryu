// apps/desktop/src/pages/HomePage.tsx
//
// The Home dashboard: a customizable, constantly-updating grid of widgets. The
// grid is the main surface; a collapsible "Build with AI" panel hosts the
// dashboard builder chat (mirroring the Workflows page). Widgets render from a
// fixed catalog of standard shadcn components, pull live data via Core's refresh
// loop, and update over SSE. Layout (drag/resize) persists to Core per widget.

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@ryu/ui/components/toggle-group";
import {
	CheckIcon,
	ChevronDownIcon,
	FrameIcon,
	LayoutDashboardIcon,
	LayoutGridIcon,
	PencilIcon,
	PlusIcon,
	SparklesIcon,
	Trash2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddWidgetDialog } from "@/src/components/dashboard/AddWidgetDialog.tsx";
import { DashboardBuilderChat } from "@/src/components/dashboard/DashboardBuilderChat.tsx";
import {
	DashboardCanvas,
	DEFAULT_NODE_H,
	DEFAULT_NODE_W,
} from "@/src/components/dashboard/DashboardCanvas.tsx";
import {
	DashboardGrid,
	type WidgetLiveState,
} from "@/src/components/dashboard/DashboardGrid.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CanvasLayoutRect,
	createDashboard,
	createWidget,
	type Dashboard,
	type DashboardViewMode,
	deleteDashboard,
	deleteWidget,
	type GridLayoutRect,
	getCatalog,
	getDashboard,
	listDashboards,
	refreshWidget,
	renameDashboard,
	setDashboardViewMode,
	streamDashboardEvents,
	updateWidgetCanvas,
	updateWidgetLayout,
	type Widget,
	type WidgetInput,
} from "@/src/lib/api/dashboard.ts";

/** Quick-add presets so the grid is usable without the AI builder. */
const PRESETS: Array<{ label: string } & WidgetInput> = [
	{
		label: "Connected clients",
		kind: "stat",
		title: "Connected clients",
		source: {
			type: "core_endpoint",
			endpoint: "connections",
			selector: "clients",
		},
		config: { label: "online now" },
		refresh_interval: "10s",
		layout: { x: 0, y: 0, w: 3, h: 3 },
	},
	{
		label: "Open quests",
		kind: "list",
		title: "Open quests",
		source: { type: "core_endpoint", endpoint: "quests", selector: "quests" },
		config: { label_key: "title" },
		refresh_interval: "30s",
		layout: { x: 0, y: 0, w: 4, h: 4 },
	},
	{
		label: "Monitors",
		kind: "table",
		title: "Monitors",
		source: {
			type: "core_endpoint",
			endpoint: "monitors",
			selector: "monitors",
		},
		config: {},
		refresh_interval: "30s",
		layout: { x: 0, y: 0, w: 6, h: 4 },
	},
	{
		label: "Note",
		kind: "text",
		title: "Note",
		source: { type: "static", data: null },
		config: { markdown: "Welcome to your Home dashboard. Edit me." },
		layout: { x: 0, y: 0, w: 4, h: 3 },
	},
];

/**
 * Non-overlapping grid placements for the auto-seeded starter (keyed by preset
 * label), so the four widgets tile the 12-column grid neatly on first launch.
 */
const STARTER_LAYOUTS: Record<string, GridLayoutRect> = {
	"Connected clients": { x: 0, y: 0, w: 3, h: 3 },
	"Open quests": { x: 3, y: 0, w: 5, h: 4 },
	Note: { x: 8, y: 0, w: 4, h: 4 },
	Monitors: { x: 0, y: 4, w: 8, h: 4 },
};

/**
 * The prompt the "Generate a dashboard for me" button auto-sends to the AI
 * builder (the local `ryu`/Gemma agent), which authors widgets via Core's
 * `dashboard_builder__*` tools.
 */
const AI_STARTER_PROMPT =
	"Build me a useful starter Home dashboard. Add a few widgets that show my Ryu activity at a glance — for example connected clients, open quests, active monitors, and a short welcome note — using sensible core_endpoint sources, and arrange them neatly on the 12-column grid. Keep it clean and not overwhelming.";

/**
 * Nodes for which we've already auto-seeded a starter Home this session. Guards
 * against a re-list (or a dev StrictMode double-mount) seeding the starter twice.
 */
const bootstrappedNodes = new Set<string>();

/**
 * Seed the curated starter widgets onto a freshly created dashboard. Best-effort:
 * a failed widget just yields a smaller starter rather than aborting the rest, so
 * first launch always lands on a populated (not blank) Home.
 */
async function seedStarterWidgets(
	target: ApiTarget,
	dashboardId: string
): Promise<void> {
	for (const preset of PRESETS) {
		const { label, ...input } = preset;
		const layout = STARTER_LAYOUTS[label] ?? input.layout;
		try {
			await createWidget(target, dashboardId, { ...input, layout });
		} catch {
			// Best-effort: skip this widget and keep seeding the rest.
		}
	}
}

/** Compact, model-readable summary of a dashboard's widgets for the builder preamble. */
function dashboardSnapshot(widgets: Widget[]): string {
	if (widgets.length === 0) {
		return "(empty — no widgets yet)";
	}
	return widgets
		.map(
			(w) =>
				`  - ${w.id} (${w.kind}) "${w.title}" source=${w.source.type} at ${w.layout.x},${w.layout.y} ${w.layout.w}x${w.layout.h}`
		)
		.join("\n");
}

/** The next free row beneath all current widgets (so a quick-add stacks). */
function nextRow(widgets: Widget[]): number {
	return widgets.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0);
}

export default function HomePage() {
	const activeNode = useActiveNode();
	const target = useMemo(
		() => ({ url: activeNode.url, token: activeNode.token ?? null }),
		[activeNode.url, activeNode.token]
	);

	const [dashboards, setDashboards] = useState<Dashboard[]>([]);
	const [dashboardId, setDashboardId] = useState<string | null>(null);
	const [dashboardName, setDashboardName] = useState("Home");
	// The current dashboard's render mode: v1 grid (default) or v2 canvas.
	const [viewMode, setViewMode] = useState<DashboardViewMode>("grid");
	// Latest canvas viewport centre (flow coords), reported by DashboardCanvas, so a
	// new widget added in canvas view lands where the user is looking.
	const canvasCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const [widgets, setWidgets] = useState<Widget[]>([]);
	const [live, setLive] = useState<Record<string, WidgetLiveState>>({});
	const [loading, setLoading] = useState(true);
	// A load failure (fetching the dashboard list / a dashboard's widgets). Kept
	// separate from transient action failures, which surface as toasts, so the
	// grid never renders the "empty" state on top of a failed fetch.
	const [error, setError] = useState<string | null>(null);
	// Bumped to re-trigger the initial load effect from the Retry affordance.
	const [_reloadKey, setReloadKey] = useState(0);
	const [builderOpen, setBuilderOpen] = useState(false);
	// A one-shot prompt handed to the AI builder when the user clicks "Generate a
	// dashboard for me"; consumed (cleared) by the builder once sent.
	const [builderAutoPrompt, setBuilderAutoPrompt] = useState<string | null>(
		null
	);
	// True while an AI "generate" turn is in flight, so the empty area shows an
	// "assembling…" state instead of the call-to-action.
	const [generating, setGenerating] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	// Armed when the user picks "Delete" so we can confirm before wiping a
	// dashboard (and all of its widgets).
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const [coreEndpoints, setCoreEndpoints] = useState<string[]>([]);
	// Name dialog state, shared by "New dashboard" (create) and "Rename".
	const [nameDialog, setNameDialog] = useState<{
		mode: "create" | "rename";
		value: string;
	} | null>(null);

	// Fetch the catalog once so the Add-widget picker offers the live endpoint list.
	useEffect(() => {
		getCatalog(target)
			.then((c) => setCoreEndpoints(c.core_endpoints))
			.catch(() => {
				// Non-fatal: the picker falls back to a sensible default list.
			});
	}, [target]);

	// Load the dashboard list, creating a default "Home" when none exist yet.
	// Returns the list so callers can pick a selection.
	const refreshList = useCallback(async (): Promise<Dashboard[]> => {
		let list = await listDashboards(target);
		if (list.length === 0) {
			const home = await createDashboard(target, "Home");
			// First launch on this node: auto-seed a curated starter so Home is
			// never blank. Guarded per-node so it happens at most once per session
			// and never re-seeds a dashboard the user has since emptied.
			if (!bootstrappedNodes.has(target.url)) {
				bootstrappedNodes.add(target.url);
				await seedStarterWidgets(target, home.id);
			}
			list = [home];
		}
		setDashboards(list);
		return list;
	}, [target]);

	// Resolve the dashboard list + initial selection on mount (and on Retry).
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		(async () => {
			try {
				const list = await refreshList();
				if (cancelled) {
					return;
				}
				// Selecting an id triggers the reload effect, which sets the name + widgets.
				setDashboardId((prev) =>
					prev && list.some((d) => d.id === prev) ? prev : list[0].id
				);
			} catch {
				if (!cancelled) {
					setError(
						"We couldn't load your dashboards. Check your connection and try again."
					);
					setLoading(false);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [refreshList]);

	const reload = useCallback(
		async (id: string) => {
			try {
				const { dashboard, widgets: ws } = await getDashboard(target, id);
				setDashboardName(dashboard.name);
				setViewMode(dashboard.view_mode ?? "grid");
				setWidgets(ws);
				// Seed live state from cached values so a reload shows data immediately.
				setLive((prev) => {
					const next = { ...prev };
					for (const w of ws) {
						if (!(w.id in next) && w.last_value !== undefined) {
							next[w.id] = { value: w.last_value, error: w.last_error };
						}
					}
					return next;
				});
				setError(null);
			} catch {
				setError(
					"We couldn't load this dashboard. Check your connection and try again."
				);
			} finally {
				setLoading(false);
			}
		},
		[target]
	);

	// Load widgets whenever the selected dashboard changes.
	useEffect(() => {
		if (dashboardId) {
			reload(dashboardId);
		}
	}, [dashboardId, reload]);

	// Subscribe to the live SSE event stream for this dashboard.
	useEffect(() => {
		if (!dashboardId) {
			return;
		}
		const controller = new AbortController();
		(async () => {
			try {
				await streamDashboardEvents(
					target,
					(event) => {
						if ("dashboard_id" in event && event.dashboard_id !== dashboardId) {
							return;
						}
						switch (event.type) {
							case "widget_data":
								setLive((p) => ({
									...p,
									[event.widget_id]: { value: event.value, error: null },
								}));
								break;
							case "widget_error":
								setLive((p) => ({
									...p,
									[event.widget_id]: { error: event.error },
								}));
								break;
							case "widget_updated":
								setWidgets((p) => {
									const i = p.findIndex((w) => w.id === event.widget.id);
									if (i === -1) {
										return [...p, event.widget];
									}
									const copy = [...p];
									copy[i] = event.widget;
									return copy;
								});
								break;
							case "widget_deleted":
								setWidgets((p) => p.filter((w) => w.id !== event.widget_id));
								break;
							case "dashboard_updated":
								reload(dashboardId);
								break;
							default:
								break;
						}
					},
					controller.signal
				);
			} catch {
				// Stream dropped (navigation / Core restart); the next mount reconnects.
			}
		})();
		return () => controller.abort();
	}, [dashboardId, target, reload]);

	const handleLayoutPersist = useCallback(
		(widgetId: string, rect: GridLayoutRect) => {
			if (!dashboardId) {
				return;
			}
			// Optimistic local update so the grid doesn't snap back before the PUT lands.
			setWidgets((p) =>
				p.map((w) => (w.id === widgetId ? { ...w, layout: rect } : w))
			);
			updateWidgetLayout(target, dashboardId, widgetId, rect).catch(() => {
				// A failed persist self-heals on the next reload.
			});
		},
		[dashboardId, target]
	);

	// Persist a widget's canvas (v2) rect. Additive: never touches the grid layout,
	// so v1 stays intact. Optimistic so the node doesn't snap before the PUT lands.
	const handleCanvasPersist = useCallback(
		(widgetId: string, rect: CanvasLayoutRect) => {
			if (!dashboardId) {
				return;
			}
			setWidgets((p) =>
				p.map((w) => (w.id === widgetId ? { ...w, canvas: rect } : w))
			);
			updateWidgetCanvas(target, dashboardId, widgetId, rect).catch(() => {
				// A failed persist self-heals on the next reload.
			});
		},
		[dashboardId, target]
	);

	// Switch the current dashboard between grid (v1) and canvas (v2). Optimistic +
	// best-effort persist; the grid layout and widgets are untouched by the toggle.
	const handleSetViewMode = useCallback(
		(mode: DashboardViewMode) => {
			if (!dashboardId || mode === viewMode) {
				return;
			}
			setViewMode(mode);
			setDashboards((p) =>
				p.map((d) => (d.id === dashboardId ? { ...d, view_mode: mode } : d))
			);
			setDashboardViewMode(target, dashboardId, mode).catch(() => {
				// A failed persist self-heals on the next reload.
			});
		},
		[dashboardId, viewMode, target]
	);

	const handleRefresh = useCallback(
		(widgetId: string) => {
			if (!dashboardId) {
				return;
			}
			refreshWidget(target, dashboardId, widgetId)
				.then((r) => {
					setLive((p) => ({
						...p,
						[widgetId]: { value: r.value, error: r.error ?? null },
					}));
				})
				.catch(() => {
					toast.error("Couldn't refresh widget", {
						description: "Check your connection and try again.",
					});
				});
		},
		[dashboardId, target]
	);

	const handleRemove = useCallback(
		(widgetId: string) => {
			if (!dashboardId) {
				return;
			}
			setWidgets((p) => p.filter((w) => w.id !== widgetId));
			deleteWidget(target, dashboardId, widgetId).catch(() => {
				reload(dashboardId);
			});
		},
		[dashboardId, target, reload]
	);

	// Create any widget (from a quick preset or the full Add-widget picker),
	// stacking it beneath the current widgets and pulling its first value at once.
	const handleCreateWidget = useCallback(
		async (input: WidgetInput) => {
			if (!dashboardId) {
				return;
			}
			const layout = {
				x: 0,
				y: nextRow(widgets),
				w: input.layout?.w ?? 4,
				h: input.layout?.h ?? 3,
			};
			// In canvas view, drop the new widget at the current viewport centre so it
			// appears where the user is looking (the grid layout still round-trips).
			const canvas =
				viewMode === "canvas"
					? {
							x: canvasCenterRef.current.x - DEFAULT_NODE_W / 2,
							y: canvasCenterRef.current.y - DEFAULT_NODE_H / 2,
							w: input.canvas?.w ?? DEFAULT_NODE_W,
							h: input.canvas?.h ?? DEFAULT_NODE_H,
						}
					: input.canvas;
			try {
				const widget = await createWidget(target, dashboardId, {
					...input,
					layout,
					canvas,
				});
				setWidgets((p) => [...p, widget]);
				handleRefresh(widget.id);
			} catch {
				toast.error("Couldn't add widget", {
					description: "Check your connection and try again.",
				});
				reload(dashboardId);
			}
		},
		[dashboardId, target, widgets, handleRefresh, reload, viewMode]
	);

	// Open the AI builder and hand it a starter prompt so the local model
	// authors the dashboard — the one-click "generate one for me" path.
	const handleGenerateWithAi = useCallback(() => {
		setGenerating(true);
		setBuilderOpen(true);
		setBuilderAutoPrompt(AI_STARTER_PROMPT);
	}, []);

	// The AI turn produced widgets: drop the "assembling…" state so the grid shows.
	useEffect(() => {
		if (widgets.length > 0) {
			setGenerating(false);
		}
	}, [widgets.length]);

	const resolveDashboardId = useCallback(async () => {
		if (dashboardId) {
			return dashboardId;
		}
		try {
			const dash = await createDashboard(target, "Home");
			refreshList();
			setDashboardId(dash.id);
			return dash.id;
		} catch {
			return null;
		}
	}, [dashboardId, target, refreshList]);

	// Switch to another dashboard: changing the id re-runs the reload + SSE effects.
	const handleSelectDashboard = useCallback(
		(id: string) => {
			if (id === dashboardId) {
				return;
			}
			setLive({});
			setWidgets([]);
			setDashboardId(id);
		},
		[dashboardId]
	);

	// Commit the name dialog: create a new dashboard (and switch to it) or rename
	// the current one.
	const handleSubmitName = useCallback(async () => {
		if (!nameDialog) {
			return;
		}
		const name = nameDialog.value.trim();
		if (!name) {
			return;
		}
		try {
			if (nameDialog.mode === "create") {
				const dash = await createDashboard(target, name);
				await refreshList();
				handleSelectDashboard(dash.id);
			} else if (dashboardId) {
				await renameDashboard(target, dashboardId, name);
				setDashboardName(name);
				await refreshList();
			}
		} catch {
			toast.error("Couldn't save dashboard", {
				description: "Check your connection and try again.",
			});
		} finally {
			setNameDialog(null);
		}
	}, [nameDialog, target, dashboardId, refreshList, handleSelectDashboard]);

	// Delete the current dashboard (blocked when it is the only one) and fall back
	// to the first remaining.
	const handleDeleteCurrent = useCallback(async () => {
		if (!dashboardId || dashboards.length <= 1) {
			return;
		}
		try {
			await deleteDashboard(target, dashboardId);
			const list = await refreshList();
			const fallback = list.find((d) => d.id !== dashboardId) ?? list[0];
			handleSelectDashboard(fallback.id);
		} catch {
			toast.error("Couldn't delete dashboard", {
				description: "Check your connection and try again.",
			});
		}
	}, [
		dashboardId,
		dashboards.length,
		target,
		refreshList,
		handleSelectDashboard,
	]);

	// Retry a failed load: re-run the widget fetch when a dashboard is selected,
	// otherwise re-run the initial list resolution.
	const handleRetry = useCallback(() => {
		setError(null);
		setLoading(true);
		if (dashboardId) {
			reload(dashboardId);
		} else {
			setReloadKey((k) => k + 1);
		}
	}, [dashboardId, reload]);

	const snapshot = useMemo(() => dashboardSnapshot(widgets), [widgets]);

	// Dashboard controls live in the window titlebar actions instead of an
	// in-page header row. To keep the titlebar uncluttered, everything hangs off
	// the single dashboard selector dropdown: switching dashboards, adding widgets
	// (Build with AI + the widget presets), and managing the current dashboard.
	const dashboardActions = useMemo(
		() => (
			<div className="flex items-center gap-1.5">
				<ToggleGroup
					className="rounded-lg bg-muted/60 p-0.5"
					onValueChange={(v: string) => {
						if (v === "grid" || v === "canvas") {
							handleSetViewMode(v);
						}
					}}
					spacing={0}
					value={viewMode}
					variant="default"
				>
					<ToggleGroupItem
						aria-label="Grid view"
						className="h-7 gap-1 px-2 text-xs"
						value="grid"
					>
						<LayoutGridIcon className="size-3.5" /> Grid
					</ToggleGroupItem>
					<ToggleGroupItem
						aria-label="Canvas view"
						className="h-7 gap-1 px-2 text-xs"
						value="canvas"
					>
						<FrameIcon className="size-3.5" /> Canvas
					</ToggleGroupItem>
				</ToggleGroup>
				<DropdownMenu>
					<DropdownMenuTrigger
						className={buttonVariants({
							variant: "ghost",
							size: "sm",
							className: "gap-0.5 font-semibold",
						})}
					>
						{dashboardName}
						<ChevronDownIcon className="size-3.5 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-52">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Dashboards</DropdownMenuLabel>
							{dashboards.map((d) => (
								<DropdownMenuItem
									key={d.id}
									onClick={() => handleSelectDashboard(d.id)}
								>
									<CheckIcon
										className={
											d.id === dashboardId ? "size-4" : "size-4 opacity-0"
										}
									/>
									<span className="truncate">{d.name}</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => setBuilderOpen(true)}>
							<SparklesIcon className="size-4" /> Build with AI
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<PlusIcon className="size-4" /> Add widget
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{PRESETS.map((preset) => (
									<DropdownMenuItem
										key={preset.label}
										onClick={() => handleCreateWidget(preset)}
									>
										{preset.label}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={() => setAddOpen(true)}>
									<PlusIcon className="size-4" /> Custom widget…
								</DropdownMenuItem>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => setNameDialog({ mode: "create", value: "" })}
						>
							<PlusIcon className="size-4" /> New dashboard
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								setNameDialog({ mode: "rename", value: dashboardName })
							}
						>
							<PencilIcon className="size-4" /> Rename
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={dashboards.length <= 1}
							onClick={() => setConfirmDeleteOpen(true)}
							variant="destructive"
						>
							<Trash2Icon className="size-4" /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		),
		[
			dashboardName,
			dashboards,
			dashboardId,
			handleSelectDashboard,
			handleCreateWidget,
			viewMode,
			handleSetViewMode,
		]
	);
	useTitleBar(null, dashboardActions);

	if (loading && widgets.length === 0 && !error) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	const buildLoadErrorArea = () => (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<TriangleAlertIcon />
				</EmptyMedia>
				<EmptyTitle>Couldn't load your dashboard</EmptyTitle>
				<EmptyDescription>{error}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={handleRetry} size="sm" variant="outline">
					Try again
				</Button>
			</EmptyContent>
		</Empty>
	);

	const buildEmptyArea = () => {
		// An AI "generate" turn is running: show progress, not the call-to-action,
		// so the user waits for widgets to materialise rather than re-triggering.
		if (generating) {
			return (
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Spinner />
						</EmptyMedia>
						<EmptyTitle>Assembling your dashboard…</EmptyTitle>
						<EmptyDescription>
							Ryu is choosing widgets and arranging them for you. They'll appear
							here as they're created — you can follow along in the chat.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			);
		}
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<LayoutDashboardIcon />
					</EmptyMedia>
					<EmptyTitle>Your dashboard is empty</EmptyTitle>
					<EmptyDescription>
						Let Ryu build one for you from your activity, or add widgets
						yourself.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button onClick={handleGenerateWithAi} size="sm">
							<SparklesIcon className="size-4" /> Generate a dashboard for me
						</Button>
						<Button
							onClick={() => setAddOpen(true)}
							size="sm"
							variant="outline"
						>
							<PlusIcon className="size-4" /> Add a widget
						</Button>
					</div>
				</EmptyContent>
			</Empty>
		);
	};

	const buildGridArea = () => {
		// A failed fetch must not masquerade as an empty dashboard.
		if (error && widgets.length === 0) {
			return buildLoadErrorArea();
		}
		if (widgets.length === 0) {
			return buildEmptyArea();
		}
		if (viewMode === "canvas") {
			return (
				<DashboardCanvas
					live={live}
					onAddWidget={() => setAddOpen(true)}
					onCanvasPersist={handleCanvasPersist}
					onRefresh={handleRefresh}
					onRemove={handleRemove}
					onViewportCenterChange={(c) => {
						canvasCenterRef.current = c;
					}}
					widgets={widgets}
				/>
			);
		}
		return (
			<div className="h-full overflow-auto p-3">
				<DashboardGrid
					live={live}
					onLayoutPersist={handleLayoutPersist}
					onRefresh={handleRefresh}
					onRemove={handleRemove}
					widgets={widgets}
				/>
			</div>
		);
	};

	const gridArea = buildGridArea();

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{error && widgets.length > 0 && (
				<div className="flex items-center gap-3 bg-destructive/10 px-4 py-2 text-destructive text-xs">
					<span className="flex-1">{error}</span>
					<Button
						className="h-6 px-2 text-xs"
						onClick={handleRetry}
						size="sm"
						variant="ghost"
					>
						Try again
					</Button>
					<Button
						aria-label="Dismiss error"
						className="h-6 px-2 text-xs"
						onClick={() => setError(null)}
						size="sm"
						variant="ghost"
					>
						Dismiss
					</Button>
				</div>
			)}
			{builderOpen ? (
				<ResizablePanelGroup
					className="min-h-0 flex-1"
					orientation="horizontal"
				>
					<ResizablePanel className="min-h-0" defaultSize={64} minSize={40}>
						{gridArea}
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel
						className="flex min-h-0 flex-col"
						defaultSize={36}
						id="dashboard-builder-chat"
						minSize={24}
					>
						<DashboardBuilderChat
							autoPrompt={builderAutoPrompt}
							dashboardId={dashboardId}
							dashboardName={dashboardName}
							dashboardSnapshot={snapshot}
							onAutoPromptConsumed={() => setBuilderAutoPrompt(null)}
							onDashboardChanged={(id) =>
								// After each settled turn: re-hydrate the grid, then clear the
								// "assembling…" state (whether or not widgets landed) so the
								// empty area falls back to the call-to-action on a no-op turn.
								reload(id).then(() => setGenerating(false))
							}
							resolveDashboardId={resolveDashboardId}
							target={target}
						/>
					</ResizablePanel>
				</ResizablePanelGroup>
			) : (
				<div className="min-h-0 flex-1">{gridArea}</div>
			)}
			<AddWidgetDialog
				coreEndpoints={coreEndpoints}
				onCreate={handleCreateWidget}
				onOpenChange={setAddOpen}
				open={addOpen}
			/>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setNameDialog(null);
					}
				}}
				open={nameDialog !== null}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{nameDialog?.mode === "rename"
								? "Rename dashboard"
								: "New dashboard"}
						</DialogTitle>
					</DialogHeader>
					<Input
						autoFocus
						onChange={(e) =>
							setNameDialog((prev) =>
								prev ? { ...prev, value: e.target.value } : prev
							)
						}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleSubmitName();
							}
						}}
						placeholder="Dashboard name"
						value={nameDialog?.value ?? ""}
					/>
					<DialogFooter>
						<Button onClick={() => setNameDialog(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={!nameDialog?.value.trim()}
							onClick={() => handleSubmitName()}
						>
							{nameDialog?.mode === "rename" ? "Rename" : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete "{dashboardName}"?</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently deletes this dashboard and all of its widgets.
							This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => handleDeleteCurrent()}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
