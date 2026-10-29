import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Fish } from "lucide-react";
import { motion } from "motion/react";
import { GLASS } from "./aquarium-parts.tsx";

/**
 * Where the waiting silhouettes hang in the water, as fractions of the tank
 * (left, top), their size in pixels, and which way they face.
 */
const SILHOUETTES: readonly {
	flip: boolean;
	left: number;
	size: number;
	top: number;
}[] = [
	{ flip: false, left: 0.22, size: 56, top: 0.38 },
	{ flip: true, left: 0.7, size: 72, top: 0.3 },
	{ flip: false, left: 0.6, size: 44, top: 0.62 },
	{ flip: true, left: 0.32, size: 40, top: 0.66 },
	{ flip: false, left: 0.82, size: 48, top: 0.56 },
	{ flip: true, left: 0.12, size: 46, top: 0.58 },
];

/** Shafts of light while the reef loads: left edge (fraction) and width (fraction). */
const SHAFTS: readonly [number, number][] = [
	[0.14, 0.08],
	[0.36, 0.12],
	[0.62, 0.07],
	[0.78, 0.1],
];

/** A soft, side-on fish shape: the waiting stand-in for a creature. */
function Silhouette({ flip, size }: { flip: boolean; size: number }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("fill-current", flip && "-scale-x-100")}
			height={size * 0.6}
			viewBox="0 0 48 28"
			width={size}
		>
			<path d="M8 14C12 5 26 2 36 7c4 2 7 4.6 8.6 7-1.6 2.4-4.6 5-8.6 7-10 5-24 2-28-7Z" />
			<path d="M9.4 14 1 6.6l2.4 7.4L1 21.4Z" />
		</svg>
	);
}

/**
 * The tank while it fills: light shafts swaying through the water, a few
 * creature silhouettes where the cast will swim, and a status card. Shown
 * while the snapshot loads and until the 3D reef has drawn its first frame
 * (its chunk loads and its shaders compile), so the water is never just an
 * empty gradient. Still under reduced motion.
 */
export function TankFilling({
	count,
	reduced,
}: {
	/** How many creatures are on their way (0 while the snapshot loads). */
	count: number;
	reduced: boolean;
}) {
	const tl = useLiteralMessages();
	const silhouettes = SILHOUETTES.slice(
		0,
		count > 0 ? Math.min(count, SILHOUETTES.length) : 3
	);
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
			data-testid="aquarium-filling"
			exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.3 } }}
			initial={reduced ? false : { opacity: 0 }}
		>
			<div aria-hidden="true" className="absolute inset-0">
				{SHAFTS.map(([left, width], index) => (
					<motion.div
						animate={
							reduced
								? undefined
								: { opacity: [0.5, 0.9, 0.5], rotate: [12, 16, 12] }
						}
						className="absolute -top-1/4 h-[130%] origin-top bg-gradient-to-b from-background/45 via-background/15 to-transparent blur-2xl"
						key={left}
						style={{
							left: `${left * 100}%`,
							opacity: 0.7,
							rotate: "14deg",
							width: `${width * 100}%`,
						}}
						transition={{
							delay: index * 0.6,
							duration: 6 + index,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
				))}
				{silhouettes.map((item, index) => (
					<motion.div
						animate={
							reduced
								? undefined
								: {
										opacity: [0.35, 0.6, 0.35],
										x: item.flip ? [0, -10, 0] : [0, 10, 0],
									}
						}
						className="absolute text-background/40 blur-[1.5px]"
						key={`${item.left}:${item.top}`}
						style={{
							left: `${item.left * 100}%`,
							opacity: 0.45,
							top: `${item.top * 100}%`,
						}}
						transition={{
							delay: index * 0.35,
							duration: 3.2 + (index % 3) * 0.6,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					>
						<Silhouette flip={item.flip} size={item.size} />
					</motion.div>
				))}
			</div>
			<div className="absolute inset-0 flex items-center justify-center p-6">
				<div
					className={cn(
						"flex w-64 flex-col gap-3 rounded-2xl px-4 py-3.5",
						GLASS
					)}
					role="status"
				>
					<div className="flex items-center gap-3">
						<span
							aria-hidden="true"
							className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary"
						>
							<Fish className="size-[18px]" />
						</span>
						<div className="flex min-w-0 flex-col gap-0.5">
							<p className="font-medium text-foreground text-sm leading-tight">
								Filling the tank…
							</p>
							<p className="text-foreground/70 text-xs leading-tight">
								{count > 0
									? tl(
											"{count, plural, one {{countText} creature} other {{countText} creatures}} on the way",
											{ count, countText: String(count) }
										)
									: "Gathering your agents"}
							</p>
						</div>
					</div>
					<div
						aria-hidden="true"
						className="relative h-1 overflow-hidden rounded-full bg-muted"
					>
						<motion.div
							animate={reduced ? undefined : { x: ["-100%", "260%"] }}
							className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary/70"
							style={reduced ? { width: "40%", x: "75%" } : undefined}
							transition={{
								duration: 1.4,
								ease: "easeInOut",
								repeat: Number.POSITIVE_INFINITY,
							}}
						/>
					</div>
				</div>
			</div>
		</motion.div>
	);
}
