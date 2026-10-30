"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { formatMicroUsd } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Info } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import type { CreditAllocationView } from "./credit-balance-breakdown.tsx";
import { Item, ItemGroup, ItemSeparator } from "./item.tsx";

export function finiteAmount(value: number | null | undefined): number | null {
	if (!(isNativeNumber(value) && Number.isFinite(value))) {
		return null;
	}
	return value;
}

export function amountLabel(
	value: number | null | undefined,
	currency: string
): string {
	const amount = finiteAmount(value);
	return amount === null ? "—" : formatMicroUsd(amount, currency, 2);
}

export function InfoTooltip({
	label,
	children,
}: {
	label: string;
	children: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				aria-label={label}
				className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				type="button"
			>
				<Info aria-hidden="true" className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent className="max-w-80 whitespace-normal leading-relaxed">
				<p>{children}</p>
			</TooltipContent>
		</Tooltip>
	);
}

export function BucketCard({
	amount,
	detail,
	flat,
	label,
	tooltip,
}: {
	amount: string;
	detail: string;
	flat: boolean;
	label: string;
	tooltip: string;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			className={cn(
				"rounded-lg p-3",
				flat ? "bg-background/70" : "border bg-background/60"
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="font-medium text-sm">{label}</p>
				<InfoTooltip
					label={tl("About {label}", { label: label.toLowerCase() })}
				>
					{tooltip}
				</InfoTooltip>
			</div>
			<p className="mt-2 font-medium font-mono text-xl tabular-nums">
				{amount}
			</p>
			<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
				{detail}
			</p>
		</div>
	);
}

/** The one line free credit is explained with, wherever it is shown. */
export const FREE_CREDIT_USAGE_LINE =
	"Used automatically on models marked Free";

/**
 * The expiry label of the allocation that lapses soonest: by ISO `expiresAt`
 * when callers provide it, else the first allocation that carries a label.
 */
export function nearestExpiryLabel(
	allocations: readonly CreditAllocationView[]
): string | null {
	let nearest: CreditAllocationView | null = null;
	for (const allocation of allocations) {
		const at = allocation.expiresAt
			? Date.parse(allocation.expiresAt)
			: Number.NaN;
		if (Number.isNaN(at)) {
			continue;
		}
		const best = nearest?.expiresAt
			? Date.parse(nearest.expiresAt)
			: Number.NaN;
		if (Number.isNaN(best) || at < best) {
			nearest = allocation;
		}
	}
	return (
		nearest?.expiresAtLabel ??
		allocations.find((allocation) => allocation.expiresAtLabel)
			?.expiresAtLabel ??
		null
	);
}

export function FreeCreditRow({
	amountMicroUsd,
	currency,
	expiresAtLabel,
	flat,
}: {
	amountMicroUsd: number;
	currency: string;
	expiresAtLabel: string | null;
	flat: boolean;
}) {
	const details = [FREE_CREDIT_USAGE_LINE, expiresAtLabel].filter(Boolean);
	return (
		<div
			className={cn(
				"flex items-start justify-between gap-3 rounded-lg px-3 py-2.5",
				flat ? "bg-background/70" : "border bg-background/50"
			)}
		>
			<div className="min-w-0">
				<p className="break-words font-medium text-sm">Free credit</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					{details.join(" · ")}
				</p>
			</div>
			<span className="shrink-0 font-medium font-mono text-sm tabular-nums">
				{amountLabel(amountMicroUsd, currency)}
			</span>
		</div>
	);
}

/** One grouped card of hairline-separated rows (desktop Settings look). */
export function GroupedCard({
	rows,
}: {
	rows: { key: string; node: ReactNode }[];
}) {
	return (
		<ItemGroup appearance="settings-group" spacing="flush">
			{rows.map((row, index) => (
				<Fragment key={row.key}>
					{index > 0 ? <ItemSeparator className="my-0" /> : null}
					{row.node}
				</Fragment>
			))}
		</ItemGroup>
	);
}

export function GroupedRow({
	amount,
	amountClassName,
	detail,
	label,
	tooltip,
	tooltipLabel,
	trailing,
}: {
	amount: string;
	amountClassName?: string;
	detail?: string;
	label: string;
	tooltip?: string;
	tooltipLabel?: string;
	trailing?: ReactNode;
}) {
	const tl = useLiteralMessages();
	return (
		<Item purpose="settings-row" size="sm">
			<div className="flex w-full items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<p className="text-sm">{label}</p>
						{tooltip ? (
							<InfoTooltip
								label={
									tooltipLabel ??
									tl("About {label}", { label: label.toLowerCase() })
								}
							>
								{tooltip}
							</InfoTooltip>
						) : null}
					</div>
					{detail ? (
						<p className="text-muted-foreground text-xs leading-snug">
							{detail}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{trailing}
					<span
						className={cn(
							"font-medium font-mono tabular-nums",
							amountClassName ?? "text-sm"
						)}
					>
						{amount}
					</span>
				</div>
			</div>
		</Item>
	);
}

export const GROUPED_CAPTION_CLASS =
	"px-3.5 text-muted-foreground text-xs leading-snug";
