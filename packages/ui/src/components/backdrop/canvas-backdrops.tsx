// packages/ui/src/components/backdrop/canvas-backdrops.tsx
//
// Canvas 2D backdrops: starfields, meteors, a topographic contour field, a
// dotted globe, drifting particles and flowing lines. Original implementations
// of those well-known looks, sharing one loop that caps the pixel ratio, caps
// the frame rate, pauses while the page is hidden, and paints a single still
// frame when motion is off.

import { useEffect, useRef } from "react";
import { z } from "zod";
import type { BackdropParams } from "./params.ts";

export interface BackdropRendererProps {
	animate: boolean;
	className?: string;
	params: BackdropParams;
}

interface Frame {
	ctx: CanvasRenderingContext2D;
	/** Seconds since the backdrop mounted (frozen while paused). */
	dt: number;
	height: number;
	time: number;
	width: number;
}

export type Painter = (frame: Frame) => void;

const MAX_DPR = 1.5;
const FRAME_MS = 1000 / 30;
const canvasNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const canvasTextSchema = z.string();
const canvasToggleSchema = z.boolean();

export function num(
	params: BackdropParams,
	key: string,
	fallback: number
): number {
	const parsed = canvasNumberSchema.safeParse(params[key]);
	return parsed.success ? parsed.data : fallback;
}

export function str(
	params: BackdropParams,
	key: string,
	fallback: string
): string {
	const parsed = canvasTextSchema.safeParse(params[key]);
	return parsed.success ? parsed.data : fallback;
}

export function bool(
	params: BackdropParams,
	key: string,
	fallback: boolean
): boolean {
	const parsed = canvasToggleSchema.safeParse(params[key]);
	return parsed.success ? parsed.data : fallback;
}

/** Deterministic PRNG so a backdrop looks the same on every mount. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/**
 * Drive `createPainter()` on a canvas. The painter factory re-runs when
 * `paramsKey` changes so painters can precompute per-param state.
 */
export function CanvasBackdrop({
	animate,
	className,
	createPainter,
	paramsKey,
}: {
	animate: boolean;
	className?: string;
	createPainter: () => Painter;
	paramsKey: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const factoryRef = useRef(createPainter);
	factoryRef.current = createPainter;

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!(canvas && ctx)) {
			return;
		}
		const paint = factoryRef.current();
		let width = 0;
		let height = 0;
		let raf = 0;
		let last = 0;
		let time = 0;

		const resize = () => {
			const rect = canvas.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
			width = Math.max(1, rect.width);
			height = Math.max(1, rect.height);
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		const draw = (dt: number) => {
			paint({ ctx, dt, height, time, width });
		};
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (document.hidden) {
				last = now;
				return;
			}
			const elapsed = now - last;
			if (elapsed < FRAME_MS) {
				return;
			}
			const dt = Math.min(elapsed, 100) / 1000;
			last = now;
			time += dt;
			draw(dt);
		};

		resize();
		draw(0);
		const observer = new ResizeObserver(() => {
			resize();
			draw(0);
		});
		observer.observe(canvas);
		if (animate) {
			last = performance.now();
			raf = requestAnimationFrame(tick);
		}
		return () => {
			cancelAnimationFrame(raf);
			observer.disconnect();
		};
	}, [animate, paramsKey]);

	return (
		<canvas
			className={className ?? "absolute inset-0 size-full"}
			ref={canvasRef}
		/>
	);
}

export function paramsKeyOf(params: BackdropParams): string {
	return JSON.stringify(params);
}

// ---- starfield warp ---------------------------------------------------------

