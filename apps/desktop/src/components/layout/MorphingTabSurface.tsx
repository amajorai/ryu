import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
import layoutStyles from "./MorphingTabSurface.module.css";

const MORPHING_TAB_LAYOUT_ID = "desktop-titlebar-morphing-tab-surface";
const MORPHING_TAB_TRANSITION = {
	type: "spring",
	stiffness: 360,
	damping: 32,
	mass: 0.6,
} as const;

/**
 * The non-floating tab treatment from the titlebar's side of the Morphing Tabs
 * idea: the active tab owns one shared page-colored surface that glides between
 * tabs, then extends below the rail so it reads as the top edge of the page.
 * The actual page remains in Layout, so this deliberately only renders the
 * surface and leaves activation, close, drag, and context-menu behavior to the
 * existing tab controls.
 */
export function MorphingTabSurface({
	floatingTabs,
	isActive,
}: {
	floatingTabs: boolean;
	isActive: boolean;
}) {
	const reduceMotion = useReducedMotion();
	if (floatingTabs || !isActive) {
		return null;
	}
	return (
		<motion.span
			aria-hidden
			className={cn(
				"pointer-events-none absolute -inset-x-1 -top-1 -bottom-2 z-0 rounded-t-xl bg-background",
				layoutStyles.authored1
			)}
			data-tab-surface="morphing"
			layoutId={MORPHING_TAB_LAYOUT_ID}
			transition={reduceMotion ? { duration: 0 } : MORPHING_TAB_TRANSITION}
		/>
	);
}
