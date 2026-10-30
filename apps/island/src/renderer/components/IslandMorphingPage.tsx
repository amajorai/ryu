import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useIsPresent } from "motion/react";
import type { ReactNode } from "react";
import { useReducedMotion } from "../hooks/use-reduced-motion.ts";

const PAGE_EASE = [0.16, 1, 0.3, 1] as const;
const ENTER_DURATION = 0.2;
const EXIT_DURATION = 0.15;
const REDUCED_ENTER_DURATION = 0.09;
const REDUCED_EXIT_DURATION = 0.09;

/**
 * Swap one page inside the existing Island surface, without adding a modal
 * shell: opacity and a small y offset, no blur filter (opacity only under
 * reduced motion).
 */
export function IslandMorphingPage({
	children,
	className,
}: {
	children: ReactNode;
	className: string;
}) {
	const isPresent = useIsPresent();
	const reduceMotion = useReducedMotion();
	const enterTransition = reduceMotion
		? { duration: REDUCED_ENTER_DURATION, ease: PAGE_EASE }
		: { duration: ENTER_DURATION, ease: PAGE_EASE };
	const exitTransition = reduceMotion
		? { duration: REDUCED_EXIT_DURATION, ease: PAGE_EASE }
		: { duration: EXIT_DURATION, ease: PAGE_EASE };

	return (
		<motion.div
			animate={
				reduceMotion
					? { opacity: 1, transition: enterTransition }
					: { opacity: 1, y: 0, transition: enterTransition }
			}
			aria-hidden={!isPresent}
			className={cn(
				className,
				isPresent ? "pointer-events-auto" : "pointer-events-none"
			)}
			exit={
				reduceMotion
					? { opacity: 0, transition: exitTransition }
					: { opacity: 0, y: -8, transition: exitTransition }
			}
			inert={!isPresent}
			initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
			layout
		>
			{children}
		</motion.div>
	);
}
