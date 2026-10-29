// apps/desktop/src/pages/UsagePage.tsx
//
// Container for the Usage settings tab. Mirrors `CreditsPage.tsx`: this file
// loads and maps, `@ryu/blocks/desktop/usage` renders. The split is what lets
// `apps/storyboard` show the same surface with mock data.

import { UsageView } from "@ryu/blocks/desktop/usage.tsx";
import type {
	UsageAnalyticsData,
	UsageDateRange,
	UsageGranularity,
	UsageScope,
} from "@ryu/blocks/desktop/usage-analytics.ts";
import { usagePresetRange } from "@ryu/blocks/desktop/usage-range-days.ts";
import { PlanBadge } from "@ryu/ui/components/plan-badge.tsx";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { SubscriptionUsageDashboard } from "@/src/components/usage/SubscriptionUsageDashboard.tsx";
import { UsageHistoryDashboard } from "@/src/components/usage/UsageHistoryDashboard.tsx";
import { useLlmProviders } from "@/src/hooks/useLlmProviders.ts";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";
import { useSubscriptionCostUsage } from "@/src/hooks/useSubscriptionCostUsage.ts";
import { useSubscriptionUsage } from "@/src/hooks/useSubscriptionUsage.ts";
import { useUsageStatement } from "@/src/hooks/useUsageStatement.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useActiveOrgId } from "@/src/lib/api/orgs.ts";
import { fetchUsageAnalytics } from "@/src/lib/api/usage-analytics.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

// The dashboard opens on the last 30 civil days in the display time zone,
// today included, the same range its "30 days" preset picks.
function initialRange(): UsageDateRange {
	return usagePresetRange(30);
}

function errorMessageFor<TError>(error: TError): string {
	return error instanceof Error
		? error.message
		: "Unable to load usage analytics.";
}

/**
 * The organization these credits belong to, as one grouped settings row. Not
 * the bordered `OrgBillingContext` banner: inside the Settings pane that read as
 * a box above the cards instead of one of them.
 */
