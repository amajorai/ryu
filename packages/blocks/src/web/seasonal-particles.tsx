"use client";

import { usePrefersReducedMotion } from "@ryu/ui/components/reduced-motion.ts";
import { useEffect, useRef } from "react";
import {
	type ParticleConfig,
	type ParticleKind,
	SEASON_PARTICLES,
} from "./seasonal-particle-configs.ts";
import { drawParticle } from "./seasonal-particle-shapes.ts";
import type { Season } from "./seasons.ts";
import { whenBrowserIdle } from "./when-browser-idle.ts";
import { whenUserEngaged } from "./when-user-engaged.ts";

interface Particle {
	colorIndex: number;
	kind: number;
	life: number;
	maxLife: number;
	phase: number;
	rotation: number;
	size: number;
	speed: number;
	spin: number;
	sway: number;
	x: number;
	y: number;
}

const between = ([min, max]: readonly [number, number]) =>
	min + Math.random() * (max - min);

function pickKind(config: ParticleConfig, totalWeight: number): number {
	let roll = Math.random() * totalWeight;
	for (const [index, kind] of config.kinds.entries()) {
		roll -= kind.weight;
		if (roll <= 0) {
			return index;
		}
	}
	return 0;
}

function runParticles(
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	config: ParticleConfig
): () => void {
	const [firstKind] = config.kinds;
	if (!firstKind) {
		return noop;
	}
	// Particle kinds index into a static, non-empty list; fall back to the first.
	const kindAt = (index: number): ParticleKind =>
		config.kinds[index] ?? firstKind;
	const totalWeight = config.kinds.reduce((sum, kind) => sum + kind.weight, 0);
	const direction = config.direction === "up" ? -1 : 1;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	let width = 0;
	let height = 0;
	const resize = () => {
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	resize();

	// `scattered` places a particle mid-life anywhere on screen, so the first
	// frame is already full instead of filling in from one edge.
	const spawn = (scattered: boolean): Particle => {
		const kind = pickKind(config, totalWeight);
		const spec = kindAt(kind);
		const maxLife = between(spec.life);
		return {
			kind,
			x: Math.random() * width,
			y: scattered
				? Math.random() * height
				: direction === -1
					? height + 20
					: -20,
			size: between(spec.size),
			speed: between(spec.speed),
			sway: between(spec.sway),
			phase: Math.random() * Math.PI * 2,
			spin: (Math.random() - 0.5) * 2,
			rotation: Math.random() * Math.PI * 2,
			life: scattered ? Math.random() * maxLife * 0.6 : 0,
			maxLife,
			colorIndex: Math.floor(Math.random() * 8),
		};
	};

	const particles = Array.from({ length: config.count }, () => spawn(true));
	let last = performance.now();
	let frame = 0;

	const tick = (now: number) => {
		const dt = Math.min((now - last) / 1000, 0.05);
		last = now;
		ctx.clearRect(0, 0, width, height);
		const isDark = document.documentElement.classList.contains("dark");

		for (const [index, particle] of particles.entries()) {
			const spec = kindAt(particle.kind);
			particle.life += dt;
			particle.y += direction * particle.speed * dt;
			particle.phase += dt * 1.6;
			particle.rotation += particle.spin * dt;

			const offscreen = particle.y < -40 || particle.y > height + 40;
			if (particle.life >= particle.maxLife || offscreen) {
				particles[index] = spawn(false);
				continue;
			}

			// Fade in quickly and out at the end of life; embers flicker.
			const t = particle.life / particle.maxLife;
			const fade = Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
			const flicker = spec.shape === "dot" ? 0.7 + Math.random() * 0.3 : 1;
			const colors = spec.colors(isDark);

			ctx.save();
			ctx.globalAlpha = fade * flicker;
			ctx.fillStyle = colors[particle.colorIndex % colors.length] ?? "#fff";
			ctx.translate(
				particle.x + Math.sin(particle.phase) * particle.sway,
				particle.y
			);
			drawParticle(
				ctx,
				spec.shape,
				particle.size,
				particle.phase,
				particle.rotation
			);
			ctx.restore();
		}

		frame = window.requestAnimationFrame(tick);
	};

	frame = window.requestAnimationFrame(tick);
	window.addEventListener("resize", resize);
	return () => {
		window.cancelAnimationFrame(frame);
		window.removeEventListener("resize", resize);
	};
}

/**
 * A full-viewport canvas of drifting seasonal particles (snow, embers, hearts…).
 * Decorative and click-through; it renders nothing for visitors who ask for
 * reduced motion. The frame loop starts once the browser is idle and the visitor
 * first interacts, so redrawing the whole viewport every frame never competes
 * with the page load (the same rule as the hero's Download beam).
 */
export function SeasonalParticles({ season }: { season: Season }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const reduceMotion = usePrefersReducedMotion();

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (reduceMotion || !(canvas && ctx)) {
			return;
		}
		let idle = false;
		let engaged = false;
		let stop: (() => void) | undefined;
		const startWhenReady = () => {
			if (idle && engaged && !stop) {
				stop = runParticles(canvas, ctx, SEASON_PARTICLES[season]);
			}
		};
		const cancelIdle = whenBrowserIdle(() => {
			idle = true;
			startWhenReady();
		});
		const cancelEngaged = whenUserEngaged(() => {
			engaged = true;
			startWhenReady();
		});
		return () => {
			cancelIdle();
			cancelEngaged();
			stop?.();
		};
	}, [reduceMotion, season]);

	if (reduceMotion) {
		return null;
	}
	return (
		<canvas
			className="pointer-events-none fixed inset-0 z-40 h-screen w-screen"
			data-season={season}
			data-testid="seasonal-particles"
			ref={canvasRef}
		/>
	);
}

function noop(): void {
	// Nothing was started.
}
