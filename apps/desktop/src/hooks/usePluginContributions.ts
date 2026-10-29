import { z } from "zod";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
// Data-driven bridge between Core's enabled-plugin contributions
// (`GET /api/plugins/contributions`) and the desktop shell. Three hooks:
//
//   - `usePluginContributions()` — the shared, react-query-cached read of every
//     enabled plugin's declarative contributions (companions, slash commands, …).
//     Multiple callers share one fetch via the stable query key.
//   - `usePluginContributionRoutes()` — the side-effecting half: registers a
//     navigable route per contributed **companion** into the singleton
//     `contributionRegistry` so `RouteOutlet` can render it. Call this ONCE from a
//     component that is always mounted (LayoutContent), never the palette.
//   - `usePluginContributionTabIcons()` — seeds the title-bar tab-icon registry
//     from companion / sidebar_section / sidebar_button `icon` fields so tabs
//     inherit the same Iconify/Hugeicons glyph the sidebar shows.
//
// Nothing is hardcoded per-plugin: routes and tab icons are minted purely from
// the API payload.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, lazy, useCallback, useEffect, useState } from "react";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import {
	registerTabIcon,
	ruleFromItemTarget,
} from "@/src/contributions/tab-icon-registry.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getPluginContributions,
	type PluginContributions,
} from "@/src/lib/api/plugins.ts";
import {
	ENFORCE_CUSTOM_APP_CSP_PREF_KEY,
	subscribePreferenceChanges,
} from "@/src/lib/api/preferences.ts";
import { useRealtimeRoom } from "@/src/lib/realtime/use-realtime-room.ts";

// The route bodies load when a plugin route first opens (RouteOutlet suspends
// on them), not with every surface that reads contributions, such as the
// avatar provider.
const PluginCompanionPage = lazy(
	() => import("@/src/pages/PluginCompanionPage.tsx")
);
const PluginViewPage = lazy(() => import("@/src/pages/PluginViewPage.tsx"));
const HelloDeclarativeViewHarness = lazy(() =>
	import("@/src/components/views/DeclarativeView.tsx").then((module) => ({
		default: module.HelloDeclarativeViewHarness,
	}))
);

/** Stable empty payload so a missing/old Core (or an in-flight fetch) yields an
 *  identical reference every render — keeps the registration effect from looping. */
const EMPTY: PluginContributions = {
	agent_edit_panels: [],
	agent_profile_tabs: [],
	avatar_accessories: [],
	avatar_styles: [],
	composer_controls: [],
	chat_features: [],
	computer_use_planners: [],
	backgrounds: [],
	settings_tabs: [],
	message_actions: [],
	selection_actions: [],
	output_styles: [],
	context_menu_items: [],
	create_actions: [],
	slash_commands: [],
	turn_hooks: [],
	hook_events: [],
	interfaces: [],
	views: [],
	sidebar_sections: [],
	sidebar_modes: [],
	sidebar_buttons: [],
	themes: [],
	dock_panels: [],
	file_handlers: [],
	live_activities: [],
	store_tabs: [],
	channels: [],
	companions: [],
	widget_apps: [],
};
const PLUGIN_CONTRIBUTION_DATA_PROPS: "data"[] = ["data"];

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

/** The dock-tab key a contributed workspace panel is identified by. Namespaced by the
 *  owning plugin (mirroring the Rust `DockPanelContribution` doc) so two apps may reuse
 *  a panel id, and prefixed so it can never collide with a built-in tab kind. */
export function pluginDockPanelKey(pluginId: string, panelId: string): string {
	return `plugin:${pluginId}:${panelId}`;
}

/** The dev/storybook harness route rendering the shared `hello list-detail` example
 *  with the desktop renderer — the desktop half of the "one spec, two renderers" proof. */
export const DECLARATIVE_VIEW_HARNESS_PATH = "/dev/declarative-view";

/**
 * The raw shared query behind {@link usePluginContributions}.
 *
 * Exposed for the one class of consumer that must tell "Core says there are none"
 * apart from "the fetch has not landed yet" — anything that MIRRORS the payload
 * into durable storage, where treating the in-flight EMPTY as authoritative would
 * evict real data on every cold start. Readers that only render what they are given
 * want `usePluginContributions()` instead.
 */
