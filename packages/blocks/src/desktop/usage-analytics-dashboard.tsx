"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@ryu/ui/components/toggle-group";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";
import {
	GRANULARITY_LABELS,
	type UsageAnalyticsData,
	type UsageDateRange,
	type UsageGranularity,
	type UsageScope,
	usageProviderLabel,
} from "./usage-analytics.ts";
import {
	ActivityHeatmap,
	FeatureMix,
	PurposeMix,
	RankedBreakdown,
	UsageDonut,
} from "./usage-analytics-dashboard-breakdowns.tsx";
import { DateRangeControl } from "./usage-analytics-dashboard-date-range.tsx";
import { PromptCacheTrend } from "./usage-analytics-dashboard-prompt-cache.tsx";
import {
	formatCompact,
	formatMilliseconds,
	formatSpend,
	GRANULARITY_VALUES,
	KPI_COLORS,
	KpiCard,
	SCOPE_LABELS,
	SCOPE_VALUES,
} from "./usage-analytics-dashboard-shared.tsx";
import { UsageTrend } from "./usage-analytics-dashboard-trend.tsx";

export interface UsageAnalyticsDashboardProps {
	analytics: UsageAnalyticsData | null;
	failed?: boolean;
	granularity: UsageGranularity;
	loading: boolean;
	model: string | null;
	modelOptions?: string[];
	onGranularityChange: (value: UsageGranularity) => void;
	onModelChange: (value: string | null) => void;
	onProviderChange: (value: string | null) => void;
	onRangeChange: (value: UsageDateRange) => void;
	onRefresh?: () => void;
	onScopeChange: (value: UsageScope) => void;
	provider: string | null;
	providerOptions?: string[];
	range: UsageDateRange;
	scope: UsageScope;
}

