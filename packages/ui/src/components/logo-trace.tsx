"use client";

import type { CSSProperties } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import styles from "./logo.module.css";

export interface LogoTraceOptions {
	/** Accessible status label for the trace variant. */
	ariaLabel?: string;
	/** Seconds for the trace variant's fill fade (default 0.3). */
	fillFadeSeconds?: number;
	/** Resolve the trace into the filled mark. */
	isComplete?: boolean;
	/** Keep tracing until false (default true). */
	loading?: boolean;
	/** Seconds per trace revolution (default 1.6). */
	loopDurationSeconds?: number;
	/** Called once per loading cycle after the filled mark is visible. */
	onDone?: () => void;
	/** Trace stroke width in SVG units (default 1.5). */
	strokeWidth?: number;
}

interface LogoTraceProps extends LogoTraceOptions {
	animated?: boolean;
	className?: string;
	showEyes?: boolean;
	size?: string;
}

type TracePhase = "loop" | "closingOutline" | "fadingFill" | "done";

// The existing ghost silhouette, normalized to its original 24-unit geometry.
const GHOST_PATH =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";
const CLOSE_SECONDS = 0.35;

const seconds = (value: number, fallback: number): number =>
	Number.isFinite(value) && value > 0 ? value : fallback;

function useTracePhase(
	complete: boolean,
	instant: boolean,
	fadeSeconds: number,
	onDone?: () => void
) {
	const [phase, setPhase] = useState<TracePhase>(instant ? "done" : "loop");
	const notified = useRef(false);
	const callback = useRef(onDone);
	useEffect(() => {
		callback.current = onDone;
	}, [onDone]);
	useEffect(() => {
		if (!complete) {
			notified.current = false;
			setPhase("loop");
			return;
		}
		if (notified.current) {
			return;
		}
		if (instant) {
			setPhase("done");
			return;
		}
		setPhase("closingOutline");
		// Timers also complete the reveal when SVG/CSS animation events are absent.
		const closeTimer = setTimeout(
			() => setPhase("fadingFill"),
			CLOSE_SECONDS * 1000
		);
		const fillTimer = setTimeout(
			() => setPhase("done"),
			(CLOSE_SECONDS + fadeSeconds) * 1000
		);
		return () => {
			clearTimeout(closeTimer);
			clearTimeout(fillTimer);
		};
	}, [complete, fadeSeconds, instant]);
	useEffect(() => {
		if (complete && phase === "done" && !notified.current) {
			notified.current = true;
			callback.current?.();
		}
	}, [complete, phase]);
	return phase;
}

export function LogoTrace({
	animated = true,
	ariaLabel = "Loading",
	className,
	fillFadeSeconds = 0.3,
	isComplete = false,
	loading = true,
	loopDurationSeconds = 1.6,
	onDone,
	showEyes = true,
	size = "192px",
	strokeWidth = 1.5,
}: LogoTraceProps) {
	const maskId = useId();
	const [reducedMotion, setReducedMotion] = useState(false);
	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	const instant = !animated || reducedMotion;
	const complete = instant || isComplete || !loading;
	const fadeSeconds = seconds(fillFadeSeconds, 0.3);
	const phase = useTracePhase(complete, instant, fadeSeconds, onDone);
	const style: CSSProperties & Record<string, string> = {
		"--logo-size": size,
		"--trace-loop-duration": `${seconds(loopDurationSeconds, 1.6)}s`,
		"--trace-close-duration": `${CLOSE_SECONDS}s`,
		"--trace-fill-duration": `${fadeSeconds}s`,
	};
	return (
		<svg
			aria-busy={!complete}
			aria-label={ariaLabel}
			className={cn(styles.dimensions, styles.trace, className)}
			data-logo-trace-phase={phase}
			height={size}
			role="status"
			style={style}
			viewBox="-2 -2 28 28"
			width={size}
		>
			<defs>
				<mask
					height="28"
					id={maskId}
					mask-type="luminance"
					maskUnits="userSpaceOnUse"
					width="28"
					x="-2"
					y="-2"
				>
					<path d={GHOST_PATH} fill="var(--color-logo-mask-solid, white)" />
					{showEyes && (
						<>
							<ellipse
								cx="15"
								cy="10"
								fill="var(--color-logo-mask-clear, black)"
								rx="1.5"
								ry="3"
							/>
							<ellipse
								cx="19"
								cy="10"
								fill="var(--color-logo-mask-clear, black)"
								rx="1.5"
								ry="3"
							/>
						</>
					)}
				</mask>
			</defs>
			<g
				className={styles.traceOutline}
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={seconds(strokeWidth, 1.5)}
			>
				<path d={GHOST_PATH} opacity="0.18" />
				<path
					className={styles.traceStroke}
					d={GHOST_PATH}
					pathLength="1"
					strokeDasharray="0.16 0.84"
				/>
			</g>
			<path
				className={styles.traceFill}
				d={GHOST_PATH}
				fill="currentColor"
				mask={`url(#${maskId})`}
			/>
		</svg>
	);
}
