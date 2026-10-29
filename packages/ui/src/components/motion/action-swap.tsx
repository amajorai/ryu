"use client";

import type { CSSProperties } from "react";
import css from "./action-swap.module.css";

interface Inline1Style extends CSSProperties {
	"--action-swap-1-transition"?: CSSProperties["transition"];
	"--action-swap-1-width"?: CSSProperties["width"];
}

import {
	EASE_OUT,
	EASE_OUT_CSS,
	SPRING_PRESS,
	SPRING_SWAP,
} from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	type HTMLMotionProps,
	motion,
	useReducedMotion,
	type Variants,
} from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { isNativeText } from "../../lib/native-primitive-observation.ts";

export interface ActionSwapItem {
	ariaLabel?: string;
	icon?: ReactNode;
	id: string;
	label: ReactNode;
}

export type ActionSwapButtonVariant =
	| "primary"
	| "secondary"
	| "outline"
	| "ghost";
export type ActionSwapButtonSize = "sm" | "md" | "lg" | "icon";
export type ActionSwapAnimation = "blur" | "roll" | "cascade";

/** Animations with a single-element variant set (cascade animates per letter). */
type CoreAnimation = "blur" | "roll";

export interface ActionSwapButtonProps
	extends Omit<HTMLMotionProps<"button">, "children" | "onChange"> {
	animation?: ActionSwapAnimation;
	cycle?: boolean;
	defaultValue?: string;
	iconOnly?: boolean;
	items: ActionSwapItem[];
	onValueChange?: (value: string, item: ActionSwapItem) => void;
	size?: ActionSwapButtonSize;
	value?: string;
	variant?: ActionSwapButtonVariant;
}

export interface ActionSwapTextProps {
	animation?: ActionSwapAnimation;
	children: ReactNode;
	className?: string;
	value: string;
}

export interface ActionSwapIconProps {
	animation?: ActionSwapAnimation;
	children: ReactNode;
	className?: string;
	value: string;
}

const BLUR_TRANSITION = { duration: 0.2, ease: "easeInOut" } as const;
const ROLL_TRANSITION = SPRING_SWAP;
const ROLL_EXIT_TRANSITION = { duration: 0.14, ease: EASE_OUT } as const;
const SWAP_BLUR = "blur(8px)";
const ROLL_BLUR = "blur(3px)";

// Cascade rolls the label one letter at a time, left to right. The leaving
// and landing strings overlap as independent layers (no shared cells), so
// proportional glyph widths never jitter. Exits cascade at half the enter
// stagger so the tail of the old label lingers briefly.
const CASCADE_STAGGER = 0.025;

const CASCADE_LETTER_VARIANTS: Variants = {
	initial: { opacity: 0, y: "105%", filter: ROLL_BLUR },
	animate: (delay = 0) => ({
		opacity: 1,
		y: "0%",
		filter: "blur(0px)",
		transition: { ...SPRING_SWAP, delay },
	}),
	exit: (delay = 0) => ({
		opacity: 0,
		y: "-105%",
		filter: ROLL_BLUR,
		transition: { duration: 0.16, ease: EASE_OUT, delay: delay * 0.5 },
	}),
};

const TEXT_VARIANTS = {
	blur: {
		initial: { opacity: 0, scale: 0.94, filter: SWAP_BLUR },
		animate: {
			opacity: 1,
			scale: 1,
			filter: "blur(0px)",
			transition: BLUR_TRANSITION,
		},
		exit: {
			opacity: 0,
			scale: 0.94,
			filter: SWAP_BLUR,
			transition: BLUR_TRANSITION,
		},
	},
	roll: {
		initial: { opacity: 0, y: "90%", filter: ROLL_BLUR },
		animate: {
			opacity: 1,
			y: "0%",
			filter: "blur(0px)",
			transition: ROLL_TRANSITION,
		},
		exit: {
			opacity: 0,
			y: "-90%",
			filter: ROLL_BLUR,
			transition: ROLL_EXIT_TRANSITION,
		},
	},
} satisfies Record<CoreAnimation, Variants>;

