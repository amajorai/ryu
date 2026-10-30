"use client";

import { formatCurrency } from "@ryu/ui/lib/number-format.ts";
import type { HistoryScope } from "@/src/lib/api/usage-history.ts";
import { historyCounterDisplay } from "./history-format.ts";

export const COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];
export const PERIODS = [
	{ label: "All time", value: "all", days: null },
	{ label: "30 days", value: "30", days: 30 },
	{ label: "7 days", value: "7", days: 7 },
] as const;

export const SCOPES = [
	{ value: "session", label: "Session history" },
	{ value: "account", label: "Account reports" },
	{ value: "organization", label: "Organization reports" },
	{ value: "unattributed", label: "Unattributed usage" },
	{ value: "unreconciled", label: "Unreconciled live usage" },
] as const satisfies readonly { value: HistoryScope; label: string }[];

export function money(value: number | null): string {
	return value === null
		? "Unknown"
		: formatCurrency(value, "USD", {
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
			});
}

/** A flat stat tile (the gateway `StatTile` shape) with an optional test id. */
export function Stat({
	label,
	value,
	detail,
	valueTestId,
}: {
	label: string;
	value: string;
	detail: string;
	valueTestId?: string;
}) {
	return (
		<div className="min-w-0">
			<div className="text-(length:--text-detail) truncate text-muted-foreground leading-(--text-detail--line-height)">
				{label}
			</div>
			<div
				className="mt-1 truncate font-medium text-xl tabular-nums"
				data-testid={valueTestId}
			>
				{value}
			</div>
			<div className="mt-0.5 text-muted-foreground text-xs">{detail}</div>
		</div>
	);
}

export function CounterCell({
	value,
	missing,
	records,
}: {
	value: number;
	missing: number | readonly number[];
	records: number;
}) {
	const display = historyCounterDisplay(value, missing, records);
	return (
		<span title={display.detail}>
			{display.value}
			{display.detail.endsWith("Partial") ? (
				<span className="block text-muted-foreground text-xs">
					Partial counters
				</span>
			) : null}
		</span>
	);
}
