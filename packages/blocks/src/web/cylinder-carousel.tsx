"use client";

// Adapted from beui.dev/components/motion/cylinder-carousel

import { cn } from "@ryu/ui/lib/utils";
import {
	type AnimationPlaybackControls,
	animate,
	type MotionValue,
	motion,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from "motion/react";
import {
	Children,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type WheelEvent as ReactWheelEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

const GLIDE_SPRING = { stiffness: 40, damping: 20, mass: 3 };
const FLICK_MOMENTUM = 0.45;
const MAX_FLICK_ITEMS = 6;

const THETA_EDGE = (72 * Math.PI) / 180;
const THETA_CLAMP = (95 * Math.PI) / 180;

export interface CylinderCarouselProps {
	/** Curve depth in px: for concave, how far the edge balls ride above the
	 * center one (valley); for convex, how far below (arch). 0 = flat line.
	 * Defaults to 35% of the item size. */
	arc?: number;
	/** Roll on its own until interacted with. */
	autoRotate?: boolean;
	/** Auto-roll speed in items per second. */
	autoRotateSpeed?: number;
	children: ReactNode;
	className?: string;
	defaultIndex?: number;
	/** Items rolled per item-width dragged — above 1 the wall outruns the
	 * pointer, which reads as a lighter, freer roll. */
	dragSpeed?: number;
	/** Stage height in px. Defaults to `itemSize`. */
	height?: number;
	/** Max item box size in px (square) at full size, i.e. at the container edge.
	 * Balls shrink below this automatically so the row keeps breathing room in
	 * narrow containers. */
	itemSize?: number;
	/** Scale of the smallest ball (center for concave, edges for convex);
	 * the biggest reaches 1. */
	minScale?: number;
	onIndexChange?: (index: number) => void;
	/** Snap to the nearest item when the roll settles. */
	snap?: boolean;
	/** "concave" (default): inside of the cylinder — center ball smallest and
	 * dipped, growing toward the edges. "convex": outside of the cylinder —
	 * center ball biggest and raised, shrinking toward the edges. */
	variant?: "concave" | "convex";
	/** How many item slots span the container width. */
	visibleItems?: number;
}

function CarouselBall({
	scroll,
	index,
	count,
	alpha,
	k,
	projection,
	gap,
	edgeOffset,
	minScale,
	convex,
	arc,
	halfWidth,
	itemSize,
	children,
}: {
	scroll: MotionValue<number>;
	index: number;
	count: number;
	alpha: number;
	k: number;
	projection: number;
	gap: number;
	edgeOffset: number;
	minScale: number;
	convex: boolean;
	arc: number;
	halfWidth: number;
	itemSize: number;
	children: ReactNode;
}) {
	const offset = useTransform(scroll, (s) => {
		let o = index - s;
		o -= Math.round(o / count) * count;
		return o;
	});

	const x = useTransform(offset, (o) => {
		if (convex) {
			return o * gap;
		}
		const th = Math.max(-THETA_CLAMP, Math.min(THETA_CLAMP, o * alpha));
		return (projection * Math.sin(th)) / (Math.cos(th) + k);
	});

	const scale = useTransform(offset, (o) => {
		const t = Math.min(Math.abs(o) / edgeOffset, THETA_CLAMP / THETA_EDGE);
		return convex ? 1 - (1 - minScale) * t : minScale + (1 - minScale) * t;
	});

	const y = useTransform(x, (px) => {
		const t = px / halfWidth;
		const valley = arc * (0.5 - t * t);
		return convex ? -valley : valley;
	});

	const visibility = useTransform(x, (px) =>
		Math.abs(px) > halfWidth + itemSize ? "hidden" : "visible"
	);

	return (
		<motion.div
			className="absolute top-1/2 left-1/2"
			style={{
				x,
				y,
				scale,
				visibility,
				width: itemSize,
				height: itemSize,
				marginLeft: -itemSize / 2,
				marginTop: -itemSize / 2,
			}}
		>
			{children}
		</motion.div>
	);
}

export function CylinderCarousel({
	children,
	itemSize = 200,
	visibleItems = 5,
	variant = "concave",
	minScale = 0.55,
	dragSpeed = 1.5,
	arc: arcProp,
	snap = true,
	autoRotate = false,
	autoRotateSpeed = 0.4,
	defaultIndex = 0,
	onIndexChange,
	height,
	className,
}: CylinderCarouselProps) {
	const reduce = useReducedMotion() ?? false;
	const items = Children.toArray(children);
	const count = items.length;

	const stageRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = stageRef.current;
		if (!el) {
			return;
		}
		const ro = new ResizeObserver(([entry]) => {
			setWidth(entry.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const stageWidth = width || 800;
	const halfWidth = stageWidth / 2;
	const edgeOffset = (visibleItems + 1) / 2;

	const convex = variant === "convex";
	let scaleSum = 0;
	for (let i = 0; i < visibleItems; i++) {
		const t = Math.abs(i - (visibleItems - 1) / 2) / edgeOffset;
		scaleSum += convex ? 1 - (1 - minScale) * t : minScale + (1 - minScale) * t;
	}
	const size = Math.min(itemSize, (stageWidth * 0.65) / scaleSum);

	const gap = stageWidth / (visibleItems + 1);
	const arc = arcProp ?? size * 0.35;

	const alpha = THETA_EDGE / edgeOffset;
	const k = Math.max(0.2, (minScale - Math.cos(THETA_EDGE)) / (1 - minScale));
	const projection =
		(halfWidth * (Math.cos(THETA_EDGE) + k)) / Math.sin(THETA_EDGE);

	const scroll = useMotionValue(defaultIndex);
	const indexRef = useRef(defaultIndex);
	const [, setActiveIndex] = useState(defaultIndex);
	const glideRef = useRef<AnimationPlaybackControls | null>(null);
	const draggingRef = useRef(false);
	const hoverRef = useRef(false);

	useEffect(() => {
		if (count === 0) {
			return;
		}
		const unsub = scroll.on("change", (v) => {
			const idx = ((Math.round(v) % count) + count) % count;
			if (idx !== indexRef.current) {
				indexRef.current = idx;
				setActiveIndex(idx);
				onIndexChange?.(idx);
			}
		});
		return unsub;
	}, [scroll, count, onIndexChange]);

	const stopGlide = useCallback(() => {
		glideRef.current?.stop();
		glideRef.current = null;
	}, []);

	const glideTo = useCallback(
		(to: number, velocity: number) => {
			stopGlide();
			if (reduce) {
				scroll.set(to);
				return;
			}
			glideRef.current = animate(scroll, to, {
				type: "spring",
				...GLIDE_SPRING,
				velocity,
				restDelta: 0.001,
				restSpeed: 0.005,
			});
		},
		[scroll, stopGlide, reduce]
	);

	const settle = useCallback(
		(velocity: number) => {
			const projected =
				scroll.get() +
				Math.max(
					-MAX_FLICK_ITEMS,
					Math.min(MAX_FLICK_ITEMS, velocity * FLICK_MOMENTUM)
				);
			glideTo(snap ? Math.round(projected) : projected, velocity);
		},
		[scroll, snap, glideTo]
	);

	const drag = useRef({
		startX: 0,
		startScroll: 0,
		lastX: 0,
		lastT: 0,
		prevX: 0,
		prevT: 0,
	});

	const onPointerDown = useCallback(
		(e: ReactPointerEvent) => {
			e.preventDefault();
			stopGlide();
			draggingRef.current = true;
			e.currentTarget.setPointerCapture(e.pointerId);
			const now = performance.now();
			drag.current = {
				startX: e.clientX,
				startScroll: scroll.get(),
				lastX: e.clientX,
				lastT: now,
				prevX: e.clientX,
				prevT: now,
			};
		},
		[scroll, stopGlide]
	);

	const onPointerMove = useCallback(
		(e: ReactPointerEvent) => {
			if (!draggingRef.current) {
				return;
			}
			const d = drag.current;
			scroll.set(d.startScroll - ((e.clientX - d.startX) * dragSpeed) / gap);
			d.prevX = d.lastX;
			d.prevT = d.lastT;
			d.lastX = e.clientX;
			d.lastT = performance.now();
		},
		[scroll, gap, dragSpeed]
	);

	const onPointerUp = useCallback(
		(e: ReactPointerEvent) => {
			if (!draggingRef.current) {
				return;
			}
			draggingRef.current = false;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) {
				e.currentTarget.releasePointerCapture(e.pointerId);
			}
			const d = drag.current;
			const dt = d.lastT - d.prevT;
			const vpx = dt > 0 ? (d.lastX - d.prevX) / dt : 0;
			settle((-vpx * dragSpeed * 1000) / gap);
		},
		[settle, gap, dragSpeed]
	);

	const rollBy = useCallback(
		(dir: number) => {
			glideTo(Math.round(scroll.get()) + dir, scroll.getVelocity());
		},
		[scroll, glideTo]
	);

	const wheelSettleRef = useRef<number | undefined>(undefined);
	const onWheel = useCallback(
		(e: ReactWheelEvent) => {
			stopGlide();
			const delta =
				Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			scroll.set(scroll.get() + delta / gap);
			if (wheelSettleRef.current) {
				window.clearTimeout(wheelSettleRef.current);
			}
			wheelSettleRef.current = window.setTimeout(
				() => settle(scroll.getVelocity()),
				140
			);
		},
		[scroll, gap, settle, stopGlide]
	);

	useEffect(() => {
		if (!autoRotate || reduce || count === 0) {
			return;
		}
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const dt = (now - last) / 1000;
			last = now;
			if (!(draggingRef.current || hoverRef.current || glideRef.current)) {
				scroll.set(scroll.get() + autoRotateSpeed * dt);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [autoRotate, autoRotateSpeed, reduce, count, scroll]);

	const stageHeight = height ?? size;

	return (
		<div
			className={cn(
				"relative w-full touch-none select-none outline-none [clip-path:inset(0)]",
				"cursor-grab active:cursor-grabbing",
				"focus-visible:ring-2 focus-visible:ring-foreground/20",
				className
			)}
			onKeyDown={(e) => {
				if (e.key === "ArrowRight") {
					e.preventDefault();
					rollBy(1);
				} else if (e.key === "ArrowLeft") {
					e.preventDefault();
					rollBy(-1);
				}
			}}
			onPointerCancel={onPointerUp}
			onPointerDown={onPointerDown}
			onPointerEnter={() => {
				hoverRef.current = true;
			}}
			onPointerLeave={() => {
				hoverRef.current = false;
			}}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onWheel={onWheel}
			ref={stageRef}
			style={{ height: stageHeight }}
		>
			{items.map((item, i) => (
				<CarouselBall
					alpha={alpha}
					arc={arc}
					convex={convex}
					count={count}
					edgeOffset={edgeOffset}
					gap={gap}
					halfWidth={halfWidth}
					index={i}
					itemSize={size}
					k={k}
					// biome-ignore lint/suspicious/noArrayIndexKey: children are a fixed, ordered list
					key={i}
					minScale={minScale}
					projection={projection}
					scroll={scroll}
				>
					{item}
				</CarouselBall>
			))}
		</div>
	);
}
