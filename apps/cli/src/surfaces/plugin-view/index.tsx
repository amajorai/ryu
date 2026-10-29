/* @jsxImportSource @opentui/react */
// The GENERIC surface for a plugin-contributed declarative view (path
// /plugin-view/<plugin>/<viewId>) — the terminal's counterpart to the desktop's
// `PluginViewPage` route mint. Every view an enabled plugin contributes is reachable
// here without the shell knowing a single app id: the path carries the owning
// plugin + view id, the contributions feed supplies the spec, and
// src/ui/ContributedView.tsx renders it and executes its actions.
//
// This is the surface the command palette links to, so a newly enabled app's views
// show up as navigable destinations the moment Core reports them.

import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useContributions } from "../../core/ContributionsContext.tsx";
import { parsePluginViewPath } from "../../core/contributions.ts";
import { tf } from "../../i18n/translate.ts";
import { ContributedViewPanel } from "../../ui/ContributedView.tsx";
import { Loading } from "../../ui/Loading.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

/** Resolve this instance's tab path (this pane's active tab) so the plugin/view ids
 *  can be read off the route the shell opened (the Store surface precedent). */
function pathForPane(
	panes: { activeTabId: string | null; id: string }[],
	tabs: { id: string; path: string }[],
	paneId: string
): string {
	const pane = panes.find((p) => p.id === paneId);
	const tab = tabs.find((t) => t.id === pane?.activeTabId);
	return tab?.path ?? "";
}

function PluginViewSurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { panes, tabs, focusedPaneId } = useWorkspace();
	const { views, loading } = useContributions();
	const focused = active && focusedPaneId === paneId;

	const route = parsePluginViewPath(pathForPane(panes, tabs, paneId));
	const view = views.find(
		(candidate) =>
			candidate.plugin === route?.plugin && candidate.id === route?.view
	);

	const header = (
		<box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1}>
			<text fg={theme.colors.foreground}>
				<b>{view?.title ?? route?.view ?? "App view"}</b>
			</text>
			{route ? (
				<text fg={theme.colors.mutedForeground}>{route.plugin}</text>
			) : null}
		</box>
	);

	return (
		<box flexDirection="column" flexGrow={1} paddingTop={1}>
			{header}
			<box flexDirection="column" paddingLeft={1}>
				<PluginViewBody
					focused={focused}
					loading={loading}
					view={view}
					viewId={route?.view}
				/>
			</box>
		</box>
	);
}

/** Body states: still fetching the feed, the view is gone (app disabled/removed),
 *  or the contributed view itself. Split out so the surface stays a thin frame. */
function PluginViewBody({
	focused,
	loading,
	view,
	viewId,
}: {
	focused: boolean;
	loading: boolean;
	view: ReturnType<typeof useContributions>["views"][number] | undefined;
	viewId: string | undefined;
}) {
	const theme = useTheme();
	if (view) {
		return <ContributedViewPanel focused={focused} view={view} />;
	}
	if (loading) {
		return <Loading label="Loading contributions…" />;
	}
	return (
		<text fg={theme.colors.mutedForeground}>
			{viewId
				? tf('No enabled app contributes the view "{viewId}".', { viewId })
				: "No view selected."}
		</text>
	);
}

/** The generic contributed-view surface (path /plugin-view/<plugin>/<viewId>). */
export const pluginViewSurface: SurfaceModule = {
	id: "plugin-view",
	title: "App view",
	match: (path) => path.startsWith("/plugin-view/"),
	Component: PluginViewSurface,
};
