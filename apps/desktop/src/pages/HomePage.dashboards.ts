import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useState } from "react";
import {
	DEFAULT_NODE_H,
	DEFAULT_NODE_W,
} from "@/src/components/dashboard/DashboardCanvas.tsx";
import {
	createDashboard,
	createWidget,
	deleteDashboard,
	renameDashboard,
	type WidgetInput,
} from "@/src/lib/api/dashboard.ts";
import type { useHomeDashboardData } from "./HomePage.data.ts";
import { findCanvasRect, nextRow } from "./HomePage.presets.ts";
import type { useHomeWidgetActions } from "./HomePage.widgets.ts";

type HomeDashboardActionsInput = Pick<
	ReturnType<typeof useHomeDashboardData>,
	| "canvasCenterRef"
	| "dashboardId"
	| "dashboards"
	| "nameDialog"
	| "publishDashboardChanged"
	| "refreshList"
	| "reload"
	| "setBuilderOpen"
	| "setConfirmDeleteOpen"
	| "setDashboardId"
	| "setDashboardName"
	| "setError"
	| "setGenerating"
	| "setLive"
	| "setLoading"
	| "setNameDialog"
	| "setReloadKey"
	| "setWidgets"
	| "target"
	| "viewMode"
	| "widgets"
> &
	Pick<ReturnType<typeof useHomeWidgetActions>, "handleRefresh">;

/** Widget creation, AI starter generation, and dashboard select/rename/delete. */
export function useHomeDashboardActions({
	canvasCenterRef,
	dashboardId,
	dashboards,
	handleRefresh,
	nameDialog,
	publishDashboardChanged,
	refreshList,
	reload,
	setBuilderOpen,
	setConfirmDeleteOpen,
	setDashboardId,
	setDashboardName,
	setError,
	setGenerating,
	setLive,
	setLoading,
	setNameDialog,
	setReloadKey,
	setWidgets,
	target,
	viewMode,
	widgets,
}: HomeDashboardActionsInput) {
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
					? findCanvasRect(
							widgets,
							canvasCenterRef.current,
							input.canvas?.w ?? DEFAULT_NODE_W,
							input.canvas?.h ?? DEFAULT_NODE_H
						)
					: input.canvas;
			try {
				const widget = await createWidget(target, dashboardId, {
					...input,
					layout,
					canvas,
				});
				setWidgets((p) => [...p, widget]);
				publishDashboardChanged();
				handleRefresh(widget.id);
			} catch {
				toast.error("Couldn't add widget", {
					description: "Check your connection and try again.",
				});
				reload(dashboardId);
			}
		},
		[
			dashboardId,
			target,
			widgets,
			handleRefresh,
			publishDashboardChanged,
			reload,
			viewMode,
		]
	);
	// Open the AI builder and hand the assistant a starter prompt so the model
	// authors the dashboard — the one-click "generate one for me" path. The
	// prompt is queued only once the dashboard surface is the active takeover
	// (see below); queued earlier, an already-open assistant would send it as
	// plain chat without the builder's tools.
	const [starterPending, setStarterPending] = useState(false);
	const handleGenerateWithAi = useCallback(() => {
		setGenerating(true);
		setBuilderOpen(true);
		setStarterPending(true);
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
				publishDashboardChanged();
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
			publishDashboardChanged();
			const list = await refreshList();
			const fallback = list.find((d) => d.id !== dashboardId) ?? list[0];
			handleSelectDashboard(fallback.id);
		} catch {
			toast.error("Couldn't delete dashboard", {
				description: "Check your connection and try again.",
			});
		} finally {
			setConfirmDeleteOpen(false);
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
	return {
		handleCreateWidget,
		handleDeleteCurrent,
		handleGenerateWithAi,
		handleRetry,
		handleSelectDashboard,
		handleSubmitName,
		resolveDashboardId,
		setStarterPending,
		starterPending,
	};
}
