"use client";

import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { z } from "zod";
import { cn } from "../lib/utils.ts";
import styles from "./announcement-visual.module.css";
import { ditherAvatarHue } from "./dither-kit/avatar.tsx";
import { Icon } from "./icon.tsx";
import { ShaderBackground } from "./motion/shader-background.tsx";
import {
	hueHex,
	useIsDarkFace,
	WARP_BASE_DARK,
	WARP_BASE_LIGHT,
	WARP_DISTORTION,
	WARP_HUE_SPREAD,
	WARP_SCALE,
	WARP_SOFTNESS,
	WARP_SPEED,
	WARP_SWIRL,
} from "./pass-card-shell.tsx";

/**
 * Example scene code shown in the admin editor. It is deliberately a small
 * data format rather than executable JSX: the desktop can render admin-owned
 * artwork as React without evaluating a code string in every user's app.
 */
export const DEFAULT_ANNOUNCEMENT_VISUAL_CODE = `{
  "version": 1,
  "layers": [
    { "type": "rings", "size": 190, "count": 3, "color": "#7dd3fc", "duration": 9 },
    { "type": "orbit", "radius": 74, "count": 4, "color": "#c4b5fd", "duration": 12, "dotSize": 7 },
    { "type": "particles", "color": "#ffffff", "duration": 4 }
  ]
}`;

const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const MAX_LAYERS = 24;
const MAX_PARTICLES = 32;

const optionalSceneNumber = z.number().optional().catch(undefined);
const optionalSceneString = z.string().optional().catch(undefined);
const rawPointSchema = z
	.object({
		color: optionalSceneString,
		delay: optionalSceneNumber,
		size: optionalSceneNumber,
		x: optionalSceneNumber,
		y: optionalSceneNumber,
	})
	.nullable()
	.catch(null);
const rawLayerSchema = z
	.object({
		angle: optionalSceneNumber,
		color: optionalSceneString,
		count: optionalSceneNumber,
		direction: optionalSceneString,
		dotSize: optionalSceneNumber,
		duration: optionalSceneNumber,
		opacity: optionalSceneNumber,
		points: z
			.array(z.unknown())
			.transform((entries) => entries.slice(0, MAX_PARTICLES))
			.pipe(z.array(rawPointSchema))
			.optional()
			.catch(undefined),
		radius: optionalSceneNumber,
		size: optionalSceneNumber,
		type: z
			.enum(["rings", "orbit", "bars", "particles", "beam"])
			.optional()
			.catch(undefined),
	})
	.nullable()
	.catch(null);
const authoredSceneSchema = z
	.object({
		layers: z
			.array(z.unknown())
			.transform((entries) => entries.slice(0, MAX_LAYERS))
			.pipe(z.array(rawLayerSchema)),
		version: z.literal(1),
	})
	.nullable()
	.catch(null);
type RawVisualPoint = z.infer<typeof rawPointSchema>;
type RawVisualLayer = z.infer<typeof rawLayerSchema>;
interface AnnouncementAccentStyle extends CSSProperties {
	"--announcement-accent": string;
}

interface SceneGeometryStyle extends CSSProperties {
	"--scene-color"?: string;
	"--scene-height"?: string;
	"--scene-left"?: string;
	"--scene-margin"?: string;
	"--scene-size"?: string;
	"--scene-top"?: string;
}

interface VisualPoint {
	color: string;
	delay: number;
	size: number;
	x: number;
	y: number;
}

interface RingsLayer {
	color: string;
	count: number;
	duration: number;
	opacity: number;
	size: number;
	type: "rings";
}

interface OrbitLayer {
	color: string;
	count: number;
	direction: "normal" | "reverse";
	dotSize: number;
	duration: number;
	radius: number;
	type: "orbit";
}

interface BarsLayer {
	color: string;
	count: number;
	duration: number;
	type: "bars";
}

interface ParticlesLayer {
	color: string;
	duration: number;
	points: VisualPoint[];
	type: "particles";
}

interface BeamLayer {
	angle: number;
	color: string;
	duration: number;
	type: "beam";
}

