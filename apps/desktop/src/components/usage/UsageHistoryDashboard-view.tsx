"use client";

import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useState } from "react";
import { Segmented } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type HistoryImportReport,
	type HistoryImportRequest,
	type HistoryScope,
	historyProcessedTokens,
	type UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import { ProviderBrandLogo } from "@/src/lib/provider-brand.tsx";
import { historyCounterDisplay } from "./history-format.ts";
import {
	RecordedAccounts,
	SourceCoverage,
} from "./UsageHistoryDashboard-accounts.tsx";
import { Breakdown } from "./UsageHistoryDashboard-breakdown.tsx";
import { DailyChart } from "./UsageHistoryDashboard-daily-chart.tsx";
import { ImportReportCard } from "./UsageHistoryDashboard-import-report.tsx";
import { OverviewStats } from "./UsageHistoryDashboard-overview-stats.tsx";
import { COLORS, money, PERIODS } from "./UsageHistoryDashboard-shared.tsx";
import usageVisualStyles from "./usage-visual-indicators.module.css";
import type { UsageVisualStyle } from "./usage-visual-style.ts";

export interface UsageHistoryViewProps {
	days: number | null;
	error: string | null;
	importError: string | null;
	importing: boolean;
	importReport: HistoryImportReport | null;
	loading: boolean;
	onDaysChange: (days: number | null) => void;
	onImport: (request: HistoryImportRequest) => Promise<void>;
	onRefresh: () => void;
	refreshing: boolean;
	report: UsageHistoryReport | null;
	scope: HistoryScope;
}

