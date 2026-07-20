import { SplitIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import type React from "react";

/**
 * A conversation checkpoint marker, mirroring the AI SDK "Checkpoint" element.
 * In Ryu a checkpoint is non-destructive: restoring branches a new chat from
 * this point via the existing fork endpoint (POST /conversations/:id/fork),
 * leaving the original thread intact. Renders as a hairline divider with a
 * centered restore trigger.
 */
export function Checkpoint({
	children,
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex select-none items-center gap-2 py-0.5", className)}
			{...props}
		>
			<div className="h-px flex-1 bg-border/60" />
			{children}
			<div className="h-px flex-1 bg-border/60" />
		</div>
	);
}

export function CheckpointIcon({
	children,
	className,
}: {
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"flex size-3 shrink-0 items-center justify-center text-muted-foreground",
				className
			)}
		>
			{children ?? (
				<HugeiconsIcon className="size-3 rotate-90" icon={SplitIcon} />
			)}
		</span>
	);
}

export interface CheckpointTriggerProps
	extends Omit<React.ComponentProps<"button">, "children"> {
	children?: React.ReactNode;
	tooltip?: string;
}

export function CheckpointTrigger({
	children = "Restore checkpoint",
	tooltip,
	className,
	...props
}: CheckpointTriggerProps) {
	return (
		<button
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-muted-foreground text-xs transition-colors hover:border-primary/40 hover:text-foreground",
				className
			)}
			title={tooltip}
			type="button"
			{...props}
		>
			{children}
		</button>
	);
}
