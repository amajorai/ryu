"use client";

import { cn } from "@ryu/ui/lib/utils";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type SkyShader, startSkyShader } from "./backgrounds/sky-shader.ts";
import { useBackdropGate } from "./backgrounds/use-backdrop-gate.ts";
import type { SkyPalette } from "./seasonal-sky.ts";

// Opaque at the top, 20% two thirds of the way down, then nothing, so the sky
// melts into the page instead of ending on a line.
const FADE =
	"linear-gradient(to bottom, #000, rgb(0 0 0 / 0.2) 66%, transparent)";

/** The static sky: the shader's gradient with a few soft cloud puffs. */
function staticSky([zenith, horizon, cloud, shade]: SkyPalette): CSSProperties {
	return {
		backgroundColor: horizon,
		backgroundImage: [
			`radial-gradient(28% 18% at 22% 32%, ${cloud} 0%, transparent 70%)`,
			`radial-gradient(24% 16% at 74% 58%, ${cloud} 0%, transparent 68%)`,
			`radial-gradient(20% 14% at 88% 24%, ${shade} 0%, transparent 70%)`,
			`linear-gradient(180deg, ${zenith} 0%, ${horizon} 100%)`,
		].join(", "),
	};
}

/**
 * The homepage hero sky: drifting clouds (`./backgrounds/sky-shader.ts`) given
 * a soft-focus finish. The sky layer overhangs the box by 5% on every side and
 * is blurred 12.5px, so the blur never pulls a transparent edge in. It fades out
 * toward the bottom over the page background, and the edges get a soft inner
 * glow. Until the browser is idle, and without a hardware GPU, the static
 * gradient stays.
 */
export function HeroSky({
	className,
	colors,
	night,
}: {
	className?: string;
	colors: SkyPalette;
	night: boolean;
}) {
	const gate = useBackdropGate("webgl");
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const shaderRef = useRef<SkyShader | null>(null);
	const paletteRef = useRef(colors);
	paletteRef.current = colors;
	const [live, setLive] = useState(false);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (gate !== "on" || !canvas) {
			return;
		}
		const shader = startSkyShader(canvas, paletteRef.current);
		shaderRef.current = shader;
		setLive(shader !== null);
		return () => {
			shader?.stop();
			shaderRef.current = null;
		};
	}, [gate]);

	useEffect(() => {
		shaderRef.current?.setPalette(colors);
	}, [colors]);

	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 overflow-hidden bg-background",
				className
			)}
			data-sky={night ? "night" : "day"}
			data-testid="hero-sky"
		>
			<div
				className="absolute inset-0"
				style={{ maskImage: FADE, WebkitMaskImage: FADE }}
			>
				<div
					className="absolute -top-[5%] -left-[5%] h-[110%] w-[110%] blur-[12.5px]"
					data-testid="hero-sky-layer"
					style={staticSky(colors)}
				>
					{gate === "on" ? (
						<canvas
							className={cn(
								"absolute inset-0 size-full transition-opacity duration-700",
								live ? "opacity-100" : "opacity-0"
							)}
							data-testid="hero-sky-canvas"
							ref={canvasRef}
						/>
					) : null}
				</div>
			</div>
			<div className="absolute inset-0 shadow-[inset_0_0_54px_0_color-mix(in_oklab,var(--background)_60%,transparent)]" />
		</div>
	);
}
