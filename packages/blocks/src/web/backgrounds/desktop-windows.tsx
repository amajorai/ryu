"use client";

import { useEffect, useRef } from "react";

/*
 * A quiet desktop on a 2D canvas: a faint dot grid with a few window frames
 * floating at different depths, and focus passing from window to window as a
 * soft accent outline. Written for Ryu (not vendored). Sleeps offscreen and
 * draws one still frame under reduced motion.
 */

export interface DesktopWindowsProps {
	className?: string;
	/** Outline colour of the focused window. */
	color?: string;
	/** Seconds each window keeps focus. */
	interval?: number;
}

export interface Frame {
	/** 0 (far, faint) to 1 (near, bright). */
	depth: number;
	h: number;
	phase: number;
	w: number;
	x: number;
	y: number;
}

/*
 * Window positions as fractions of the stage. The stage hero centres its copy,
 * so the windows keep to the corners and edges and leave the middle clear.
 */
export const FRAMES: readonly Frame[] = [
	{ x: 0.7, y: 0.07, w: 0.26, h: 0.26, depth: 1, phase: 0 },
	{ x: 0.04, y: 0.64, w: 0.23, h: 0.28, depth: 0.9, phase: 1.7 },
	{ x: 0.75, y: 0.62, w: 0.21, h: 0.26, depth: 0.75, phase: 3.1 },
	{ x: 0.05, y: 0.1, w: 0.15, h: 0.2, depth: 0.4, phase: 2.3 },
	{ x: 0.87, y: 0.38, w: 0.11, h: 0.18, depth: 0.35, phase: 4.4 },
	{ x: 0.4, y: 0.86, w: 0.2, h: 0.12, depth: 0.25, phase: 5.2 },
];

/** Windows near enough to take focus, nearest first. */
export const FOCUSABLE = FRAMES.flatMap((frame, index) =>
	frame.depth >= 0.6 ? [index] : []
);

const GRID_SPACING = 28;
const DRIFT = 10;
const FOCUS_EASE = 4;

function roundedRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
) {
	context.beginPath();
	context.roundRect(x, y, w, h, r);
}

