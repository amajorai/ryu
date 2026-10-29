"use client";

// beui.dev/components/agents/agent-disclosure

import type { MotionStyle } from "motion/react";
import { isNativeNumber } from "../../lib/native-primitive-observation.ts";
import css from "./agent-disclosure.module.css";

interface Inline1Style extends MotionStyle {
	"--agent-disclosure-1-height"?: MotionStyle["height"];
	"--agent-disclosure-1-pointer-events"?: MotionStyle["pointerEvents"];
	"--agent-disclosure-1-transform-origin"?: MotionStyle["transformOrigin"];
}

import { EASE_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type HTMLMotionProps, motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";

export interface AgentDisclosureProps
	extends Omit<HTMLMotionProps<"div">, "animate" | "initial"> {
	open: boolean;
	openHeight?: CSSProperties["height"];
}

/**
 * Shared transform-only reveal for collapsible agent content. Animating
 * `clipPath` + `y` rather than `height` keeps the whole reveal on the compositor,
 * so a long tool output does not relayout the thread on every frame.
 */
export function AgentDisclosure({
	open,
	openHeight = "auto",
	className,
	style,
	transition,
	...props
}: AgentDisclosureProps) {
	const reduce = useReducedMotion() ?? false;
	const motionState = reduce
		? { opacity: open ? 1 : 0 }
		: {
				opacity: open ? 1 : 0,
				clipPath: open ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
				y: open ? 0 : -4,
			};
	const openDuration = open ? 0.22 : 0.14;

	// The collapse owns height, pointer-events, and transform-origin: drop caller
	// values for them so `open={false}` always collapses via the module class.
	const inline1Style: Inline1Style = {
		...style,
		height: undefined,
		pointerEvents: undefined,
		transformOrigin: undefined,
		"--agent-disclosure-1-height": open
			? isNativeNumber(openHeight)
				? `${openHeight}px`
				: openHeight
			: "0px",
		"--agent-disclosure-1-pointer-events": open ? undefined : "none",
		"--agent-disclosure-1-transform-origin": "top",
	};
	return (
		<motion.div
			{...props}
			animate={motionState}
			aria-hidden={!open}
			className={[css.inline1, cn("overflow-hidden", className)].join(" ")}
			inert={!open}
			initial={false}
			style={inline1Style}
			transition={
				transition ?? {
					duration: reduce ? 0 : openDuration,
					ease: EASE_OUT,
				}
			}
		/>
	);
}
