// apps/desktop/src/components/store/ContributedStoreSection-localize.ts
//
// A contributed Store tab's copy arrives in English: the tab title and
// subtitle and the spec's empty state, group labels, install and action labels
// from the owning app's manifest, plus the catalog rows its backend serves
// (Meetings note styles, Social post templates, …). The extractor catalogs
// that copy, so each value renders through the active locale's catalog;
// anything uncatalogued (user-made rows, brand names) comes back as is.

import type {
	StoreCatalogItem,
	StoreTabSpec,
	ViewAction,
} from "@ryu/app-host/views";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { manifestCopy, optionalManifestCopy } from "@/src/lib/manifest-copy.ts";

/** The tab's title and subtitle in the active locale. */
export function localizeStoreTab(
	tl: LiteralMessage,
	tab: PluginStoreTab
): PluginStoreTab {
	return {
		...tab,
		subtitle: optionalManifestCopy(tl, tab.subtitle),
		title: manifestCopy(tl, tab.title),
	};
}

function localizeAction(tl: LiteralMessage, action: ViewAction): ViewAction {
	return {
		...action,
		confirm: optionalManifestCopy(tl, action.confirm),
		label: manifestCopy(tl, action.label),
	};
}

/** The spec's display copy in the active locale; requests stay untouched. */
export function localizeStoreSpec(
	tl: LiteralMessage,
	spec: StoreTabSpec | undefined
): StoreTabSpec | undefined {
	if (!spec) {
		return spec;
	}
	const graph = spec.detail?.graph;
	return {
		...spec,
		detail:
			spec.detail && graph
				? {
						...spec.detail,
						graph: { ...graph, title: optionalManifestCopy(tl, graph.title) },
					}
				: spec.detail,
		empty: spec.empty && {
			description: optionalManifestCopy(tl, spec.empty.description),
			title: optionalManifestCopy(tl, spec.empty.title),
		},
		groups: spec.groups?.map((group) => ({
			...group,
			label: manifestCopy(tl, group.label),
		})),
		install: spec.install && {
			...spec.install,
			label: optionalManifestCopy(tl, spec.install.label),
			successMessage: optionalManifestCopy(tl, spec.install.successMessage),
		},
		itemActions: spec.itemActions?.map((action) => localizeAction(tl, action)),
		searchPlaceholder: optionalManifestCopy(tl, spec.searchPlaceholder),
	};
}

/** A catalog row's card title and description in the active locale. */
export function localizeStoreItem(
	tl: LiteralMessage,
	item: StoreCatalogItem
): StoreCatalogItem {
	return {
		...item,
		description: optionalManifestCopy(tl, item.description),
		title: manifestCopy(tl, item.title),
	};
}
