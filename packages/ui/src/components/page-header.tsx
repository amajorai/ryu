"use client";

import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { cn } from "../lib/utils.ts";

interface PageHeaderProps {
	animate?: boolean;
	className?: string;
	style?: CSSProperties;
	subtitle?: string;
	subtitleDelay?: number;
	title: string;
	titleClassName?: string;
	titleDelay?: number;
}

export function PageHeader({
	title,
	subtitle,
	className,
	titleClassName,
	animate = false,
	titleDelay = 0.2,
	subtitleDelay = 0.3,
	style,
}: PageHeaderProps) {
	if (animate) {
		return (
			<div className={cn("space-y-1 text-left", className)} style={style}>
				<motion.h1
					animate={{ opacity: 1, y: 0 }}
					className={cn("font-medium text-xl", titleClassName)}
					initial={{ opacity: 0, y: 20 }}
					transition={{ delay: titleDelay, duration: 0.5 }}
				>
					{title}
				</motion.h1>
				{subtitle && (
					<motion.p
						animate={{ opacity: 1, y: 0 }}
						className="max-w-md text-left font-medium text-muted-foreground text-xl"
						initial={{ opacity: 0, y: 20 }}
						transition={{ delay: subtitleDelay, duration: 0.5 }}
					>
						{subtitle}
					</motion.p>
				)}
			</div>
		);
	}

	return (
		<div className={cn("space-y-1 text-left", className)} style={style}>
			<h1 className={cn("font-medium text-xl", titleClassName)}>{title}</h1>
			{subtitle ? (
				<p className="font-medium text-muted-foreground text-xl">{subtitle}</p>
			) : null}
		</div>
	);
}

export default PageHeader;
