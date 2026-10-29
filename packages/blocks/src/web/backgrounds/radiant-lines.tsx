"use client";

import { useEffect, useRef } from "react";

/*
 * Lines radiating from a focal point below the fold, each carrying pulses of
 * light outward: many connections leaving one hub. Written for Ryu (not
 * vendored). Sleeps offscreen and draws one still frame under reduced motion.
 */

export interface RadiantLinesProps {
	className?: string;
	/** Pulse colour. */
	color?: string;
	/** Number of radiating lines. */
	count?: number;
	/** Focal point as a fraction of the canvas: [x, y]. */
	origin?: [number, number];
}

interface Ray {
	angle: number;
	offset: number;
	speed: number;
}

export default function RadiantLines({
	className,
	color = "#4fb3ff",
	count = 72,
	origin = [0.5, 1.08],
}: RadiantLinesProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [originX, originY] = origin;

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!(canvas && context)) {
			return;
		}
		const reduce = window.matchMedia(
			"(prefers-reduced-motion: reduce)"
		).matches;
		// A half fan of rays, upward from the focal point.
		const rays: Ray[] = Array.from({ length: count }, (_, index) => ({
			angle: Math.PI + (Math.PI * (index + 0.5)) / count,
			offset: Math.random(),
			speed: 0.08 + Math.random() * 0.12,
		}));
		let width = 0;
		let height = 0;
		let raf = 0;
		let visible = true;

		const resize = () => {
			const ratio = Math.min(window.devicePixelRatio || 1, 2);
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = Math.max(1, Math.round(width * ratio));
			canvas.height = Math.max(1, Math.round(height * ratio));
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
		};

		const draw = (time: number) => {
			const cx = width * originX;
			const cy = height * originY;
			const reach = Math.hypot(width, height);
			context.clearRect(0, 0, width, height);
			context.lineWidth = 1;
			for (const ray of rays) {
				const dx = Math.cos(ray.angle);
				const dy = Math.sin(ray.angle);
				// The line itself: faint, fading out with distance.
				const line = context.createLinearGradient(
					cx,
					cy,
					cx + dx * reach,
					cy + dy * reach
				);
				line.addColorStop(0, "rgba(255,255,255,0.32)");
				line.addColorStop(0.7, "rgba(255,255,255,0.06)");
				line.addColorStop(1, "rgba(255,255,255,0)");
				context.strokeStyle = line;
				context.beginPath();
				context.moveTo(cx, cy);
				context.lineTo(cx + dx * reach, cy + dy * reach);
				context.stroke();
				// One pulse travelling out along it.
				const t = (ray.offset + time * ray.speed) % 1;
				const head = t * reach * 0.9;
				const tail = Math.max(0, head - 140);
				const pulse = context.createLinearGradient(
					cx + dx * tail,
					cy + dy * tail,
					cx + dx * head,
					cy + dy * head
				);
				pulse.addColorStop(0, "rgba(0,0,0,0)");
				pulse.addColorStop(1, color);
				context.globalAlpha = 1 - t;
				context.strokeStyle = pulse;
				context.lineWidth = 2.2;
				context.beginPath();
				context.moveTo(cx + dx * tail, cy + dy * tail);
				context.lineTo(cx + dx * head, cy + dy * head);
				context.stroke();
				context.globalAlpha = 1;
				context.lineWidth = 1;
			}
		};

		const frame = (now: number) => {
			raf = 0;
			if (!visible || document.hidden) {
				return;
			}
			draw(now / 1000);
			raf = requestAnimationFrame(frame);
		};

		const wake = () => {
			if (!(raf || reduce)) {
				raf = requestAnimationFrame(frame);
			}
		};

		const observer = new ResizeObserver(() => {
			resize();
			draw(0);
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
	}, [color, count, originX, originY]);

	return (
		<canvas
			className={className ?? "absolute inset-0 block h-full w-full"}
			ref={canvasRef}
		/>
	);
}