type VisualLayer =
	| BarsLayer
	| BeamLayer
	| OrbitLayer
	| ParticlesLayer
	| RingsLayer;

export interface AnnouncementVisualScene {
	layers: VisualLayer[];
	version: 1;
}

export interface AnnouncementVisualProps {
	/** Optional admin accent used when the scene does not specify a layer color. */
	accent?: string | null;
	appearance?: "default" | "marketplace-guide";
	/** Admin-authored hex color stops for the shared waitlist warp background. */
	backgroundColors?: readonly string[];
	className?: string;
	/** Optional canonical app/plugin icon tile to place at the visual center. */
	iconContent?: ReactNode;
	/** Universal icon-library id, such as `lucide:sparkles` or `rocket-01`. */
	iconId?: string | null;
	/** Optional uploaded/custom icon URL layered over the banner. */
	iconImageUrl?: string | null;
	/** Optional admin-authored image URL. It is only rendered inside the detail. */
	imageUrl?: string | null;
	/** Seed used to derive the same kind of hue variation as the waitlist pass. */
	seed?: string;
	/** JSON scene code authored per announcement in the admin dashboard. */
	visualCode?: string | null;
}

function numberInRange(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
}

function stringValue(value: string | undefined, fallback: string): string {
	return value !== undefined && value.trim().length > 0
		? value.trim()
		: fallback;
}

function hexColor(value: string | undefined, fallback: string): string {
	const candidate = stringValue(value, fallback);
	return HEX_COLOR.test(candidate) ? candidate : fallback;
}

function normalizePoints(
	value: readonly RawVisualPoint[] | undefined,
	fallbackColor: string
): VisualPoint[] {
	if (value === undefined) {
		return defaultParticles(fallbackColor);
	}

	const points: VisualPoint[] = [];
	for (const entry of value.slice(0, MAX_PARTICLES)) {
		if (entry === null) {
			continue;
		}
		points.push({
			color: hexColor(entry.color, fallbackColor),
			delay: numberInRange(entry.delay, points.length * 0.12, 0, 8),
			size: numberInRange(entry.size, 4, 2, 14),
			x: numberInRange(entry.x, 50, 4, 96),
			y: numberInRange(entry.y, 50, 8, 92),
		});
	}
	return points.length > 0 ? points : defaultParticles(fallbackColor);
}

function defaultParticles(color: string): VisualPoint[] {
	return [
		{ color, delay: 0, size: 4, x: 17, y: 29 },
		{ color, delay: 0.45, size: 6, x: 78, y: 23 },
		{ color, delay: 0.9, size: 3, x: 66, y: 76 },
		{ color, delay: 1.35, size: 5, x: 28, y: 78 },
		{ color, delay: 1.8, size: 3, x: 48, y: 16 },
	];
}

function normalizeLayer(
	value: RawVisualLayer,
	fallbackColor: string
): VisualLayer | null {
	if (value === null) {
		return null;
	}

	switch (value.type) {
		case "rings":
			return {
				color: hexColor(value.color, fallbackColor),
				count: Math.round(numberInRange(value.count, 3, 1, 6)),
				duration: numberInRange(value.duration, 9, 3, 30),
				opacity: numberInRange(value.opacity, 0.55, 0.1, 1),
				size: numberInRange(value.size, 190, 90, 360),
				type: "rings",
			};
		case "orbit":
			return {
				color: hexColor(value.color, fallbackColor),
				count: Math.round(numberInRange(value.count, 4, 1, 8)),
				direction: value.direction === "reverse" ? "reverse" : "normal",
				dotSize: numberInRange(value.dotSize, 7, 3, 16),
				duration: numberInRange(value.duration, 12, 4, 36),
				radius: numberInRange(value.radius, 74, 28, 150),
				type: "orbit",
			};
		case "bars":
			return {
				color: hexColor(value.color, fallbackColor),
				count: Math.round(numberInRange(value.count, 9, 3, 18)),
				duration: numberInRange(value.duration, 2.8, 1, 8),
				type: "bars",
			};
		case "particles":
			return {
				color: hexColor(value.color, fallbackColor),
				duration: numberInRange(value.duration, 4, 1.5, 12),
				points: normalizePoints(value.points, fallbackColor),
				type: "particles",
			};
		case "beam":
			return {
				angle: numberInRange(value.angle, -18, -180, 180),
				color: hexColor(value.color, fallbackColor),
				duration: numberInRange(value.duration, 7, 3, 20),
				type: "beam",
			};
		default:
			return null;
	}
}

