import { RealtimeConnection } from "@ryuhq/core-client/realtime.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WidgetLiveState } from "@/src/components/dashboard/DashboardGrid.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { realtimeJwtForTarget } from "@/src/lib/api/client.ts";
import {
	createDashboard,
	type Dashboard,
	type DashboardViewMode,
	getCatalog,
	getDashboard,
	listDashboards,
	type Widget,
} from "@/src/lib/api/dashboard.ts";
import { bootstrappedNodes, seedStarterWidgets } from "./HomePage.presets.ts";

/** Dashboard list, widget loading, realtime refresh, and builder/dialog state. */
export function useHomeDashboardData() {
	const activeNode = useActiveNode();
	const target = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token]
	);
	const dashboardRealtimeRef = useRef<RealtimeConnection | null>(null);
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
	const [reloadKey, setReloadKey] = useState(0);
	// "Build with AI" mode: while on, the global Ask Ryu assistant is this
	// dashboard's builder (see `useAssistantSurface` below). There is no second
	// chat pane on Home.
	const [builderOpen, setBuilderOpen] = useState(false);
	// True while an AI "generate" turn is in flight, so the empty area shows an
	// "assembling…" state instead of the call-to-action.
	const [generating, setGenerating] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	// Armed when the user picks "Delete" so we can confirm before wiping a
	// dashboard (and all of its widgets).
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const [coreEndpoints, setCoreEndpoints] = useState<string[]>([]);
	const [sourceTypes, setSourceTypes] = useState<string[]>(["static"]);
	// Name dialog state, shared by "New dashboard" (create) and "Rename".
	const [nameDialog, setNameDialog] = useState<{
		mode: "create" | "rename";
		value: string;
	} | null>(null);
	// Fetch the catalog once so the Add-widget picker offers the live endpoint list.
	useEffect(() => {
		let active = true;
		setSourceTypes(["static"]);
		getCatalog(target)
			.then((c) => {
				if (!active) {
					return;
				}
				setCoreEndpoints(c.core_endpoints);
				setSourceTypes(
					Array.isArray(c.source_types) ? c.source_types : ["static"]
				);
			})
			.catch(() => {
				// A missing catalog leaves only the host-independent static source.
			});
		return () => {
			active = false;
		};
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
		// `reloadKey` is load-bearing: `handleRetry`'s no-dashboard-selected branch
		// only bumps it, so dropping it leaves that retry on a permanent spinner.
	}, [refreshList, reloadKey]);
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
	useEffect(() => {
		if (!dashboardId) {
			return;
		}
		let cancelled = false;
		let connection: RealtimeConnection | null = null;
		void realtimeJwtForTarget(target).then((jwt) => {
			if (cancelled) {
				return;
			}
			connection = new RealtimeConnection(target, {
				appId: "@ryu/dashboards",
				handlers: {
					onNamedEvent: ({ name }) => {
						if (name === "resource.changed") {
							void reload(dashboardId);
						}
					},
					onResyncRequired: () => {
						void reload(dashboardId);
					},
				},
				jwt,
				kind: "application",
				roomId: dashboardId,
			});
			dashboardRealtimeRef.current = connection;
			connection.connect();
		});
		return () => {
			cancelled = true;
			dashboardRealtimeRef.current = null;
			connection?.close();
		};
	}, [dashboardId, reload, target]);
	const publishDashboardChanged = useCallback(() => {
		dashboardRealtimeRef.current?.sendEvent("resource.changed", null);
	}, []);
	return {
		addOpen,
		builderOpen,
		canvasCenterRef,
		confirmDeleteOpen,
		coreEndpoints,
		dashboardId,
		dashboardName,
		dashboards,
		error,
		generating,
		live,
		loading,
		nameDialog,
		publishDashboardChanged,
		refreshList,
		reload,
		setAddOpen,
		setBuilderOpen,
		setConfirmDeleteOpen,
		setDashboardId,
		setDashboardName,
		setDashboards,
		setError,
		setGenerating,
		setLive,
		setLoading,
		setNameDialog,
		setReloadKey,
		setViewMode,
		setWidgets,
		sourceTypes,
		target,
		viewMode,
		widgets,
	};
}
