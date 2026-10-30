// Seeds every built-in desktop page into the contribution registry, reproducing
// the exact routes (and first-match precedence) of the old `TabContent` if-else
// in `Layout.tsx`. This is the behavior-preserving half of #446: Layout renders
// via `RouteOutlet` (which calls `contributionRegistry.resolve`), so this file is
// the single place built-in routes are declared, and a plugin appends to the same
// registry instead of editing `Layout.tsx`.
//
// This module is the EXACT mirror of `Layout.tsx`'s former `TabContent`: every
// branch below maps one branch there, in the same exact-then-pattern order. The
// old chain interleaved exact and pattern branches, but every pattern is
// `$`-anchored and requires a deeper path segment than its exact sibling
// (`/agents` vs `/agents/.+/edit`, `/workflows` vs `/workflows/.+`, `/spaces` vs
// `/spaces/:id`, `/library` vs `/library/:section`, `/meetings` vs
// `/meetings/:id`), so no path matches both. Exacts therefore go in the O(1) map
// (checked first) and patterns in an ordered list — behavior-identical to the
// interleaved chain, only relative pattern order matters (and is preserved here).
//
// Deliberately NOT registered here (all are wired elsewhere so this stays a pure
// behavior-preserving mirror of the old chain):
//   - `/plugin/<id>` — registered per enabled companion by
//     `usePluginContributionRoutes`, so a disabled plugin's route disappears
//     (resolves null → blank) exactly as #446 item 4 wants.
//   - The Home dashboard — registered by `useAppShellRoutes` at whatever path
//     `@ryu/dashboards` declares in `contributes.sidebar_buttons[].target`. The
//     component is a shell page (no companion bundle), but the feature is the app's,
//     so the app decides both the path AND whether the route exists at all. It used
//     to be a frozen `exact("/home", …)` here: the sidebar button was already
//     app-registered and correctly hid itself when the (not pre-installed) app was
//     disabled, while the route stayed live — the exact disagreement
//     `companion-alias.ts` exists to prevent. See `app-shell-routes.ts`.
//   - `/profile`: the account profile and stats live in the App Settings dialog
//     (Profile / Stats tabs), and the user menu's "Profile" opens the public web
//     profile. `/graph` + `/spaces/:id/graph` (the knowledge graph) ARE registered
//     below: the Space doc editor's "Graph" button already opened the per-space path,
//     which used to resolve to blank. (`/skills/new` + `/skills/:id/edit` ARE also
//     handled below — the W7 frontend extraction landed the SKILL.md editor as the
//     @ryu/skill-editor companion; both previously resolved to blank.)
//
// No COMPANION ID is named here. This file used to carry twelve hardcoded aliases of the
// shape `createElement(PluginCompanionPage, { companionId: "app__<x>-companion" })`
// (activity, approvals/inbox, calendar, learning, mail, meetings, monitors, quests,
// skill-editor, timeline, webhooks, workflows). They duplicated the
// `usePluginContributionRoutes` seam AND kept resolving after their app was disabled
// — a companion id baked into shell code cannot know the app is gone. They are
// replaced by `CompanionAliasRoute` below: one generic catch-all that looks the
// companion up in the LIVE contributions feed, so an app that is not enabled
// contributes no companion, matches nothing, and its short path renders blank
// exactly as the seam intends. See `resolveCompanionAlias` for the lookup order.
//
// NOTE (PR-1 wiring): `seedBuiltinRoutes()` is called once at `Layout.tsx` module
// load (before first render) so the registry is populated before `RouteOutlet`
// resolves. Kept as JSX-free `createElement` calls so the file is `.ts` (no
// `.tsx`) and carries no JSX-runtime assumptions.
// The retained Chat, Library and Store surfaces stay in the entry chunk for fast
// first navigation. Long-tail editors, settings and secondary pages below are
// lazy components; `RouteOutlet` owns the shared loading boundary.

//
// The table itself is split by area under `./builtins/`: the Store, Library and
// Memory slice, the shell's exact and pattern routes, the lazy page components,
// the path patterns, and the shared companion-alias and chat crash-boundary
// elements. This file keeps the registration order.

import { companionAlias } from "./builtins/companion-routes.ts";
import { COMPANION_ALIAS } from "./builtins/route-patterns.ts";
import { registerShellExactRoutes } from "./builtins/shell-exact-routes.ts";
import {
	registerChatPatternRoutes,
	registerShellPatternRoutes,
} from "./builtins/shell-pattern-routes.ts";
import {
	registerLibraryPatternRoutes,
	registerStoreLibraryExactRoutes,
	registerStorePatternRoutes,
} from "./builtins/store-library-routes.ts";
import {
	contributionRegistry,
	type RoutePreload,
	type RouteRender,
} from "./registry.ts";

let seeded = false;

/** Register all built-in routes exactly once. Idempotent. */
// one-time flat registration of the built-in route table, mirroring the old tab router branch-for-branch.
export function seedBuiltinRoutes(): void {
	if (seeded) {
		return;
	}
	seeded = true;

	// `preload` is passed for lazy pages so a hovered sidebar/palette link can
	// fetch the chunk before the click (see `lazy-route.ts`).
	const exact = (path: string, render: RouteRender, preload?: RoutePreload) =>
		contributionRegistry.registerRoute({
			kind: "exact",
			path,
			preload,
			render,
		});

	// ── Exact routes (matched first via the O(1) map) ─────────────────────────
	// No Home/dashboard route here — see the note above about app-owned shell
	// pages: `@ryu/dashboards` declares its own path and `useAppShellRoutes`
	// mints it from the feed.
	registerShellExactRoutes(exact);
	registerStoreLibraryExactRoutes(exact);

	// ── Pattern routes (ordered; each `$`-anchored regex uses [^/]+ per segment,
	// so deeper paths only match their own pattern — relative order among them is
	// preserved to mirror the old chain exactly) ─
	const pattern = (
		test: RegExp | { startsWith: string },
		render: RouteRender,
		preload?: RoutePreload
	) =>
		contributionRegistry.registerRoute({
			kind: "pattern",
			preload,
			test,
			render,
		});

	registerStorePatternRoutes(pattern);
	registerChatPatternRoutes(pattern);
	registerLibraryPatternRoutes(pattern);
	registerShellPatternRoutes(pattern);
	// The legacy short paths (`/calendar`, `/timeline`, `/inbox`, `/mail`, …), minted
	// from the contributions feed instead of a hardcoded table — registered LAST so
	// every shell route above still wins, and so this only ever sees paths that used
	// to fall through to blank. An app that is disabled contributes no companion, so
	// its short path resolves to nothing exactly as the `/plugin/<id>` seam intends.
	pattern(COMPANION_ALIAS, (tab) => companionAlias(tab.path));
}