/** Parse and bound an admin-authored scene. Invalid or unknown layers are ignored. */
export function parseAnnouncementVisualCode(
	value: string | null | undefined,
	fallbackColor = "#ffffff"
): AnnouncementVisualScene | null {
	if (!value?.trim()) {
		return null;
	}
	try {
		const parsed = authoredSceneSchema.parse(JSON.parse(value));
		if (parsed === null) {
			return null;
		}
		const layers = parsed.layers
			.slice(0, MAX_LAYERS)
			.map((layer) => normalizeLayer(layer, fallbackColor))
			.filter((layer): layer is VisualLayer => layer !== null);
		return { layers, version: 1 };
	} catch {
		return null;
	}
}

function safeImageUrl(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		const url = new URL(value);
		return ["https:", "http:", "blob:"].includes(url.protocol) ? value : null;
	} catch {
		return null;
	}
}

function safeIconId(value: string | null | undefined): string | null {
	const candidate = value?.trim();
	if (!candidate || candidate.length > 200 || /\s/.test(candidate)) {
		return null;
	}
	return /^[\w.-]+(?::[\w./@-]+)?$/.test(candidate) ? candidate : null;
}

function OrbitLayer({
	layer,
	reducedMotion,
}: {
	layer: OrbitLayer;
	reducedMotion: boolean;
}) {
	const diameter = layer.radius * 2;
	const orbitStyle: SceneGeometryStyle = {
		"--scene-size": `${diameter}px`,
		"--scene-margin": `${-layer.radius}px`,
	};
	return (
		<motion.div
			animate={
				reducedMotion
					? undefined
					: { rotate: layer.direction === "reverse" ? -360 : 360 }
			}
			className={cn("absolute top-1/2 left-1/2", styles.orbit)}
			initial={false}
			style={orbitStyle}
			transition={{
				duration: layer.duration,
				ease: "linear",
				repeat: Number.POSITIVE_INFINITY,
			}}
		>
			{Array.from({ length: layer.count }, (_, index) => {
				const angle = (index / layer.count) * Math.PI * 2;
				const x = Math.cos(angle) * layer.radius;
				const y = Math.sin(angle) * layer.radius;
				const dotStyle: SceneGeometryStyle = {
					"--scene-color": layer.color,
					"--scene-size": `${layer.dotSize}px`,
					"--scene-left": `calc(50% + ${x}px - ${layer.dotSize / 2}px)`,
					"--scene-top": `calc(50% + ${y}px - ${layer.dotSize / 2}px)`,
				};
				return (
					<span
						aria-hidden="true"
						className={cn("absolute rounded-full", styles.orbitDot)}
						key={`${x}-${y}`}
						style={dotStyle}
					/>
				);
			})}
		</motion.div>
	);
}

