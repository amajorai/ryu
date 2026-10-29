import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { useId, useMemo } from "react";
import { HUB_ART_HEIGHT, HUB_ART_WIDTH, hubArt, hubSeed } from "./hub-model.ts";
import { HUB_EASE } from "./hub-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Back to front. The far ridges take the neutral accent as haze, the near
 * ones the primary, so every theme gets aerial depth rather than one flat hue.
 */
const RIDGE_FILLS = [
	"fill-accent/70",
	"fill-primary/[0.09]",
	"fill-accent/50",
	"fill-primary/[0.2]",
];

const BLOOM_STOP = { stopColor: "var(--primary)" };

/**
 * The ambient picture: layered hills under a low glow, drawn only from the
 * user's theme tokens and seeded by the day so it changes once a day. When the
 * display wakes it softens out of focus behind the cards.
 */
export function HubBackdrop({
	awake,
	dayKey,
}: {
	awake: boolean;
	dayKey: string;
}) {
	const reduceMotion = useReducedMotion();
	const art = useMemo(() => hubArt(hubSeed(dayKey)), [dayKey]);
	const bloomId = useId();
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 overflow-hidden bg-background"
		>
			<motion.div
				animate={
					awake
						? { filter: "blur(28px)", scale: 1.08 }
						: { filter: "blur(0px)", scale: 1 }
				}
				className="absolute inset-0 bg-linear-to-b from-primary/10 via-primary/[0.03] to-background"
				initial={false}
				transition={{ duration: reduceMotion ? 0 : 0.6, ease: HUB_EASE }}
			>
				<svg
					className="absolute inset-0 size-full"
					preserveAspectRatio="xMidYMax slice"
					role="presentation"
					viewBox={`0 0 ${HUB_ART_WIDTH} ${HUB_ART_HEIGHT}`}
				>
					<defs>
						<radialGradient id={bloomId}>
							<stop offset="0" stopOpacity={0.2} style={BLOOM_STOP} />
							<stop offset="0.5" stopOpacity={0.07} style={BLOOM_STOP} />
							<stop offset="1" stopOpacity={0} style={BLOOM_STOP} />
						</radialGradient>
					</defs>
					<ellipse
						cx={art.bloom.cx}
						cy={art.bloom.cy}
						fill={`url(#${bloomId})`}
						rx={art.bloom.r * 1.8}
						ry={art.bloom.r * 0.8}
					/>
					{art.ridges.map((path, index) => (
						<path
							className={RIDGE_FILLS[index] ?? RIDGE_FILLS[0]}
							d={path}
							key={path}
						/>
					))}
				</svg>
			</motion.div>
			<div
				className={cn(
					"absolute inset-0 bg-background transition-opacity duration-500 motion-reduce:transition-none",
					awake ? "opacity-40" : "opacity-0"
				)}
			/>
		</div>
	);
}
