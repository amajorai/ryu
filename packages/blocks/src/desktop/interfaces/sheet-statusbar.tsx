import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { SheetStatusMark } from "./sheet-cells.tsx";

function StatusTab({
	active,
	children,
	count,
	compact = false,
	hideCount = false,
	label,
	onSelect,
}: {
	active: boolean;
	children?: ReactNode;
	/** Drop the visible label in narrow sheets; a tooltip and the accessible name keep it. */
	compact?: boolean;
	count: number;
	/** Leave the count to the accessible name, e.g. when the summary row already states it. */
	hideCount?: boolean;
	label: string;
	onSelect: () => void;
}) {
	const inner = (
		<>
			{active ? (
				<motion.span
					aria-hidden="true"
					className="absolute inset-0 rounded-sm bg-muted"
					layoutId="sheet-status-tab"
					transition={{ duration: 0.12, ease: "easeOut" }}
				/>
			) : null}
			<span className="relative flex items-center gap-1.5">
				{children}
				{compact ? null : (
					<span className={cn(active && "font-medium")}>{label}</span>
				)}
				<span
					className={cn(
						"tabular-nums",
						hideCount && "hidden",
						active ? "text-foreground/70" : "text-muted-foreground"
					)}
				>
					{count}
				</span>
			</span>
		</>
	);
	const buttonProps = {
		"aria-label": `${label}: ${count}`,
		"aria-pressed": active,
		className: cn(
			"relative flex h-6 shrink-0 items-center gap-1.5 rounded-sm text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
			compact ? "px-1.5" : "px-2",
			active && "text-foreground",
			!active && "hover:bg-muted/60 hover:text-foreground",
			!active && (count === 0 ? "text-muted-foreground" : "text-foreground/80")
		),
		onClick: onSelect,
		type: "button",
	} as const;
	if (!compact) {
		return <button {...buttonProps}>{inner}</button>;
	}
	return (
		<Tooltip>
			<TooltipTrigger render={<button {...buttonProps} />}>
				{inner}
			</TooltipTrigger>
			<TooltipContent side="top">
				{label} · {count}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The sheet's footer: status tabs that double as the per-status summary and a
 * one-click filter. The record count and column totals live in the grid's
 * summary row, under their own columns.
 */
export function SheetStatusBar({
	compact,
	counts,
	onStatus,
	status,
	total,
}: {
	/** True when the grid is too narrow for labelled status tabs. */
	compact: boolean;
	counts: Record<ThreadStatus, number>;
	onStatus: (status: ThreadStatus | null) => void;
	status: ThreadStatus | null;
	total: number;
}) {
	return (
		<footer className="flex h-10 shrink-0 items-center gap-3 border-border border-t bg-background ps-3 pe-3">
			<div
				aria-label="Filter by status"
				className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
				role="group"
			>
				<StatusTab
					active={status === null}
					count={total}
					hideCount
					label="All"
					onSelect={() => onStatus(null)}
				/>
				{THREAD_STATUS_ORDER.filter(
					// Empty statuses drop out, like a grouped view's empty groups;
					// the active one stays so it can be switched off.
					(item) => counts[item] > 0 || status === item
				).map((item) => (
					<StatusTab
						active={status === item}
						compact={compact}
						count={counts[item]}
						key={item}
						label={THREAD_STATUS_LABELS[item]}
						onSelect={() => onStatus(status === item ? null : item)}
					>
						<SheetStatusMark status={item} />
					</StatusTab>
				))}
			</div>
		</footer>
	);
}
