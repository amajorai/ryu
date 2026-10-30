import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect } from "react";
import {
	type CanvasLayoutRect,
	type DashboardViewMode,
	deleteWidget,
	type GridLayoutRect,
	refreshWidget,
	setDashboardViewMode,
	streamDashboardEvents,
	updateWidgetCanvas,
	updateWidgetLayout,
} from "@/src/lib/api/dashboard.ts";
import type { useHomeDashboardData } from "./HomePage.data.ts";

type HomeWidgetActionsInput = Pick<
	ReturnType<typeof useHomeDashboardData>,
	| "dashboardId"
	| "publishDashboardChanged"
	| "reload"
	| "setDashboards"
	| "setLive"
	| "setViewMode"
	| "setWidgets"
	| "target"
	| "viewMode"
>;

/** Layout and canvas persistence, view mode, and widget refresh/removal. */
export function useHomeWidgetActions({
	dashboardId,
	publishDashboardChanged,
	reload,
	setDashboards,
	setLive,
	setViewMode,
	setWidgets,
	target,
	viewMode,
}: HomeWidgetActionsInput) {
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
			updateWidgetLayout(target, dashboardId, widgetId, rect)
				.then(publishDashboardChanged)
				.catch(() => {
					// A failed persist self-heals on the next reload.
				});
		},
		[dashboardId, publishDashboardChanged, target]
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
			updateWidgetCanvas(target, dashboardId, widgetId, rect)
				.then(publishDashboardChanged)
				.catch(() => {
					// A failed persist self-heals on the next reload.
				});
		},
		[dashboardId, publishDashboardChanged, target]
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
			setDashboardViewMode(target, dashboardId, mode)
				.then(publishDashboardChanged)
				.catch(() => {
					// A failed persist self-heals on the next reload.
				});
		},
		[dashboardId, publishDashboardChanged, viewMode, target]
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
			deleteWidget(target, dashboardId, widgetId)
				.then(publishDashboardChanged)
				.catch(() => {
					void reload(dashboardId);
				});
		},
		[dashboardId, publishDashboardChanged, target, reload]
	);
	return {
		handleCanvasPersist,
		handleLayoutPersist,
		handleRefresh,
		handleRemove,
		handleSetViewMode,
	};
}
