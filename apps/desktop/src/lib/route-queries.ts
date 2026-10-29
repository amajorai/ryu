// Query definitions shared by a page and its route preload.
//
// A hover prefetch only turns into a cache hit when it uses the exact key and
// fetcher the page later reads, so both sides build their query from these
// factories instead of writing the key inline. Each takes the node it should
// read from; the preload passes the default active node, which is what a newly
// opened tab resolves to.

import { queryOptions } from "@tanstack/react-query";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { listDownloadHistory } from "@/src/lib/api/downloads.ts";
import {
	getDraftsSettings,
	listDrafts,
	listSentDrafts,
} from "@/src/lib/api/drafts.ts";
import { getWeeklyReview } from "@/src/lib/api/shadow.ts";
import {
	listVaultSecrets,
	type VaultListFilter,
	vaultQueryString,
} from "@/src/lib/api/vault.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** How many sent drafts the history shows. Enough to answer "did the thing I
 *  queued last night actually go out", not an archive browser. */
export const DRAFTS_HISTORY_LIMIT = 25;
/** The Review page's default window, in days. */
export const REVIEW_DEFAULT_DAYS = 7;

export const downloadsHistoryQuery = (target: ApiTarget) =>
	queryOptions({
		queryKey: ["downloads", "history", target.url],
		queryFn: () => listDownloadHistory(target),
	});

export const draftsListQuery = (target: ApiTarget) =>
	queryOptions({
		queryKey: ["drafts-list", target.url],
		queryFn: () => listDrafts(target),
	});

export const draftsSentQuery = (target: ApiTarget) =>
	queryOptions({
		queryKey: ["drafts-sent", target.url],
		queryFn: () => listSentDrafts(target, DRAFTS_HISTORY_LIMIT),
	});

export const draftsSettingsQuery = (target: ApiTarget) =>
	queryOptions({
		queryKey: ["drafts-settings", target.url],
		queryFn: () => getDraftsSettings(target),
	});

export const weeklyReviewQuery = (days: number) =>
	queryOptions({
		queryKey: ["shadow-weekly-review", days],
		queryFn: ({ signal }) => getWeeklyReview(days, signal),
	});

/** The key carries the filter's query string, so the unfiltered preload and
 *  the page's first (unfiltered) read share one cache entry. */
export const vaultSecretsQuery = (
	target: ApiTarget,
	filter: VaultListFilter = {}
) =>
	queryOptions({
		queryKey: [
			"vault",
			"secrets",
			target.url,
			vaultQueryString({
				environment: filter.environment,
				path: filter.path,
				recursive: filter.recursive,
				includeDeleted: filter.includeDeleted || undefined,
			}),
		] as const,
		queryFn: () => listVaultSecrets(target, filter),
	});

/** The node a freshly opened tab talks to. */
function defaultTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

/** Warm a route's queries against the default node. Fresh cache entries are
 *  left alone (prefetchQuery respects staleTime) and prefetchQuery never
 *  rejects, so a hover stays silent; the page reports errors when it renders. */
export function prefetchRouteQueries(
	build: (target: ApiTarget) => Parameters<typeof Promise.all>[0]
) {
	return Promise.all(build(defaultTarget()));
}
