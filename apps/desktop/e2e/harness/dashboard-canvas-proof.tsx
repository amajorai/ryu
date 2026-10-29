import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AddWidgetDialog } from "@/src/components/dashboard/AddWidgetDialog.tsx";
import {
	CANVAS_CELL,
	DashboardCanvas,
	DEFAULT_NODE_H,
	DEFAULT_NODE_W,
} from "@/src/components/dashboard/DashboardCanvas.tsx";
import { DashboardGrid } from "@/src/components/dashboard/DashboardGrid.tsx";
import type { WidgetInput } from "@/src/components/dashboard/widgets/schema.ts";
import type {
	CanvasLayoutRect,
	GridLayoutRect,
	Widget,
} from "@/src/lib/api/dashboard.ts";
import "../../src/index.css";

const STORAGE_KEY = "dashboard-canvas-proof-state";
const WIDGET_ID = "canvas-proof-widget";

interface CanvasCall {
	name: "add-widget" | "create-widget" | "persist" | "refresh" | "remove";
	payload: {
		canvas?: CanvasLayoutRect;
		input?: WidgetInput;
		rect?: CanvasLayoutRect | GridLayoutRect;
		widgetId?: string;
	};
}

interface ProofState {
	calls: CanvasCall[];
	widgets: Widget[];
}

interface WidgetLiveState {
	error?: string | null;
	value?: unknown;
}

const INITIAL_WIDGET: Widget = {
	canvas: { h: 240, w: 320, x: 160, y: 120 },
	config: { label_key: "label" },
	dashboard_id: "canvas-proof-dashboard",
	id: WIDGET_ID,
	kind: "list",
	last_value: [{ label: "Persisted initial result" }],
	layout: { h: 3, w: 4, x: 0, y: 0 },
	source: { data: null, type: "static" },
	title: "Canvas proof widget",
};

function findCanvasRect(
	widgets: Widget[],
	center: { x: number; y: number },
	w: number,
	h: number
): CanvasLayoutRect {
	const gap = 24;
	const stepX = w + gap;
	const stepY = h + gap;
	const existing = widgets.map(
		(widget) =>
			widget.canvas ?? {
				h: widget.layout.h * CANVAS_CELL,
				w: widget.layout.w * CANVAS_CELL,
				x: widget.layout.x * CANVAS_CELL,
				y: widget.layout.y * CANVAS_CELL,
			}
	);
	const origin = { x: center.x - w / 2, y: center.y - h / 2 };
	const overlaps = (x: number, y: number) =>
		existing.some(
			(rect) =>
				x < rect.x + rect.w + gap &&
				x + w + gap > rect.x &&
				y < rect.y + rect.h + gap &&
				y + h + gap > rect.y
		);
	if (!overlaps(origin.x, origin.y)) {
		return { ...origin, w, h };
	}
	for (let radius = 1; radius <= widgets.length + 2; radius += 1) {
		for (let dx = radius; dx >= -radius; dx -= 1) {
			const vertical = radius - Math.abs(dx);
			const offsets = vertical === 0 ? [0] : [vertical, -vertical];
			for (const dy of offsets) {
				const x = origin.x + dx * stepX;
				const y = origin.y + dy * stepY;
				if (!overlaps(x, y)) {
					return { h, w, x, y };
				}
			}
		}
	}
	const lowestEdge = existing.reduce(
		(max, rect) => Math.max(max, rect.y + rect.h),
		origin.y
	);
	return { h, w, x: origin.x, y: lowestEdge + gap };
}

function loadState(): ProofState {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			return /* SAFETY: This isolated proof restores its own private STORAGE_KEY JSON written by commit(next: ProofState). The fixture controls this stored state; the cast is not schema validation for injected or external storage. */ JSON.parse(
				saved
			) as ProofState;
		}
	} catch {
		// Start from the known fixture if a prior browser session stored invalid data.
	}
	return { calls: [], widgets: [INITIAL_WIDGET] };
}

