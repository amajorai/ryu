// packages/ui/src/components/backdrop/css-backdrops.tsx
//
// Backdrops painted with plain CSS: fixed patterns (grid, dots, glow) and two
// light animations (drifting colour blobs, floating geometric pills) that run
// on the compositor via CSS keyframes and pause with `animation-play-state`.

import type { CSSProperties } from "react";
import { z } from "zod";
import { cn } from "../../lib/utils.ts";

type BackdropStyleInputs = CSSProperties &
	Partial<
		Record<
			| "--ryu-backdrop-grid-root-background"
			| "--ryu-backdrop-grid-background-image"
			| "--ryu-backdrop-grid-background-size"
			| "--ryu-backdrop-dots-root-background"
			| "--ryu-backdrop-dots-background-image"
			| "--ryu-backdrop-dots-background-size"
			| "--ryu-backdrop-radial-background"
			| "--ryu-backdrop-blobs-root-background"
			| "--ryu-backdrop-blob-animation"
			| "--ryu-backdrop-blob-animation-play-state"
			| "--ryu-backdrop-blob-background"
			| "--ryu-backdrop-blob-filter"
			| "--ryu-backdrop-blob-left"
			| "--ryu-backdrop-blob-top"
			| "--ryu-backdrop-pills-root-background"
			| "--ryu-backdrop-pill-animation"
			| "--ryu-backdrop-pill-animation-play-state"
			| "--ryu-backdrop-pill-background"
			| "--ryu-backdrop-pill-box-shadow"
			| "--ryu-backdrop-pill-height"
			| "--ryu-backdrop-pill-left"
			| "--ryu-backdrop-pill-top"
			| "--ryu-backdrop-pill-transform"
			| "--ryu-backdrop-pill-width"
			| "--ryu-backdrop-pill-glow-background"
			| "--ryu-backdrop-retro-root-background"
			| "--ryu-backdrop-retro-plane-transform"
			| "--ryu-backdrop-retro-grid-animation"
			| "--ryu-backdrop-retro-grid-animation-play-state"
			| "--ryu-backdrop-retro-grid-background-image"
			| "--ryu-backdrop-retro-grid-background-size"
			| "--ryu-backdrop-retro-fade-background"
			| "--ryu-backdrop-ripple-root-background"
			| "--ryu-backdrop-ring-animation"
			| "--ryu-backdrop-ring-animation-play-state"
			| "--ryu-backdrop-ring-background"
			| "--ryu-backdrop-ring-border-color"
			| "--ryu-backdrop-ring-height"
			| "--ryu-backdrop-ring-width"
			| "--ryu-backdrop-stripes-background"
			| "--ryu-rot",
			string | number
		>
	>;

import type { BackdropRendererProps } from "./canvas-backdrops.tsx";
import type { BackdropParams } from "./params.ts";

function num(params: BackdropParams, key: string, fallback: number): number {
	const value = params[key];
	const parsed = z
		.union([
			z.number(),
			z.nan(),
			z.literal(Number.POSITIVE_INFINITY),
			z.literal(Number.NEGATIVE_INFINITY),
		])
		.safeParse(value);
	return parsed.success ? parsed.data : fallback;
}

function str(params: BackdropParams, key: string, fallback: string): string {
	const value = params[key];
	const parsed = z.string().safeParse(value);
	return parsed.success ? parsed.data : fallback;
}

function colors(
	params: BackdropParams,
	key: string,
	fallback: string[]
): string[] {
	const value = params[key];
	const parsed = z.array(z.unknown()).min(1).safeParse(value);
	if (!parsed.success) {
		return fallback;
	}
	return parsed.data.flatMap((item) => {
		const color = z.string().safeParse(item);
		return color.success ? [color.data] : [];
	});
}

