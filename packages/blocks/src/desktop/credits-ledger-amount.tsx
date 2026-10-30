"use client";

import { type CreditLedgerRow, formatMicroUsd } from "./credits-model.ts";

export function LedgerAmount({
	row,
	currency,
}: {
	row: CreditLedgerRow;
	currency: string;
}) {
	const formatted = formatMicroUsd(Math.abs(row.delta), currency);
	return (
		<span
			className={`font-heading font-medium text-sm tabular-nums ${
				row.isCredit ? "text-status-success" : "text-foreground"
			}`}
		>
			{row.isCredit ? "+" : "−"}
			{formatted}
		</span>
	);
}
