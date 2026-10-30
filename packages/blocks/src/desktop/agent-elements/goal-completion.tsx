"use client";

import { CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { formatDateTime, formatTime } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils";
import { formatGoalElapsed } from "./goal-message.ts";
import {
	MESSAGE_TIME_OPTIONS,
	MESSAGE_TOOLTIP_OPTIONS,
} from "./user-message.tsx";

interface GoalCompletionProps {
	completedAt: Date | null;
	elapsedMs: number;
}

/** Compact end-of-turn status matching the goal bar's success icon and timing. */
export function GoalCompletionFooter({
	completedAt,
	elapsedMs,
}: GoalCompletionProps) {
	return (
		<div
			className="inline-flex min-w-0 items-center gap-3"
			data-slot="goal-completion"
			data-testid="goal-completion"
		>
			<span className="inline-flex min-w-0 items-center gap-1.5">
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
				<span className="truncate">
					Goal achieved in{" "}
					<span className="tabular-nums">{formatGoalElapsed(elapsedMs)}</span>
				</span>
			</span>
			{completedAt ? (
				<TooltipProvider delay={0}>
					<Tooltip>
						<TooltipTrigger
							render={
								<span
									className={cn(
										"inline-flex shrink-0 text-muted-foreground",
										"tabular-nums"
									)}
									data-testid="goal-completion-time"
								>
									{formatTime(completedAt, MESSAGE_TIME_OPTIONS)}
								</span>
							}
						/>
						<TooltipContent>
							<p>{formatDateTime(completedAt, MESSAGE_TOOLTIP_OPTIONS)}</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : null}
		</div>
	);
}
