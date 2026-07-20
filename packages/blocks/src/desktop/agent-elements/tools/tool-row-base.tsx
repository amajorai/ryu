import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
import { cn } from "@ryu/ui/lib/utils";
import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { TextShimmer } from "../text-shimmer.tsx";

export interface ToolRowBaseProps {
	children?: ReactNode;
	completeLabel: string;
	defaultOpen?: boolean;
	detail?: string;
	expandable?: boolean;
	expanded?: boolean;
	icon?: ReactNode;
	isAnimating: boolean;
	onToggleExpand?: () => void;
	shimmerLabel?: string;
	trailingContent?: ReactNode;
}

export function ToolRowBase({
	icon,
	shimmerLabel,
	completeLabel,
	isAnimating,
	detail,
	trailingContent,
	expandable = false,
	expanded,
	defaultOpen = false,
	onToggleExpand,
	children,
}: ToolRowBaseProps) {
	const isComplete = !isAnimating;
	const isExpanded = expanded ?? false;
	const canToggle = expandable && (isComplete || isExpanded || isAnimating);

	const row = (
		<div
			className={cn(
				"flex max-w-full select-none items-center gap-1 rounded-md",
				canToggle ? "cursor-pointer" : "cursor-default"
			)}
		>
			<div className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
				{icon && (
					<span className="flex size-3 shrink-0 items-center justify-center">
						{icon}
					</span>
				)}
				<span className="shrink-0 whitespace-nowrap font-[450]">
					{isAnimating && shimmerLabel ? (
						<TextShimmer
							as="span"
							className="m-0 inline-flex h-4 items-center leading-none"
							duration={1.2}
						>
							{shimmerLabel}
						</TextShimmer>
					) : (
						completeLabel
					)}
				</span>
				{detail && (
					<span className="min-w-0 flex-1 truncate font-normal text-muted-foreground/60">
						{detail}
					</span>
				)}
				{trailingContent}
			</div>
			{expandable && (isComplete || isExpanded || isAnimating) && (
				<div>
					<IconChevronRight
						className={cn(
							"shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
							"size-3",
							"rotate-0 group-data-panel-open:rotate-90"
						)}
					/>
				</div>
			)}
		</div>
	);

	if (!expandable) {
		return <div className="flex flex-col gap-1">{row}</div>;
	}

	const rootProps =
		expanded === undefined
			? { defaultOpen }
			: { open: expanded, onOpenChange: onToggleExpand };

	return (
		<Collapsible className="flex w-full flex-col gap-2" {...rootProps}>
			<CollapsibleTrigger
				aria-disabled={!canToggle}
				className="group flex"
				disabled={!canToggle}
			>
				{row}
			</CollapsibleTrigger>
			<CollapsibleContent
				className={cn(
					"overflow-hidden",
					"h-[var(--collapsible-panel-height)] transition-all duration-150 ease-out",
					"data-ending-style:h-0 data-starting-style:h-0",
					"[&[hidden]:not([hidden='until-found'])]:hidden"
				)}
			>
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
