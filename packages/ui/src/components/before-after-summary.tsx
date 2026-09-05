import { Badge } from "@ryu/ui/components/badge.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ArrowRight } from "lucide-react";

export interface BeforeAfterSummaryItem {
	amount: string;
	detail?: string;
	eyebrow: string;
	label: string;
}

export interface BeforeAfterSummaryFooter {
	detail?: string;
	label: string;
	value: string;
}

export interface BeforeAfterSummaryProps {
	className?: string;
	current: BeforeAfterSummaryItem;
	footer?: BeforeAfterSummaryFooter;
	next: BeforeAfterSummaryItem;
}

/**
 * A compact money-moving preview shared by billing surfaces. The two columns
 * answer the only question a confirmation step should ask: what do I have now,
 * and what will I have after I continue?
 */
export function BeforeAfterSummary({
	className,
	current,
	footer,
	next,
}: BeforeAfterSummaryProps) {
	return (
		<div
			aria-label={`${current.eyebrow}: ${current.label}, ${current.amount}. ${next.eyebrow}: ${next.label}, ${next.amount}.`}
			className={cn(
				"rounded-3xl border border-border/80 bg-muted/20 p-3.5 shadow-sm",
				className
			)}
			data-slot="before-after-summary"
			role="group"
		>
			<div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
				<SummarySide item={current} />
				<ArrowRight
					aria-hidden="true"
					className="size-4 text-muted-foreground/70"
				/>
				<SummarySide accent item={next} />
			</div>
			{footer ? (
				<div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-border/70 border-t pt-3">
					<span className="text-muted-foreground text-xs">{footer.label}</span>
					<span className="font-medium text-sm">{footer.value}</span>
					{footer.detail ? (
						<span className="basis-full text-muted-foreground text-xs">
							{footer.detail}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function SummarySide({
	accent = false,
	item,
}: {
	accent?: boolean;
	item: BeforeAfterSummaryItem;
}) {
	return (
		<div
			className={cn(
				"min-w-0 rounded-2xl px-2.5 py-2",
				accent && "border border-primary/25 bg-primary/5"
			)}
		>
			<Badge
				className={cn(
					"mb-2 max-w-full truncate",
					accent && "bg-primary/15 text-primary dark:bg-primary/20"
				)}
				variant={accent ? "default" : "secondary"}
			>
				{item.eyebrow}
			</Badge>
			<p className="break-words font-medium font-mono text-lg tabular-nums leading-tight sm:text-xl">
				{item.amount}
			</p>
			<p className="mt-0.5 truncate font-medium text-sm">{item.label}</p>
			{item.detail ? (
				<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
					{item.detail}
				</p>
			) : null}
		</div>
	);
}