const ICON_VARIANTS = {
	blur: {
		initial: { opacity: 0, scale: 0.25, filter: SWAP_BLUR },
		animate: {
			opacity: 1,
			scale: 1,
			filter: "blur(0px)",
			transition: BLUR_TRANSITION,
		},
		exit: {
			opacity: 0,
			scale: 0.25,
			filter: SWAP_BLUR,
			transition: BLUR_TRANSITION,
		},
	},
	roll: {
		initial: { opacity: 0, y: 12, filter: ROLL_BLUR },
		animate: {
			opacity: 1,
			y: 0,
			filter: "blur(0px)",
			transition: ROLL_TRANSITION,
		},
		exit: {
			opacity: 0,
			y: -12,
			filter: ROLL_BLUR,
			transition: ROLL_EXIT_TRANSITION,
		},
	},
} satisfies Record<CoreAnimation, Variants>;

const VARIANT_CLASS = {
	primary: "bg-primary text-primary-foreground hover:bg-primary/90",
	secondary: "border border-border bg-card text-foreground hover:border-border",
	outline:
		"border border-border bg-transparent text-foreground hover:bg-primary/5",
	ghost: "text-muted-foreground hover:bg-primary/5 hover:text-foreground",
} satisfies Record<ActionSwapButtonVariant, string>;

const SIZE_CLASS = {
	sm: "h-8 gap-1.5 rounded-full px-3 text-xs",
	md: "h-10 gap-2 rounded-full px-4 text-sm",
	lg: "h-12 gap-2.5 rounded-full px-5 text-base",
	icon: "h-10 w-10 rounded-full",
} satisfies Record<ActionSwapButtonSize, string>;

export function ActionSwapText({
	value,
	children,
	animation = "blur",
	className,
}: ActionSwapTextProps) {
	const reduce = useReducedMotion();
	const measureRef = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState<number>();

	useLayoutEffect(() => {
		const nextWidth = measureRef.current?.offsetWidth;
		if (!nextWidth) {
			return;
		}
		setWidth((currentWidth) =>
			currentWidth === nextWidth ? currentWidth : nextWidth
		);
	});

	// Cascade needs a plain string to split into letters; non-string content
	// and reduced motion fall back to the closest single-element animation.
	const label = isNativeText(children) ? children : null;
	const cascade = animation === "cascade" && label !== null && !reduce;
	const coreAnimation: CoreAnimation =
		animation === "cascade" ? "roll" : animation;

	const inline1Style: Inline1Style = {
		"--action-swap-1-width": width === undefined ? undefined : `${width}px`,
		"--action-swap-1-transition": reduce
			? undefined
			: `width 220ms ${EASE_OUT_CSS}`,
	};
	return (
		<span
			className={[
				css.inline1,
				cn(
					"relative inline-block overflow-hidden whitespace-nowrap align-bottom",
					className
				),
			].join(" ")}
			style={inline1Style}
		>
			<span
				aria-hidden
				className="invisible inline-block whitespace-nowrap"
				ref={measureRef}
			>
				{children}
			</span>
			{cascade ? (
				<>
					{/* Letters are decorative fragments; readers get the whole label. */}
					<span className="sr-only">{label}</span>
					<AnimatePresence initial={false}>
						<motion.span
							animate="animate"
							aria-hidden
							className="absolute top-0 left-0 inline-block whitespace-pre"
							exit="exit"
							initial="initial"
							key={`cascade-${value}`}
						>
							{label.split("").map((char, i) => (
								<motion.span
									className="inline-block whitespace-pre will-change-[opacity,filter,transform]"
									custom={i * CASCADE_STAGGER}
									key={i}
									variants={CASCADE_LETTER_VARIANTS}
								>
									{char}
								</motion.span>
							))}
						</motion.span>
					</AnimatePresence>
				</>
			) : (
				<AnimatePresence initial={false}>
					<motion.span
						animate={
							reduce
								? { opacity: 1, filter: "blur(0px)", scale: 1, y: 0 }
								: "animate"
						}
						className="absolute top-0 left-0 inline-block will-change-[opacity,filter,transform]"
						exit={reduce ? undefined : "exit"}
						initial={reduce ? false : "initial"}
						key={`${animation}-${value}`}
						variants={TEXT_VARIANTS[coreAnimation]}
					>
						{children}
					</motion.span>
				</AnimatePresence>
			)}
		</span>
	);
}

