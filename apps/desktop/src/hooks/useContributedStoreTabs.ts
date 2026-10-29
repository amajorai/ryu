// apps/desktop/src/hooks/useContributedStoreTabs.ts
//
// App-registered Store sections (`contributes.store_tabs[]`) joined into the
// Store's own section list.
//
// The Store used to enumerate its sections in a closed union inside StorePage; an
// app that wanted a marketplace tab — workflow templates, meeting-notes templates,
// monitor presets — had no way in short of an edit to closed desktop source. This
// hook is the join: Core serves the declarations, this turns them into the same
// `StoreSectionTab` shape the nav bar already renders, and StorePage dispatches
// unknown section values to the generic renderer.
//
// Section VALUE convention is `plugin:<pluginId>:<tabId>`, matching
// `pluginDockPanelKey` — two apps may both ship a tab called `templates`.
// `resolveStoreSection` additionally accepts a BARE tab id so historic deep links
// (`/store/workflows`) keep working after the tab moves into a manifest.

import { useMemo } from "react";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { usePluginContributions } from "./usePluginContributions.ts";

/** Nav clusters the bar draws dividers between, in render order. A contributed tab
 *  naming a group outside this list joins `catalog` rather than being dropped —
 *  an unplaced pill is worse than a slightly-misplaced one. */
export const STORE_GROUP_ORDER = [
	"discover",
	"catalog",
	"community",
	"manage",
	"account",
] as const;

export type StoreGroup = (typeof STORE_GROUP_ORDER)[number];

/** The nav group a contributed tab joins. */
export function storeTabGroup(tab: PluginStoreTab): StoreGroup {
	return STORE_GROUP_ORDER.find((group) => group === tab.group) ?? "catalog";
}

/** The Store section value a contributed tab occupies. */
export function storeTabSectionValue(tab: PluginStoreTab): string {
	return `plugin:${tab.plugin}:${tab.id}`;
}

/**
 * Contributed store tabs the Store shows, sorted into a stable render order
 * within each group.
 *
 * **Only tabs whose owning app is installed AND enabled.** Core serves every
 * declaration regardless (see `Contributes::store_tabs`) so a surface *may* use
 * the tab as an acquisition funnel; the desktop deliberately does not. A pill
 * that exists whether or not you own the app is indistinguishable from a section
 * the shell hardcoded — it made "Workflows" and "Meeting Notes" look welded into
 * the Store, and clicking either got you a "Turn on X" prompt where a catalog
 * should be. Apps are installed from the Apps tab; a tab appears when its app
 * does, and disappears when the app is turned off.
 */
export function useContributedStoreTabs(): PluginStoreTab[] {
	const { store_tabs } = usePluginContributions();
	return useMemo(
		() =>
			store_tabs
				.filter((t) => t.app_installed && t.app_enabled)
				.sort(
					(a, b) =>
						(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
				),
		[store_tabs]
	);
}

/**
 * Resolve an incoming section string (a deep-link path segment, or a value from the
 * nav bar) to a real section value.
 *
 * Order matters: a built-in section wins over a contributed tab claiming the same
 * word, so a third-party manifest cannot hijack `apps` or `installed` by naming its
 * tab that. Then the namespaced value, then the bare tab id — which is what keeps
 * `/store/workflows` pointing at the Workflows tab now that it is app-registered.
 * Returns `null` when nothing matches, so the caller can fall back to Home.
 */
export function resolveStoreSection(
	raw: string,
	builtinValues: readonly string[],
	tabs: PluginStoreTab[]
): string | null {
	if (builtinValues.includes(raw)) {
		return raw;
	}
	const namespaced = tabs.find((t) => storeTabSectionValue(t) === raw);
	if (namespaced) {
		return storeTabSectionValue(namespaced);
	}
	const bare = tabs.find((t) => t.id === raw);
	return bare ? storeTabSectionValue(bare) : null;
}

/** Find the contributed tab a section value belongs to, or `null`. */
export function contributedTabForSection(
	section: string,
	tabs: PluginStoreTab[]
): PluginStoreTab | null {
	return tabs.find((t) => storeTabSectionValue(t) === section) ?? null;
}
