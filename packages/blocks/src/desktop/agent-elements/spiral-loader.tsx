"use client";

import { cn } from "@ryu/ui/lib/utils";
import type { LottieComponentProps, LottieRefCurrentProps } from "lottie-react";
import { useTheme } from "next-themes";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import styles from "./elements-one.module.css";
import type { AgentGeometryStyle } from "./elements-one-style.ts";
import { spiralFastData, spiralSlowData } from "./spiral-loader-data.ts";

const LottieLib = lazy(() => import("lottie-react"));

function Lottie(props: LottieComponentProps) {
	return (
		<Suspense fallback={null}>
			<LottieLib {...props} />
		</Suspense>
	);
}

const FAST_REPEATS = 4;
const SLOW_REPEATS = 2;

export interface SpiralLoaderProps {
	className?: string;
	size?: number;
}

export function SpiralLoader({ size = 16, className }: SpiralLoaderProps) {
	const [isMounted, setIsMounted] = useState(false);
	const [phase, setPhase] = useState<"fast" | "slow">("fast");
	const repeatCountRef = useRef(0);
	const fastRef = useRef<LottieRefCurrentProps | null>(null);
	const slowRef = useRef<LottieRefCurrentProps | null>(null);
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		setIsMounted(true);
	}, []);

	const startFastPhase = useCallback(() => {
		repeatCountRef.current = 0;
		setPhase("fast");
		slowRef.current?.stop();
		fastRef.current?.goToAndPlay(0, true);
	}, []);

	const startSlowPhase = useCallback(() => {
		repeatCountRef.current = 0;
		setPhase("slow");
		fastRef.current?.stop();
		slowRef.current?.goToAndPlay(0, true);
	}, []);

	const handleFastComplete = useCallback(() => {
		repeatCountRef.current += 1;
		if (repeatCountRef.current < FAST_REPEATS) {
			fastRef.current?.goToAndPlay(0, true);
		} else {
			startSlowPhase();
		}
	}, [startSlowPhase]);

	const handleSlowComplete = useCallback(() => {
		repeatCountRef.current += 1;
		if (repeatCountRef.current < SLOW_REPEATS) {
			slowRef.current?.goToAndPlay(0, true);
		} else {
			startFastPhase();
		}
	}, [startFastPhase]);

	if (!isMounted) {
		return null;
	}
	const needsInvert = resolvedTheme !== "dark";

	return (
		<div
			className={cn(styles.square, "relative shrink-0", className)}
			style={
				{
					"--agent-size": `${size}px`,
				} satisfies AgentGeometryStyle as AgentGeometryStyle
			}
		>
			<div
				className={cn(
					"absolute inset-0 transition-opacity duration-75",
					needsInvert && "invert",
					phase === "fast" ? "opacity-100" : "opacity-0"
				)}
			>
				<Lottie
					animationData={spiralFastData}
					autoplay={true}
					className={styles.full}
					loop={false}
					lottieRef={fastRef}
					onComplete={handleFastComplete}
				/>
			</div>
			<div
				className={cn(
					"absolute inset-0 transition-opacity duration-75",
					needsInvert && "invert",
					phase === "slow" ? "opacity-100" : "opacity-0"
				)}
			>
				<Lottie
					animationData={spiralSlowData}
					autoplay={false}
					className={styles.full}
					loop={false}
					lottieRef={slowRef}
					onComplete={handleSlowComplete}
				/>
			</div>
		</div>
	);
}
