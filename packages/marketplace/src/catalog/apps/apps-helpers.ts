import { isUnstableRelease } from "../stability.ts";
import type { AppCatalogItem, CatalogEntry } from "../types.ts";
import { CommunityShelf } from "./community-shelf.tsx";

/** Which slice of the plugin catalog a section instance browses. An "app" claims a
 *  UI DESTINATION — somewhere the user navigates TO that does not exist while the
 *  item is uninstalled: a companion window, a workspace dock tab, or a top-level
 *  route. A "plugin" is everything else — it only modifies surfaces that already
 *  exist (tools/agents/channels/policies, turn hooks, capability providers, settings
 *  tabs, sidebar sections). "all" = the historical unsplit tab, which web still uses.
 *
 *  Notably NOT app-ness: shipping a sidecar (the five `document.parse` providers each
 *  ship one and nobody opens Docling), living under `apps-store/` (that is a
 *  PACKAGING root — items published as their own satellite repo), or declaring a
 *  `category`. The rule is adjudicated server-side by `manifest_declares_destination`
 *  (apps/core/src/server/mod.rs) and arrives here as {@link CatalogEntry.type}.
 *
 *  There is no "community" variant any more. Community listings are not a
 *  different KIND of thing — they are apps and plugins that nobody at Ryu
 *  reviewed — so a whole tab for them split the catalog by provenance and asked
 *  the user to visit two places to answer one question ("is there a Ryu plugin
 *  for X?"). They are now a trailing, clearly-labelled shelf inside these same
 *  tabs; see {@link CommunityShelf}. */
export type AppsCatalogVariant = "apps" | "plugins" | "all";

/** True when a catalog entry is an "app" — i.e. it claims a UI destination (see
 *  {@link AppsCatalogVariant}).
 *
 *  The `type` discriminator is AUTHORITATIVE and the rule lives in exactly one
 *  place: Core's `manifest_declares_destination`, which reads the three keys that
 *  mint a destination (a `companion` runnable, `contributes.dock_panels` in any
 *  panel mode, or a top-level `contributes.sidebar_buttons[].target`). Do not
 *  re-derive it here — a second copy is how Browser/Simulator/CRM/UGC and
 *  Dashboards/Drafts/Mission Control ended up in a different tab than their `type`
 *  said they were in.
 *
 *  The `kinds` fallback is for OLDER WIRES ONLY (a Core that predates the `type`
 *  key). It is deliberately still the narrow companion test rather than the full
 *  rule, because it cannot be anything else: the catalog entry carries `kinds`, but
 *  the projector never puts `dock_panels` or `sidebar_buttons` on it
 *  (`project_manifest`'s allowlist emits `apiSurface`, not the shell contributions),
 *  so the three-key rule is not expressible from entry data. A stale Core therefore
 *  under-reports apps; it never mis-reports one.
 *
 *  Exported for unit tests (the detail-panel helpers below run only inside the
 *  Dialog-portaled preview, which `renderToStaticMarkup` cannot emit). */
export function isCompanionApp(item: AppCatalogItem): boolean {
	if (item.entry.type) {
		return item.entry.type === "app";
	}
	return item.entry.kinds.includes("companion");
}

/** True when a listing was discovered from a public GitHub topic rather than
 *  published to a first-party catalog — i.e. nobody at Ryu reviewed it.
 *
 *  Keys on the snake_case `origin` the Core projector stamps (see
 *  `plugin_marketplace_item_to_entry`); `reviewed === false` is accepted as a
 *  secondary signal so a source that stamps only the trust flag still gets the
 *  notice. Absent/null ⇒ first-party: deliberately fail-safe in that direction so
 *  an older wire never gains a scary label, which makes the notice opt-in from the
 *  producer. Exported for unit tests. */
export function isCommunityEntry(item: AppCatalogItem): boolean {
	return item.entry.origin === "community" || item.entry.reviewed === false;
}

/**
 * The URL a community listing installs from — its repository.
 *
 * Community rows cannot be installed BY ID: Core keeps unreviewed listings out
 * of the first-party catalog, so the catalog install path has nothing to resolve.
 * They install through the same `installFromUrl` request the store's own
 * "Install from URL" field makes, which is why this returns a URL rather than
 * calling anything — the caller pairs it with the host's install layer.
 *
 * `null` when Core stamped no repository on the row, in which case the card
 * keeps its browse-only affordance rather than offering an install that cannot
 * run. Exported for unit tests.
 */
export function communityInstallUrl(item: AppCatalogItem): string | null {
	const url = item.entry.repo_url?.trim();
	return url ? url : null;
}

