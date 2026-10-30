"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useState } from "react";
import { Segmented } from "@/src/components/gateway/quiet.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import {
	type HistoryBucket,
	type HistoryScope,
	historyProcessedTokens,
	type UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import { CounterCell, money } from "./UsageHistoryDashboard-shared.tsx";

const HEAD = "h-10 px-2 font-normal text-muted-foreground text-xs";
const CELL = "h-10 px-2 py-0";

export function Breakdown({
	report,
	scope,
}: {
	report: UsageHistoryReport;
	scope: HistoryScope;
}) {
	const tl = useLiteralMessages();
	const [kind, setKind] = useState<"model" | "day">("model");
	const [all, setAll] = useState(false);
	const rows = kind === "model" ? report.summary.models : report.summary.daily;
	const shown = all ? rows : rows.slice(0, 20);
	return (
		<SettingsSection
			caption="Unknown prices and missing counters stay visible."
			headerAction={
				<Segmented
					label="Breakdown grouping"
					onChange={(value) => {
						setKind(value);
						setAll(false);
					}}
					options={[
						{ label: "By model", value: "model" },
						{ label: "By day", value: "day" },
					]}
					value={kind}
				/>
			}
			title="Usage breakdown"
		>
			<Table className="text-sm">
				<caption className="sr-only">
					{tl(
						"{kind, select, model {Historical usage grouped by model} other {Historical usage grouped by day}}",
						{ kind }
					)}
				</caption>
				<TableHeader>
					<TableRow appearance="header">
						<TableHead className={HEAD}>
							{kind === "model"
								? "Model"
								: scope === "unattributed"
									? "Observed date"
									: "Date"}
						</TableHead>
						<TableHead className={HEAD}>Source</TableHead>
						<TableHead className={cn(HEAD, "text-right")}>
							{scope === "unattributed" ? "Ryu conversations" : "Sessions"}
						</TableHead>
						<TableHead className={cn(HEAD, "text-right")}>Tokens</TableHead>
						<TableHead className={cn(HEAD, "text-right")}>
							Cached input
						</TableHead>
						<TableHead className={cn(HEAD, "text-right")}>
							API estimate
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.map((row: HistoryBucket) => (
						<TableRow
							className="border-border"
							key={`${row.date}:${row.sourceId}:${row.modelId}`}
						>
							<TableCell className={CELL}>
								{kind === "model" ? (row.modelId ?? "Unknown model") : row.date}
							</TableCell>
							<TableCell className={cn(CELL, "text-muted-foreground")}>
								{report.sources.find((source) => source.id === row.sourceId)
									?.label ?? row.sourceId}
							</TableCell>
							<TableCell className={cn(CELL, "text-right tabular-nums")}>
								{scope === "unattributed" &&
								row.records > 0 &&
								row.sessions === 0
									? "Not reported"
									: formatNumber(row.sessions)}
							</TableCell>
							<TableCell className={cn(CELL, "text-right tabular-nums")}>
								<CounterCell
									missing={[
										row.totals.missingInputRecords,
										row.totals.missingOutputRecords,
										row.totals.missingCacheReadRecords,
										row.totals.missingCacheWriteRecords,
									]}
									records={row.records}
									value={historyProcessedTokens(row.totals)}
								/>
							</TableCell>
							<TableCell className={cn(CELL, "text-right tabular-nums")}>
								<CounterCell
									missing={row.totals.missingCacheReadRecords}
									records={row.records}
									value={row.totals.cacheReadTokens}
								/>
							</TableCell>
							<TableCell className={cn(CELL, "text-right tabular-nums")}>
								{money(row.estimatedCostUsd)}
								{row.unpricedRecords ? (
									<span className="block text-muted-foreground text-xs">
										Partial estimate
									</span>
								) : null}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
			{rows.length === 0 ? (
				<p className="py-6 text-muted-foreground text-sm">
					No usage records in this period.
				</p>
			) : null}
			{rows.length > 20 ? (
				<Button
					className="mt-2"
					onClick={() => setAll(!all)}
					size="sm"
					variant="ghost"
				>
					{all
						? "Show fewer"
						: tl("Show all {count} rows", {
								count: formatNumber(rows.length),
							})}
				</Button>
			) : null}
		</SettingsSection>
	);
}
