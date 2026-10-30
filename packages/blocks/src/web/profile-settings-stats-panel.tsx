"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge";
import { buttonVariants } from "@ryu/ui/components/button";
import {
	ContributionsGraph,
	StatCard,
	withActiveDays,
} from "@ryu/ui/components/contributions-graph";
import {
	ActivityArea,
	FeatureMixBar,
	RankedList,
	TransportDonut,
} from "@ryu/ui/components/profile-charts";
import { Spinner } from "@ryu/ui/components/spinner";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { USAGE_STREAK_HINT } from "@ryu/ui/lib/usage-streak.ts";
import {
	Activity,
	Bot,
	Coins,
	Cpu,
	Gauge,
	Network,
	Plug,
	Sparkles,
	Trophy,
	Zap,
} from "lucide-react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";
import { RowHint } from "./profile-settings-row-hint.tsx";
import {
	ChartCard,
	HeroStat,
	UnlockAction,
} from "./profile-settings-stats-cards.tsx";
import {
	formatCompact,
	formatCost,
	formatHourUtc,
	formatJoined,
	SECONDS_PER_HOUR,
	tierBadgeVariant,
	tierLabel,
} from "./profile-settings-stats-format.ts";
import type { ProfileStatsPanelProps } from "./profile-settings-types.ts";

// Stat tiles and ranked lists share the settings card surface (muted fill, no
// border or shadow) instead of the elevated profile-card look.
const STAT_TILE_CLASS = "rounded-lg bg-muted/40 shadow-none";
const RANKED_LIST_SURFACE_CLASS =
	"[&>div]:rounded-lg [&>div]:border-0 [&>div]:bg-muted/40";

/**
 * Presentational Stats panel: profile header, contributions heatmap, lifetime
 * stat tiles and the points-unlock list, plus the Ryu Wrapped share row. Pure —
 * the live page (apps/web) fetches `/me/*` and passes resolved data + the
 * point-spend callback; the storyboard can render it with static data.
 */
