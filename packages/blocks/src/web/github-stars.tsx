"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { Star } from "lucide-react";

export interface GitHubStarsProps {
	className?: string;
	/**
	 * Optional locales for number formatting.
	 * @defaultValue "en-US"
	 */
	locales?: Intl.LocalesArgument;
	/** Number of stars to display. */
	stargazersCount: number;
}

function formatCompactCount(
	count: number,
	locales: Intl.LocalesArgument
): string {
	return new Intl.NumberFormat(locales, {
		notation: "compact",
		compactDisplay: "short",
	})
		.format(count)
		.toLowerCase();
}

export function GitHubStars({
	stargazersCount,
	locales = "en-US",
	className,
}: GitHubStarsProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				className={cn("inline-flex items-center gap-1", className)}
				render={<span />}
			>
				<Star
					aria-hidden
					className="size-3.5 fill-amber-400 text-amber-400"
					strokeWidth={1.5}
				/>
				<span
					className="text-[0.8125rem]/none text-muted-foreground tabular-nums"
					style={{ textBox: "trim-end cap alphabetic" }}
				>
					{formatCompactCount(stargazersCount, locales)}
				</span>
			</TooltipTrigger>
			<TooltipContent className="tabular-nums">
				{new Intl.NumberFormat(locales).format(stargazersCount)} stars
			</TooltipContent>
		</Tooltip>
	);
}
