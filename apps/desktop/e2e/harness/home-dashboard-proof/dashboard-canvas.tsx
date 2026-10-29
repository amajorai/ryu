import { useEffect } from "react";
import type { CanvasLayoutRect, Widget } from "@/src/lib/api/dashboard.ts";

export const CANVAS_CELL = 100;
export const DEFAULT_NODE_W = 320;
export const DEFAULT_NODE_H = 240;

interface WidgetLiveState {
	error?: string | null;
	value?: unknown;
}

export function DashboardCanvas({
	onAddWidget,
	onViewportCenterChange,
	widgets,
}: {
	live: Record<string, WidgetLiveState>;
	onAddWidget: () => void;
	onCanvasPersist: (widgetId: string, layout: CanvasLayoutRect) => void;
	onRefresh: (widgetId: string) => void;
	onRemove: (widgetId: string) => void;
	onViewportCenterChange: (center: { x: number; y: number }) => void;
	widgets: Widget[];
}) {
	useEffect(() => {
		onViewportCenterChange({ x: 400, y: 250 });
	}, [onViewportCenterChange]);
	return (
		<section aria-label="Dashboard canvas" data-testid="home-dashboard-canvas">
			{widgets.map((widget) => (
				<article key={widget.id}>
					<h2>{widget.title}</h2>
				</article>
			))}
			<button onClick={onAddWidget} type="button">
				Add widget to canvas
			</button>
		</section>
	);
}
