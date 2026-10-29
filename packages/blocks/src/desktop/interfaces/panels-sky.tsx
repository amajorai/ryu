import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import type { CSSProperties } from "react";
import { skyAt } from "./panels-model.ts";
import { SKY_PALETTES, SKY_STAR } from "./panels-palette.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Mix an art color into the theme background, so the sky follows the theme.
 * `--panels-sky-k` scales every stop: dark themes turn the bright phases
 * down, so a dark day reads as a dim, dusk-toned sky rather than a wash.
 */
function mix(color: string, strength: number): string {
	return `color-mix(in oklab, ${color} calc(${strength}% * var(--panels-sky-k, 1)), var(--background))`;
}

/** A translucent glow, so a halo lights the sky under it instead of covering it. */
function glow(color: string, strength: number): string {
	return `color-mix(in oklab, ${color} ${strength}%, transparent)`;
}

interface Star {
	opacity: number;
	radius: number;
	/** Percent of the band's width. */
	x: number;
	/** Pixels from the top of the band. */
	y: number;
}

/** Deterministic star field: no randomness, so screenshots stay stable. */
const STARS: Star[] = (() => {
	const stars: Star[] = [];
	let seed = 7;
	const next = () => {
		seed = (seed * 9301 + 49_297) % 233_280;
		return seed / 233_280;
	};
	for (let index = 0; index < 54; index += 1) {
		stars.push({
			opacity: 0.3 + next() * 0.55,
			radius: 0.5 + next() * 0.8,
			x: next() * 100,
			y: 8 + next() * 220,
		});
	}
	return stars;
})();

/** The arc the sun or moon travels, in pixels from the top of the band. */
const ARC_BASE = 150;
const ARC_PEAK = 26;
/**
 * Where the arc meets the horizon, as percents of the band's width. It keeps
 * to the right of the greeting and ends above the suggestion cards, so the
 * sun never sits behind text.
 */
const ARC_START = 50;
const ARC_END = 96;

/** A waxing crescent: a soft-edged disc cut out of the moon's upper right. */
const MOON_MASK =
	"radial-gradient(circle at 78% 30%, transparent 0 46%, black 50%)";

/**
 * The Home backdrop: a band of sky for the local time of day behind the
 * greeting and the suggestions. It fills its (relative) parent and runs 48px
 * past it, so the fade into the page always ends above the panels grid. The
 * sun (or moon) sits on a faint arc for the current minute, so the band reads
 * as a quiet clock face above the suggestions. It is decorative; the header
 * states the date and time in text. On a phone-width page the arc and its
 * body drop out, since there is no clear sky beside the greeting.
 */
export function PanelsSky({ now }: { now: Date }) {
	const reduceMotion = useReducedMotion();
	const sky = skyAt(now);
	const palette = SKY_PALETTES[sky.phase];
	const strength = palette.strength;
	const isMoon = sky.body === "moon";
	const left = `${ARC_START + (ARC_END - ARC_START) * sky.progress}%`;
	const top = ARC_BASE - (ARC_BASE - ARC_PEAK) * sky.altitude;
	const bandStyle: CSSProperties = {
		backgroundImage: `linear-gradient(to bottom, ${mix(palette.zenith, strength)} 0%, ${mix(palette.middle, strength - 8)} 34%, ${mix(palette.horizon, strength - 18)} 62%, var(--background) 100%)`,
	};
	const dimInDark = sky.phase === "day" || sky.phase === "dawn";
	const haloSize = isMoon ? 112 : 160;
	const haloInner = isMoon ? 26 : 55;
	const haloOuter = isMoon ? 7 : 16;
	const discSize = isMoon ? 22 : 30;
	const showStars = sky.phase === "night" || sky.phase === "dusk";
	const arcMid = 2 * ARC_PEAK - ARC_BASE;
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 -bottom-12 overflow-hidden",
				dimInDark && "dark:[--panels-sky-k:0.55]",
				// On a light page, a full-strength night turns the band a dull
				// grey; a lighter indigo wash keeps it clean behind dark text.
				sky.phase === "night" && "[--panels-sky-k:0.62] dark:[--panels-sky-k:1]"
			)}
			data-sky-body={sky.body}
			data-sky-phase={sky.phase}
			data-testid="panels-sky"
			style={bandStyle}
		>
			{showStars ? (
				<svg
					className="absolute inset-x-0 top-0 w-full"
					height={ARC_BASE + 40}
					opacity={sky.phase === "night" ? 1 : 0.35}
				>
					{STARS.map((star) => (
						<circle
							cx={`${star.x}%`}
							cy={star.y}
							fill={SKY_STAR}
							key={`${star.x}-${star.y}`}
							opacity={star.opacity}
							r={star.radius}
						/>
					))}
				</svg>
			) : null}
			<svg
				className="absolute inset-x-0 top-0 @max-xl:hidden w-full text-foreground"
				height={ARC_BASE}
				preserveAspectRatio="none"
				viewBox={`0 0 100 ${ARC_BASE}`}
			>
				<path
					d={`M ${ARC_START} ${ARC_BASE} Q ${(ARC_START + ARC_END) / 2} ${arcMid} ${ARC_END} ${ARC_BASE}`}
					fill="none"
					stroke="currentColor"
					strokeDasharray="1 5"
					strokeLinecap="round"
					strokeOpacity={0.22}
					strokeWidth={1}
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
			<motion.div
				animate={{ opacity: 1, y: 0 }}
				className="absolute @max-xl:hidden"
				initial={reduceMotion ? false : { opacity: 0, y: 16 }}
				style={{ left, top }}
				transition={{
					duration: reduceMotion ? 0 : 1.4,
					ease: [0.22, 1, 0.36, 1],
				}}
			>
				<div
					className="absolute rounded-full"
					style={{
						backgroundImage: `radial-gradient(closest-side, ${glow(palette.halo, haloInner)}, ${glow(palette.halo, haloOuter)} 45%, transparent)`,
						height: haloSize,
						left: -haloSize / 2,
						opacity: 0.9,
						top: -haloSize / 2,
						width: haloSize,
					}}
				/>
				<div
					className="absolute rounded-full"
					style={{
						backgroundColor: palette.light,
						height: discSize,
						left: -discSize / 2,
						// The crescent is cut with a mask, so the real sky shows
						// through the dark side in every theme.
						maskImage: isMoon ? MOON_MASK : undefined,
						top: -discSize / 2,
						WebkitMaskImage: isMoon ? MOON_MASK : undefined,
						width: discSize,
					}}
				/>
			</motion.div>
		</div>
	);
}
