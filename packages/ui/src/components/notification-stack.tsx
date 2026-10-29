"use client";

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { SPRING_LAYOUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { MotionStyle } from "motion/react";
import { motion, type Transition, useReducedMotion } from "motion/react";
import {
	type FocusEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useRef,
	useState,
} from "react";
import drawingStyles from "./notification-stack.drawing.module.css";

interface NotificationCardStyle extends MotionStyle {
	"--notification-stack-1-border-left-color"?: MotionStyle["borderLeftColor"];
	"--notification-stack-1-grid-column"?: MotionStyle["gridColumn"];
	"--notification-stack-1-grid-row"?: MotionStyle["gridRow"];
	"--notification-stack-1-z-index"?: MotionStyle["zIndex"];
}

export interface NotificationStackItem {
	accent?: string;
	actions?: ReactNode;
	/** Activate this item on the first click even when the stack is collapsed. */
	activateCollapsed?: boolean;
	ariaLabel?: string;
	description?: ReactNode;
	id: string;
	leading?: ReactNode;
	muted?: boolean;
	onActivate?: () => void;
	title: ReactNode;
	trailing?: ReactNode;
	unread?: boolean;
}

export interface NotificationStackClassNames {
	card?: string;
	content?: string;
	description?: string;
	footer?: string;
	leading?: string;
	stack?: string;
	title?: string;
	trailing?: string;
}

export interface NotificationStackProps {
	className?: string;
	classNames?: NotificationStackClassNames;
	collapsedLabel?: string;
	defaultExpanded?: boolean;
	emptyLabel?: string;
	expanded?: boolean;
	expandedLabel?: string;
	items: NotificationStackItem[];
	maxVisible?: number;
	onExpandedChange?: (expanded: boolean) => void;
	onItemClick?: (item: NotificationStackItem) => void;
	onViewAll?: () => void;
}

const STACK_PEEK = 8;
const STACK_INSET = 12;

function useControllableExpanded({
	defaultExpanded,
	expanded,
	onExpandedChange,
}: {
	defaultExpanded: boolean;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
}) {
	const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
	const isControlled = expanded !== undefined;
	const value = expanded ?? internalExpanded;
	const setValue = useCallback(
		(next: boolean) => {
			if (!isControlled) {
				setInternalExpanded(next);
			}
			onExpandedChange?.(next);
		},
		[isControlled, onExpandedChange]
	);
	return [value, setValue] as const;
}

function NotificationCardContent({
	classNames,
	item,
}: {
	classNames?: NotificationStackClassNames;
	item: NotificationStackItem;
}) {
	return (
		<span
			className={cn(
				"flex min-w-0 items-start gap-2 py-3.5",
				classNames?.content
			)}
		>
			{item.leading && (
				<span
					className={cn(
						"mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-muted text-muted-foreground",
						classNames?.leading
					)}
				>
					{item.leading}
				</span>
			)}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-start justify-between gap-2">
					<span
						className={cn(
							"type-detail flex min-w-0 items-start gap-1.5 font-medium leading-snug",
							item.muted && "text-muted-foreground",
							classNames?.title
						)}
					>
						{item.unread && (
							<span
								aria-hidden="true"
								className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
							/>
						)}
						<span className="min-w-0 truncate">{item.title}</span>
					</span>
					{item.trailing && (
						<span
							className={cn(
								"type-compact shrink-0 text-muted-foreground/70 tabular-nums",
								classNames?.trailing
							)}
						>
							{item.trailing}
						</span>
					)}
				</span>
				{item.description && (
					<span
						className={cn(
							"type-caption line-clamp-2 text-muted-foreground leading-snug",
							classNames?.description
						)}
					>
						{item.description}
					</span>
				)}
			</span>
			{item.actions && (
				<span className="pointer-events-auto relative z-20 flex shrink-0 items-center gap-0.5">
					{item.actions}
				</span>
			)}
		</span>
	);
}

export function NotificationStack({
	className,
	classNames,
	collapsedLabel = "Notifications",
	defaultExpanded = false,
	emptyLabel = "All caught up",
	expanded,
	expandedLabel = "View all",
	items,
	maxVisible = 3,
	onExpandedChange,
	onItemClick,
	onViewAll,
}: NotificationStackProps) {
	const reduce = useReducedMotion();
	const tl = useLiteralMessages();
	const canHover = useHoverCapable();
	const hasFocus = useRef(false);
	const [isExpanded, setIsExpanded] = useControllableExpanded({
		defaultExpanded,
		expanded,
		onExpandedChange,
	});
	const visibleItems = items.slice(0, Math.max(1, maxVisible));
	const primaryItem = visibleItems[0];
	const transition: Transition = reduce ? { duration: 0 } : SPRING_LAYOUT;
	const cardTransition: Transition = reduce
		? { duration: 0 }
		: { duration: 0.32, ease: [0.16, 1, 0.3, 1] };

	if (!primaryItem) {
		return (
			<div
				className={cn(
					"flex w-full items-center justify-center gap-2 rounded-3xl bg-muted/70 px-5 py-8 font-medium text-muted-foreground text-sm",
					className
				)}
				role="status"
			>
				{emptyLabel}
			</div>
		);
	}

	const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
		if (event.currentTarget.contains(event.relatedTarget)) {
			return;
		}
		hasFocus.current = false;
		setIsExpanded(false);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") {
			return;
		}
		event.preventDefault();
		setIsExpanded(false);
	};

	const handleFooterClick = () => {
		if (!isExpanded) {
			setIsExpanded(true);
			return;
		}
		if (onViewAll) {
			onViewAll();
			return;
		}
		setIsExpanded(false);
	};

	const activateItem = (item: NotificationStackItem) => {
		if (!(isExpanded || item.activateCollapsed)) {
			setIsExpanded(true);
			return;
		}
		item.onActivate?.();
		onItemClick?.(item);
	};

	return (
		<div
			className={cn("relative w-full max-w-[22rem]", className)}
			onBlur={handleBlur}
			onFocus={() => {
				hasFocus.current = true;
				setIsExpanded(true);
			}}
			onKeyDown={handleKeyDown}
			onPointerEnter={() => {
				if (canHover) {
					setIsExpanded(true);
				}
			}}
			onPointerLeave={() => {
				if (canHover && !hasFocus.current) {
					setIsExpanded(false);
				}
			}}
		>
			{/* The invisible card reserves the compact footprint while the visible
			   cards are free to spring between the stacked and expanded layouts. */}
			<div aria-hidden="true" className="invisible block p-2">
				<div className="block rounded-2xl border border-transparent px-4">
					<NotificationCardContent classNames={classNames} item={primaryItem} />
				</div>
				<div className="mt-2 h-9" />
			</div>

			<div className="absolute inset-x-0 bottom-0 block p-2">
				<motion.div
					aria-hidden="true"
					className="absolute inset-0 rounded-3xl bg-muted"
					initial={false}
					layout
					transition={transition}
				/>
				<div
					className={cn(
						"relative z-10 grid gap-1",
						!isExpanded && "pb-2",
						classNames?.stack
					)}
				>
					{visibleItems.map((item, index) => {
						const isPrimary = index === 0;
						const interactive = Boolean(item.onActivate || onItemClick);
						const notificationCardStyle: NotificationCardStyle = {
							"--notification-stack-1-border-left-color": item.accent,
							"--notification-stack-1-grid-column": 1,
							"--notification-stack-1-grid-row": isExpanded ? index + 1 : 1,
							"--notification-stack-1-z-index": visibleItems.length - index,
						};
						return (
							<motion.div
								animate={{
									clipPath: isExpanded
										? "inset(0px 0px round 16px)"
										: `inset(0px ${index * STACK_INSET}px round 16px)`,
									y: isExpanded ? 0 : index * STACK_PEEK,
								}}
								className={cn(
									cn(
										"relative block rounded-2xl border border-border/60 bg-background/90 px-4",
										interactive && "cursor-pointer",
										item.muted && "opacity-80",
										classNames?.card
									),
									drawingStyles.notificationCard,
									// Unlayered module rules outrank the border utilities, so the
									// accent edge applies only to cards that set one.
									item.accent && drawingStyles.notificationAccent
								)}
								initial={false}
								key={item.id}
								layout="position"
								style={notificationCardStyle}
								transition={cardTransition}
							>
								{interactive && (
									<button
										aria-label={
											item.ariaLabel ??
											tl("Open {title}", { title: String(item.title) })
										}
										className="absolute inset-0 z-0 rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										onClick={() => activateItem(item)}
										type="button"
									/>
								)}
								<span
									className={cn(
										"pointer-events-none relative z-10 block",
										!(isPrimary || isExpanded) && "invisible"
									)}
								>
									<NotificationCardContent
										classNames={classNames}
										item={item}
									/>
								</span>
							</motion.div>
						);
					})}
				</div>
				<motion.div
					className={cn(
						"relative z-10 mt-2 flex min-h-9 items-center gap-2 px-1",
						classNames?.footer
					)}
					layout="position"
					transition={transition}
				>
					<span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary font-medium text-primary-foreground text-xs">
						{items.length}
					</span>
					<button
						aria-expanded={isExpanded}
						aria-label={
							isExpanded
								? tl("{count} notifications. {expandedLabel}.", {
										count: String(items.length),
										expandedLabel,
									})
								: tl("{count} notifications. Expand {collapsedLabel}.", {
										collapsedLabel: collapsedLabel.toLowerCase(),
										count: String(items.length),
									})
						}
						className="flex items-center gap-1 rounded-lg px-1 py-1 text-left font-medium text-foreground text-sm transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={handleFooterClick}
						type="button"
					>
						{isExpanded ? expandedLabel : collapsedLabel}
						{isExpanded && (
							<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
						)}
					</button>
				</motion.div>
			</div>
		</div>
	);
}
