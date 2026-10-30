"use client";

import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	CELL,
	clamp,
	HOME,
	KEY_PAN,
	KEY_ZOOM,
	NEAR_HOME,
	SLOP,
	SNAP_HOME,
	type Spring,
	TOGGLE,
	WHEEL_RATE,
} from "./image-lightbox-motion.ts";

interface Drag {
	from: { x: number; y: number };
	id: number;
	x: number;
	y: number;
}

interface UseLightboxOptions {
	disabled?: boolean;
	maxScale?: number;
	onDismiss?: () => void;
	steps?: number;
}

export function useLightbox<
	Frame extends HTMLElement = HTMLDivElement,
	Content extends HTMLElement = HTMLImageElement,
>({
	maxScale = 4,
	steps = 8,
	disabled = false,
	onDismiss,
}: UseLightboxOptions = {}) {
	const cells = Math.max(1, Math.round(steps));
	const top = Math.max(1.1, maxScale);

	const frameRef = useRef<Frame>(null);
	const contentRef = useRef<Content>(null);

	const scale = useMotionValue(1);
	const x = useMotionValue(0);
	const y = useMotionValue(0);

	const [step, setStep] = useState(0);
	const [zoomValue, setZoomValue] = useState(1);
	const [settledZoomValue, setSettledZoomValue] = useState(1);

	const stepRef = useRef(0);
	const settledRef = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const drag = useRef<Drag | null>(null);
	const onContent = useRef(false);

	const reduced = useReducedMotion();
	const dismiss = useRef(onDismiss);
	dismiss.current = onDismiss;

	const toStep = useCallback(
		(s: number) => clamp(Math.round(((s - 1) / (top - 1)) * cells), 0, cells),
		[cells, top]
	);

	const mark = useCallback(
		(s: number) => {
			const next = toStep(s);
			if (stepRef.current === next) {
				return;
			}
			stepRef.current = next;
			setStep(next);
		},
		[toStep]
	);

	const settle = useCallback(
		(s: number) => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			const next = toStep(s);
			if (settledRef.current === next) {
				setSettledZoomValue(s);
				return;
			}
			settledRef.current = next;
			setSettledZoomValue(s);
		},
		[toStep]
	);

	const settleSoon = useCallback(
		(s: number) => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
			timer.current = setTimeout(() => {
				timer.current = null;
				settle(s);
			}, 220);
		},
		[settle]
	);

	const limit = useCallback((s: number) => {
		const frame = frameRef.current;
		const content = contentRef.current;
		if (!(frame && content)) {
			return { mx: 0, my: 0 };
		}
		return {
			mx: Math.max(0, (content.offsetWidth * s - frame.clientWidth) / 2),
			my: Math.max(0, (content.offsetHeight * s - frame.clientHeight) / 2),
		};
	}, []);

	const place = useCallback(
		(s: number, nx: number, ny: number) => {
			const { mx, my } = limit(s);
			scale.set(s);
			x.set(clamp(nx, -mx, mx));
			y.set(clamp(ny, -my, my));
			setZoomValue(s);
			mark(s);
		},
		[limit, mark, scale, setZoomValue, x, y]
	);

	const glide = useCallback(
		(s: number, nx: number, ny: number, spring: Spring = CELL) => {
			const { mx, my } = limit(s);
			const tx = clamp(nx, -mx, mx);
			const ty = clamp(ny, -my, my);
			if (reduced) {
				scale.set(s);
				x.set(tx);
				y.set(ty);
			} else {
				animate(scale, s, spring);
				animate(x, tx, spring);
				animate(y, ty, spring);
			}
			setZoomValue(s);
			mark(s);
			settle(s);
		},
		[limit, mark, reduced, scale, setZoomValue, settle, x, y]
	);

	const reset = useCallback(() => {
		glide(1, 0, 0, HOME);
	}, [glide]);

	const zoomAt = useCallback(
		(next: number, cx: number, cy: number, animated: boolean) => {
			const frame = frameRef.current;
			if (!frame) {
				return;
			}
			const r = frame.getBoundingClientRect();
			const px = cx - (r.left + r.width / 2);
			const py = cy - (r.top + r.height / 2);
			const s0 = scale.get();
			const ax = (px - x.get()) / s0;
			const ay = (py - y.get()) / s0;
			const s = clamp(next, 1, top);
			const nx = px - ax * s;
			const ny = py - ay * s;
			if (animated) {
				glide(s, nx, ny, s <= 1 ? HOME : CELL);
				return;
			}
			place(s, nx, ny);
			settleSoon(s);
		},
		[glide, place, scale, settleSoon, top, x, y]
	);

	const finish = useCallback(() => {
		const s0 = scale.get();
		if (s0 < SNAP_HOME) {
			reset();
		} else {
			settle(s0);
		}
	}, [reset, scale, settle]);

	const release = (e: React.PointerEvent) => {
		const held = drag.current;
		if (!held || held.id !== e.pointerId) {
			return;
		}
		drag.current = null;
		const moved = Math.hypot(e.clientX - held.from.x, e.clientY - held.from.y);
		if (moved < SLOP && !onContent.current && scale.get() <= NEAR_HOME) {
			dismiss.current?.();
			return;
		}
		finish();
	};

	const cancel = (e: React.PointerEvent) => {
		const held = drag.current;
		if (!held || held.id !== e.pointerId) {
			return;
		}
		drag.current = null;
		finish();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		const frame = frameRef.current;
		if (!frame || disabled) {
			return;
		}
		const r = frame.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		const s0 = scale.get();

		if (e.key === "+" || e.key === "=") {
			e.preventDefault();
			zoomAt(s0 * KEY_ZOOM, cx, cy, true);
			return;
		}
		if (e.key === "-" || e.key === "_") {
			e.preventDefault();
			zoomAt(s0 / KEY_ZOOM, cx, cy, true);
			return;
		}
		if (e.key === "0") {
			e.preventDefault();
			reset();
			return;
		}
		if (e.key === "Escape" && s0 > NEAR_HOME) {
			e.preventDefault();
			e.stopPropagation();
			reset();
			return;
		}
		if (s0 > NEAR_HOME && e.key.startsWith("Arrow")) {
			e.preventDefault();
			const dx =
				e.key === "ArrowLeft" ? KEY_PAN : e.key === "ArrowRight" ? -KEY_PAN : 0;
			const dy =
				e.key === "ArrowUp" ? KEY_PAN : e.key === "ArrowDown" ? -KEY_PAN : 0;
			glide(s0, x.get() + dx, y.get() + dy);
		}
	};

	const bind = {
		onPointerDown: (e: React.PointerEvent) => {
			if (disabled) {
				return;
			}
			if (e.pointerType === "mouse" && e.button !== 0) {
				return;
			}
			const content = contentRef.current;
			onContent.current =
				content && e.target instanceof Node
					? content.contains(e.target)
					: false;
			e.currentTarget.setPointerCapture?.(e.pointerId);
			drag.current = {
				id: e.pointerId,
				from: { x: e.clientX, y: e.clientY },
				x: x.get(),
				y: y.get(),
			};
		},
		onPointerMove: (e: React.PointerEvent) => {
			const held = drag.current;
			if (!held || held.id !== e.pointerId) {
				return;
			}
			if (scale.get() <= 1) {
				return;
			}
			place(
				scale.get(),
				held.x + (e.clientX - held.from.x),
				held.y + (e.clientY - held.from.y)
			);
		},
		onPointerUp: release,
		onPointerCancel: cancel,
		onLostPointerCapture: cancel,
		onDoubleClick: (e: React.MouseEvent) => {
			if (disabled) {
				return;
			}
			zoomAt(
				scale.get() > SNAP_HOME ? 1 : Math.min(TOGGLE, top),
				e.clientX,
				e.clientY,
				true
			);
		},
		onKeyDown,
	};

	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) {
			return;
		}
		const onWheel = (e: WheelEvent) => {
			if (disabled) {
				return;
			}
			e.preventDefault();
			zoomAt(
				scale.get() * Math.exp(-e.deltaY / WHEEL_RATE),
				e.clientX,
				e.clientY,
				false
			);
		};
		frame.addEventListener("wheel", onWheel, { passive: false });
		return () => frame.removeEventListener("wheel", onWheel);
	}, [disabled, scale, zoomAt]);

	useEffect(() => {
		const bail = () => {
			drag.current = null;
		};
		window.addEventListener("blur", bail);
		return () => {
			window.removeEventListener("blur", bail);
			if (timer.current) {
				clearTimeout(timer.current);
			}
		};
	}, []);

	return {
		frameRef,
		contentRef,
		bind,
		scale,
		x,
		y,
		step,
		steps: cells,
		zoom: zoomValue,
		settledZoom: settledZoomValue,
		zoomed: step > 0,
		reset,
		zoomAt,
	};
}