function BillingOrganizationSection({ caption }: { caption: string }) {
	const { organization, plan } = useOrgBillingStatus();
	return (
		<SettingsSection caption={caption} title="Billing organization">
			<SettingsGroup>
				<SettingsItem
					actions={<PlanBadge plan={plan} size="sm" />}
					// User-controlled text, passed as a node so the settings formatter
					// does not read braces in the name as placeholders.
					title={
						<span>{organization?.name ?? "No organization selected"}</span>
					}
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

export default function UsageTab() {
	const {
		entries,
		stats,
		loading,
		loadingMore,
		hasMore,
		error,
		loadMore,
		refresh,
	} = useUsageStatement();
	const {
		catalog: providerCatalog,
		error: providerCatalogError,
		loading: providerCatalogLoading,
		reload: reloadProviderCatalog,
	} = useLlmProviders();
	const subscriptionUsage = useSubscriptionUsage(providerCatalog);
	const activeOrgId = useActiveOrgId();
	const getActiveNode = useNodeStore((state) => state.getActiveNode);
	const defaultNode = useNodeStore((state) => state.defaultNode);
	const nodes = useNodeStore((state) => state.nodes);
	const autoSelectedNode = useNodeStore((state) => state.autoSelectedNode);
	const activeNode = useMemo(
		() => getActiveNode(),
		[autoSelectedNode, defaultNode, getActiveNode, nodes]
	);
	const activeNodeTarget = useMemo(
		() => ({
			...toTarget(activeNode),
			local: isLocalNode(activeNode),
			managed: activeNode.managed,
		}),
		[activeNode]
	);
	const subscriptionCostUsage = useSubscriptionCostUsage(activeNodeTarget);
	const [analyticsScope, setAnalyticsScope] =
		useState<UsageScope>("organization");
	const [analyticsGranularity, setAnalyticsGranularity] =
		useState<UsageGranularity>("daily");
	const [analyticsRange, setAnalyticsRange] =
		useState<UsageDateRange>(initialRange);
	const [analyticsProvider, setAnalyticsProvider] = useState<string | null>(
		null
	);
	const [analyticsModel, setAnalyticsModel] = useState<string | null>(null);
	const [analytics, setAnalytics] = useState<UsageAnalyticsData | null>(null);
	const [analyticsLoading, setAnalyticsLoading] = useState(true);
	const [analyticsError, setAnalyticsError] = useState<string | null>(null);
	const [providerOptions, setProviderOptions] = useState<string[]>([]);
	const [modelOptions, setModelOptions] = useState<string[]>([]);
	const [analyticsRefreshNonce, setAnalyticsRefreshNonce] = useState(0);
	const analyticsNodeTarget =
		analyticsScope === "node" ? activeNodeTarget : null;
	const analyticsNodeUrl = analyticsNodeTarget?.url ?? null;
	const analyticsOrgId = analyticsScope === "organization" ? activeOrgId : null;

	useLayoutEffect(() => {
		setAnalytics(null);
		setAnalyticsProvider(null);
		setAnalyticsModel(null);
		setProviderOptions([]);
		setModelOptions([]);
	}, [analyticsNodeUrl, analyticsOrgId, analyticsScope]);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		setAnalyticsLoading(true);
		setAnalyticsError(null);
		setAnalytics(null);
		void fetchUsageAnalytics(
			{
				from: analyticsRange.from,
				granularity: analyticsGranularity,
				model: analyticsModel,
				provider: analyticsProvider,
				to: analyticsRange.to,
			},
			{
				activeNode: analyticsNodeTarget,
				activeOrgId: analyticsOrgId,
				scope: analyticsScope,
			},
			controller.signal
		)
			.then((next) => {
				if (cancelled) {
					return;
				}
				setAnalytics(next);
				setProviderOptions((previous) =>
					[...new Set([...previous, ...next.providerOptions])].sort()
				);
				setModelOptions((previous) =>
					[...new Set([...previous, ...next.modelOptions])].sort()
				);
			})
			.catch((error) => {
				if (!cancelled) {
					setAnalyticsError(errorMessageFor(error));
				}
			})
			.finally(() => {
				if (!cancelled) {
					setAnalyticsLoading(false);
				}
			});
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [
		analyticsNodeTarget,
		analyticsOrgId,
		analyticsGranularity,
		analyticsModel,
		analyticsProvider,
		analyticsRange,
		analyticsScope,
		analyticsRefreshNonce,
	]);

	const refreshAll = () => {
		refresh();
		reloadProviderCatalog();
		subscriptionUsage.refresh();
		subscriptionCostUsage.refresh();
		setAnalyticsRefreshNonce((nonce) => nonce + 1);
	};

	const rows = useMemo(
		() =>
			entries.map((entry) => ({
				id: entry.id,
				reason: entry.reason,
				// Formatted HERE, not in the block: the block is rendered by the
				// storyboard too, and the desktop's shared display contract belongs
				// at this host boundary so both consumers stay portable.
				createdAtLabel: formatDateTime(entry.createdAt),
				delta: entry.delta,
				isCredit: entry.delta > 0,
				balanceAfter: entry.balanceAfter,
				model: entry.model,
				provider: entry.provider,
				upstreamProvider: entry.upstreamProvider,
				inputTokens: entry.inputTokens,
				outputTokens: entry.outputTokens,
				durationMs: entry.durationMs,
				taskLabel: entry.taskLabel,
			})),
		[entries]
	);

	return (
		<div className="space-y-6">
			<BillingOrganizationSection caption="Credits stay scoped to the organization; usage analytics also include BYOK, self-hosted, and local traffic." />
			<UsageHistoryDashboard target={activeNodeTarget} />
			<SubscriptionUsageDashboard
				accounts={subscriptionUsage.accounts}
				catalogError={providerCatalogError}
				catalogLoading={providerCatalogLoading}
				costTrackingError={subscriptionCostUsage.trackingError}
				costTrackingUpdating={subscriptionCostUsage.trackingUpdating}
				costUsage={subscriptionCostUsage.usage}
				costUsageError={subscriptionCostUsage.error}
				costUsageLoading={subscriptionCostUsage.loading}
				onRefresh={refreshAll}
				onSetCostTracking={subscriptionCostUsage.setTrackingEnabled}
				refreshing={
					subscriptionUsage.refreshing || subscriptionCostUsage.refreshing
				}
			/>
			<UsageView
				analyticsDashboard={{
					analytics,
					failed: analyticsError !== null,
					granularity: analyticsGranularity,
					loading: analyticsLoading,
					model: analyticsModel,
					modelOptions,
					onGranularityChange: setAnalyticsGranularity,
					onModelChange: setAnalyticsModel,
					onProviderChange: setAnalyticsProvider,
					onRangeChange: setAnalyticsRange,
					onRefresh: refreshAll,
					onScopeChange: setAnalyticsScope,
					provider: analyticsProvider,
					providerOptions,
					range: analyticsRange,
					scope: analyticsScope,
				}}
				errorMessage={error?.message ?? analyticsError}
				hasMore={hasMore}
				loading={loading}
				loadingMore={loadingMore}
				onLoadMore={loadMore}
				onRefresh={refreshAll}
				rows={rows}
				summary={
					stats
						? {
								byModel: stats.byModel,
								byProvider: stats.byProvider,
								byReason: stats.byReason,
								spentMicroUsd: stats.spentMicroUsd,
								creditedMicroUsd: stats.creditedMicroUsd,
								inputTokens: stats.inputTokens,
								outputTokens: stats.outputTokens,
								durationMs: stats.durationMs,
								transactions: stats.transactions,
							}
						: null
				}
			/>
		</div>
	);
}
