import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

export interface StatCardProps {
	chart?: ReactNode;
	className?: string;
	icon?: ReactNode;
	sub?: ReactNode;
	title: string;
	value: ReactNode;
}

export function StatCard({
	chart,
	className,
	title,
	value,
	sub,
	icon,
}: StatCardProps) {
	return (
		<div
			className={cn(
				"flex flex-col gap-1 rounded-4xl border border-border bg-card p-4 text-card-foreground",
				className
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-muted-foreground text-sm">
					{title}
				</span>
				{icon ? (
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
					>
						{icon}
					</span>
				) : null}
			</div>
			<span className="font-heading font-medium text-2xl text-foreground tabular-nums">
				{value}
			</span>
			{sub ? (
				<span className="text-muted-foreground text-sm">{sub}</span>
			) : null}
			{chart ? <div className="mt-auto pt-2">{chart}</div> : null}
		</div>
	);
}
