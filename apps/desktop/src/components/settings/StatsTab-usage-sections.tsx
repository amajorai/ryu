// The Activity, Lifetime and Most used sections of the Stats settings tab.

import {
	PlugSocketIcon,
	Robot01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ContributionDay,
	ContributionsGraph,
} from "@ryu/ui/components/contributions-graph.tsx";
import {
	ActivityArea,
	FeatureMixBar,
	RankedList,
	TransportDonut,
} from "@ryu/ui/components/profile-charts.tsx";
import type { ReactNode } from "react";
import type { ProfileStats, UsageDay } from "@/src/lib/api/profile.ts";
import { formatCost, formatNumber } from "./StatsTab-format.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export interface StatsUsageSectionsProps {
	agentHours: number;
	costMicroUsd: number;
	heatmapData: ContributionDay[];
	insights: ProfileStats["insights"] | undefined;
	requestCount: number;
	stats: ProfileStats | undefined;
	totalTokens: number;
	usageDays: UsageDay[];
}

/**
 * One lifetime figure, flat: a muted label over a tabular value and an optional
 * muted note. Settings never box their stats in cards or tint their icons.
 */
function LifetimeStat({
	sub,
	title,
	value,
}: {
	sub?: ReactNode;
	title: string;
	value: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<p className="text-detail text-muted-foreground">
				<span>{title}</span>
			</p>
			<span
				className="truncate font-medium text-xl tabular-nums"
				title={typeof value === "string" ? value : undefined}
			>
				{value}
			</span>
			{sub ? (
				<span className="truncate text-muted-foreground text-xs">{sub}</span>
			) : null}
		</div>
	);
}

/** The Activity, Lifetime and Most used sections of the Stats tab. */
export function StatsUsageSections({
	agentHours,
	costMicroUsd,
	heatmapData,
	insights,
	requestCount,
	stats,
	totalTokens,
	usageDays,
}: StatsUsageSectionsProps) {
	return (
		<>
			<SettingsSection
				caption="Your activity over the last year."
				title="Activity"
			>
				<SettingsCard>
					<ContributionsGraph data={heatmapData} title="Daily activity" />
				</SettingsCard>
				<SettingsCard>
					<span className="font-medium text-sm">Last 30 days</span>
					<ActivityArea data={usageDays} days={30} formatCount={formatNumber} />
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Lifetime">
				<div className="grid grid-cols-2 gap-6 py-3 sm:grid-cols-4">
					<LifetimeStat
						sub="input + output"
						title="Total tokens"
						value={formatNumber(totalTokens)}
					/>
					<LifetimeStat
						sub="agent runtime"
						title="Agent hours"
						value={agentHours.toFixed(1)}
					/>
					<LifetimeStat title="Total spend" value={formatCost(costMicroUsd)} />
					<LifetimeStat title="Requests" value={formatNumber(requestCount)} />
				</div>

				<div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
					<SettingsCard>
						<span className="font-medium text-sm">
							Where your usage comes from
						</span>
						<TransportDonut
							formatCount={formatNumber}
							transport={
								stats?.insights.transport ?? {
									acp: 0,
									gateway: 0,
									openAiCompat: 0,
									other: 0,
								}
							}
						/>
					</SettingsCard>
					<SettingsCard>
						<span className="font-medium text-sm">Usage by feature</span>
						<FeatureMixBar
							featureTotals={
								stats?.byFeatureTotals ?? {
									agentSeconds: 0,
									chat: 0,
									island: 0,
									predictAccepted: 0,
								}
							}
						/>
					</SettingsCard>
				</div>

				<div className="mt-3 grid grid-cols-2 gap-6 py-3 sm:grid-cols-4">
					<LifetimeStat
						title="Active days"
						value={formatNumber(insights?.activeDays ?? 0)}
					/>
					<LifetimeStat
						sub={insights?.peakDay?.day ?? "none yet"}
						title="Peak day"
						value={formatNumber(insights?.peakDay?.tokens ?? 0)}
					/>
					<LifetimeStat
						sub="best effort"
						title="Peak hour"
						value={
							insights?.peakHourUtc ? `${insights.peakHourUtc}:00 UTC` : "—"
						}
					/>
					<LifetimeStat
						title="Favourite model"
						value={insights?.favoriteModel ?? "—"}
					/>
				</div>
			</SettingsSection>

			<SettingsSection title="Most used">
				<div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
					<RankedList
						empty="No model usage recorded yet."
						formatCount={formatNumber}
						icon={<HugeiconsIcon className="size-4" icon={Robot01Icon} />}
						items={insights?.topModels ?? []}
						title="Models"
					/>
					<RankedList
						empty="No skill usage recorded yet."
						formatCount={formatNumber}
						icon={<HugeiconsIcon className="size-4" icon={SparklesIcon} />}
						items={insights?.topSkills ?? []}
						title="Skills"
					/>
					<RankedList
						empty="No plugin usage recorded yet."
						formatCount={formatNumber}
						icon={<HugeiconsIcon className="size-4" icon={PlugSocketIcon} />}
						items={insights?.topPlugins ?? []}
						title="Plugins"
					/>
				</div>
			</SettingsSection>
		</>
	);
}
