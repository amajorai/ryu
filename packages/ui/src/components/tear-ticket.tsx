"use client";

import { Ticket } from "lucide-react";
import { type MotionStyle, motion, useReducedMotion } from "motion/react";
import type React from "react";
import { useEffect, useRef } from "react";
import { cn } from "../lib/utils.ts";
import styles from "./tear-ticket.module.css";

interface TearBodyStyle extends React.CSSProperties {
	"--tear-clip"?: string;
}
interface TearStubStyle extends MotionStyle {
	"--tear-clip"?: string;
	"--tear-origin": string;
}
interface TearLabelStyle extends React.CSSProperties {
	"--tear-label-top": string;
}

type Point = readonly [x: number, y: number];

export const TEAR_LINE_RATIO = 0.73;
const TEAR_LINE_Y = TEAR_LINE_RATIO * 100;
const TEAR_EDGE_POINTS: readonly Point[] = [
	[0, TEAR_LINE_Y],
	[6, 70],
	[12, 76],
	[19, 70],
	[25, 75],
	[31, 70],
	[38, 76],
	[44, 70],
	[50, 75],
	[56, 70],
	[63, 76],
	[69, 70],
	[75, 75],
	[81, 69],
	[88, 76],
	[94, 70],
	[100, TEAR_LINE_Y],
];
const TEAR_FIBERS = [
	{ x1: 18, x2: 20, y1: 70, y2: 75 },
	{ x1: 41, x2: 39, y1: 69, y2: 75 },
	{ x1: 65, x2: 67, y1: 70, y2: 76 },
	{ x1: 88, x2: 86, y1: 69, y2: 75 },
] as const;

function polygonPath(points: readonly Point[]): string {
	return `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(", ")})`;
}

function tearEdgePoints(lineRatio: number): Point[] {
	const yOffset = (lineRatio - TEAR_LINE_RATIO) * 100;
	return TEAR_EDGE_POINTS.map(([x, y]): Point => [x, y + yOffset]);
}

function bodyClipPath(points: readonly Point[], lineY: number): string {
	return polygonPath([
		[0, 0],
		[100, 0],
		[100, lineY],
		...points.slice(0, -1).reverse(),
	]);
}

function detachedStubClipPath(points: readonly Point[], lineY: number): string {
	return polygonPath([
		[0, 100],
		[100, 100],
		[100, lineY],
		...points.slice(0, -1).reverse(),
	]);
}

export interface TearTicketProps {
	children: React.ReactNode;
	className?: string;
	/** Duration of the loose ticket stub as it tears free. */
	durationMs?: number;
	/** Optional completion callback for flows that continue after the tear. */
	onTearComplete?: () => void;
	/** Partial tear progress, from 0 to 1. */
	progress?: number;
	/** Keep a dotted perforation visible before the ticket starts tearing. */
	showIdlePerforation?: boolean;
	/** Short label printed on the moving stub. */
	stubLabel?: string;
	/** Height of the horizontal perforation, as a fraction of the card. */
	tearLineRatio?: number;
	/** Keep the ticket in its used state after the animation. */
	torn?: boolean;
}

