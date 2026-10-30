import {
	type ConsentPluginCandidate,
	type PluginInstallRequest,
	pluginTrustTier,
} from "@ryu/blocks/desktop/agent-elements/tools/consent-tool.ts";
import { ALL_PLUGIN_SOURCES_ID } from "@ryu/marketplace/catalog/types";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchInstalledPortablePackages } from "@/src/lib/api/marketplace.ts";
import {
	type AppInfo,
	type CatalogEntry,
	fetchApps,
	searchPluginCatalog,
} from "@/src/lib/api/plugins.ts";
import {
	catalogInstallRefusal,
	portablePackageTarget,
} from "@/src/lib/catalog-entry-install.ts";

const SEARCH_LIMIT = 8;

function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The first https link a user can review the listing at: its repository,
 *  an integration descriptor's source, or its homepage. */
function reviewUrlFor(entry: CatalogEntry): string | null {
	const links = [
		entry.repo_url,
		entry.repository_url,
		entry.integration_url,
		entry.homepage,
	];
	return links.find((url) => url && /^https:\/\//i.test(url)) ?? null;
}

/** Core serves these two ids as one merged first-party catalog. */
const MERGED_FIRST_PARTY_SOURCES = new Set(["ryu-marketplace", "ryu-catalog"]);

function canonicalSourceId(id: string | null | undefined): string | null {
	if (!id) {
		return null;
	}
	return MERGED_FIRST_PARTY_SOURCES.has(id) ? "ryu-catalog" : id;
}

/** Map a catalog entry to the card's candidate. Trust comes from the entry's
 *  server-derived fields only. */
export function candidateFromEntry(
	entry: CatalogEntry,
	installed: ReadonlyMap<string, { enabled: boolean }>,
	requestedIds: ReadonlySet<string>,
	activeSourceId: string | null = null
): ConsentPluginCandidate {
	const record = installed.get(entry.id);
	const catalogInstallable = catalogInstallRefusal(entry) === null;
	// Core installs by id, trying the node's active marketplace first. A listing
	// browsed from another marketplace (stamped in the all-marketplaces view)
	// could resolve to a different same-id package, so it goes to the Store.
	const storeOnly =
		catalogInstallable &&
		Boolean(entry.catalog_source_id) &&
		canonicalSourceId(entry.catalog_source_id) !==
			canonicalSourceId(activeSourceId);
	return {
		author: entry.author ?? entry.developer ?? null,
		description: entry.tagline ?? entry.description ?? null,
		downloads: finiteOrNull(entry.downloads),
		enabled: record?.enabled ?? false,
		iconUrl: entry.icon_url ?? null,
		id: entry.id,
		installable: catalogInstallable && !storeOnly,
		installed: record !== undefined,
		name: entry.name,
		ratingAverage: finiteOrNull(entry.rating_average),
		ratingCount: finiteOrNull(entry.rating_count),
		requested: requestedIds.has(entry.id),
		reviewed: typeof entry.reviewed === "boolean" ? entry.reviewed : null,
		reviewUrl: reviewUrlFor(entry),
		stars: finiteOrNull(entry.stars),
		storeOnly,
		tier: pluginTrustTier(entry),
		version: entry.version || null,
	};
}
/**
 * Installed state for each entry, read the way the Store reads it: portable
 * packages from their own registry, everything else from `/api/apps`. A failed
 * read rejects, so the card shows an error instead of offering Install for a
 * plugin that is already there.
 */
export async function loadInstalledState(
	target: ApiTarget,
	entries: readonly CatalogEntry[]
): Promise<Map<string, { enabled: boolean }>> {
	const needsPortable = entries.some((entry) => portablePackageTarget(entry));
	const [apps, portable] = await Promise.all([
		fetchApps(target),
		needsPortable ? fetchInstalledPortablePackages(target) : [],
	]);
	const appState = new Map(
		apps
			.filter((app: AppInfo) => app.installed)
			.map((app) => [app.id, { enabled: app.enabled }] as const)
	);
	const portableState = new Map(
		portable.map((pkg) => [`${pkg.kind}:${pkg.id}`, { enabled: pkg.enabled }])
	);
	const installed = new Map<string, { enabled: boolean }>();
	for (const entry of entries) {
		const pkg = portablePackageTarget(entry);
		const state = pkg
			? portableState.get(`${pkg.kind}:${pkg.id}`)
			: appState.get(entry.id);
		if (state) {
			installed.set(entry.id, state);
		}
	}
	return installed;
}

/** How long the post-install "is it on?" read may take before the card
 *  falls back to asking the user to confirm in the Store. */
const ENABLED_CHECK_TIMEOUT_MS = 10_000;

export async function readEnabledBounded(
	target: ApiTarget,
	entry: CatalogEntry
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ENABLED_CHECK_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			loadInstalledState(target, [entry]).then(
				(state) => state.get(entry.id)?.enabled ?? false
			),
			timeout,
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Catalog entries matching the request: named ids, the reviewed catalog, and
 *  the community feed. A failed source contributes nothing rather than failing
 *  the card, unless every source failed. */
export async function searchEntries(
	target: ApiTarget,
	request: PluginInstallRequest
): Promise<CatalogEntry[]> {
	const searches: Promise<CatalogEntry[]>[] = [];
	// A named id may be a reviewed listing or a community one; the default view
	// leaves community listings out, so look in both.
	for (const id of request.pluginIds) {
		for (const origin of [undefined, "community"] as const) {
			searches.push(
				searchPluginCatalog(target, {
					limit: SEARCH_LIMIT,
					query: id,
					...(origin ? { origin } : { source: ALL_PLUGIN_SOURCES_ID }),
				}).then((page) => page.entries.filter((entry) => entry.id === id))
			);
		}
	}
	if (request.query) {
		const query = request.query;
		searches.push(
			// Every registered marketplace, the Store's default view.
			searchPluginCatalog(target, {
				limit: SEARCH_LIMIT,
				query,
				source: ALL_PLUGIN_SOURCES_ID,
			}).then((page) => page.entries),
			searchPluginCatalog(target, {
				limit: SEARCH_LIMIT,
				origin: "community",
				query,
			}).then((page) => page.entries)
		);
	}
	const settled = await Promise.allSettled(searches);
	const entries: CatalogEntry[] = [];
	let failure: unknown = null;
	let anySucceeded = false;
	for (const result of settled) {
		if (result.status === "fulfilled") {
			anySucceeded = true;
			entries.push(...result.value);
		} else {
			failure ??= result.reason;
		}
	}
	// Only a total failure is an error: one source answering "no matches" while
	// another is down is still a real, empty result.
	if (!anySucceeded && failure) {
		throw failure instanceof Error
			? failure
			: new Error("Couldn't search the plugin catalog.");
	}
	return entries;
}
