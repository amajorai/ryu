"use client";

// Adapted from beui.dev/components/blocks/overflow-actions

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { MoreHorizontal, X } from "lucide-react";
import {
	AnimatePresence,
	motion,
	type Transition,
	useReducedMotion,
	type Variants,
} from "motion/react";
import {
	type ReactNode,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export type OverflowActionsSize = "sm" | "md";

export interface OverflowActionItem {
	ariaLabel?: string;
	/** Per-item class override — useful for marking a selected option. */
	className?: string;
	disabled?: boolean;
	icon?: ReactNode;
	id: string;
	label: ReactNode;
	onClick?: () => void;
}

export interface OverflowActionsClassNames {
	action?: string;
	icon?: string;
	label?: string;
	overflowAction?: string;
	primaryAction?: string;
	root?: string;
	toggle?: string;
	track?: string;
}

export interface OverflowActionsProps {
	className?: string;
	classNames?: OverflowActionsClassNames;
	closeLabel?: string;
	collapseOnAction?: boolean;
	defaultExpanded?: boolean;
	expanded?: boolean;
	onAction?: (item: OverflowActionItem) => void;
	onExpandedChange?: (expanded: boolean) => void;
	openLabel?: string;
	overflowActions: OverflowActionItem[];
	primaryActions: OverflowActionItem[];
	size?: OverflowActionsSize;
}

// This needs a softer layout spring than the app defaults so the overflow group
// stays visually attached to the toggle while entering and leaving.
const SHELL_TRANSITION: Transition = {
	type: "spring",
	stiffness: 220,
	damping: 17,
	mass: 0.85,
};

const ICON_VARIANTS: Variants = {
	hidden: { opacity: 0, filter: "blur(3px)" },
	visible: {
		opacity: 1,
		filter: "blur(0px)",
		transition: { duration: 0.18, ease: EASE_OUT },
	},
	exit: {
		opacity: 0,
		filter: "blur(3px)",
		transition: { duration: 0.18, ease: EASE_OUT },
	},
};

const OVERFLOW_ACTION_VARIANTS: Variants = {
	hidden: { opacity: 0, filter: "blur(4px)" },
	visible: { opacity: 1, filter: "blur(0px)" },
	exit: { opacity: 0, filter: "blur(4px)" },
};

const TRACK_SIZE_CLASS: Record<OverflowActionsSize, string> = {
	sm: "gap-1 p-1 text-xs",
	md: "gap-1.5 p-1.5 text-sm",
};

const GROUP_GAP_CLASS: Record<OverflowActionsSize, string> = {
	sm: "gap-1",
	md: "gap-1.5",
};

const ACTION_SIZE_CLASS: Record<OverflowActionsSize, string> = {
	sm: "h-8 min-w-8 gap-1.5 px-3",
	md: "h-9 min-w-9 gap-2 px-3.5",
};

const TOGGLE_SIZE_CLASS: Record<OverflowActionsSize, string> = {
	sm: "h-8 w-8",
	md: "h-9 w-9",
};

const ICON_SIZE_CLASS: Record<OverflowActionsSize, string> = {
	sm: "h-3.5 w-3.5",
	md: "h-4 w-4",
};

function useControllableExpanded({
	expanded,
	defaultExpanded,
	onExpandedChange,
}: {
	expanded?: boolean;
	defaultExpanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
}) {
	const [internalExpanded, setInternalExpanded] = useState(
		defaultExpanded ?? false
	);
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

export function OverflowActions({
	primaryActions,
	overflowActions,
	expanded,
	defaultExpanded = false,
	onExpandedChange,
	onAction,
	collapseOnAction = false,
	size = "md",
	openLabel = "Show extra actions",
	closeLabel = "Hide extra actions",
	className,
	classNames,
}: OverflowActionsProps) {
	const reduce = useReducedMotion();
	const canHover = useHoverCapable();
	const overflowId = useId();
	const overflowWrapperRef = useRef<HTMLDivElement>(null);
	const overflowWrapperLeftRef = useRef(0);
	const [isExpanded, setIsExpanded] = useControllableExpanded({
		expanded,
		defaultExpanded,
		onExpandedChange,
	});

	const transition = reduce ? { duration: 0 } : SHELL_TRANSITION;

	useLayoutEffect(() => {
		const overflowNode = overflowWrapperRef.current;
		if (!overflowNode) {
			return;
		}

		if (isExpanded) {
			overflowNode.style.left = "";
			overflowWrapperLeftRef.current =
				overflowNode.getBoundingClientRect().left;
			return;
		}

		overflowNode.style.left = `${
			overflowWrapperLeftRef.current - overflowNode.getBoundingClientRect().left
		}px`;
	}, [isExpanded]);

	const handleAction = (item: OverflowActionItem) => {
		item.onClick?.();
		onAction?.(item);
		if (collapseOnAction) {
			setIsExpanded(false);
		}
	};

	return (
		<motion.div
			className={cn("inline-flex", classNames?.root, className)}
			layout
			transition={transition}
		>
			<motion.div
				className={cn(
					"relative inline-flex items-center overflow-hidden rounded-full border border-border bg-card",
					TRACK_SIZE_CLASS[size],
					classNames?.track
				)}
				layout
				transition={transition}
			>
				<motion.div
					className={cn("inline-flex items-center", GROUP_GAP_CLASS[size])}
					layout
					transition={transition}
				>
					{primaryActions.map((item) => (
						<ActionButton
							canHover={canHover}
							className={cn(classNames?.action, classNames?.primaryAction)}
							iconClassName={classNames?.icon}
							item={item}
							key={item.id}
							labelClassName={classNames?.label}
							layoutTransition={transition}
							onAction={handleAction}
							reduce={reduce}
							size={size}
						/>
					))}
				</motion.div>

				<AnimatePresence initial={false} mode="popLayout">
					{isExpanded ? (
						<motion.div
							aria-hidden={!isExpanded}
							className={cn(
								"relative inline-flex w-max items-center",
								GROUP_GAP_CLASS[size]
							)}
							id={overflowId}
							key="overflow-actions"
							layout
							ref={overflowWrapperRef}
							transition={transition}
						>
							{overflowActions.map((item) => (
								<ActionButton
									canHover={canHover}
									className={cn(classNames?.action, classNames?.overflowAction)}
									iconClassName={classNames?.icon}
									item={item}
									key={item.id}
									labelClassName={classNames?.label}
									layoutTransition={transition}
									onAction={handleAction}
									overflow
									reduce={reduce}
									size={size}
									variants={OVERFLOW_ACTION_VARIANTS}
									visible={isExpanded}
								/>
							))}
						</motion.div>
					) : null}
				</AnimatePresence>

				<motion.button
					aria-controls={isExpanded ? overflowId : undefined}
					aria-expanded={isExpanded}
					aria-label={isExpanded ? closeLabel : openLabel}
					className={cn(
						"relative inline-grid shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none disabled:pointer-events-none disabled:opacity-50",
						"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
						TOGGLE_SIZE_CLASS[size],
						classNames?.toggle
					)}
					layout
					onClick={() => setIsExpanded(!isExpanded)}
					title={isExpanded ? closeLabel : openLabel}
					transition={transition}
					type="button"
					whileHover={reduce || !canHover ? undefined : { scale: 1.03 }}
					whileTap={reduce ? undefined : { scale: 0.96 }}
				>
					<AnimatePresence initial={false} mode="popLayout">
						<motion.span
							animate={reduce ? { opacity: 1 } : "visible"}
							className="inline-grid place-items-center"
							exit={reduce ? { opacity: 0 } : "exit"}
							initial={reduce ? { opacity: 0 } : "hidden"}
							key={isExpanded ? "close" : "open"}
							variants={ICON_VARIANTS}
						>
							{isExpanded ? (
								<X className={ICON_SIZE_CLASS[size]} />
							) : (
								<MoreHorizontal className={ICON_SIZE_CLASS[size]} />
							)}
						</motion.span>
					</AnimatePresence>
				</motion.button>
			</motion.div>
		</motion.div>
	);
}

function variantState(
	variants: Variants | undefined,
	reduce: boolean | null,
	key: "hidden" | "visible" | "exit",
	reducedOpacity: number
) {
	if (!variants) {
		return;
	}
	return reduce ? { opacity: reducedOpacity } : key;
}

function ActionButton({
	item,
	size,
	reduce,
	canHover,
	overflow,
	visible = true,
	variants,
	onAction,
	layoutTransition,
	className,
	iconClassName,
	labelClassName,
}: {
	item: OverflowActionItem;
	size: OverflowActionsSize;
	reduce: boolean | null;
	canHover: boolean;
	overflow?: boolean;
	visible?: boolean;
	variants?: Variants;
	onAction: (item: OverflowActionItem) => void;
	layoutTransition: Transition;
	className?: string;
	iconClassName?: string;
	labelClassName?: string;
}) {
	const label = typeof item.label === "string" ? item.label : undefined;
	const allowHoverScale = !(reduce || !canHover || item.disabled);

	return (
		<motion.span
			animate={variantState(variants, reduce, "visible", 1)}
			className="inline-flex shrink-0"
			exit={variantState(variants, reduce, "exit", 0)}
			initial={variantState(variants, reduce, "hidden", 0)}
			layout="position"
			transition={layoutTransition}
			variants={variants}
			whileHover={allowHoverScale ? { scale: 1.008 } : undefined}
			whileTap={reduce || item.disabled ? undefined : { scale: 0.97 }}
		>
			<button
				aria-label={item.ariaLabel}
				className={cn(
					"inline-flex shrink-0 items-center justify-center rounded-full bg-background font-medium text-foreground outline-none",
					"disabled:pointer-events-none disabled:opacity-45",
					"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					ACTION_SIZE_CLASS[size],
					className,
					item.className
				)}
				disabled={item.disabled}
				onClick={() => onAction(item)}
				tabIndex={overflow && !visible ? -1 : undefined}
				title={label}
				type="button"
			>
				{item.icon ? (
					<span
						className={cn(
							"inline-flex shrink-0 items-center justify-center",
							ICON_SIZE_CLASS[size],
							iconClassName
						)}
					>
						{item.icon}
					</span>
				) : null}
				<span className={cn("whitespace-nowrap", labelClassName)}>
					{item.label}
				</span>
			</button>
		</motion.span>
	);
}