function clampProgress(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Splits a live ticket into its remaining body and one moving stub. The original
 * face is rendered once, which keeps shader-backed passes intact.
 */
export function TearTicket({
	children,
	className,
	durationMs = 460,
	onTearComplete,
	progress = 0,
	showIdlePerforation = true,
	stubLabel = "used",
	tearLineRatio = TEAR_LINE_RATIO,
	torn = false,
}: TearTicketProps) {
	const reducedMotion = useReducedMotion() === true;
	const tearProgress = torn ? 1 : clampProgress(progress);
	const tearLineY = tearLineRatio * 100;
	const edgePoints = tearEdgePoints(tearLineRatio);
	const tearEdge = edgePoints
		.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`)
		.join(" ");
	const fiberOffset = tearLineY - TEAR_LINE_Y;
	const stubDrop = tearProgress * 16;
	const stubRotation = tearProgress * 0.8;
	const stubTransform = `translateY(${stubDrop}px) rotate(${stubRotation}deg)`;
	const previousTorn = useRef(torn);
	const shouldReportCompletion = useRef(false);

	useEffect(() => {
		if (!torn) {
			previousTorn.current = false;
			shouldReportCompletion.current = false;
			return;
		}
		if (previousTorn.current) {
			return;
		}
		previousTorn.current = true;
		shouldReportCompletion.current = true;
		if (reducedMotion) {
			shouldReportCompletion.current = false;
			onTearComplete?.();
		}
	}, [onTearComplete, reducedMotion, torn]);

	const finishTear = () => {
		if (!shouldReportCompletion.current) {
			return;
		}
		shouldReportCompletion.current = false;
		onTearComplete?.();
	};

	const bodyStyle: TearBodyStyle = {
		"--tear-clip":
			tearProgress > 0 ? bodyClipPath(edgePoints, tearLineY) : undefined,
	};
	const stubStyle: TearStubStyle = {
		"--tear-clip":
			tearProgress > 0
				? detachedStubClipPath(edgePoints, tearLineY)
				: undefined,
		"--tear-origin": `50% ${tearLineY}%`,
	};
	const labelStyle: TearLabelStyle = {
		"--tear-label-top": `${((tearLineRatio + 1) / 2) * 100}%`,
	};

	return (
		<div
			className={cn("relative w-full overflow-visible", className)}
			data-tear-progress={tearProgress.toFixed(2)}
			data-tear-state={torn ? "torn" : tearProgress > 0 ? "tearing" : "ready"}
		>
			<div
				className={cn(
					"relative w-full [clip-path:var(--tear-clip)]",
					styles.clipTransition
				)}
				data-tear-piece="body"
				style={bodyStyle}
			>
				{children}
			</div>
			<motion.div
				animate={
					torn
						? reducedMotion
							? {
									opacity: 1,
									transform: "translateY(6px) rotate(0.4deg)",
								}
							: {
									opacity: 1,
									transform: [
										stubTransform,
										`translateY(${stubDrop + 4}px) rotate(${stubRotation + 0.6}deg)`,
										"translateY(16px) rotate(1.2deg)",
									],
								}
						: {
								opacity: tearProgress > 0 ? 1 : 0,
								transform: stubTransform,
							}
				}
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-0 z-20 [clip-path:var(--tear-clip)] [transform-origin:var(--tear-origin)]",
					styles.stubShadow,
					styles.clipTransition
				)}
				data-tear-piece="stub"
				initial={{
					opacity: 0,
					transform: "translateY(0px) rotate(0deg)",
				}}
				onAnimationComplete={finishTear}
				style={stubStyle}
				transition={{
					duration:
						torn && !reducedMotion
							? durationMs / 1000
							: reducedMotion
								? 0
								: 0.1,
					ease: [0.22, 1, 0.36, 1],
				}}
			>
				<div
					className={cn(
						"absolute inset-0 overflow-hidden border border-border bg-linear-to-br from-card via-background to-muted",
						styles.stubCorners
					)}
				/>
				<div
					className="absolute top-[var(--tear-label-top)] left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 text-foreground"
					style={labelStyle}
				>
					<Ticket aria-hidden="true" className="size-4" />
					<span className="type-tiny font-mono uppercase tracking-widest">
						{stubLabel}
					</span>
				</div>
			</motion.div>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-30 size-full overflow-visible"
				preserveAspectRatio="none"
				viewBox="0 0 100 100"
			>
				<path
					d={tearEdge}
					fill="none"
					pathLength="100"
					stroke="currentColor"
					strokeDasharray="1.2 2.2"
					strokeOpacity={tearProgress > 0 || showIdlePerforation ? 0.44 : 0}
					strokeWidth="0.8"
				/>
				<path
					d={tearEdge}
					fill="none"
					pathLength="100"
					stroke="var(--background)"
					strokeDasharray="100"
					strokeDashoffset="0"
					strokeOpacity={tearProgress > 0 ? 0.72 : 0}
					strokeWidth="1.25"
				/>
				<path
					d={tearEdge}
					fill="none"
					pathLength="100"
					stroke="currentColor"
					strokeDasharray="100"
					strokeDashoffset="0"
					strokeOpacity={tearProgress > 0 ? 0.72 : 0}
					strokeWidth="0.65"
				/>
				{TEAR_FIBERS.map((fiber) => (
					<line
						key={`${fiber.y1}-${fiber.x1}`}
						stroke="currentColor"
						strokeOpacity={torn ? 0.72 : tearProgress > 0 ? 0.5 : 0}
						strokeWidth="0.7"
						x1={fiber.x1}
						x2={fiber.x2}
						y1={fiber.y1 + fiberOffset}
						y2={fiber.y2 + fiberOffset}
					/>
				))}
			</svg>
		</div>
	);
}