/**
 * Collapse repeat listings of the same id, keeping the FIRST occurrence.
 *
 * The all-marketplaces view (`?source=all`) is a concatenation of every source's
 * page, so one app published to two marketplaces — or present both as a built-in
 * and as a remote listing — arrives twice. Two copies of one listing is bad
 * enough on its own; worse, the copies need not agree about what they ARE, and a
 * pair that disagrees about `type` lands one row in Apps and the other in
 * Plugins. That is how the same app comes to appear in both tabs at once.
 *
 * First occurrence wins because Core emits the unified first-party view ahead of
 * the federated sources, so the copy that survives is the one Ryu itself
 * publishes — the same precedence `merged_plugin_catalog_entries` applies
 * server-side. Order is otherwise preserved: it is meaningful here.
 *
 * Exported for unit tests.
 */
export function dedupeById(items: readonly AppCatalogItem[]): AppCatalogItem[] {
	const seen = new Set<string>();
	const out: AppCatalogItem[] = [];
	for (const item of items) {
		if (seen.has(item.entry.id)) {
			continue;
		}
		seen.add(item.entry.id);
		out.push(item);
	}
	return out;
}

/** Apply the Marketplace's stable-only default to an already scoped list. */
export function filterAppsByStability(
	items: readonly AppCatalogItem[],
	showUnstable: boolean
): AppCatalogItem[] {
	return showUnstable
		? [...items]
		: items.filter((item) => !isUnstableRelease(item.entry.stability));
}

/** Shared predicate for the Marketplace tag filter and its focused tests. */
export function matchesCatalogTag(
	item: AppCatalogItem,
	selectedTag: string | null
): boolean {
	return selectedTag === null || item.entry.tags.includes(selectedTag);
}

/** One marketplace's slice of the all-marketplaces list. */
export interface CatalogSourceSection {
	id: string;
	items: AppCatalogItem[];
	label: string;
}

/**
 * Group listings by the marketplace they came from, preserving the order Core
 * emitted them in — that order is meaningful (the unified first-party view first,
 * then the federated sources), so it is kept rather than re-sorted alphabetically.
 *
 * Rows with no stamp are folded into a single trailing bucket instead of being
 * dropped: a source Core could not name is still a real listing the user can
 * install, and silently hiding it would be a worse failure than an unlabelled
 * heading. Exported for unit tests.
 */
export function groupByCatalogSource(
	items: readonly AppCatalogItem[]
): CatalogSourceSection[] {
	const sections = new Map<string, CatalogSourceSection>();
	for (const item of items) {
		const id = item.entry.catalog_source_id ?? "";
		const existing = sections.get(id);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		sections.set(id, {
			id,
			label: item.entry.catalog_source_name ?? "Other marketplaces",
			items: [item],
		});
	}
	return [...sections.values()];
}

/** One community marketplace's slice of the community feed, for the
 *  "Community Marketplaces" section — see {@link groupCommunityMarketplaces}. */
export interface CommunityMarketplaceSection {
	id: string;
	items: AppCatalogItem[];
	name: string;
}

/**
 * Group community listings into marketplaces, splitting out the standalone ones.
 *
 * A community MARKETPLACE entry carries a grouping stamp (`catalog_source_id` /
 * `catalog_source_name` — the `ryu-marketplace` repo it was discovered from), so
 * it renders under its marketplace's sub-heading inside the "Community
 * Marketplaces" section. A standalone topic-discovered repo carries no stamp and
 * keeps the flat "From the community" shelf. Exported for unit tests.
 */
export function groupCommunityMarketplaces(items: readonly AppCatalogItem[]) {
	const marketplaces = new Map<string, CommunityMarketplaceSection>();
	const standalone: AppCatalogItem[] = [];
	for (const item of items) {
		const id = item.entry.catalog_source_id;
		const name = item.entry.catalog_source_name;
		if (!(id && name)) {
			standalone.push(item);
			continue;
		}
		const existing = marketplaces.get(id);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		marketplaces.set(id, { id, name, items: [item] });
	}
	return { marketplaces: [...marketplaces.values()], standalone };
}

export const VARIANT_COPY = {
	apps: {
		noun: "app",
		nounPlural: "apps",
		searchPlaceholder: "Search apps…",
	},
	plugins: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
	all: {
		noun: "plugin",
		nounPlural: "plugins",
		searchPlaceholder: "Search plugins…",
	},
} satisfies Record<
	AppsCatalogVariant,
	{ noun: string; nounPlural: string; searchPlaceholder: string }
>;
