"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { BorderBeam as BorderBeamPrimitive } from "border-beam";
import type { ComponentProps, ReactNode } from "react";
import { usePrefersReducedMotion } from "./reduced-motion.ts";

export {
	BorderBeam,
	type BorderBeamColorVariant,
	type BorderBeamProps,
	type BorderBeamSize,
	type BorderBeamTheme,
} from "border-beam";

/** Shared beam presets for nav upsell CTAs (pulse = Upgrade, rotate = Lifetime). */
export type NavBeamVariant = "pulse" | "rotate";

interface NavBeamCtaProps {
	children: ReactNode;
	className?: string;
	/** App theme — prefer `resolvedTheme` from next-themes over system `auto`. */
	theme?: ComponentProps<typeof BorderBeamPrimitive>["theme"];
	variant: NavBeamVariant;
}

/**
 * Border-beam wrapper tuned for dropdown menu CTAs. Pulse breathes inside the
 * item border; rotate sends a traveling beam around it (sm = button-sized).
 * Under reduced motion the library already hides the pulse (it drops every
 * animation, fade-in included) but keeps the rotating beam spinning, so both
 * stay inactive for those visitors, as the landing download beam does.
 */
export function NavBeamCta({
	children,
	variant,
	theme = "dark",
	className,
}: NavBeamCtaProps) {
	const reduceMotion = usePrefersReducedMotion();
	return (
		<BorderBeamPrimitive
			active={!reduceMotion}
			borderRadius={16}
			className={cn("w-full", className)}
			colorVariant="colorful"
			size={variant === "pulse" ? "pulse-inner" : "sm"}
			strength={0.7}
			theme={theme}
		>
			{children}
		</BorderBeamPrimitive>
	);
}