function DashboardCanvasProof() {
	const [state, setState] = useState<ProofState>(loadState);
	const stateRef = useRef(state);
	const [live, setLive] = useState<Record<string, WidgetLiveState>>({
		[WIDGET_ID]: { error: "Fixture source is temporarily unavailable" },
	});
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const [center, setCenter] = useState<{ x: number; y: number } | null>(null);
	const centerRef = useRef({ x: 320, y: 240 });

	const commit = useCallback((next: ProofState) => {
		stateRef.current = next;
		setState(next);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	}, []);

	const onAddWidget = useCallback(() => {
		const current = stateRef.current;
		commit({
			...current,
			calls: [...current.calls, { name: "add-widget", payload: {} }],
		});
		setAddDialogOpen(true);
	}, [commit]);

	const onCreateWidget = useCallback(
		async (input: WidgetInput) => {
			const current = stateRef.current;
			const id = `canvas-proof-created-${current.widgets.length}`;
			const canvas = findCanvasRect(
				current.widgets,
				centerRef.current,
				input.canvas?.w ?? DEFAULT_NODE_W,
				input.canvas?.h ?? DEFAULT_NODE_H
			);
			const widget: Widget = {
				canvas,
				config: input.config ?? {},
				dashboard_id: "canvas-proof-dashboard",
				id,
				kind: input.kind ?? "stat",
				last_value: 42,
				layout: input.layout ?? { h: 3, w: 3, x: 0, y: 0 },
				refresh_interval: input.refresh_interval,
				source: input.source ?? { data: 42, type: "static" },
				title: input.title ?? "Untitled widget",
			};
			commit({
				calls: [
					...current.calls,
					{ name: "create-widget", payload: { canvas, input } },
				],
				widgets: [...current.widgets, widget],
			});
			setLive((previous) => ({ ...previous, [id]: { value: 42 } }));
		},
		[commit]
	);

	const onCanvasPersist = useCallback(
		(widgetId: string, rect: CanvasLayoutRect) => {
			const current = stateRef.current;
			commit({
				calls: [
					...current.calls,
					{ name: "persist", payload: { rect, widgetId } },
				],
				widgets: current.widgets.map((widget) =>
					widget.id === widgetId ? { ...widget, canvas: rect } : widget
				),
			});
		},
		[commit]
	);

	const onGridPersist = useCallback(
		(widgetId: string, rect: GridLayoutRect) => {
			const current = stateRef.current;
			commit({
				calls: [
					...current.calls,
					{ name: "persist", payload: { rect, widgetId } },
				],
				widgets: current.widgets.map((widget) =>
					widget.id === widgetId ? { ...widget, layout: rect } : widget
				),
			});
		},
		[commit]
	);

	const onRefresh = useCallback(
		(widgetId: string) => {
			const current = stateRef.current;
			commit({
				...current,
				calls: [...current.calls, { name: "refresh", payload: { widgetId } }],
			});
			setLive({
				[widgetId]: { value: [{ label: "Refreshed fixture result" }] },
			});
		},
		[commit]
	);

	const onRemove = useCallback(
		(widgetId: string) => {
			const current = stateRef.current;
			commit({
				calls: [...current.calls, { name: "remove", payload: { widgetId } }],
				widgets: current.widgets.filter((widget) => widget.id !== widgetId),
			});
		},
		[commit]
	);

	const onViewportCenterChange = useCallback(
		(nextCenter: { x: number; y: number }) => {
			centerRef.current = nextCenter;
			setCenter(nextCenter);
		},
		[]
	);
	const isGridComparison =
		new URLSearchParams(window.location.search).get("surface") === "grid";

	return (
		<I18nProvider packs={[]}>
			<I18nDirectionProvider>
				<ChatDisplayPrefsProvider value={{ animationsEnabled: false }}>
					<main className="flex h-screen w-screen flex-col bg-background text-foreground">
						<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
							<h1 className="font-medium text-sm">Dashboard Canvas</h1>
							<output className="sr-only" data-testid="canvas-proof-state">
								{JSON.stringify({
									calls: state.calls,
									center,
									widgets: state.widgets,
								})}
							</output>
						</header>
						<section
							aria-label="Dashboard canvas proof surface"
							className="min-h-0 flex-1"
						>
							{isGridComparison ? (
								<DashboardGrid
									live={live}
									onLayoutPersist={onGridPersist}
									onRefresh={onRefresh}
									onRemove={onRemove}
									widgets={state.widgets}
								/>
							) : (
								<DashboardCanvas
									live={live}
									onAddWidget={onAddWidget}
									onCanvasPersist={onCanvasPersist}
									onRefresh={onRefresh}
									onRemove={onRemove}
									onViewportCenterChange={onViewportCenterChange}
									widgets={state.widgets}
								/>
							)}
						</section>
						<AddWidgetDialog
							coreEndpoints={["connections", "quests", "monitors"]}
							onCreate={onCreateWidget}
							onOpenChange={setAddDialogOpen}
							open={addDialogOpen}
						/>
					</main>
				</ChatDisplayPrefsProvider>
			</I18nDirectionProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Dashboard canvas proof root is missing");
}
createRoot(root).render(<DashboardCanvasProof />);