export function ProfileStatsPanel({
	activeDays,
	summary = null,
	usage = [],
	featureTotals,
	insights,
	catalog = [],
	unlockedKeys = [],
	pointsBalance,
	unlockingKey = null,
	onUnlockFeature,
	wrappedHref,
	isLoading = false,
	errorMessage = null,
}: ProfileStatsPanelProps) {
	const tl = useLiteralMessages();
	if (errorMessage) {
		return (
			<SettingsCard>
				<p className="py-4 text-center text-sm text-status-destructive">
					{errorMessage}
				</p>
			</SettingsCard>
		);
	}

	if (isLoading && !summary) {
		return (
			<SettingsCard className="flex items-center justify-center py-10">
				<Spinner className="size-5" />
			</SettingsCard>
		);
	}

	const totals = summary?.totals;
	const totalTokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);
	const agentHours = (totals?.agentSeconds ?? 0) / SECONDS_PER_HOUR;
	const joined = formatJoined(summary?.joinedAt);
	const balance = pointsBalance ?? summary?.pointsBalance ?? 0;
	const unlocked = new Set(unlockedKeys);

	return (
		<div className="space-y-6">
			<SettingsCard className="flex items-center gap-4">
				{safeMediaUrl(summary?.image) ? (
					<img
						alt={summary?.name ?? "Profile"}
						className="size-14 shrink-0 rounded-full object-cover ring-1 ring-border"
						src={safeMediaUrl(summary?.image) ?? undefined}
					/>
				) : (
					<div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-lg">
						{(summary?.name ?? "You").slice(0, 2).toUpperCase()}
					</div>
				)}
				<div className="min-w-0">
					<h2 className="truncate font-medium text-base">
						{summary?.name ?? "Your activity"}
					</h2>
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
						<span>{summary?.plan ?? "Free"}</span>
						{joined ? <span>{tl("Joined {joined}", { joined })}</span> : null}
						<span>
							{tl("Level {level}", { level: String(summary?.level ?? 0) })}
						</span>
					</div>
				</div>
			</SettingsCard>

			<SettingsSection title="Lifetime">
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					<HeroStat
						label="Lifetime tokens"
						value={formatCompact(totalTokens)}
					/>
					<HeroStat
						label="Total spend"
						value={formatCost(totals?.costMicroUsd ?? 0)}
					/>
					<HeroStat label="Agent hours" value={agentHours.toFixed(1)} />
					<HeroStat
						label="Active days"
						value={formatCompact(insights?.activeDays ?? 0)}
					/>
					<HeroStat
						hint={USAGE_STREAK_HINT}
						label="Current streak"
						value={`${summary?.streak.current ?? 0} days`}
					/>
					<HeroStat
						hint={USAGE_STREAK_HINT}
						label="Longest streak"
						value={`${summary?.streak.longest ?? 0} days`}
					/>
				</div>
			</SettingsSection>

			<SettingsCard>
				{/* Each cell is that day's request count, not tokens; a
				    streak-active day with no requests shows at the lowest level. */}
				<ContributionsGraph
					data={withActiveDays(usage, activeDays)}
					title="Daily activity"
				/>
			</SettingsCard>

			<div className="grid gap-3 lg:grid-cols-3">
				<ChartCard
					icon={<Activity className="size-4" />}
					title="Recent activity"
				>
					<ActivityArea data={usage} days={30} formatCount={formatCompact} />
				</ChartCard>
				<ChartCard
					icon={<Network className="size-4" />}
					title="Where your usage comes from"
				>
					<TransportDonut
						formatCount={formatCompact}
						transport={
							insights?.transport ?? {
								acp: 0,
								gateway: 0,
								openAiCompat: 0,
								other: 0,
							}
						}
					/>
				</ChartCard>
				<ChartCard icon={<Cpu className="size-4" />} title="Usage by feature">
					<FeatureMixBar
						featureTotals={
							featureTotals ?? {
								agentSeconds: 0,
								chat: 0,
								island: 0,
								predictAccepted: 0,
							}
						}
					/>
				</ChartCard>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Zap className="size-4" />}
					sub="avg / active day"
					title="Daily tokens"
					value={formatCompact(insights?.averageTokensPerActiveDay ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Trophy className="size-4" />}
					sub={insights?.peakDay?.day ?? "none yet"}
					title="Peak day"
					value={formatCompact(insights?.peakDay?.tokens ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Gauge className="size-4" />}
					sub="best effort"
					title="Peak hour"
					value={formatHourUtc(insights?.peakHourUtc)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Bot className="size-4" />}
					sub="request count"
					title="Favourite model"
					value={insights?.favoriteModel ?? "Not enough data"}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Activity className="size-4" />}
					title="Sessions"
					value={formatCompact(totals?.sessionCount ?? 0)}
				/>
				<StatCard
					className={STAT_TILE_CLASS}
					icon={<Coins className="size-4" />}
					sub="lifetime"
					title="Requests"
					value={formatCompact(totals?.requestCount ?? 0)}
				/>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<SettingsSection title="Activity insights">
					<SettingsGroup>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(totals?.requestCount ?? 0)}
								</span>
							}
							title="Requests"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.averageRequestsPerActiveDay ?? 0)}
								</span>
							}
							title="Avg requests / usage day"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.transport.gateway ?? 0)}
								</span>
							}
							title="Gateway-observed runs"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(insights?.transport.acp ?? 0)}
								</span>
							}
							title="ACP app-observed runs"
						/>
						<SettingsItem
							actions={
								<span className="font-medium text-sm tabular-nums">
									{formatCompact(featureTotals?.island ?? 0)}
								</span>
							}
							title="Island interactions"
						/>
					</SettingsGroup>
				</SettingsSection>
				<div className={RANKED_LIST_SURFACE_CLASS}>
					<RankedList
						empty="No model usage recorded yet."
						formatCount={formatCompact}
						icon={<Bot className="size-4" />}
						items={insights?.topModels ?? []}
						title="Most used models"
					/>
				</div>
			</div>

			<div className={`grid gap-4 lg:grid-cols-2 ${RANKED_LIST_SURFACE_CLASS}`}>
				<RankedList
					empty="No skill usage recorded yet."
					formatCount={formatCompact}
					icon={<Sparkles className="size-4" />}
					items={insights?.topSkills ?? []}
					title="Most used skills"
				/>
				<RankedList
					empty="No plugin usage recorded yet."
					formatCount={formatCompact}
					icon={<Plug className="size-4" />}
					items={insights?.topPlugins ?? []}
					title="Most used plugins"
				/>
			</div>

			{catalog.length > 0 ? (
				<SettingsSection
					headerAction={
						<span className="text-muted-foreground text-xs">
							{tl("{points} points available", {
								points: formatCompact(balance),
							})}
						</span>
					}
					title="Unlocks"
				>
					<SettingsGroup>
						{catalog.map((feature) => (
							<SettingsItem
								actions={
									<div className="flex items-center gap-2">
										<UnlockAction
											feature={feature}
											isUnlocked={unlocked.has(feature.key)}
											isUnlocking={unlockingKey === feature.key}
											onUnlock={onUnlockFeature}
											pointsBalance={balance}
										/>
										<Badge variant={tierBadgeVariant(feature.tier)}>
											{tierLabel(feature.tier)}
										</Badge>
									</div>
								}
								key={feature.key}
								title={feature.title}
							>
								<RowHint>{feature.description}</RowHint>
							</SettingsItem>
						))}
					</SettingsGroup>
				</SettingsSection>
			) : null}

			{wrappedHref ? (
				<SettingsGroup>
					<SettingsItem
						actions={
							<a className={buttonVariants({ size: "sm" })} href={wrappedHref}>
								<Sparkles className="size-4" />
								View my Wrapped
							</a>
						}
						description="A shareable snapshot of your year with Ryu."
						title="Share your Ryu Wrapped"
					/>
				</SettingsGroup>
			) : null}
		</div>
	);
}
