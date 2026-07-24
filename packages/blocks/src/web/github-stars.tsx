"use client";

import { cn } from "@ryu/ui/lib/utils";
import { GITHUB_SVGL, SvglIcon } from "./svgl-icon.tsx";

export interface GitHubStarsProps {
	className?: string;
	locales?: Intl.LocalesArgument;
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
		<span className={cn("inline-flex items-center gap-1", className)}>
			<SvglIcon className="size-4" spec={GITHUB_SVGL} />
			<span
				className="text-[0.8125rem]/none text-muted-foreground tabular-nums"
				style={{ textBox: "trim-end cap alphabetic" }}
			>
				{formatCompactCount(stargazersCount, locales)}
			</span>
		</span>
	);
}
