"use client";

import { motion, useInView } from "motion/react";
import { type ReactNode, useRef } from "react";

export function Reveal({
	children,
	delay = 0,
	className,
}: {
	children: ReactNode;
	delay?: number;
	className?: string;
}) {
	const ref = useRef(null);
	const inView = useInView(ref, { once: true, margin: "-80px" });

	return (
		<motion.div
			animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
			className={className}
			initial={{ opacity: 0, y: 16 }}
			ref={ref}
			transition={{ duration: 0.5, delay, ease: "easeOut" }}
		>
			{children}
		</motion.div>
	);
}