export default function DesktopWindows({
	className,
	color = "#4fb3ff",
	interval = 3.2,
}: DesktopWindowsProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!(canvas && context)) {
			return;
		}
		const reduce = window.matchMedia(
			"(prefers-reduced-motion: reduce)"
		).matches;
		const grid = document.createElement("canvas");
		const focus: number[] = FRAMES.map((_, index) =>
			index === FOCUSABLE[0] ? 1 : 0
		);
		let focused = 0;
		let untilSwitch = interval;
		let width = 0;
		let height = 0;
		let ratio = 1;
		let raf = 0;
		let last = 0;
		let clock = 0;
		let visible = true;

		// The dot grid never moves, so it is drawn once per size.
		const paintGrid = () => {
			grid.width = canvas.width;
			grid.height = canvas.height;
			const gridContext = grid.getContext("2d");
			if (!gridContext) {
				return;
			}
			gridContext.setTransform(ratio, 0, 0, ratio, 0, 0);
			gridContext.fillStyle = "rgba(255,255,255,0.09)";
			for (let y = GRID_SPACING / 2; y < height; y += GRID_SPACING) {
				for (let x = GRID_SPACING / 2; x < width; x += GRID_SPACING) {
					gridContext.fillRect(x - 0.5, y - 0.5, 1, 1);
				}
			}
		};

		const resize = () => {
			ratio = Math.min(window.devicePixelRatio || 1, 2);
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = Math.max(1, Math.round(width * ratio));
			canvas.height = Math.max(1, Math.round(height * ratio));
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			paintGrid();
		};

		const drawFrame = (frame: Frame, index: number, time: number) => {
			const drift = reduce ? 0 : DRIFT * frame.depth;
			const x = frame.x * width + Math.sin(time * 0.11 + frame.phase) * drift;
			const y =
				frame.y * height + Math.cos(time * 0.09 + frame.phase) * drift * 0.6;
			const w = Math.max(96, frame.w * width);
			const h = Math.max(72, frame.h * height);
			const bar = Math.min(24, h * 0.14);
			const alpha = 0.05 + frame.depth * 0.13;
			const lit = focus[index] ?? 0;

			roundedRect(context, x, y, w, h, 10);
			context.fillStyle = `rgba(255,255,255,${0.015 + frame.depth * 0.02})`;
			context.fill();
			context.lineWidth = 1;
			context.strokeStyle = `rgba(255,255,255,${alpha})`;
			context.stroke();

			// Title bar: a divider and three controls.
			context.strokeStyle = `rgba(255,255,255,${alpha * 0.7})`;
			context.beginPath();
			context.moveTo(x, y + bar);
			context.lineTo(x + w, y + bar);
			context.stroke();
			context.fillStyle = `rgba(255,255,255,${alpha * 1.4})`;
			for (let dot = 0; dot < 3; dot++) {
				context.beginPath();
				context.arc(x + 12 + dot * 10, y + bar / 2, 2.5, 0, Math.PI * 2);
				context.fill();
			}

			// Content as a few skeleton lines, on windows tall enough to read.
			if (h > 140) {
				context.fillStyle = `rgba(255,255,255,${alpha * 0.45})`;
				for (const [row, span] of [0.62, 0.44, 0.7].entries()) {
					context.fillRect(x + 16, y + bar + 18 + row * 14, w * span - 16, 4);
				}
			}

			if (lit > 0.01) {
				context.save();
				context.globalAlpha = lit;
				context.shadowColor = color;
				context.shadowBlur = 28;
				context.strokeStyle = color;
				context.lineWidth = 1.2;
				roundedRect(context, x, y, w, h, 10);
				context.stroke();
				context.restore();
			}
		};

		const draw = (time: number) => {
			context.clearRect(0, 0, width, height);
			context.drawImage(grid, 0, 0, width, height);
			// Far windows first, so near ones sit on top.
			const order = FRAMES.map((_, index) => index).sort(
				(a, b) => (FRAMES[a]?.depth ?? 0) - (FRAMES[b]?.depth ?? 0)
			);
			for (const index of order) {
				const frame = FRAMES[index];
				if (frame) {
					drawFrame(frame, index, time);
				}
			}
		};

		const frame = (now: number) => {
			raf = 0;
			if (!visible || document.hidden) {
				last = 0;
				return;
			}
			const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
			last = now;
			untilSwitch -= dt;
			if (untilSwitch <= 0) {
				focused = (focused + 1) % FOCUSABLE.length;
				untilSwitch = interval;
			}
			const target = FOCUSABLE[focused];
			for (const [index, value] of focus.entries()) {
				const goal = index === target ? 1 : 0;
				focus[index] = value + (goal - value) * Math.min(1, dt * FOCUS_EASE);
			}
			clock = now / 1000;
			draw(clock);
			raf = requestAnimationFrame(frame);
		};

		const wake = () => {
			if (!(raf || reduce)) {
				raf = requestAnimationFrame(frame);
			}
		};

		const observer = new ResizeObserver(() => {
			resize();
			draw(clock);
		});
		observer.observe(canvas);
		const intersection = new IntersectionObserver((entries) => {
			visible = entries.some((entry) => entry.isIntersecting);
			if (visible) {
				wake();
			}
		});
		intersection.observe(canvas);
		document.addEventListener("visibilitychange", wake);
		resize();
		draw(0);
		wake();

		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
			intersection.disconnect();
			document.removeEventListener("visibilitychange", wake);
		};
	}, [color, interval]);

	return (
		<canvas
			className={className ?? "absolute inset-0 block h-full w-full"}
			ref={canvasRef}
		/>
	);
}