function RingsLayer({
	layer,
	reducedMotion,
}: {
	layer: RingsLayer;
	reducedMotion: boolean;
}) {
	return (
		<div className="absolute inset-0 grid place-items-center">
			{Array.from({ length: layer.count }, (_, index) => {
				const size = layer.size - index * (layer.size / (layer.count + 1));
				const ringStyle: SceneGeometryStyle = {
					"--scene-color": layer.color,
					"--scene-size": `${size}px`,
				};
				return (
					<motion.span
						animate={
							reducedMotion
								? undefined
								: {
										opacity: [
											layer.opacity * 0.35,
											layer.opacity,
											layer.opacity * 0.35,
										],
										scale: [0.92, 1, 0.92],
									}
						}
						aria-hidden="true"
						className={cn("absolute rounded-full border", styles.ring)}
						initial={false}
						key={size}
						style={ringStyle}
						transition={{
							delay: index * 0.28,
							duration: layer.duration,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
				);
			})}
		</div>
	);
}

function BarsLayer({
	layer,
	reducedMotion,
}: {
	layer: BarsLayer;
	reducedMotion: boolean;
}) {
	return (
		<div className="absolute inset-x-[18%] bottom-[22%] flex h-24 items-end justify-center gap-1.5 opacity-75">
			{Array.from({ length: layer.count }, (_, index) => {
				const barStyle: SceneGeometryStyle = {
					"--scene-color": layer.color,
					"--scene-height": `${35 + (index % 5) * 12}%`,
				};
				return (
					<motion.span
						animate={
							reducedMotion ? undefined : { scaleY: [0.35, 1, 0.55, 0.8, 0.35] }
						}
						aria-hidden="true"
						className={cn("w-1.5 origin-bottom rounded-full", styles.bar)}
						initial={false}
						key={index}
						style={barStyle}
						transition={{
							delay: index * 0.08,
							duration: layer.duration,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
				);
			})}
		</div>
	);
}

function ParticlesLayer({
	layer,
	reducedMotion,
}: {
	layer: ParticlesLayer;
	reducedMotion: boolean;
}) {
	return (
		<div className="absolute inset-0">
			{layer.points.map((point, index) => {
				const pointStyle: SceneGeometryStyle = {
					"--scene-color": point.color,
					"--scene-size": `${point.size}px`,
					"--scene-left": `${point.x}%`,
					"--scene-top": `${point.y}%`,
				};
				return (
					<motion.span
						animate={
							reducedMotion
								? undefined
								: { opacity: [0.35, 1, 0.35], y: [0, -7, 0] }
						}
						aria-hidden="true"
						className={cn("absolute rounded-full", styles.particle)}
						initial={false}
						key={`${point.x}-${point.y}-${index}`}
						style={pointStyle}
						transition={{
							delay: point.delay,
							duration: layer.duration,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
				);
			})}
		</div>
	);
}

function BeamLayer({
	layer,
	reducedMotion,
}: {
	layer: BeamLayer;
	reducedMotion: boolean;
}) {
	const beamStyle: SceneGeometryStyle = { "--scene-color": layer.color };
	return (
		<motion.div
			animate={
				reducedMotion
					? undefined
					: { opacity: [0.2, 0.85, 0.2], x: ["-35%", "35%", "-35%"] }
			}
			aria-hidden="true"
			className={cn(
				"absolute top-1/2 left-1/2 h-px w-[75%] -translate-x-1/2 bg-linear-to-r from-transparent via-current to-transparent",
				styles.beam
			)}
			initial={false}
			style={beamStyle}
			transformTemplate={(_transform, generated) =>
				`${generated === "none" ? "" : generated} rotate(${layer.angle}deg)`
			}
			transition={{
				duration: layer.duration,
				ease: "easeInOut",
				repeat: Number.POSITIVE_INFINITY,
			}}
		/>
	);
}

function VisualLayers({
	layers,
	reducedMotion,
}: {
	layers: VisualLayer[];
	reducedMotion: boolean;
}) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden"
		>
			{layers.map((layer, index) => {
				switch (layer.type) {
					case "rings":
						return (
							<RingsLayer
								key={`${layer.type}-${index}`}
								layer={layer}
								reducedMotion={reducedMotion}
							/>
						);
					case "orbit":
						return (
							<OrbitLayer
								key={`${layer.type}-${index}`}
								layer={layer}
								reducedMotion={reducedMotion}
							/>
						);
					case "bars":
						return (
							<BarsLayer
								key={`${layer.type}-${index}`}
								layer={layer}
								reducedMotion={reducedMotion}
							/>
						);
					case "particles":
						return (
							<ParticlesLayer
								key={`${layer.type}-${index}`}
								layer={layer}
								reducedMotion={reducedMotion}
							/>
						);
					case "beam":
						return (
							<BeamLayer
								key={`${layer.type}-${index}`}
								layer={layer}
								reducedMotion={reducedMotion}
							/>
						);
				}
			})}
		</div>
	);
}

function validBackgroundColors(
	colors: readonly string[] | undefined
): string[] {
	return (colors ?? []).filter((color) => HEX_COLOR.test(color)).slice(0, 8);
}

export function AnnouncementVisual({
	accent,
	appearance = "default",
	backgroundColors,
	className,
	iconContent,
	iconId,
	iconImageUrl,
	imageUrl,
	seed = "announcement",
	visualCode,
}: AnnouncementVisualProps) {
	const reducedMotion = Boolean(useReducedMotion());
	const isDark = useIsDarkFace("auto");
	const hue = ditherAvatarHue(seed);
	const candidateAccent = accent ?? "";
	const defaultColor = HEX_COLOR.test(candidateAccent)
		? candidateAccent
		: hueHex(hue);
	const colors = validBackgroundColors(backgroundColors);
	const warpColors =
		colors.length >= 2
			? colors
			: [
					isDark ? WARP_BASE_DARK : WARP_BASE_LIGHT,
					defaultColor,
					isDark ? WARP_BASE_DARK : WARP_BASE_LIGHT,
					hueHex(hue + WARP_HUE_SPREAD),
				];
	const scene = parseAnnouncementVisualCode(visualCode, defaultColor);
	const image = safeImageUrl(imageUrl);
	const customIcon = safeImageUrl(iconImageUrl);
	const universalIcon = safeIconId(iconId);
	const hasIcon = Boolean(iconContent || customIcon || universalIcon);
	const style: AnnouncementAccentStyle = {
		"--announcement-accent": defaultColor,
	};

	return (
		<div
			className={cn(
				"relative isolate min-h-60 overflow-hidden rounded-3xl bg-card",
				appearance === "marketplace-guide" &&
					"min-h-[13rem] rounded-none sm:min-h-[16rem] sm:rounded-t-4xl",
				className
			)}
			data-slot="announcement-visual"
			style={style}
		>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 opacity-90"
			>
				<ShaderBackground
					className="h-full w-full"
					colors={warpColors}
					distortion={WARP_DISTORTION}
					scale={WARP_SCALE}
					softness={WARP_SOFTNESS}
					speed={reducedMotion ? 0 : WARP_SPEED}
					swirl={WARP_SWIRL}
					variant="warp"
				/>
			</div>
			<div
				aria-hidden="true"
				className="scrim-t pointer-events-none absolute inset-0 [--scrim-alpha:0.45]"
			/>
			{scene ? (
				<VisualLayers layers={scene.layers} reducedMotion={reducedMotion} />
			) : null}
			{hasIcon ? (
				<div
					className="absolute inset-0 z-20 grid place-items-center p-8"
					data-slot="announcement-visual-icon"
				>
					{iconContent ?? (
						<div className="grid size-32 place-items-center rounded-[2rem] border border-white/35 bg-black/15 p-5 shadow-2xl ring-1 ring-black/15 backdrop-blur-sm">
							{customIcon ? (
								<img
									alt="Announcement icon"
									className="size-full rounded-2xl object-contain"
									data-slot="announcement-visual-icon-image"
									decoding="async"
									referrerPolicy="no-referrer"
									src={customIcon}
								/>
							) : (
								<Icon
									className="text-white drop-shadow-[0_4px_18px_rgb(0_0_0/0.45)]"
									icon={universalIcon}
									label="Announcement icon"
									size={104}
								/>
							)}
						</div>
					)}
				</div>
			) : null}
			{image ? (
				<div className="absolute inset-0 grid place-items-center p-8">
					<img
						alt="Announcement artwork"
						className="relative z-10 max-h-52 max-w-[78%] rounded-2xl object-contain shadow-2xl ring-1 ring-white/25"
						data-slot="announcement-visual-image"
						decoding="async"
						referrerPolicy="no-referrer"
						src={image}
					/>
				</div>
			) : null}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-8 bottom-5 h-px bg-linear-to-r from-transparent via-white/35 to-transparent"
			/>
		</div>
	);
}
