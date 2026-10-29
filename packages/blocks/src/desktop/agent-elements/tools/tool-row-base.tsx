import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { IconChevronRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { TextShimmer } from "../text-shimmer.tsx";
import styles from "./tool-row-base.module.css";
import { ToolTiming } from "./tool-timing.tsx";

export interface ToolRowBaseProps {
	children?: ReactNode;
	completeLabel: string;
	defaultOpen?: boolean;
	detail?: string;
	expandable?: boolean;
	expanded?: boolean;
	icon?: ReactNode;
	isAnimating: boolean;
	/**
	 * Replaces the 12px `icon` slot wholesale, for a leading element that has to
	 * size itself — the live status row's stack of agent avatars, say, which is
	 * both taller than a glyph and as wide as the number of agents running.
	 * Mutually exclusive with `icon`; when set, `icon` is ignored.
	 */
	leading?: ReactNode;
	onToggleExpand?: () => void;
	shimmerLabel?: string;
	/**
	 * Set false to suppress the elapsed/took badge for a row where it would be
	 * noise rather than information — a row that represents state rather than
	 * work, for instance. Defaults on: every tool call is worth timing, and the
	 * badge hides itself anyway when there is nothing honest to show.
	 */
	showTiming?: boolean;
	trailingContent?: ReactNode;
}

export function ToolRowBase({
	icon,
	leading,
	shimmerLabel,
	completeLabel,
	isAnimating,
	detail,
	trailingContent,
	expandable = false,
	expanded,
	defaultOpen = false,
	onToggleExpand,
	showTiming = true,
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
				{leading ??
					(icon && (
						<span className="flex size-3 shrink-0 items-center justify-center">
							{icon}
						</span>
					))}
				<span className={styles.label}>
					{isAnimating && shimmerLabel ? (
						<TextShimmer
							as="span"
							className="m-0 inline-flex h-4 items-center leading-none"
							duration={0.9}
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
				{/* Last in the row so a ticking counter grows into empty space
				    instead of pushing the label and detail around. */}
				{showTiming && <ToolTiming isRunning={isAnimating} />}
			</div>
			{expandable && (isComplete || isExpanded || isAnimating) && (
				<div>
					<IconChevronRight
						className={cn(
							"shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
							"size-3",
							styles.chevron
						)}
					/>
				</div>
			)}
		</div>
	);

	const localizedRow = useLocalizedText(row, { literal: true });
	if (!expandable) {
		return <div className="flex flex-col gap-1">{row}</div>;
	}

	const rootProps =
		expanded === undefined
			? { defaultOpen }
			: { open: expanded, onOpenChange: onToggleExpand };

	return (
		<CollapsiblePrimitive.Root
			className="flex w-full flex-col gap-2"
			data-slot="collapsible"
			{...rootProps}
		>
			<CollapsiblePrimitive.Trigger
				aria-disabled={!canToggle}
				className="group flex"
				data-slot="collapsible-trigger"
				disabled={!canToggle}
			>
				{localizedRow}
			</CollapsiblePrimitive.Trigger>
			<CollapsiblePrimitive.Panel
				className={styles.panel}
				data-slot="collapsible-content"
			>
				{children}
			</CollapsiblePrimitive.Panel>
		</CollapsiblePrimitive.Root>
	);
}