export function usePluginContributionsQuery(options?: {
	notifyOnChangeProps?: "data"[];
	target?: ApiTarget;
}) {
	const node = useActiveNode();
	const target = options?.target ?? {
		url: node.url,
		token: node.token,
		userJwt: node.userJwt ?? null,
	};
	const fetchContributions = useCallback(
		({ signal }: { signal: AbortSignal }) =>
			getPluginContributions(target, signal),
		[target.url, target.token, target.userJwt]
	);
	return useQuery({
		queryKey: [
			"plugin-contributions",
			target.url,
			target.token,
			target.userJwt,
		],
		queryFn: fetchContributions,
		// Best-effort surface: a stale window avoids hammering Core, and any error
		// simply leaves `data` undefined → the stable EMPTY payload below. `retry`
		// is off so an older Core lacking this endpoint fails once, quietly, rather
		// than retrying three times per mount.
		staleTime: 30_000,
		retry: false,
		notifyOnChangeProps: options?.notifyOnChangeProps,
	});
}

/** Shared, cached read of the enabled plugins' declarative contributions. */
export function usePluginContributions(
	target?: ApiTarget
): PluginContributions {
	// These consumers only read the payload. Suppress query status notifications
	// (`isFetching` during a stale-window refresh) so a background plugin refresh
	// cannot rebuild every sidebar/command consumer; payload identity still wakes
	// them when a plugin actually changes.
	const { data } = usePluginContributionsQuery({
		notifyOnChangeProps: PLUGIN_CONTRIBUTION_DATA_PROPS,
		target,
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
	useEffect(
		() =>
			subscribePreferenceChanges((key) => {
				if (key === ENFORCE_CUSTOM_APP_CSP_PREF_KEY) {
					queryClient.invalidateQueries({
						queryKey: ["plugin-contributions"],
					});
				}
			}),
		[queryClient]
	);
	// Prefix invalidation (the full key is ["plugin-contributions", url, token, userJwt])
	// so a node switch mid-flight can't strand a stale cache entry.
	useRealtimeRoom(PLUGINS_ROOM, "conversation", {
		onEvent: (data: Parameters<typeof contributionChangeSchema.parse>[0]) => {
			const changed = contributionChangeSchema.safeParse(data);
			if (changed.success) {
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
					render: (tab) =>
						createElement(PluginCompanionPage, {
							companionId: c.id,
							mountContext: tab.mountContext,
						}),
				})
			),
			// One route per contributed declarative view, rendered natively by the
			// desktop `DeclarativeView` (via `PluginViewPage`). Scoped by owning plugin.
			...views.flatMap((v) => {
				const pluginId = v.plugin;
				if (!pluginId) {
					return [];
				}
				return [
					contributionRegistry.registerRoute({
						kind: "exact",
						path: pluginViewPath(pluginId, v.id),
						render: () =>
							createElement(PluginViewPage, { pluginId, viewId: v.id }),
					}),
				];
			}),
		];
		forceReresolve((n) => n + 1);
		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	}, [companions, views]);
}

/**
 * Seed the title-bar tab-icon registry from enabled plugin contributions so
 * companions / sidebar sections / sidebar buttons paint their declared Iconify
 * (or Hugeicons) glyph on tabs without each app calling `shell.registerTabIcon`.
 * Call ONCE from Layout alongside {@link usePluginContributionRoutes}.
 */
export function usePluginContributionTabIcons(): void {
	const { companions, sidebar_sections, sidebar_buttons } =
		usePluginContributions();

	useEffect(() => {
		const disposers: (() => void)[] = [];

		for (const companion of companions) {
			if (!companion.icon) {
				continue;
			}
			disposers.push(
				registerTabIcon({
					id: `contrib:companion:${companion.id}`,
					pathPrefix: pluginCompanionPath(companion.id),
					icon: companion.icon,
					priority: 15,
				})
			);
		}

		for (const section of sidebar_sections) {
			if (!(section.icon && pluginSidebarSpec(section)?.itemTarget)) {
				continue;
			}
			const rule = ruleFromItemTarget(
				pluginSidebarSpec(section)?.itemTarget ?? "",
				section.icon,
				`contrib:section:${section.plugin}:${section.id}`
			);
			if (rule) {
				disposers.push(registerTabIcon(rule));
			}
		}

		for (const button of sidebar_buttons) {
			if (!(button.icon && button.target?.startsWith("/"))) {
				continue;
			}
			disposers.push(
				registerTabIcon({
					id: `contrib:button:${button.plugin}:${button.id}`,
					pathPrefix: button.target.split("?")[0] ?? button.target,
					icon: button.icon,
					priority: 15,
				})
			);
		}

		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	}, [companions, sidebar_sections, sidebar_buttons]);
}

const contributionChangeSchema = z.object({
	type: z.literal("contributions_changed"),
});
