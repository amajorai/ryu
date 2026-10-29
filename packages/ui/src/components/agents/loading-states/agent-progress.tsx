"use client";

// beui.dev/components/agents/loading-states/agent-progress

import { useLiteralMessages } from "@ryu/i18n/react";
import { EASE_IN_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const GRID_CELLS = [
	{ id: "top-left", delay: 0 },
	{ id: "top-center", delay: 0.14 },
	{ id: "top-right", delay: 0.28 },
	{ id: "middle-left", delay: 0.42 },
	{ id: "middle-center", delay: 0.56 },
	{ id: "middle-right", delay: 0.7 },
	{ id: "bottom-left", delay: 0.84 },
	{ id: "bottom-center", delay: 0.98 },
	{ id: "bottom-right", delay: 1.12 },
];

export interface AgentProgressProps {
	className?: string;
	/** Controlled elapsed time in seconds. */
	elapsedSeconds?: number;
	/** Starting time for the internal timer, in seconds. */
	initialSeconds?: number;
	/** Verb describing the agent's current activity. */
	label?: string;
	/** Whether the internal timer should advance. Ignored when elapsedSeconds is provided. */
	running?: boolean;
}

function formatElapsed(totalSeconds: number) {
	const safeSeconds = Math.max(0, totalSeconds);
	const minutes = Math.floor(safeSeconds / 60);
	const seconds = (safeSeconds % 60).toFixed(1);
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function AgentProgress({
	label = "Churning",
	elapsedSeconds,
	initialSeconds = 0,
	running = true,
	className,
}: AgentProgressProps) {
	const tl = useLiteralMessages();
	const reduce = useReducedMotion() ?? false;
	const [internalSeconds, setInternalSeconds] = useState(initialSeconds);

	useEffect(() => {
		if (elapsedSeconds !== undefined || !running) {
			return;
		}

		const startedAt = performance.now() - initialSeconds * 1000;
		const timer = window.setInterval(() => {
			setInternalSeconds((performance.now() - startedAt) / 1000);
		}, 100);

		return () => window.clearInterval(timer);
	}, [elapsedSeconds, initialSeconds, running]);

	const elapsed = elapsedSeconds ?? internalSeconds;

	return (
		<span
			aria-label={tl("{label}, in progress", { label })}
			className={cn(
				"inline-flex items-center gap-3 font-mono text-muted-foreground text-sm",
				className
			)}
			role="status"
		>
			<span
				aria-hidden="true"
				className="grid size-5 shrink-0 grid-cols-3 gap-[2px]"
			>
				{GRID_CELLS.map(({ id, delay }) => (
					<motion.span
						animate={
							reduce
								? { opacity: [0.35, 0.8, 0.35] }
								: {
										opacity: [0.28, 1, 0.28],
										scale: [0.72, 1, 0.72],
									}
						}
						className="rounded-[1px] bg-current"
						key={id}
						transition={{
							duration: 0.9,
							ease: EASE_IN_OUT,
							repeat: Number.POSITIVE_INFINITY,
							delay,
						}}
					/>
				))}
			</span>
			<span className="font-medium font-sans">{label}</span>
			<span
				aria-hidden="true"
				className="text-muted-foreground/70 tabular-nums"
			>
				{formatElapsed(elapsed)}
			</span>
		</span>
	);
}