export function WarpStarfield({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#02030a");
				const color = str(params, "starColor", "#ffffff");
				const count = Math.round(num(params, "count", 500));
				const speed = num(params, "speed", 1);
				const trails = bool(params, "trails", true);
				const random = mulberry32(7);
				const stars = Array.from({ length: count }, () => ({
					x: random() * 2 - 1,
					y: random() * 2 - 1,
					z: random(),
				}));
				return ({ ctx, dt, height, width }) => {
					ctx.fillStyle = background;
					ctx.globalAlpha = trails && dt > 0 ? 0.35 : 1;
					ctx.fillRect(0, 0, width, height);
					ctx.globalAlpha = 1;
					const cx = width / 2;
					const cy = height / 2;
					const focal = Math.max(width, height) * 0.5;
					ctx.fillStyle = color;
					ctx.strokeStyle = color;
					for (const star of stars) {
						const prevZ = star.z;
						star.z -= dt * speed * 0.35;
						if (star.z <= 0.02) {
							star.x = random() * 2 - 1;
							star.y = random() * 2 - 1;
							star.z = 1;
							continue;
						}
						const sx = cx + (star.x / star.z) * focal;
						const sy = cy + (star.y / star.z) * focal;
						if (sx < 0 || sx > width || sy < 0 || sy > height) {
							continue;
						}
						const size = Math.max(0.4, (1 - star.z) * 2.2);
						ctx.globalAlpha = Math.min(1, (1 - star.z) * 1.4);
						if (trails && dt > 0) {
							const px = cx + (star.x / prevZ) * focal;
							const py = cy + (star.y / prevZ) * focal;
							ctx.lineWidth = size;
							ctx.beginPath();
							ctx.moveTo(px, py);
							ctx.lineTo(sx, sy);
							ctx.stroke();
						} else {
							ctx.beginPath();
							ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
							ctx.fill();
						}
					}
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- twinkling stars + shooting stars ----------------------------------------

function makeStarPainter(params: BackdropParams, meteors: boolean): Painter {
	const background = str(params, "background", "#030712");
	const color = str(params, "starColor", "#ffffff");
	const meteorColor = str(params, "meteorColor", "#9ecbff");
	const density = num(params, "density", 0.6);
	const twinkle = num(params, "twinkle", 1);
	const frequency = num(params, "frequency", 0.5);
	const random = mulberry32(11);
	const stars = Array.from({ length: Math.round(120 + density * 900) }, () => ({
		phase: random() * Math.PI * 2,
		rate: 0.5 + random() * 1.5,
		size: 0.3 + random() * 1.1,
		x: random(),
		y: random(),
	}));
	const trails: {
		angle: number;
		length: number;
		life: number;
		speed: number;
		x: number;
		y: number;
	}[] = [];
	let nextMeteor = 0.5;
	return ({ ctx, dt, height, time, width }) => {
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = color;
		for (const star of stars) {
			const glow =
				0.55 + 0.45 * Math.sin(time * star.rate * twinkle + star.phase);
			ctx.globalAlpha = 0.25 + glow * 0.75;
			ctx.beginPath();
			ctx.arc(star.x * width, star.y * height, star.size, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
		if (!meteors) {
			return;
		}
		nextMeteor -= dt;
		if (nextMeteor <= 0 && frequency > 0) {
			trails.push({
				angle: Math.PI / 4 + (random() - 0.5) * 0.3,
				length: 80 + random() * 140,
				life: 0,
				speed: 500 + random() * 500,
				x: random() * width * 0.8,
				y: random() * height * 0.4,
			});
			nextMeteor = (0.6 + random() * 2.4) / frequency;
		}
		for (let index = trails.length - 1; index >= 0; index -= 1) {
			const trail = trails[index];
			if (!trail) {
				continue;
			}
			trail.life += dt;
			const headX = trail.x + Math.cos(trail.angle) * trail.speed * trail.life;
			const headY = trail.y + Math.sin(trail.angle) * trail.speed * trail.life;
			if (headX > width + 200 || headY > height + 200) {
				trails.splice(index, 1);
				continue;
			}
			const tailX = headX - Math.cos(trail.angle) * trail.length;
			const tailY = headY - Math.sin(trail.angle) * trail.length;
			const gradient = ctx.createLinearGradient(tailX, tailY, headX, headY);
			gradient.addColorStop(0, "transparent");
			gradient.addColorStop(1, meteorColor);
			ctx.strokeStyle = gradient;
			ctx.lineWidth = 1.6;
			ctx.beginPath();
			ctx.moveTo(tailX, tailY);
			ctx.lineTo(headX, headY);
			ctx.stroke();
		}
	};
}

export function TwinklingStars({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => makeStarPainter(params, false)}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

export function ShootingStars({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => makeStarPainter(params, true)}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- topographic field -----------------------------------------------------

export function makeNoise(seed: number) {
	const random = mulberry32(seed);
	const perm = Array.from({ length: 256 }, (_, index) => index);
	for (let index = 255; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		[perm[index], perm[swap]] = [perm[swap] ?? 0, perm[index] ?? 0];
	}
	const table = [...perm, ...perm];
	const hash = (x: number, y: number, z: number) =>
		(table[(table[(table[x & 255] ?? 0) + (y & 255)] ?? 0) + (z & 255)] ?? 0) /
		255;
	const fade = (t: number) => t * t * (3 - 2 * t);
	const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
	return (x: number, y: number, z: number) => {
		const xi = Math.floor(x);
		const yi = Math.floor(y);
		const zi = Math.floor(z);
		const xf = fade(x - xi);
		const yf = fade(y - yi);
		const zf = fade(z - zi);
		const c = (dx: number, dy: number, dz: number) =>
			hash(xi + dx, yi + dy, zi + dz);
		const x00 = lerp(c(0, 0, 0), c(1, 0, 0), xf);
		const x10 = lerp(c(0, 1, 0), c(1, 1, 0), xf);
		const x01 = lerp(c(0, 0, 1), c(1, 0, 1), xf);
		const x11 = lerp(c(0, 1, 1), c(1, 1, 1), xf);
		return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
	};
}

export function TopoField({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#0b0f14");
				const lineColor = str(params, "lineColor", "#7dd3fc");
				const levels = Math.round(num(params, "levels", 14));
				const scale = num(params, "scale", 1);
				const speed = num(params, "speed", 0.3);
				const lineWidth = num(params, "lineWidth", 1);
				const noise = makeNoise(3);
				const cell = 12;
				return ({ ctx, height, time, width }) => {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					const cols = Math.ceil(width / cell) + 1;
					const rows = Math.ceil(height / cell) + 1;
					const field = new Float32Array(cols * rows);
					const frequency = 0.006 / scale;
					const z = time * speed * 0.2;
					for (let row = 0; row < rows; row += 1) {
						for (let col = 0; col < cols; col += 1) {
							const x = col * cell * frequency;
							const y = row * cell * frequency;
							field[row * cols + col] =
								noise(x, y, z) * 0.65 + noise(x * 2.1, y * 2.1, z) * 0.35;
						}
					}
					ctx.strokeStyle = lineColor;
					ctx.lineWidth = lineWidth;
					ctx.globalAlpha = 0.55;
					ctx.beginPath();
					for (let level = 1; level < levels; level += 1) {
						const iso = level / levels;
						for (let row = 0; row < rows - 1; row += 1) {
							for (let col = 0; col < cols - 1; col += 1) {
								const a = field[row * cols + col] ?? 0;
								const b = field[row * cols + col + 1] ?? 0;
								const c = field[(row + 1) * cols + col + 1] ?? 0;
								const d = field[(row + 1) * cols + col] ?? 0;
								const x0 = col * cell;
								const y0 = row * cell;
								const points: [number, number][] = [];
								const edge = (
									v1: number,
									v2: number,
									p1: [number, number],
									p2: [number, number]
								) => {
									if (v1 < iso !== v2 < iso) {
										const t = (iso - v1) / (v2 - v1);
										points.push([
											p1[0] + (p2[0] - p1[0]) * t,
											p1[1] + (p2[1] - p1[1]) * t,
										]);
									}
								};
								edge(a, b, [x0, y0], [x0 + cell, y0]);
								edge(b, c, [x0 + cell, y0], [x0 + cell, y0 + cell]);
								edge(c, d, [x0 + cell, y0 + cell], [x0, y0 + cell]);
								edge(d, a, [x0, y0 + cell], [x0, y0]);
								for (let index = 0; index + 1 < points.length; index += 2) {
									const from = points[index];
									const to = points[index + 1];
									if (from && to) {
										ctx.moveTo(from[0], from[1]);
										ctx.lineTo(to[0], to[1]);
									}
								}
							}
						}
					}
					ctx.stroke();
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- dotted globe -----------------------------------------------------------

export function DottedGlobe({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#050816");
				const dotColor = str(params, "dotColor", "#8ab4ff");
				const glowColor = str(params, "glowColor", "#3b82f6");
				const count = Math.round(num(params, "dots", 1400));
				const speed = num(params, "speed", 0.25);
				const size = num(params, "size", 0.36);
				const tilt = 0.35;
				const golden = Math.PI * (3 - Math.sqrt(5));
				const points = Array.from({ length: count }, (_, index) => {
					const y = 1 - (index / (count - 1)) * 2;
					const radius = Math.sqrt(1 - y * y);
					const theta = golden * index;
					return [
						Math.cos(theta) * radius,
						y,
						Math.sin(theta) * radius,
					] as const;
				});
				return ({ ctx, height, time, width }) => {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					const cx = width / 2;
					const cy = height / 2;
					const radius = Math.min(width, height) * size;
					const halo = ctx.createRadialGradient(
						cx,
						cy,
						radius * 0.6,
						cx,
						cy,
						radius * 1.6
					);
					halo.addColorStop(0, glowColor);
					halo.addColorStop(1, "transparent");
					ctx.globalAlpha = 0.25;
					ctx.fillStyle = halo;
					ctx.fillRect(0, 0, width, height);
					const spin = time * speed;
					const cosS = Math.cos(spin);
					const sinS = Math.sin(spin);
					const cosT = Math.cos(tilt);
					const sinT = Math.sin(tilt);
					ctx.fillStyle = dotColor;
					for (const [px, py, pz] of points) {
						const x = px * cosS + pz * sinS;
						const z1 = -px * sinS + pz * cosS;
						const y = py * cosT - z1 * sinT;
						const z = py * sinT + z1 * cosT;
						const depth = (z + 1) / 2;
						ctx.globalAlpha = 0.12 + depth * 0.88;
						ctx.beginPath();
						ctx.arc(
							cx + x * radius,
							cy + y * radius,
							0.6 + depth * 1.2,
							0,
							Math.PI * 2
						);
						ctx.fill();
					}
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- particles --------------------------------------------------------------

export function ParticleField({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#0a0a12");
				const color = str(params, "color", "#c4b5fd");
				const count = Math.round(num(params, "count", 90));
				const distance = num(params, "linkDistance", 120);
				const speed = num(params, "speed", 0.4);
				const random = mulberry32(5);
				const particles = Array.from({ length: count }, () => ({
					vx: (random() - 0.5) * 40,
					vy: (random() - 0.5) * 40,
					x: random(),
					y: random(),
				}));
				return ({ ctx, dt, height, width }) => {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					for (const particle of particles) {
						particle.x =
							(particle.x + (particle.vx * dt * speed) / width + 1) % 1;
						particle.y =
							(particle.y + (particle.vy * dt * speed) / height + 1) % 1;
					}
					ctx.strokeStyle = color;
					ctx.fillStyle = color;
					for (let i = 0; i < particles.length; i += 1) {
						const a = particles[i];
						if (!a) {
							continue;
						}
						const ax = a.x * width;
						const ay = a.y * height;
						for (let j = i + 1; j < particles.length; j += 1) {
							const b = particles[j];
							if (!b) {
								continue;
							}
							const dx = ax - b.x * width;
							const dy = ay - b.y * height;
							const d = Math.hypot(dx, dy);
							if (d < distance) {
								ctx.globalAlpha = (1 - d / distance) * 0.5;
								ctx.beginPath();
								ctx.moveTo(ax, ay);
								ctx.lineTo(b.x * width, b.y * height);
								ctx.stroke();
							}
						}
						ctx.globalAlpha = 0.9;
						ctx.beginPath();
						ctx.arc(ax, ay, 1.6, 0, Math.PI * 2);
						ctx.fill();
					}
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- flowing lines ------------------------------------------------------------

export function FlowingLines({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#07070c");
				const color = str(params, "color", "#f0abfc");
				const accent = str(params, "accent", "#60a5fa");
				const lines = Math.round(num(params, "lines", 24));
				const amplitude = num(params, "amplitude", 0.5);
				const speed = num(params, "speed", 0.5);
				return ({ ctx, height, time, width }) => {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					const gradient = ctx.createLinearGradient(0, 0, width, 0);
					gradient.addColorStop(0, color);
					gradient.addColorStop(1, accent);
					ctx.strokeStyle = gradient;
					ctx.lineWidth = 1;
					for (let line = 0; line < lines; line += 1) {
						const offset = line / lines;
						ctx.globalAlpha = 0.15 + 0.6 * Math.sin(offset * Math.PI);
						ctx.beginPath();
						for (let x = 0; x <= width; x += 8) {
							const u = x / width;
							const y =
								height * (0.5 + (offset - 0.5) * 0.35) +
								Math.sin(u * 6 + time * speed + offset * 4) *
									height *
									0.12 *
									amplitude +
								Math.sin(u * 13 - time * speed * 0.7 + offset * 9) *
									height *
									0.04 *
									amplitude;
							if (x === 0) {
								ctx.moveTo(x, y);
							} else {
								ctx.lineTo(x, y);
							}
						}
						ctx.stroke();
					}
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- flickering grid ----------------------------------------------------------

export function FlickeringGrid({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#050505");
				const color = str(params, "color", "#6b7280");
				const cell = num(params, "squareSize", 4);
				const gap = num(params, "gap", 6);
				const maxOpacity = num(params, "maxOpacity", 0.3);
				const chance = num(params, "flicker", 0.3);
				const random = mulberry32(13);
				let cols = 0;
				let rows = 0;
				let alphas = new Float32Array(0);
				return ({ ctx, dt, height, width }) => {
					const pitch = cell + gap;
					const nextCols = Math.ceil(width / pitch);
					const nextRows = Math.ceil(height / pitch);
					if (nextCols !== cols || nextRows !== rows) {
						cols = nextCols;
						rows = nextRows;
						alphas = Float32Array.from(
							{ length: cols * rows },
							() => random() * maxOpacity
						);
					}
					for (let index = 0; index < alphas.length; index += 1) {
						if (random() < chance * dt) {
							alphas[index] = random() * maxOpacity;
						}
					}
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					ctx.fillStyle = color;
					for (let row = 0; row < rows; row += 1) {
						for (let col = 0; col < cols; col += 1) {
							ctx.globalAlpha = alphas[row * cols + col] ?? 0;
							ctx.fillRect(col * pitch, row * pitch, cell, cell);
						}
					}
					ctx.globalAlpha = 1;
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}

// ---- meteors ----------------------------------------------------------------

export function Meteors({ animate, className, params }: BackdropRendererProps) {
	return (
		<CanvasBackdrop
			animate={animate}
			className={className}
			createPainter={() => {
				const background = str(params, "background", "#09090b");
				const color = str(params, "color", "#e4e4e7");
				const count = Math.round(num(params, "count", 20));
				const speed = num(params, "speed", 1);
				const angle = (num(params, "angle", 215) * Math.PI) / 180;
				const random = mulberry32(17);
				const meteors = Array.from({ length: count }, () => ({
					delay: random() * 6,
					length: 60 + random() * 90,
					life: random() * 6,
					x: random() * 1.4 - 0.2,
				}));
				return ({ ctx, dt, height, width }) => {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
					const dx = Math.cos(angle);
					const dy = -Math.sin(angle);
					for (const meteor of meteors) {
						meteor.life += dt * speed;
						const travel = (meteor.life - meteor.delay) * 260;
						if (travel > Math.hypot(width, height) + meteor.length) {
							meteor.life = 0;
							meteor.delay = random() * 4;
							meteor.x = random() * 1.4 - 0.2;
							continue;
						}
						if (travel < 0) {
							continue;
						}
						const headX = meteor.x * width + dx * travel;
						const headY = dy * travel;
						const tailX = headX - dx * meteor.length;
						const tailY = headY - dy * meteor.length;
						const gradient = ctx.createLinearGradient(
							headX,
							headY,
							tailX,
							tailY
						);
						gradient.addColorStop(0, color);
						gradient.addColorStop(1, "transparent");
						ctx.strokeStyle = gradient;
						ctx.lineWidth = 1;
						ctx.beginPath();
						ctx.moveTo(headX, headY);
						ctx.lineTo(tailX, tailY);
						ctx.stroke();
						ctx.fillStyle = color;
						ctx.beginPath();
						ctx.arc(headX, headY, 1.2, 0, Math.PI * 2);
						ctx.fill();
					}
				};
			}}
			paramsKey={paramsKeyOf(params)}
		/>
	);
}