export function GridPattern({ className, params }: BackdropRendererProps) {
	const size = num(params, "cellSize", 32);
	const line = str(params, "lineColor", "#ffffff1a");
	const fade = params.fade !== false;

	const gridBackgroundImageInputs: BackdropStyleInputs = {
		"--ryu-backdrop-grid-background-image": `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
		"--ryu-backdrop-grid-background-size": `${size}px ${size}px`,
	};
	const gridRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-grid-root-background": str(params, "background", "#0a0a0a"),
	};
	return (
		<div
			aria-hidden="true"
			className={cn("ryu-backdrop-grid-root", className ?? "absolute inset-0")}
			style={gridRootBackgroundInputs}
		>
			<div
				className={cn(
					"ryu-backdrop-grid absolute inset-0",
					fade && "ryu-backdrop-grid-faded"
				)}
				style={gridBackgroundImageInputs}
			/>
		</div>
	);
}

export function DotPattern({ className, params }: BackdropRendererProps) {
	const spacing = num(params, "spacing", 20);
	const dot = str(params, "dotColor", "#ffffff33");
	const radius = num(params, "dotSize", 1);
	const fade = params.fade !== false;
	const dotsBackgroundImageInputs: BackdropStyleInputs = {
		"--ryu-backdrop-dots-background-image": `radial-gradient(${dot} ${radius}px, transparent ${radius}px)`,
		"--ryu-backdrop-dots-background-size": `${spacing}px ${spacing}px`,
	};
	const dotsRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-dots-root-background": str(params, "background", "#0a0a0a"),
	};
	return (
		<div
			aria-hidden="true"
			className={cn("ryu-backdrop-dots-root", className ?? "absolute inset-0")}
			style={dotsRootBackgroundInputs}
		>
			<div
				className={cn(
					"ryu-backdrop-dots absolute inset-0",
					fade && "ryu-backdrop-dots-faded"
				)}
				style={dotsBackgroundImageInputs}
			/>
		</div>
	);
}

const GLOW_POSITIONS = new Map(
	Object.entries({
		bottom: "50% 110%",
		center: "50% 50%",
		top: "50% -10%",
	})
);

export function RadialGlow({ className, params }: BackdropRendererProps) {
	const position =
		GLOW_POSITIONS.get(str(params, "position", "top")) ?? "50% -10%";
	const glow = str(params, "glowColor", "#7c3aed");
	const spread = num(params, "spread", 60);
	const radialBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-radial-background": `radial-gradient(ellipse ${spread + 20}% ${spread}% at ${position}, ${glow}, transparent 70%), ${str(params, "background", "#050505")}`,
	};
	return (
		<div
			aria-hidden="true"
			className={cn("ryu-backdrop-radial", className ?? "absolute inset-0")}
			style={radialBackgroundInputs}
		/>
	);
}

const BLOB_SPOTS = [
	["-10%", "-10%"],
	["55%", "-5%"],
	["-5%", "50%"],
	["50%", "45%"],
	["25%", "20%"],
] as const;

export function DriftingBlobs({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	const palette = colors(params, "colors", [
		"#6366f1",
		"#ec4899",
		"#22d3ee",
		"#f59e0b",
	]);
	const speed = Math.max(0.05, num(params, "speed", 1));
	const blur = num(params, "blur", 80);
	const blobsRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-blobs-root-background": str(
			params,
			"background",
			"#0b0b14"
		),
	};
	return (
		<div
			aria-hidden="true"
			className={cn(
				"ryu-backdrop-blobs-root",
				className ?? "absolute inset-0 overflow-hidden"
			)}
			style={blobsRootBackgroundInputs}
		>
			{palette.map((color, index) => {
				const spot = BLOB_SPOTS[index % BLOB_SPOTS.length] ?? BLOB_SPOTS[0];
				const blobAnimationInputs: BackdropStyleInputs = {
					"--ryu-backdrop-blob-animation": `ryu-backdrop-drift ${(18 + index * 5) / speed}s ease-in-out ${-index * 3}s infinite`,
					"--ryu-backdrop-blob-animation-play-state": animate
						? "running"
						: "paused",
					"--ryu-backdrop-blob-background": color,
					"--ryu-backdrop-blob-filter": `blur(${blur}px)`,
					"--ryu-backdrop-blob-left": spot[0],
					"--ryu-backdrop-blob-top": spot[1],
				};
				return (
					<div
						className="ryu-backdrop-blob absolute rounded-full"
						key={`${color}-${index.toString()}`}
						style={blobAnimationInputs}
					/>
				);
			})}
		</div>
	);
}

const PILLS = [
	{ height: 120, left: "-6%", rotate: 12, top: "18%", width: 560 },
	{ height: 110, left: "70%", rotate: -15, top: "72%", width: 480 },
	{ height: 70, left: "8%", rotate: -8, top: "76%", width: 300 },
	{ height: 60, left: "72%", rotate: 20, top: "12%", width: 200 },
	{ height: 36, left: "24%", rotate: -25, top: "8%", width: 150 },
] as const;

export function FloatingPills({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	const palette = colors(params, "colors", [
		"#6366f1",
		"#f43f5e",
		"#8b5cf6",
		"#f59e0b",
		"#06b6d4",
	]);
	const speed = Math.max(0.05, num(params, "speed", 1));
	const pillGlowBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-pill-glow-background": `radial-gradient(ellipse at 30% 20%, ${palette[0] ?? "#6366f1"}14, transparent 60%), radial-gradient(ellipse at 70% 80%, ${palette[1] ?? "#f43f5e"}14, transparent 60%)`,
	};
	const pillsRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-pills-root-background": str(
			params,
			"background",
			"#030303"
		),
	};
	return (
		<div
			aria-hidden="true"
			className={cn(
				"ryu-backdrop-pills-root",
				className ?? "absolute inset-0 overflow-hidden"
			)}
			style={pillsRootBackgroundInputs}
		>
			{PILLS.map((pill, index) => {
				const color = palette[index % palette.length] ?? "#6366f1";
				const pillAnimationInputs: BackdropStyleInputs = {
					"--ryu-rot": `${pill.rotate}deg`,
					"--ryu-backdrop-pill-animation": `ryu-backdrop-float ${(10 + index * 2) / speed}s ease-in-out ${-index}s infinite`,
					"--ryu-backdrop-pill-animation-play-state": animate
						? "running"
						: "paused",
					"--ryu-backdrop-pill-background": `linear-gradient(to right, ${color}33, transparent)`,
					"--ryu-backdrop-pill-box-shadow": `0 8px 32px 0 ${color}1a`,
					"--ryu-backdrop-pill-height": `${pill.height}px`,
					"--ryu-backdrop-pill-left": pill.left,
					"--ryu-backdrop-pill-top": pill.top,
					"--ryu-backdrop-pill-transform": `rotate(${pill.rotate}deg)`,
					"--ryu-backdrop-pill-width": `${pill.width}px`,
				};
				return (
					<div
						className="ryu-backdrop-pill absolute rounded-full border border-white/15 backdrop-blur-[2px]"
						key={`${pill.left}-${pill.top}`}
						style={pillAnimationInputs}
					/>
				);
			})}
			<div
				className="ryu-backdrop-pill-glow absolute inset-0"
				style={pillGlowBackgroundInputs}
			/>
		</div>
	);
}

export function RetroGrid({
	animate,
	className,
	params,
}: BackdropRendererProps) {
	const line = str(params, "lineColor", "#a855f7");
	const size = num(params, "cellSize", 60);
	const angle = num(params, "angle", 65);
	const speed = Math.max(0.05, num(params, "speed", 1));
	const retroFadeBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-retro-fade-background": `linear-gradient(to top, ${str(params, "background", "#07030f")} 0%, transparent 90%)`,
	};
	const retroGridAnimationInputs: BackdropStyleInputs = {
		"--ryu-backdrop-retro-grid-animation": `ryu-backdrop-retro ${15 / speed}s linear infinite`,
		"--ryu-backdrop-retro-grid-animation-play-state": animate
			? "running"
			: "paused",
		"--ryu-backdrop-retro-grid-background-image": `linear-gradient(to right, ${line} 1px, transparent 0), linear-gradient(to bottom, ${line} 1px, transparent 0)`,
		"--ryu-backdrop-retro-grid-background-size": `${size}px ${size}px`,
	};
	const retroPlaneTransformInputs: BackdropStyleInputs = {
		"--ryu-backdrop-retro-plane-transform": `rotateX(${angle}deg)`,
	};
	const retroRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-retro-root-background": str(
			params,
			"background",
			"#07030f"
		),
	};
	return (
		<div
			aria-hidden="true"
			className={cn("ryu-backdrop-retro-root", className ?? "absolute inset-0")}
			style={retroRootBackgroundInputs}
		>
			<div
				className="ryu-backdrop-retro-plane absolute inset-0"
				style={retroPlaneTransformInputs}
			>
				<div
					className="ryu-backdrop-retro-grid"
					style={retroGridAnimationInputs}
				/>
			</div>
			<div
				className="ryu-backdrop-retro-fade absolute inset-0"
				style={retroFadeBackgroundInputs}
			/>
		</div>
	);
}

export function Ripple({ animate, className, params }: BackdropRendererProps) {
	const color = str(params, "color", "#94a3b8");
	const rings = Math.round(num(params, "rings", 8));
	const base = num(params, "size", 210);
	const speed = Math.max(0.05, num(params, "speed", 1));
	const rippleRootBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-ripple-root-background": str(
			params,
			"background",
			"#020617"
		),
	};
	return (
		<div
			aria-hidden="true"
			className={cn(
				"ryu-backdrop-ripple-root",
				className ?? "absolute inset-0"
			)}
			style={rippleRootBackgroundInputs}
		>
			{Array.from({ length: rings }, (_, index) => {
				const size = base + index * 70;
				const ringAnimationInputs: BackdropStyleInputs = {
					"--ryu-backdrop-ring-animation": `ryu-backdrop-ripple ${2 / speed}s ease ${index * 0.06}s infinite`,
					"--ryu-backdrop-ring-animation-play-state": animate
						? "running"
						: "paused",
					"--ryu-backdrop-ring-background": `${color}${Math.max(
						2,
						24 - index * 3
					)
						.toString(16)
						.padStart(2, "0")}`,
					"--ryu-backdrop-ring-border-color": `${color}${Math.max(
						8,
						40 - index * 4
					)
						.toString(16)
						.padStart(2, "0")}`,
					"--ryu-backdrop-ring-height": `${size}px`,
					"--ryu-backdrop-ring-width": `${size}px`,
				};
				return (
					<div
						className="ryu-backdrop-ring absolute rounded-full border"
						key={size}
						style={ringAnimationInputs}
					/>
				);
			})}
		</div>
	);
}

export function Stripes({ className, params }: BackdropRendererProps) {
	const color = str(params, "color", "#ffffff14");
	const width = num(params, "width", 10);
	const angle = num(params, "angle", 45);
	const stripesBackgroundInputs: BackdropStyleInputs = {
		"--ryu-backdrop-stripes-background": `repeating-linear-gradient(${angle}deg, ${color} 0 ${width / 2}px, transparent ${width / 2}px ${width}px), ${str(params, "background", "#0a0a0a")}`,
	};
	return (
		<div
			aria-hidden="true"
			className={cn("ryu-backdrop-stripes", className ?? "absolute inset-0")}
			style={stripesBackgroundInputs}
		/>
	);
}

// Retain the published renderer name while the implementation names its visual role.
export { FloatingPills as FloatingShapes };
