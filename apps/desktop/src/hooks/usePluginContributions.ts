// Data-driven bridge between Core's enabled-plugin contributions
// (`GET /api/plugins/contributions`) and the desktop shell. Two hooks:
//
//   - `usePluginContributions()` — the shared, react-query-cached read of every
//     enabled plugin's declarative contributions (companions, slash commands, …).
//     Multiple callers share one fetch via the stable query key.
//   - `usePluginContributionRoutes()` — the side-effecting half: registers a
//     navigable route per contributed **companion** into the singleton
//     `contributionRegistry` so `RouteOutlet` can render it. Call this ONCE from a
//     component that is always mounted (LayoutContent), never the palette.
//
// Nothing is hardcoded per-plugin: routes are minted purely from the API payload.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, useEffect, useState } from "react";
import { HelloDeclarativeViewHarness } from "@/src/components/views/DeclarativeView.tsx";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	getPluginContributions,
	type PluginContributions,
} from "@/src/lib/api/plugins.ts";
import { useRealtimeRoom } from "@/src/lib/realtime/use-realtime-room.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";
import PluginViewPage from "@/src/pages/PluginViewPage.tsx";

/** Stable empty payload so a missing/old Core (or an in-flight fetch) yields an
 *  identical reference every render — keeps the registration effect from looping. */
const EMPTY: PluginContributions = {
	composer_controls: [],
	settings_tabs: [],
	slash_commands: [],
	turn_hooks: [],
	views: [],
	sidebar_sections: [],
	sidebar_buttons: [],
	channels: [],
	companions: [],
};

/** The route path a contributed companion surface is navigable at. The companion
 *  id (`app__<runnable id>`) is a single opaque segment; encode it so any exotic
 *  character is round-tripped safely. */
export function pluginCompanionPath(companionId: string): string {
	return `/plugin/${encodeURIComponent(companionId)}`;
}

/** The route path a contributed **declarative view** (the Raycast tier) is navigable
 *  at. The view id is scoped by its owning plugin so two apps can reuse an id. */
export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugin-view/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
}

/** The dev/storybook harness route rendering the shared `hello list-detail` example
 *  with the desktop renderer — the desktop half of the "one spec, two renderers" proof. */
export const DECLARATIVE_VIEW_HARNESS_PATH = "/dev/declarative-view";

/** Shared, cached read of the enabled plugins' declarative contributions. */
export function usePluginContributions(): PluginContributions {
	const node = useActiveNode();
	const { data } = useQuery({
		queryKey: ["plugin-contributions", node.url, node.token],
		queryFn: () =>
			getPluginContributions({ url: node.url, token: node.token ?? null }),
		// Best-effort surface: a stale window avoids hammering Core, and any error
		// simply leaves `data` undefined → the stable EMPTY payload below. `retry`
		// is off so an older Core lacking this endpoint fails once, quietly, rather
		// than retrying three times per mount.
		staleTime: 30_000,
		retry: false,
	});
	return data ?? EMPTY;
}

/** The realtime room Core broadcasts plugin-lifecycle invalidations on (enable /
 *  disable / grants change). Local (loopback) shells get write access via the
 *  unknown-room grant; a remote client's join is refused and it simply keeps the
 *  existing stale-window poll — the subscription is a pure fast path. */
const PLUGINS_ROOM = "system:plugins";

/**
 * Live refresh for {@link usePluginContributions}: subscribe to Core's
 * `system:plugins` room and invalidate the shared `plugin-contributions` query
 * the moment a plugin is enabled/disabled or its grants change, instead of
 * waiting out the 30s stale window. Call ONCE from a component that is always
 * mounted (LayoutContent). Fail-soft by design: if the join is refused (remote
 * node) or the socket drops, the poll path is untouched.
 */
export function usePluginContributionsLiveRefresh(): void {
	const queryClient = useQueryClient();
	// Prefix invalidation (the full key is ["plugin-contributions", url, token])
	// so a node switch mid-flight can't strand a stale cache entry.
	useRealtimeRoom(PLUGINS_ROOM, "conversation", {
		onEvent: (data: unknown) => {
			const type =
				typeof data === "object" && data !== null
					? (data as { type?: unknown }).type
					: undefined;
			if (type === "contributions_changed") {
				queryClient.invalidateQueries({
					queryKey: ["plugin-contributions"],
				});
			}
		},
	});
}

/** Register a route per contributed companion into the contribution registry, so
 *  an enabled plugin's companion surface is reachable and renders through the same
 *  `RouteOutlet` path built-ins use. Idempotent per companion id; tears down on
 *  unmount or when the companion set changes. */
export function usePluginContributionRoutes(): void {
	const { companions, views } = usePluginContributions();
	// After registering, bump this so the always-mounted host re-renders once and
	// `RouteOutlet` re-resolves — otherwise a tab already parked on a `/plugin/<id>`
	// path (e.g. restored on startup, before the fetch resolved) would have matched
	// `null` and never recovered once the route finally appeared.
	const [, forceReresolve] = useState(0);

	// The dev harness route is static (no plugin needed): register it once so the
	// desktop renderer is always reachable + verifiable at `/dev/declarative-view`.
	useEffect(() => {
		const dispose = contributionRegistry.registerRoute({
			kind: "exact",
			path: DECLARATIVE_VIEW_HARNESS_PATH,
			render: () => createElement(HelloDeclarativeViewHarness),
		});
		return dispose;
	}, []);

	useEffect(() => {
		if (companions.length === 0 && views.length === 0) {
			return;
		}
		const disposers = [
			...companions.map((c) =>
				contributionRegistry.registerRoute({
					kind: "exact",
					path: pluginCompanionPath(c.id),
					render: () =>
						createElement(PluginCompanionPage, { companionId: c.id }),
				})
			),
			// One route per contributed declarative view, rendered natively by the
			// desktop `DeclarativeView` (via `PluginViewPage`). Scoped by owning plugin.
			...views
				.filter((v) => typeof v.plugin === "string" && v.plugin.length > 0)
				.map((v) =>
					contributionRegistry.registerRoute({
						kind: "exact",
						path: pluginViewPath(v.plugin as string, v.id),
						render: () =>
							createElement(PluginViewPage, {
								pluginId: v.plugin as string,
								viewId: v.id,
							}),
					})
				),
		];
		forceReresolve((n) => n + 1);
		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	}, [companions, views]);
}
