// Routes for shell pages an APP owns.
//
// `builtins.ts` registers the shell's own pages at paths the shell decides. A
// handful of pages are different: the page component ships in the shell (it is not a
// sandboxed companion — there is no `ui/` bundle to mount), but the FEATURE belongs
// to an app, which already declares where it wants to live via
// `contributes.sidebar_buttons[].target`. The Home dashboard is the first of them:
// `HomePage` renders the widget grid, while the store, the refresh loop and the
// `/api/dashboards/*` surface all live in `@ryu/dashboards`' sidecar.
//
// Registering those in `builtins.ts` froze two things that are the app's to decide:
//   - the PATH ("/home"), so moving the page meant editing shell code;
//   - the EXISTENCE of the route, so a disabled/never-installed app still had a live
//     route while its sidebar button was already correctly hidden (the app is
//     not pre-installed — see `plugins::builtins`' CORE_PREINSTALLED note).
//
// Here both come from the live contributions feed instead: the table below names an
// app id + button id (never a path, mirroring `WHITEBOARD_PLUGIN_ID`), and the route
// is minted at whatever target that button currently declares — and torn down when
// the app is disabled.
//
// A disabled app still gets ONE route: `AppDisabledNotice` at the page's cold-start
// path, so the "On startup → the Home page" preference (which seeds that path before
// any feed exists) lands on a card with a working Enable button rather than the
// actionless "App not enabled" prose the catch-all would give. Same recovery
// `SpacesPage` shows for Core's `503 app_disabled`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { createElement, type ReactNode, useEffect, useState } from "react";
import { AppDisabledNotice } from "@/src/components/AppDisabledNotice.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import {
	DRAFTS_BUTTON_ID,
	DRAFTS_DEFAULT_PATH,
	DRAFTS_PLUGIN_ID,
} from "@/src/lib/api/drafts.ts";
import {
	MISSION_CONTROL_BUTTON_ID,
	MISSION_CONTROL_DEFAULT_PATH,
	MISSION_CONTROL_PLUGIN_ID,
} from "@/src/lib/api/mission-control.ts";
import {
	DASHBOARD_DEFAULT_PATH,
	DASHBOARDS_HOME_BUTTON_ID,
	DASHBOARDS_PLUGIN_ID,
} from "@/src/lib/dashboards/app.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import {
	draftsListQuery,
	draftsSentQuery,
	draftsSettingsQuery,
	prefetchRouteQueries,
} from "@/src/lib/route-queries.ts";
import {
	WHATSAPP_BUTTON_ID,
	WHATSAPP_DEFAULT_PATH,
	WHATSAPP_PLUGIN_ID,
} from "@/src/lib/whatsapp-app.ts";
import { resolveAppShellPath } from "./app-shell-path.ts";
import { lazyRoute } from "./lazy-route.ts";
import { contributionRegistry, type RoutePreload } from "./registry.ts";

const ChannelsPage = lazyRoute(() => import("@/src/pages/ChannelsPage.tsx"));
const DraftsPage = lazyRoute(() => import("@/src/pages/DraftsPage.tsx"));
const HomePage = lazyRoute(() => import("@/src/pages/HomePage.tsx"));
const MissionControlPage = lazyRoute(
	() => import("@/src/pages/MissionControlPage.tsx")
);

/** A shell page whose route an app declares. */
export interface AppShellPage {
	/** The `sidebar_buttons[].id` whose `target` the page mounts at. */
	button: string;
	/** The path the manifest currently declares, used ONLY to place the
	 *  enable-this-app card while the app contributes nothing. Never used to mount the
	 *  page itself — that path always comes from the live feed. */
	fallbackPath: string;
	/** The owning app's display name, for the disabled card's message. */
	label: string;
	/** The owning app's manifest id. */
	plugin: string;
	/** Fetches the page's chunk ahead of a click (hover/focus prefetch). */
	preload: RoutePreload;
	/** The shell component to render there. */
	render: () => ReactNode;
}

