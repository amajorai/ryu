"use client";

import type { MotionStyle } from "motion/react";
import css from "./magnetic.module.css";

interface Inline1Style extends MotionStyle {
	"--magnetic-1-x"?: MotionStyle["x"];
	"--magnetic-1-y"?: MotionStyle["y"];
}

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { SPRING_MOUSE } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	motion,
	useMotionValue,
	useReducedMotion,
	useSpring,
} from "motion/react";
import { type ReactNode, useRef } from "react";

export interface MagneticProps {
	children: ReactNode;
	className?: string;
	strength?: number;
}

export function Magnetic({
	children,
	strength = 0.35,
	className,
}: MagneticProps) {
	const ref = useRef<HTMLDivElement>(null);
	const reduce = useReducedMotion();
	const canHover = useHoverCapable();
	// Decorative cursor-follow: skip on touch (phantom hover) and reduced motion.
	const enabled = !reduce && canHover;
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const sx = useSpring(x, SPRING_MOUSE);
	const sy = useSpring(y, SPRING_MOUSE);

	const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
		const el = ref.current;
		if (!(el && enabled)) {
			return;
		}
		const rect = el.getBoundingClientRect();
		x.set((e.clientX - rect.left - rect.width / 2) * strength);
		y.set((e.clientY - rect.top - rect.height / 2) * strength);
	};

	const onLeave = () => {
		x.set(0);
		y.set(0);
	};

	const inline1Style: Inline1Style = {
		"--magnetic-1-x": sx,
		"--magnetic-1-y": sy,
	};
	return (
		<motion.div
			className={[css.inline1, cn("inline-block", className)].join(" ")}
			onMouseLeave={onLeave}
			onMouseMove={onMove}
			ref={ref}
			style={inline1Style}
		>
			{children}
		</motion.div>
	);
}
