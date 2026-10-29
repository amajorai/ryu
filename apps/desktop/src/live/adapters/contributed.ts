import {
	pluginLiveActivity,
	pluginLiveSpec,
} from "@/src/lib/api/plugin-contribution-specs.ts";
import {
	type PluginValue,
	pluginValueSchema,
} from "@/src/lib/api/plugin-wire-values.ts";
// apps/desktop/src/live/adapters/contributed.ts
//
// Live-activity adapter for CONTRIBUTED activities (`contributes.live_activities`).
// For each enabled plugin's declared live activity, polls its `source` (a Core
// `/api/` path) through the host's authenticated seam and maps the response rows
// to live-activity cards via the shared `@ryu/app-host/live-activity` mappers.
// This is how an app exposes a live activity with ZERO sidecar code — the same
// relationship `DynamicSidebarSection` has to `sidebar_sections`.

import {
	actionForLiveActivity,
	type LiveActivity,
	liveActivitiesFromResponse,
} from "@ryu/app-host/live-activity";
import {
	type ContributionSourceRequest,
	contributionSourceRequest,
} from "@ryu/app-host/views";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import type { PluginLiveActivity } from "@/src/lib/api/plugins.ts";
import { useLiveActivityStore } from "@/src/store/useLiveActivityStore.ts";

const REFRESH_FLOOR_MS = 1000;

/** Map one contributed activity's source payload to cards (shared mapper). */
function mapContribution(
	contribution: PluginLiveActivity,
	payload: PluginValue,
	now: number
): LiveActivity[] {
	return liveActivitiesFromResponse(
		pluginLiveActivity(contribution),
		payload,
		now
	).map(({ activity, raw }) => ({
		...activity,
		action: actionForLiveActivity(pluginLiveActivity(contribution), raw),
	}));
}

/**
 * Poll every contributed live activity's `source` and reconcile its cards into
 * the live-activity store. One fetch per (node, path, method) via a shared query
 * key so sibling contributions reading the same endpoint share the payload —
 * the same caching `DynamicSidebarSection` uses. A dead node or a route gated
 * behind a disabled app answers non-2xx: that is an empty dock, not an error to
 * retry into.
 */
export function useContributedLiveActivities(): void {
	const node = useActiveNode();
	const { live_activities } = usePluginContributions();
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);

	const fetchable = useMemo(
		() =>
			live_activities.flatMap((contribution) => {
				const source = pluginLiveSpec(contribution)?.source;
				const sourceRequest = contributionSourceRequest(contribution, source);
				return source && sourceRequest
					? [{ contribution, source, sourceRequest }]
					: [];
			}),
		[live_activities]
	);

	const grouped = useMemo(() => {
		const sources: {
			key: string;
			request: ContributionSourceRequest;
			interval: number | false;
		}[] = [];
		const indexes = new Map<string, number>();
		const contributionIndexes = new Map<PluginLiveActivity, number>();
		for (const { contribution, source, sourceRequest } of fetchable) {
			const key = JSON.stringify([
				contribution.plugin ?? "",
				sourceRequest.path,
				sourceRequest.method,
			]);
			const interval = source.refreshMs
				? Math.max(source.refreshMs, REFRESH_FLOOR_MS)
				: false;
			let index = indexes.get(key);
			if (index === undefined) {
				index = sources.length;
				indexes.set(key, index);
				sources.push({ key, request: sourceRequest, interval });
			} else if (interval !== false) {
				const previous = sources[index].interval;
				sources[index].interval =
					previous === false ? interval : Math.min(previous, interval);
			}
			contributionIndexes.set(contribution, index);
		}
		return { sources, contributionIndexes };
	}, [fetchable]);
	const queryOptions = useMemo(
		() =>
			grouped.sources.map((source) => ({
				queryKey: [
					"contributed-live-activity-source",
					target.url,
					target.token ?? null,
					target.userJwt ?? null,
					source.key,
				],
				retry: false,
				queryFn: async ({ signal }: { signal: AbortSignal }) => {
					const controller = new AbortController();
					const abort = () => controller.abort(signal.reason);
					if (signal.aborted) {
						abort();
					} else {
						signal.addEventListener("abort", abort, { once: true });
					}
					try {
						const response = await fetch(apiUrl(target, source.request.path), {
							method: source.request.method,
							headers: await requestHeaders(target),
							signal: controller.signal,
						});
						return response.ok
							? pluginValueSchema.parse(await response.json())
							: null;
					} finally {
						signal.removeEventListener("abort", abort);
						controller.abort();
					}
				},
				refetchInterval: source.interval,
			})),
		[target, grouped.sources]
	);
	const queries = useQueries({ queries: queryOptions });
	const owned = useRef(new Map<string, { appId: string; kind: string }>());
	const mapped = useRef(
		new Map<
			string,
			{
				contribution: PluginLiveActivity;
				signature: string;
				payload: PluginValue;
				activities: LiveActivity[];
			}
		>()
	);
	useEffect(
		() => () => {
			for (const { appId, kind } of owned.current.values()) {
				useLiveActivityStore
					.getState()
					.applySourceSnapshot(appId, kind, [], `plugin:${appId}:${kind}:`);
			}
			owned.current.clear();
			mapped.current.clear();
		},
		[target.url, target.token, target.userJwt]
	);
	useEffect(() => {
		const next = new Map<string, { appId: string; kind: string }>();
		for (const { contribution } of fetchable) {
			const appId = contribution.plugin ?? "unknown";
			const kind = contribution.id;
			const owner = JSON.stringify([appId, kind]);
			next.set(owner, { appId, kind });
			const index = grouped.contributionIndexes.get(contribution);
			const payload =
				index === undefined ? null : (queries[index]?.data ?? null);
			let cached = mapped.current.get(owner);
			const signature =
				cached?.contribution === contribution
					? cached.signature
					: JSON.stringify(contribution);
			if (
				!cached ||
				cached.signature !== signature ||
				cached.payload !== payload
			) {
				cached = {
					contribution,
					signature,
					payload,
					activities: payload
						? mapContribution(contribution, payload, Date.now())
						: [],
				};
				mapped.current.set(owner, cached);
			} else {
				cached.contribution = contribution;
			}
			useLiveActivityStore
				.getState()
				.applySourceSnapshot(
					appId,
					kind,
					cached.activities,
					`plugin:${appId}:${kind}:`
				);
		}
		for (const [owner, { appId, kind }] of owned.current) {
			if (!next.has(owner)) {
				useLiveActivityStore
					.getState()
					.applySourceSnapshot(appId, kind, [], `plugin:${appId}:${kind}:`);
				mapped.current.delete(owner);
			}
		}
		owned.current = next;
	}, [fetchable, grouped, queries]);
}