/** The enable-this-app card, worded as one translatable sentence. */
function AppShellDisabledNotice({
	app,
	label,
}: {
	app: string;
	label: string;
}) {
	const tl = useLiteralMessages();
	return createElement(AppDisabledNotice, {
		app,
		message: tl("Enable the {label} app", { label }),
	});
}

/**
 * Every shell page an app owns. Deliberately tiny and explicit: a page only belongs
 * here when the shell ships the component but an app owns the feature. Anything with
 * a companion bundle is already handled by `usePluginContributionRoutes`, and
 * anything the shell owns outright belongs in `builtins.ts`.
 */
const APP_SHELL_PAGES: readonly AppShellPage[] = [
	{
		plugin: DASHBOARDS_PLUGIN_ID,
		button: DASHBOARDS_HOME_BUTTON_ID,
		fallbackPath: DASHBOARD_DEFAULT_PATH,
		label: "Dashboards",
		preload: HomePage.preload,
		render: () => createElement(HomePage),
	},
	{
		plugin: MISSION_CONTROL_PLUGIN_ID,
		button: MISSION_CONTROL_BUTTON_ID,
		fallbackPath: MISSION_CONTROL_DEFAULT_PATH,
		label: "Mission Control",
		preload: MissionControlPage.preload,
		render: () => createElement(MissionControlPage),
	},
	{
		plugin: DRAFTS_PLUGIN_ID,
		button: DRAFTS_BUTTON_ID,
		fallbackPath: DRAFTS_DEFAULT_PATH,
		label: "Drafts",
		preload: () =>
			Promise.all([
				DraftsPage.preload(),
				prefetchRouteQueries((target) => [
					queryClient.prefetchQuery(draftsListQuery(target)),
					queryClient.prefetchQuery(draftsSentQuery(target)),
					queryClient.prefetchQuery(draftsSettingsQuery(target)),
				]),
			]).then<void>(() => undefined),
		render: () => createElement(DraftsPage),
	},
	{
		plugin: WHATSAPP_PLUGIN_ID,
		button: WHATSAPP_BUTTON_ID,
		fallbackPath: WHATSAPP_DEFAULT_PATH,
		label: "WhatsApp",
		preload: ChannelsPage.preload,
		render: () =>
			createElement(ChannelsPage, {
				initialChannelType: "whatsapp",
				initialNew: true,
			}),
	},
];

/**
 * React the app-owned shell routes to the live feed. Call ONCE from a component that
 * is always mounted (LayoutContent), alongside `usePluginContributionRoutes`.
 */
export function useAppShellRoutes(): void {
	const { sidebar_buttons: buttons } = usePluginContributions();
	// Same reason as `usePluginContributionRoutes`: a tab already parked on the path
	// (restored on startup, before the fetch resolved) matched nothing and would
	// never recover once the route finally appeared.
	const [, forceReresolve] = useState(0);

	useEffect(() => {
		const disposers: (() => void)[] = [];
		for (const page of APP_SHELL_PAGES) {
			const path = resolveAppShellPath(buttons, page.plugin, page.button);
			disposers.push(
				contributionRegistry.registerRoute({
					kind: "exact",
					path: path ?? page.fallbackPath,
					preload: path ? page.preload : undefined,
					// No declaration → the app is disabled (or not installed): offer the
					// one-click Enable instead of the page. Registered at the cold-start
					// path only, so an app that MOVED itself keeps a single live route.
					render: path
						? page.render
						: () =>
								createElement(AppShellDisabledNotice, {
									app: page.plugin,
									label: page.label,
								}),
				})
			);
		}
		if (disposers.length > 0) {
			forceReresolve((n) => n + 1);
		}
		return () => {
			for (const dispose of disposers) {
				dispose();
			}
		};
	}, [buttons]);
}

/**
 * The live path for one app-owned shell page, or `null` when no enabled app claims
 * it. For the surfaces that must decide whether to OFFER the destination at all — a
 * hotkey, a menu row — rather than render it.
 */
export function useAppShellPath(plugin: string, button: string): string | null {
	const { sidebar_buttons: buttons } = usePluginContributions();
	return resolveAppShellPath(buttons, plugin, button);
}
