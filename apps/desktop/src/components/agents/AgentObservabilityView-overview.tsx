import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	formatCost,
	formatNumber,
	formatPercent,
	formatScore,
	type ObservabilitySummary,
	type ObservabilityWindow,
	windowLabel,
} from "./AgentObservabilityView-audit.ts";
import { SummaryCard } from "./AgentObservabilityView-cards.tsx";

export interface ObservabilityOverviewSectionProps {
	error: string | null;
	loading: boolean;
	onPrune: () => void;
	onRefresh: () => void;
	/** Raw failure of the last retention pass, copied but never shown. */
	pruneError: string | null;
	pruneMessage: string | null;
	pruning: boolean;
	reachable: boolean | null;
	summary: ObservabilitySummary;
	timeRange: ObservabilityWindow;
}

export function ObservabilityOverviewSection({
	error,
	loading,
	onPrune,
	onRefresh,
	pruneError,
	pruneMessage,
	pruning,
	reachable,
	summary,
	timeRange,
}: ObservabilityOverviewSectionProps) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Audit and traces stay on this node unless you opt into export."
			headerAction={
				<div className="flex items-center gap-1">
					<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<span
							aria-hidden="true"
							className={cn(
								"size-1.5 rounded-full",
								error || reachable === false
									? "bg-status-destructive"
									: "bg-status-success"
							)}
						/>
						{error || reachable === false ? "Unavailable" : "Live · 15s"}
					</span>
					<Button
						aria-label="Refresh observability"
						loading={loading}
						onClick={onRefresh}
						size="icon-sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					</Button>
					<Button
						disabled={pruning || reachable === false}
						loading={pruning}
						onClick={onPrune}
						size="sm"
						variant="ghost-muted"
					>
						Prune local audit
					</Button>
				</div>
			}
			title="Agent observability"
		>
			<SettingsCard className="flex flex-col gap-4">
				{pruneMessage ? (
					<p className="text-muted-foreground text-xs" role="status">
						{pruneMessage}
					</p>
				) : null}
				{pruneError ? (
					<InlineErrorRow
						details={pruneError}
						message="The retention pass failed."
						onRetry={reachable === false ? undefined : onPrune}
					/>
				) : null}

				{error ? (
					<InlineErrorRow
						details={error}
						message="Observability data could not be loaded."
						onRetry={onRefresh}
					/>
				) : reachable === false ? (
					<p className="text-detail text-muted-foreground">
						Gateway audit is unavailable until the Gateway or audit store
						returns.
					</p>
				) : null}

				<div
					className="flex flex-col gap-4"
					data-testid="observability-summary"
				>
					<div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
						<SummaryCard
							label="Requests"
							value={formatNumber(summary.totalRequests)}
						/>
						<SummaryCard
							label="Errors"
							tone={
								summary.errorCount > 0 ? "text-status-destructive" : undefined
							}
							value={formatNumber(summary.errorCount)}
						/>
						<SummaryCard
							label="Avg latency"
							value={
								summary.averageLatencyMs === null
									? "—"
									: `${Math.round(summary.averageLatencyMs)}ms`
							}
						/>
						<SummaryCard
							label="Spend"
							value={formatCost(summary.costMicroUsd)}
						/>
						<SummaryCard
							label="Quality"
							value={formatScore(summary.qualityScore)}
						/>
						<SummaryCard
							label="Tokens"
							value={formatNumber(
								summary.totalInputTokens + summary.totalOutputTokens
							)}
						/>
						<SummaryCard
							detail={tl("{hit} hit · {miss} miss", {
								hit: formatNumber(summary.promptCacheHitRequests),
								miss: formatNumber(summary.promptCacheMissRequests),
							})}
							label="Prompt cache"
							value={formatPercent(summary.promptCacheHitRate)}
						/>
						<SummaryCard label="Window" value={windowLabel(timeRange)} />
					</div>
					<details className="group">
						<summary className="w-fit cursor-pointer text-detail text-muted-foreground hover:text-foreground">
							Cache tokens
						</summary>
						<div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
							<SummaryCard
								label="Cache read"
								value={
									summary.promptCacheReadTokens === null
										? "—"
										: formatNumber(summary.promptCacheReadTokens)
								}
							/>
							<SummaryCard
								label="Cache write"
								value={
									summary.promptCacheWriteTokens === null
										? "—"
										: formatNumber(summary.promptCacheWriteTokens)
								}
							/>
							<SummaryCard
								label="Cache hits"
								value={
									summary.totalCacheReadTokens === null
										? "—"
										: formatNumber(summary.totalCacheReadTokens)
								}
							/>
							<SummaryCard
								label="Cache writes"
								value={
									summary.totalCacheWriteTokens === null
										? "—"
										: formatNumber(summary.totalCacheWriteTokens)
								}
							/>
							<SummaryCard
								label="Cache misses"
								value={
									summary.totalCacheMissTokens === null
										? "—"
										: formatNumber(summary.totalCacheMissTokens)
								}
							/>
						</div>
					</details>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}