export function UsageAnalyticsDashboard({
	analytics,
	failed = false,
	granularity,
	loading,
	model,
	onGranularityChange,
	onModelChange,
	onProviderChange,
	onRangeChange,
	onRefresh,
	onScopeChange,
	provider,
	providerOptions,
	modelOptions,
	range,
	scope,
}: UsageAnalyticsDashboardProps) {
	const providers = providerOptions ?? analytics?.providerOptions ?? [];
	const models = modelOptions ?? analytics?.modelOptions ?? [];
	const totals = analytics?.totals;
	const purposeRows = analytics?.byPurpose ?? [];
	const hasPurposes = purposeRows.some((row) => row.requests > 0);
	const hasPromptCache =
		(totals?.cacheReadTokens ?? 0) + (totals?.cacheWriteTokens ?? 0) > 0;
	return (
		<section
			aria-label="Usage analytics"
			className="flex flex-col gap-6"
			data-testid="usage-analytics-dashboard"
		>
			<SettingsSection title="Usage analytics">
				<div data-testid="usage-filter-rail">
					<SettingsGroup>
						<SettingsItem
							actions={
								<ToggleGroup
									appearance="segmented"
									aria-label="Usage scope"
									className="h-auto max-w-full flex-wrap"
									multiple={false}
									onValueChange={(values: string[]) => {
										const [value] = values;
										const selection = SCOPE_VALUES.find(
											(candidate) => candidate === value
										);
										if (selection) {
											onScopeChange(selection);
										}
									}}
									spacing={0}
									value={[scope]}
									variant="default"
								>
									{SCOPE_VALUES.map((value) => (
										<ToggleGroupItem
											density="segmented"
											key={value}
											value={value}
										>
											{SCOPE_LABELS[value]}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
							description={
								analytics?.caption ?? "Choose a scope to explore consumption."
							}
							title="Scope"
						/>
						<SettingsItem
							actions={
								<ToggleGroup
									appearance="segmented"
									aria-label="Usage granularity"
									className="h-auto max-w-full flex-wrap"
									multiple={false}
									onValueChange={(values: string[]) => {
										const [value] = values;
										const selection = GRANULARITY_VALUES.find(
											(candidate) => candidate === value
										);
										if (selection) {
											onGranularityChange(selection);
										}
									}}
									spacing={0}
									value={[granularity]}
									variant="default"
								>
									{GRANULARITY_VALUES.map((value) => (
										<ToggleGroupItem
											density="segmented"
											key={value}
											value={value}
										>
											{GRANULARITY_LABELS[value]}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
							title="Resolution"
						/>
						<SettingsItem
							actions={
								<DateRangeControl onChange={onRangeChange} range={range} />
							}
							title="Date range"
						/>
						<SettingsItem
							actions={
								<Select
									onValueChange={(value) =>
										onProviderChange(value === "all" ? null : value)
									}
									value={provider ?? "all"}
								>
									<SelectTrigger
										appearance="filter"
										aria-label="Filter by provider"
										className="min-w-40"
										size="sm"
										variant="default"
									>
										<span className="max-w-40 truncate">
											{provider
												? usageProviderLabel(provider)
												: "All providers"}
										</span>
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectLabel>Provider</SelectLabel>
											<SelectItem value="all">All providers</SelectItem>
											{providers.map((value) => (
												<SelectItem key={value} value={value}>
													{usageProviderLabel(value)}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							}
							title="Provider"
						/>
						<SettingsItem
							actions={
								<Select
									onValueChange={(value) =>
										onModelChange(value === "all" ? null : value)
									}
									value={model ?? "all"}
								>
									<SelectTrigger
										appearance="filter"
										aria-label="Filter by model"
										className="min-w-44"
										size="sm"
										variant="default"
									>
										<span
											className="max-w-44 truncate"
											title={model ?? "All models"}
										>
											{model ?? "All models"}
										</span>
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											<SelectLabel>Model</SelectLabel>
											<SelectItem value="all">All models</SelectItem>
											{models.map((value) => (
												<SelectItem key={value} value={value}>
													{value}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							}
							title="Model"
						/>
					</SettingsGroup>
				</div>

				{analytics?.availability?.supported === false ? (
					<SettingsCard className="text-muted-foreground text-sm">
						<p data-testid="usage-analytics-availability">
							{analytics.availability.message}
						</p>
					</SettingsCard>
				) : null}

				{loading && !analytics ? (
					<SettingsCard className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-sm">
						<Spinner /> Loading analytics…
					</SettingsCard>
				) : null}

				{analytics ? (
					<SettingsCard
						className={`grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 ${
							scope === "organization" ? "xl:grid-cols-7" : "xl:grid-cols-6"
						}`}
					>
						<KpiCard
							color={KPI_COLORS.requests}
							detail="Across the selected range"
							label="Requests"
							value={formatCompact(totals?.requests ?? 0)}
						/>
						<KpiCard
							color={KPI_COLORS.tokens}
							detail="Input + output"
							label="Tokens"
							value={formatCompact(
								(totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0)
							)}
						/>
						<KpiCard
							color={KPI_COLORS["credit spend"]}
							detail={
								scope === "node"
									? "Only if this node bills through Ryu"
									: "Debit-only consumption"
							}
							label="Credit spend"
							value={formatSpend(totals?.spendMicroUsd ?? null)}
						/>
						<KpiCard
							color={KPI_COLORS.errors}
							detail="Successful + failed calls"
							label="Errors"
							value={formatCompact(totals?.errors ?? 0)}
						/>
						<KpiCard
							color={KPI_COLORS["avg latency"]}
							detail="Average observed latency"
							label="Avg latency"
							value={formatMilliseconds(totals?.averageLatencyMs ?? null)}
						/>
						<KpiCard
							color={
								KPI_COLORS[scope === "you" ? "active days" : "active members"]
							}
							detail={
								scope === "organization"
									? "Members with activity"
									: scope === "node"
										? "Members observed"
										: "Days with activity"
							}
							label={scope === "you" ? "Active days" : "Active members"}
							value={formatCompact(
								scope === "you"
									? (totals?.activeDays ?? 0)
									: (totals?.activeMembers ?? 0)
							)}
						/>
						{scope === "organization" ? (
							<KpiCard
								color={KPI_COLORS["active nodes"]}
								detail="Nodes with activity"
								label="Active nodes"
								value={formatCompact(totals?.activeNodes ?? 0)}
							/>
						) : null}
					</SettingsCard>
				) : loading || failed ? null : (
					<SettingsGroup>
						<SettingsItem
							actions={
								onRefresh ? (
									<Button onClick={onRefresh} size="sm" variant="outline">
										Refresh analytics
									</Button>
								) : null
							}
							title={
								<span className="text-muted-foreground">
									No analytics loaded. Choose a scope and range to explore
									usage.
								</span>
							}
						/>
					</SettingsGroup>
				)}
			</SettingsSection>

			{analytics ? (
				<>
					<div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
						<UsageTrend data={analytics} />
						<UsageDonut
							data={analytics.bySource}
							description="Managed credits are only one possible billing source."
							testId="chart-source"
							title="Consumption source"
						/>
					</div>
					<div className="grid gap-6 md:grid-cols-2">
						<UsageDonut
							data={analytics.byProvider}
							description="Compare providers before narrowing the dashboard."
							testId="chart-provider"
							title="Provider mix"
						/>
						<FeatureMix data={analytics.byFeature} />
					</div>
					{hasPurposes || hasPromptCache ? (
						<div className="grid gap-6 md:grid-cols-2">
							{hasPurposes ? <PurposeMix data={purposeRows} /> : null}
							{hasPromptCache ? <PromptCacheTrend data={analytics} /> : null}
						</div>
					) : null}
					<div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
						<RankedBreakdown
							data={analytics.byModel}
							description="Most observed model calls in this scope."
							testId="chart-model"
							title="Top models"
						/>
						<RankedBreakdown
							data={analytics.byProvider}
							description="Request volume by provider."
							testId="chart-provider-ranking"
							title="Provider breakdown"
						/>
						<ActivityHeatmap data={analytics} />
					</div>
				</>
			) : null}
		</section>
	);
}
