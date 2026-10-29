"use client";

import type { MotionStyle } from "motion/react";
import css from "./base.module.css";

interface Inline1Style extends MotionStyle {
	"--base-1-height"?: MotionStyle["height"];
	"--base-1-left"?: MotionStyle["left"];
	"--base-1-top"?: MotionStyle["top"];
	"--base-1-width"?: MotionStyle["width"];
	"--base-1-x"?: MotionStyle["x"];
	"--base-1-y"?: MotionStyle["y"];
}

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { EASE_OUT, SPRING_PRESS } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	type HTMLMotionProps,
	motion,
	useReducedMotion,
} from "motion/react";
import {
	forwardRef,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useRef,
	useState,
} from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps
	extends Omit<HTMLMotionProps<"button">, "children"> {
	children?: ReactNode;
	pressScale?: number;
	/** Spawn a Material-style ripple from the press point. Off by default. */
	ripple?: boolean;
	size?: ButtonSize;
	variant?: ButtonVariant;
}

export interface ButtonLinkProps
	extends Omit<HTMLMotionProps<"a">, "children"> {
	children?: ReactNode;
	pressScale?: number;
	size?: ButtonSize;
	variant?: ButtonVariant;
}

interface Ripple {
	id: number;
	size: number;
	x: number;
	y: number;
}

const VARIANT_CLASS = {
	primary: "bg-primary text-primary-foreground hover:bg-primary/90",
	secondary: "border border-border bg-card text-foreground hover:border-border",
	ghost: "text-muted-foreground hover:text-foreground hover:bg-primary/5",
	outline:
		"border border-border bg-transparent text-foreground hover:bg-primary/5",
} satisfies Record<ButtonVariant, string>;

const SIZE_CLASS = {
	sm: "h-8 px-3 text-xs gap-1.5 rounded-full",
	md: "h-10 px-5 text-sm gap-2 rounded-full",
	lg: "h-12 px-6 text-base gap-2 rounded-full",
	icon: "h-8 w-8 rounded-lg",
} satisfies Record<ButtonSize, string>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
	function Button(
		{
			variant = "primary",
			size = "md",
			pressScale = 0.93,
			ripple = false,
			className,
			children,
			onPointerDown,
			...rest
		},
		ref
	) {
		const reduce = useReducedMotion();
		const canHover = useHoverCapable();
		const [ripples, setRipples] = useState<Ripple[]>([]);
		const nextId = useRef(0);

		const handlePointerDown = useCallback(
			(event: PointerEvent<HTMLButtonElement>) => {
				if (ripple && !reduce) {
					const rect = event.currentTarget.getBoundingClientRect();
					const size = Math.max(rect.width, rect.height) * 2;
					const id = nextId.current++;
					setRipples((prev) => [
						...prev,
						{
							id,
							x: event.clientX - rect.left,
							y: event.clientY - rect.top,
							size,
						},
					]);
				}
				onPointerDown?.(event);
			},
			[ripple, reduce, onPointerDown]
		);

		return (
			<motion.button
				className={cn(
					"inline-flex select-none items-center justify-center font-medium",
					"transition-colors",
					"disabled:pointer-events-none disabled:opacity-50",
					ripple && "relative overflow-hidden",
					VARIANT_CLASS[variant],
					SIZE_CLASS[size],
					className
				)}
				onPointerDown={handlePointerDown}
				ref={ref}
				transition={SPRING_PRESS}
				type="button"
				whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
				whileTap={reduce ? undefined : { scale: pressScale }}
				{...rest}
			>
				{ripple && !reduce ? (
					<span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
						<AnimatePresence>
							{ripples.map((r) => {
								const inline1Style: Inline1Style = {
									"--base-1-left": r.x === undefined ? undefined : `${r.x}px`,
									"--base-1-top": r.y === undefined ? undefined : `${r.y}px`,
									"--base-1-width":
										r.size === undefined ? undefined : `${r.size}px`,
									"--base-1-height":
										r.size === undefined ? undefined : `${r.size}px`,
									"--base-1-x": "-50%",
									"--base-1-y": "-50%",
								};
								return (
									<motion.span
										animate={{ scale: 1, opacity: 0 }}
										className={[
											css.inline1,
											"absolute rounded-full bg-current",
										].join(" ")}
										exit={{ opacity: 0 }}
										initial={{ scale: 0.05, opacity: 0.3 }}
										key={r.id}
										onAnimationComplete={() =>
											setRipples((prev) => prev.filter((x) => x.id !== r.id))
										}
										style={inline1Style}
										transition={{ duration: 1.6, ease: EASE_OUT }}
									/>
								);
							})}
						</AnimatePresence>
					</span>
				) : null}
				{children}
			</motion.button>
		);
	}
);

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
	function ButtonLink(
		{
			variant = "primary",
			size = "md",
			pressScale = 0.93,
			className,
			children,
			...rest
		},
		ref
	) {
		const reduce = useReducedMotion();
		const canHover = useHoverCapable();

		return (
			<motion.a
				className={cn(
					"inline-flex select-none items-center justify-center font-medium",
					"transition-colors",
					VARIANT_CLASS[variant],
					SIZE_CLASS[size],
					className
				)}
				ref={ref}
				transition={SPRING_PRESS}
				whileHover={reduce || !canHover ? undefined : { scale: 1.02 }}
				whileTap={reduce ? undefined : { scale: pressScale }}
				{...rest}
			>
				{children}
			</motion.a>
		);
	}
);
