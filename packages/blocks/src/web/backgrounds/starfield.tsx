"use client";

import { useEffect, useRef } from "react";

/*
 * A night sky on a 2D canvas: a field of slowly twinkling stars with an
 * occasional shooting star drawn as a fading streak. Written for Ryu (not
 * vendored). Sleeps offscreen and draws one still frame under reduced motion.
 */

interface Star {
	phase: number;
	r: number;
	speed: number;
	x: number;
	y: number;
}

interface Streak {
	angle: number;
	life: number;
	speed: number;
	x: number;
	y: number;
}

export interface StarfieldProps {
	className?: string;
	/** Streak colour at its head. */
	color?: string;
	/** Stars per 10,000 px². */
	density?: number;
	/** Seconds between shooting stars, on average. */
	interval?: number;
}

const STREAK_LIFE = 1.1;
const STREAK_LENGTH = 140;

export default function Starfield({
	className,
	color = "#9fd4ff",
	density = 1.6,
	interval = 2.2,
}: StarfieldProps) {
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
		let stars: Star[] = [];
		const streaks: Streak[] = [];
		let width = 0;
		let height = 0;
		let raf = 0;
		let last = 0;
		let untilNext = interval * 0.5;
		let visible = true;

		const seed = () => {
			const count = Math.round(((width * height) / 10_000) * density);
			stars = Array.from({ length: count }, () => ({
				x: Math.random() * width,
				y: Math.random() * height,
				r: Math.random() * 1.1 + 0.25,
				phase: Math.random() * Math.PI * 2,
				speed: Math.random() * 1.4 + 0.4,
			}));
		};

		const resize = () => {
			const ratio = Math.min(window.devicePixelRatio || 1, 2);
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = Math.max(1, Math.round(width * ratio));
			canvas.height = Math.max(1, Math.round(height * ratio));
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			seed();
		};

		const spawn = () => {
			streaks.push({
				x: Math.random() * width * 0.8 + width * 0.1,
				y: Math.random() * height * 0.4,
				angle: Math.PI / 5 + Math.random() * 0.25,
				speed: 520 + Math.random() * 380,
				life: 0,
			});
		};

		const draw = (time: number) => {
			context.clearRect(0, 0, width, height);
			for (const star of stars) {
				const twinkle = reduce
					? 0.7
					: 0.45 + 0.55 * Math.sin(time * star.speed + star.phase) ** 2;
				context.globalAlpha = twinkle;
				context.fillStyle = "#ffffff";
				context.beginPath();
				context.arc(star.x, star.y, star.r, 0, Math.PI * 2);
				context.fill();
			}
			for (const streak of streaks) {
				const fade = 1 - streak.life / STREAK_LIFE;
				const dx = Math.cos(streak.angle);
				const dy = Math.sin(streak.angle);
				const tailX = streak.x - dx * STREAK_LENGTH;
				const tailY = streak.y - dy * STREAK_LENGTH;
				const gradient = context.createLinearGradient(
					tailX,
					tailY,
					streak.x,
					streak.y
				);
				gradient.addColorStop(0, "rgba(255,255,255,0)");
				gradient.addColorStop(1, color);
				context.globalAlpha = fade;
				context.strokeStyle = gradient;
				context.lineWidth = 1.4;
				context.beginPath();
				context.moveTo(tailX, tailY);
				context.lineTo(streak.x, streak.y);
				context.stroke();
			}
			context.globalAlpha = 1;
		};

		const frame = (now: number) => {
			raf = 0;
			if (!visible || document.hidden) {
				last = 0;
				return;
			}
			const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
			last = now;
			untilNext -= dt;
			if (untilNext <= 0) {
				spawn();
				untilNext = interval * (0.5 + Math.random());
			}
			for (const streak of streaks) {
				streak.life += dt;
				streak.x += Math.cos(streak.angle) * streak.speed * dt;
				streak.y += Math.sin(streak.angle) * streak.speed * dt;
			}
			while (streaks.length > 0 && (streaks[0]?.life ?? 0) > STREAK_LIFE) {
				streaks.shift();
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
	}, [color, density, interval]);

	return (
		<canvas
			className={className ?? "absolute inset-0 block h-full w-full"}
			ref={canvasRef}
		/>
	);
}
