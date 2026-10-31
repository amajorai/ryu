"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, type MotionStyle, motion } from "motion/react";
import css from "./otp-input.module.css";

interface Inline1Style extends MotionStyle {
	"--otp-input-1-transform-origin"?: MotionStyle["transformOrigin"];
	"--otp-input-1-transform-style"?: MotionStyle["transformStyle"];
}

const inline1Style: Inline1Style = {
	"--otp-input-1-transform-origin": "center bottom",
	"--otp-input-1-transform-style": "preserve-3d",
};

export interface OTPSlotProps {
	alphanumeric: boolean;
	char: string;
	disabled: boolean;
	index: number;
	isActive: boolean;
	isError: boolean;
	mask: boolean;
	reduce: boolean;
	/** Shared id so the active ring glides between slots via `layoutId`. */
	ringLayoutId: string;
	showSuccess: boolean;
	size: "compact" | "default";
}

/** One presentational slot of `OTPInput`: active ring, placeholder and rolling digit. */
export function OTPSlot({
	alphanumeric,
	char,
	disabled,
	index,
	isActive,
	isError,
	mask,
	reduce,
	ringLayoutId,
	showSuccess,
	size,
}: OTPSlotProps) {
	return (
		<div
			className={cn(
				"relative grid aspect-square min-w-0 place-items-center overflow-hidden rounded-xl bg-foreground/[0.06] font-semibold tabular-nums outline-none ring-1 ring-foreground/10 transition-[background-color,color] duration-150 ease-out [container-type:inline-size] motion-reduce:transition-none",
				size === "compact"
					? "h-9 w-9 rounded-lg text-sm *:text-[min(0.875rem,43cqi)]"
					: "size-(--otp-slot) text-2xl *:text-[min(1.5rem,43cqi)]",
				showSuccess && "bg-status-success/10 ring-status-success/50",
				isError && "bg-destructive/5 ring-destructive/40",
				isActive &&
					!(showSuccess || isError) &&
					"z-10 bg-foreground/10 ring-transparent",
				disabled && "opacity-50"
			)}
			data-active={isActive}
			data-filled={char !== ""}
			data-index={index}
			data-otp-index={index}
		>
			{isActive && !showSuccess ? (
				<motion.span
					aria-hidden
					className={cn(
						// Inset: the slot clips overflow for the digit roll, so an outward
						// ring would be cut off at the slot's rounded edge.
						"pointer-events-none absolute inset-0 z-20 rounded-[inherit] ring-3 ring-inset",
						isError ? "ring-destructive" : "ring-foreground/75"
					)}
					layoutId={reduce ? undefined : ringLayoutId}
					transition={
						reduce
							? { duration: 0 }
							: { type: "spring", duration: 0.25, bounce: 0.18 }
					}
				/>
			) : null}
			{char ? null : (
				<span aria-hidden className="select-none text-foreground/20">
					{alphanumeric ? "·" : "0"}
				</span>
			)}
			<AnimatePresence initial={false}>
				{char ? (
					<motion.span
						animate={
							reduce
								? { opacity: 1 }
								: { y: 0, opacity: 1, rotateX: 0, filter: "blur(0px)" }
						}
						className={cn(
							css.inline1,
							"absolute inset-0 grid place-items-center text-foreground leading-none"
						)}
						exit={
							reduce
								? { opacity: 0 }
								: { y: -2, opacity: 0, rotateX: 15, filter: "blur(2px)" }
						}
						initial={
							reduce
								? { opacity: 0 }
								: { y: 6, opacity: 0, rotateX: -35, filter: "blur(2px)" }
						}
						key={`${index}-${char}`}
						style={inline1Style}
						transition={
							reduce
								? { duration: 0 }
								: { type: "spring", duration: 0.25, bounce: 0.2 }
						}
					>
						{mask ? "•" : char}
					</motion.span>
				) : null}
			</AnimatePresence>
		</div>
	);
}
