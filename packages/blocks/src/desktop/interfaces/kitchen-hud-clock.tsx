import { cn } from "@ryu/ui/lib/utils";
import { GAME_PLATE } from "./game-hud.tsx";
import { clockTime } from "./kitchen-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";
import { useActNow } from "./use-acts.ts";

/**
 * Bottom right: the service clock. A dial with twelve hour ticks whose ring
 * fills as the hour goes by, beside the time.
 */
export function ServiceClock() {
	// The act clock (pinned by the harness); under reduced motion the ring
	// moves with the minute.
	const now = useActNow();
	const reduced = useReducedMotion();
	const date = new Date(now);
	// Under reduced motion the ring moves with the minute, not each second.
	const minutes = date.getMinutes() + (reduced ? 0 : date.getSeconds() / 60);
	const size = 40;
	const centre = size / 2;
	const radius = 17;
	const ring = 2 * Math.PI * (radius - 2.5);
	const ticks = Array.from({ length: 12 }, (_, hour) => {
		const angle = (hour / 12) * 2 * Math.PI;
		const inner = hour % 3 === 0 ? radius - 6 : radius - 4;
		return {
			hour,
			x1: centre + Math.cos(angle) * inner,
			x2: centre + Math.cos(angle) * (radius - 2),
			y1: centre + Math.sin(angle) * inner,
			y2: centre + Math.sin(angle) * (radius - 2),
		};
	});
	return (
		<section
			aria-label="Service clock"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex items-center gap-3 py-2 ps-2.5 pe-4"
			)}
		>
			<svg
				aria-hidden="true"
				className="block shrink-0 -rotate-90"
				height={size}
				viewBox={`0 0 ${size} ${size}`}
				width={size}
			>
				<circle
					cx={centre}
					cy={centre}
					fill="var(--gk-plate-sunk)"
					r={radius}
					stroke="var(--gk-edge)"
					strokeWidth={2}
				/>
				<circle
					cx={centre}
					cy={centre}
					fill="none"
					r={radius - 2.5}
					stroke="var(--gk-accent)"
					strokeDasharray={ring}
					strokeDashoffset={ring * (1 - minutes / 60)}
					strokeWidth={3}
				/>
				{ticks.map((tick) => (
					<line
						key={`tick-${tick.hour.toString()}`}
						stroke={
							tick.hour % 3 === 0 ? "var(--gk-edge)" : "var(--gk-ink-soft)"
						}
						strokeLinecap="round"
						strokeWidth={tick.hour % 3 === 0 ? 2 : 1.25}
						x1={tick.x1}
						x2={tick.x2}
						y1={tick.y1}
						y2={tick.y2}
					/>
				))}
				<circle cx={centre} cy={centre} fill="var(--gk-edge)" r={2} />
			</svg>
			<div className="flex flex-col-reverse">
				<span className="font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide">
					Service
				</span>
				<time
					className="gk-display whitespace-nowrap text-[26px] tabular-nums leading-7"
					dateTime={date.toISOString()}
				>
					{clockTime(now)}
				</time>
			</div>
		</section>
	);
}
