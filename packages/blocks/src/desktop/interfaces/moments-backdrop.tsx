import { motion } from "motion/react";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The full-bleed wash Moments sits on, after MercuryOS: a pale, luminous
 * field in light themes and a deep, soft one in dark themes. Every stop is a
 * theme token, so it follows the user's palette. Two washes drift very slowly;
 * under reduced motion they hold still.
 */
export function MomentsBackdrop() {
	const reduceMotion = useReducedMotion();
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden bg-background"
			data-slot="moments-backdrop"
		>
			<div className="absolute inset-0 bg-linear-to-b from-muted/50 to-background" />
			<motion.div
				animate={reduceMotion ? undefined : { x: ["0%", "4%", "0%"] }}
				className="absolute -top-1/2 left-1/2 size-[140vmax] -translate-x-1/2 bg-radial from-primary/10 via-40% via-primary/5 to-70% to-transparent"
				transition={{
					duration: 48,
					ease: "easeInOut",
					repeat: Number.POSITIVE_INFINITY,
				}}
			/>
			<motion.div
				animate={reduceMotion ? undefined : { y: ["0%", "-5%", "0%"] }}
				className="absolute -right-1/2 -bottom-1/2 size-[130vmax] bg-radial from-accent/40 via-40% via-accent/15 to-70% to-transparent"
				transition={{
					duration: 56,
					ease: "easeInOut",
					repeat: Number.POSITIVE_INFINITY,
				}}
			/>
		</div>
	);
}