export function ActionSwapIcon({
	value,
	children,
	animation = "blur",
	className,
}: ActionSwapIconProps) {
	const reduce = useReducedMotion();
	// Icons are single elements — cascade maps to its closest motion, roll.
	const coreAnimation: CoreAnimation =
		animation === "cascade" ? "roll" : animation;

	return (
		<span
			className={cn(
				"relative inline-grid shrink-0 place-items-center overflow-hidden",
				className
			)}
		>
			<AnimatePresence initial={false} mode="popLayout">
				<motion.span
					animate={
						reduce
							? { opacity: 1, filter: "blur(0px)", scale: 1, y: 0 }
							: "animate"
					}
					aria-hidden
					className="col-start-1 row-start-1 inline-flex items-center justify-center will-change-[opacity,filter,transform]"
					exit={reduce ? undefined : "exit"}
					initial={reduce ? false : "initial"}
					key={`${animation}-${value}`}
					variants={ICON_VARIANTS[coreAnimation]}
				>
					{children}
				</motion.span>
			</AnimatePresence>
		</span>
	);
}

export function ActionSwapButton({
	items,
	value,
	defaultValue,
	onValueChange,
	variant = "secondary",
	size = "md",
	animation = "blur",
	iconOnly = size === "icon",
	cycle = true,
	className,
	disabled,
	onClick,
	...rest
}: ActionSwapButtonProps) {
	const reduce = useReducedMotion();
	const [internalValue, setInternalValue] = useState(
		defaultValue ?? items[0]?.id
	);
	const currentValue = value ?? internalValue;
	const activeIndex = Math.max(
		0,
		items.findIndex((item) => item.id === currentValue)
	);
	const activeItem = items[activeIndex] ?? items[0];
	const hasIcon = items.some((item) => item.icon);
	const nextItem =
		cycle && items.length > 0
			? items[(activeIndex + 1) % items.length]
			: undefined;

	if (!activeItem) {
		return null;
	}

	const accessibleLabel =
		activeItem.ariaLabel ??
		(iconOnly && isNativeText(activeItem.label) ? activeItem.label : undefined);

	return (
		<motion.button
			aria-label={accessibleLabel}
			className={cn(
				"inline-flex items-center justify-center overflow-hidden font-medium transition-colors",
				"disabled:pointer-events-none disabled:opacity-50",
				VARIANT_CLASS[variant],
				SIZE_CLASS[size],
				className
			)}
			disabled={disabled}
			onClick={(event) => {
				onClick?.(event);
				if (event.defaultPrevented || disabled || !cycle || !nextItem) {
					return;
				}
				if (value === undefined) {
					setInternalValue(nextItem.id);
				}
				onValueChange?.(nextItem.id, nextItem);
			}}
			transition={SPRING_PRESS}
			type="button"
			whileTap={reduce || disabled ? undefined : { scale: 0.97 }}
			{...rest}
		>
			{hasIcon ? (
				<ActionSwapIcon
					animation={animation}
					className="h-4 w-4"
					value={activeItem.id}
				>
					{activeItem.icon ?? null}
				</ActionSwapIcon>
			) : null}
			{iconOnly ? null : (
				<ActionSwapText animation={animation} value={activeItem.id}>
					{activeItem.label}
				</ActionSwapText>
			)}
		</motion.button>
	);
}
