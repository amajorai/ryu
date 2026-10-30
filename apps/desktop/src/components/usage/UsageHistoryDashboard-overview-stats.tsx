"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import type {
	HistoryScope,
	UsageHistoryReport,
} from "@/src/lib/api/usage-history.ts";
import type { historyCounterDisplay } from "./history-format.ts";
import { money, Stat } from "./UsageHistoryDashboard-shared.tsx";

export type HistoryCounters = Record<
	| "processed"
	| "input"
	| "output"
	| "cacheRead"
	| "cacheWrite"
	| "cachedOutput",
	ReturnType<typeof historyCounterDisplay>
>;

export function OverviewStats({
	counters,
	scope,
	summary,
}: {
	counters: HistoryCounters;
	scope: HistoryScope;
	summary: UsageHistoryReport["summary"];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="grid grid-cols-2 gap-x-6 gap-y-4 py-3 sm:grid-cols-3">
			<Stat
				detail={tl("{sessions} · {records} usage records", {
					records: formatNumber(summary.records),
					sessions:
						scope === "unattributed"
							? summary.records > 0 && summary.sessions === 0
								? tl("Ryu conversation count not reported")
								: tl("{count} retained Ryu conversations", {
										count: formatNumber(summary.sessions),
									})
							: tl(
									"{count, plural, one {{countText} session} other {{countText} sessions}}",
									{
										count: summary.sessions,
										countText: formatNumber(summary.sessions),
									}
								),
				})}
				label="API-equivalent estimate"
				value={money(summary.estimatedCostUsd)}
				valueTestId="history-estimated-cost"
			/>
			<Stat
				detail={counters.processed.detail}
				label="Processed tokens"
				value={counters.processed.value}
			/>
			<Stat
				detail={tl("Read {read} · Written {written}", {
					read: counters.cacheRead.detail,
					written: counters.cacheWrite.detail,
				})}
				label="Cached input"
				value={counters.cacheRead.value}
			/>
			<Stat
				detail={counters.input.detail}
				label="Uncached input"
				value={counters.input.value}
			/>
			<Stat
				detail={tl("{output} · Cached output {cachedOutput}", {
					cachedOutput: counters.cachedOutput.detail,
					output: counters.output.detail,
				})}
				label="Output"
				value={counters.output.value}
			/>
			<Stat
				detail={
					summary.unpricedRecords || summary.totals.missingCacheReadRecords
						? "Known cache rates only · Partial estimate"
						: "Known cache rates only"
				}
				label="Estimated cache savings"
				value={
					summary.records > 0 &&
					summary.totals.missingCacheReadRecords === summary.records
						? "Unknown"
						: money(summary.cacheSavingsUsd)
				}
			/>
		</div>
	);
}
