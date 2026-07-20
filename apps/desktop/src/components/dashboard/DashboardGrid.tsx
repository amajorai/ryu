// The draggable / resizable widget grid (react-grid-layout v2). Layout (x/y/w/h)
// is persisted to Core per widget — never localStorage — because the AI builder
// arranges widgets and positions must round-trip. Drag is gated to the widget
// header via the `.widget-drag-handle` class; resize handles are themed in
// index.css. The `layout` array is memoized on `widgets` so the frequent
// live-value re-renders (SSE ticks every few seconds) don't change its identity
// and abort an in-progress drag/resize gesture.

import GridLayout, { type Layout, useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useCallback, useMemo, useRef } from "react";
import type { GridLayoutRect, Widget } from "@/src/lib/api/dashboard.ts";
import { WidgetCard } from "./WidgetCard.tsx";

const GRID_COLS = 12;
const ROW_HEIGHT = 80;
const PERSIST_DEBOUNCE_MS = 500;

export interface WidgetLiveState {
	error?: string | null;
	value?: unknown;
}

export function DashboardGrid({
	widgets,
	live,
	onLayoutPersist,
	onRefresh,
	onRemove,
}: {
	widgets: Widget[];
	/** Live value/error per widget id, from the SSE stream. */
	live: Record<string, WidgetLiveState>;
	/** Persist a single widget's new rect (debounced by the grid). */
	onLayoutPersist: (widgetId: string, rect: GridLayoutRect) => void;
	onRefresh: (widgetId: string) => void;
	onRemove: (widgetId: string) => void;
}) {
	const { width, containerRef, mounted } = useContainerWidth();
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const layout = useMemo<Layout>(
		() =>
			widgets.map((w) => ({
				i: w.id,
				x: w.layout.x,
				y: w.layout.y,
				w: w.layout.w,
				h: w.layout.h,
				minW: 2,
				minH: 2,
			})),
		[widgets]
	);

	// Persist only the items whose rect actually changed, debounced so a drag/resize
	// gesture writes once on settle rather than on every frame.
	const handleLayoutChange = useCallback(
		(next: Layout) => {
			const byId = new Map(widgets.map((w) => [w.id, w.layout]));
			const changed = next.filter((item) => {
				const prev = byId.get(item.i);
				return (
					prev &&
					(prev.x !== item.x ||
						prev.y !== item.y ||
						prev.w !== item.w ||
						prev.h !== item.h)
				);
			});
			if (changed.length === 0) {
				return;
			}
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				for (const item of changed) {
					onLayoutPersist(item.i, {
						x: item.x,
						y: item.y,
						w: item.w,
						h: item.h,
					});
				}
			}, PERSIST_DEBOUNCE_MS);
		},
		[widgets, onLayoutPersist]
	);

	return (
		<div className="h-full w-full" ref={containerRef}>
			{mounted && (
				<GridLayout
					dragConfig={{ handle: ".widget-drag-handle" }}
					gridConfig={{
						cols: GRID_COLS,
						rowHeight: ROW_HEIGHT,
						margin: [12, 12],
					}}
					layout={layout}
					onLayoutChange={handleLayoutChange}
					resizeConfig={{ handles: ["se", "e", "s", "sw"] }}
					width={width}
				>
					{widgets.map((w) => (
						<div key={w.id}>
							<WidgetCard
								error={live[w.id]?.error ?? w.last_error}
								onRefresh={() => onRefresh(w.id)}
								onRemove={() => onRemove(w.id)}
								value={
									w.id in live && live[w.id]?.value !== undefined
										? live[w.id].value
										: w.last_value
								}
								widget={w}
							/>
						</div>
					))}
				</GridLayout>
			)}
		</div>
	);
}
