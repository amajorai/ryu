"use client";

import {
	animate,
	type MotionValue,
	useMotionValue,
	useTransform,
} from "motion/react";
import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import styles from "./slide-commit.module.css";
import {
	clamp,
	EASE_OUT,
	PAD,
	SQUASH_DIV,
	SQUASH_MAX,
} from "./slide-commit-config.ts";

const useIsoLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Spinner({ size }: { size: number }) {
	return (
		<svg
			aria-hidden="true"
			className={styles.spinner}
			height={size}
			viewBox="0 0 24 24"
			width={size}
		>
			<circle
				cx="12"
				cy="12"
				fill="none"
				r="9"
				stroke="currentColor"
				strokeOpacity="0.25"
				strokeWidth="2.4"
			/>
			<path
				d="M12 3a9 9 0 0 1 9 9"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2.4"
			/>
		</svg>
	);
}

/** The root's laid-out width, tracked so travel follows a fluid (`"100%"`) track. */
function useMeasuredWidth(
	rootRef: RefObject<HTMLDivElement | null>,
	fallback: number
) {
	const [measured, setMeasured] = useState(fallback);
	useIsoLayoutEffect(() => {
		const node = rootRef.current;
		if (!node || typeof ResizeObserver === "undefined") {
			return;
		}
		// The root itself is never transformed (only the track pulses), so its
		// box is the layout width.
		const sync = () => {
			const next = node.getBoundingClientRect().width;
			if (next > 0) {
				setMeasured(next);
			}
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(node);
		return () => observer.disconnect();
	}, [rootRef]);
	return measured;
}

/**
 * Every motion value and derived style the pill paints with. Geometry lives in
 * motion values (not closures) so a resize or hover re-derives the styles
 * without waiting for the handle to move.
 */
export function useSlideCommitMotion({
	fallbackWidth,
	gripRadius,
	height,
	rootRef,
	swellTarget,
}: {
	fallbackWidth: number;
	gripRadius: number;
	height: number;
	rootRef: RefObject<HTMLDivElement | null>;
	swellTarget: number;
}) {
	const measured = useMeasuredWidth(rootRef, fallbackWidth);
	const grip = height - PAD * 2;
	const innerWidth = Math.max(grip + 1, measured - PAD * 2);
	const travelOf = (w: number) => Math.max(1, w - grip);

	const x = useMotionValue(0);
	const inner = useMotionValue(innerWidth);
	const anchor = useMotionValue(0);
	const shown = useMotionValue(1);
	const spin = useMotionValue(0);
	const pulse = useMotionValue(1);
	const shake = useMotionValue(0);
	const swell = useMotionValue(1);

	useEffect(() => {
		inner.set(innerWidth);
		const travel = innerWidth - grip;
		if (x.get() > travel) {
			x.set(travel);
		}
	}, [grip, inner, innerWidth, x]);

	useEffect(() => {
		animate(swell, swellTarget, { duration: 0.2, ease: EASE_OUT });
	}, [swell, swellTarget]);

	const seen = useTransform([x, inner], ([v = 0, w = 0]: number[]) =>
		clamp(v, 0, travelOf(w))
	);
	const edge = useTransform(
		[seen, anchor, inner],
		([v = 0, a = 0, w = 0]: number[]) => v + grip + clamp(a - v, 0, travelOf(w))
	);
	const clip = useTransform(
		[edge, inner],
		([right = 0, w = 0]: number[]) =>
			`inset(0 ${w - right}px 0 0 round ${gripRadius}px)`
	);
	const content = useTransform(
		[seen, edge, inner],
		([v = 0, right = 0, w = 0]: number[]) =>
			`translateX(${(v + right) / 2 - w / 2}px)`
	);
	const shape = useTransform([x, swell], ([v = 0, s = 1]: number[]) => {
		const q = 1 - Math.min(SQUASH_MAX, Math.max(0, -v) / SQUASH_DIV);
		return `scale(${q * s}, ${s / q})`;
	});
	const origin = useTransform(seen, (v) => `${v}px 50%`);
	const say = useTransform([seen, inner], ([v = 0, w = 0]: number[]) =>
		clamp(1 - v / (travelOf(w) * 0.55), 0, 1)
	);
	const arrow = useTransform(
		[seen, shown, inner],
		([v = 0, on = 0, w = 0]: number[]) => {
			const travel = travelOf(w);
			return on * clamp(1 - (v - travel * 0.55) / (travel * 0.4), 0, 1);
		}
	);
	const trackTransform = useTransform(
		[shake, pulse],
		([s = 0, p = 1]: number[]) => `translateX(${s}px) scale(${p})`
	);

	return {
		anchor,
		arrow,
		clip,
		content,
		inner: innerWidth,
		measured,
		origin,
		pulse,
		say,
		seen: seen as MotionValue<number>,
		shake,
		shape,
		shown,
		spin,
		trackTransform,
		x,
	};
}