export function UsageHistoryView({
	scope,
	report,
	loading,
	refreshing,
	error,
	importing,
	importReport,
	importError,
	days,
	onDaysChange,
	onRefresh,
	onImport,
}: UsageHistoryViewProps) {
	const tl = useLiteralMessages();
	const [selected, setSelected] = useState<string[] | null>(null);
	const [path, setPath] = useState("");
	const [exportAccount, setExportAccount] = useState("");
	const [pathSource, setPathSource] = useState("");
	const sources = report?.sources ?? [];
	const localSources = sources.filter(
		(source) => source.transport === "localFiles"
	);
	const customSources = sources.filter(
		(source) =>
			(source.transport === "localFiles" && source.id !== "ryu-sessions") ||
			source.transport === "metadataExport"
	);
	const sourceIds =
		selected ??
		localSources
			.filter((source) => source.available)
			.map((source) => source.id);
	const summary = report?.summary;
	const counterFields = summary
		? [
				summary.totals.missingInputRecords,
				summary.totals.missingOutputRecords,
				summary.totals.missingCacheReadRecords,
				summary.totals.missingCacheWriteRecords,
			]
		: [];
	const missingCounters =
		counterFields.some((missing) => missing > 0) ||
		Boolean(
			summary?.totals.missingCachedOutputRecords ||
				summary?.totals.missingReasoningRecords
		);
	const counters = summary
		? {
				processed: historyCounterDisplay(
					historyProcessedTokens(summary.totals),
					counterFields,
					summary.records
				),
				input: historyCounterDisplay(
					summary.totals.inputTokens,
					summary.totals.missingInputRecords,
					summary.records
				),
				output: historyCounterDisplay(
					summary.totals.outputTokens,
					summary.totals.missingOutputRecords,
					summary.records
				),
				cacheRead: historyCounterDisplay(
					summary.totals.cacheReadTokens,
					summary.totals.missingCacheReadRecords,
					summary.records
				),
				cacheWrite: historyCounterDisplay(
					summary.totals.cacheWriteTokens,
					summary.totals.missingCacheWriteRecords,
					summary.records
				),
				cachedOutput: historyCounterDisplay(
					summary.totals.cachedOutputTokens,
					summary.totals.missingCachedOutputRecords,
					summary.records
				),
			}
		: null;
	const customSource = pathSource || customSources[0]?.id || "";
	const runImport = (retryFailed = false) => {
		void onImport({
			sourceIds,
			roots:
				path.trim() && customSource
					? [
							{
								sourceId: customSource,
								path: path.trim(),
								...(exportAccount.trim()
									? { accountId: exportAccount.trim() }
									: undefined),
							},
						]
					: [],
			maxFiles: 25,
			retryFailed,
		}).catch(() => undefined);
	};
	const sourceColor = (sourceId: string) =>
		COLORS[
			Math.max(
				0,
				sources.findIndex((item) => item.id === sourceId)
			) % COLORS.length
		];
	const overviewNotes = summary
		? [
				"List-price estimate. Subscription charges and invoices are separate.",
				summary.unpricedRecords
					? `${formatNumber(summary.unpricedRecords)} records have unknown prices.`
					: null,
				missingCounters
					? "Some records omit token counters. Totals include only reported values."
					: null,
			]
				.filter(Boolean)
				.join(" ")
		: undefined;
	return (
		<section
			aria-label="Historical usage"
			className="flex flex-col gap-8 [&>*]:mt-0"
			data-testid="usage-history-dashboard"
		>
			<SettingsSection title="Import on this node">
				<SettingsGroup>
					{localSources.map((source) => (
						<SettingsItem
							actions={
								<span className="text-muted-foreground text-xs">
									{source.available ? "Found" : "No default history"}
								</span>
							}
							key={source.id}
							title={
								<label className="flex cursor-pointer items-center gap-2">
									<Checkbox
										checked={sourceIds.includes(source.id)}
										disabled={importing}
										onCheckedChange={(checked) =>
											setSelected(
												checked
													? [...sourceIds, source.id]
													: sourceIds.filter((id) => id !== source.id)
											)
										}
									/>
									{source.label}
								</label>
							}
						/>
					))}
					<details className="px-3 py-2" key="custom-location">
						<summary className="cursor-pointer text-sm">
							Custom location or provider metadata export
						</summary>
						<div className="mt-3 flex flex-wrap gap-2">
							<label className="sr-only" htmlFor="history-path-source">
								History source
							</label>
							<select
								className="h-8 rounded-lg border-0 bg-muted/50 px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
								disabled={importing}
								id="history-path-source"
								onChange={(event) => setPathSource(event.target.value)}
								value={customSource}
							>
								{customSources.map((source) => (
									<option key={source.id} value={source.id}>
										{source.label}
									</option>
								))}
							</select>
							<label className="sr-only" htmlFor="history-scan-path">
								Explicit history path on selected node
							</label>
							<Input
								className="min-w-48 flex-1"
								disabled={importing}
								id="history-scan-path"
								onChange={(event) => setPath(event.target.value)}
								placeholder="Absolute path on the selected node"
								value={path}
							/>
							<label className="sr-only" htmlFor="history-export-account">
								Export account alias
							</label>
							<Input
								disabled={importing}
								id="history-export-account"
								onChange={(event) => setExportAccount(event.target.value)}
								placeholder="Account alias for provider exports"
								value={exportAccount}
							/>
						</div>
						<p className="mt-2 text-muted-foreground text-xs">
							Use a retained history folder or JSON usage export. Account
							reports require an export authorized by the account or
							organization owner.
						</p>
					</details>
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center justify-end gap-2">
								{importReport && importReport.errorCount > 0 ? (
									<Button
										disabled={importing}
										onClick={() => runImport(true)}
										size="sm"
										variant="outline"
									>
										Retry failed files
									</Button>
								) : null}
								<Button
									disabled={
										loading ||
										importing ||
										(sourceIds.length === 0 && !path.trim())
									}
									onClick={() => runImport()}
									size="sm"
									variant="outline"
								>
									{importing
										? "Importing…"
										: importReport?.hasMore
											? "Continue import"
											: "Import history"}
								</Button>
							</div>
						}
						description="Bring in usage from before you installed Ryu. Read-only scans store token metadata; prompts, messages, and credentials stay out of the usage ledger. Imports resume from saved checkpoints and skip unchanged records."
						key="import"
						title={tl(
							"{count, plural, one {{countText} source selected} other {{countText} sources selected}}",
							{
								count: sourceIds.length,
								countText: formatNumber(sourceIds.length),
							}
						)}
					/>
				</SettingsGroup>
				{importError ? (
					<p className="px-3 text-destructive text-xs" role="alert">
						{importError}
					</p>
				) : null}
				{importReport ? (
					<ImportReportCard importing={importing} importReport={importReport} />
				) : null}
			</SettingsSection>

			<SettingsSection
				caption={overviewNotes}
				headerAction={
					<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
						<Segmented
							label="History period"
							onChange={(value) =>
								onDaysChange(
									PERIODS.find((period) => period.value === value)?.days ?? null
								)
							}
							options={PERIODS}
							value={
								PERIODS.find((period) => period.days === days)?.value ?? "all"
							}
						/>
						<Button
							disabled={refreshing}
							onClick={onRefresh}
							size="sm"
							variant="ghost"
						>
							<HugeiconsIcon icon={Refresh01Icon} size={16} />
							Refresh
						</Button>
					</div>
				}
				title="Overview"
			>
				{error ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button onClick={onRefresh} size="sm" variant="outline">
									Retry
								</Button>
							}
							title={
								<span
									className="text-status-destructive"
									role="alert"
									title={error}
								>
									{"Couldn't load usage history."}
								</span>
							}
						/>
					</SettingsGroup>
				) : null}
				{loading && !report ? (
					<SettingsCard>
						<SkeletonRows label="Loading usage history…" />
					</SettingsCard>
				) : null}
				{summary && counters ? (
					<OverviewStats counters={counters} scope={scope} summary={summary} />
				) : null}
			</SettingsSection>

			{summary && report ? (
				<>
					{summary.sources.length > 0 ? (
						<SettingsSection title="Estimate by source">
							<SettingsGroup>
								{summary.sources.map((source) => (
									<SettingsItem
										actions={
											<span className="text-sm tabular-nums">
												{money(source.estimatedCostUsd)}
											</span>
										}
										key={source.sourceId}
										title={
											<span className="flex min-w-0 items-center gap-2">
												<span
													className={`size-2 shrink-0 rounded-full ${usageVisualStyles.sourceColor}`}
													style={
														// SAFETY: The literal satisfies full React CSSProperties and the named native CSS slots.
														// This checked owner assertion only clears fresh-literal metadata for React style.
														{
															"--usage-source-color": sourceColor(
																source.sourceId
															),
														} satisfies UsageVisualStyle as UsageVisualStyle
													}
												/>
												<ProviderBrandLogo
													providerKey={source.sourceId}
													size={16}
												/>
												<span className="truncate">
													{sources.find((item) => item.id === source.sourceId)
														?.label ?? source.sourceId}
												</span>
											</span>
										}
									/>
								))}
							</SettingsGroup>
						</SettingsSection>
					) : null}
					<SettingsSection title="Reported costs">
						<SettingsGroup>
							<SettingsItem
								actions={
									<span className="text-sm tabular-nums">
										{money(summary.sourceEstimatedCostUsd)}
									</span>
								}
								description="May be a tool estimate. No billed charge is inferred."
								title="Source-reported estimate"
							/>
							<SettingsItem
								actions={
									<span className="text-sm tabular-nums">
										{money(summary.billedCostUsd)}
									</span>
								}
								description="Only explicit billing fields. Separate usage and cost reports may cover the same activity."
								title="Provider-reported billed cost"
							/>
						</SettingsGroup>
					</SettingsSection>
					<DailyChart report={report} scope={scope} />
					<Breakdown report={report} scope={scope} />
					{summary.accounts?.some((account) => account.accountId) ? (
						// `data-slot="card"` scopes the recorded-accounts block (title and
						// rows) for the usage-history reconciliation proof.
						<RecordedAccounts accounts={summary.accounts} />
					) : null}
				</>
			) : null}
			{sources.length ? <SourceCoverage sources={sources} /> : null}
		</section>
	);
}
