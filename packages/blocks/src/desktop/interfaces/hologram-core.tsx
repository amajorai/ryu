import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { type CSSProperties, useId } from "react";
import type { HoloPulse, HoloTotals } from "./hologram-model.ts";
import { polar } from "./hologram-model.ts";
import { CORE_FILL_STOPS } from "./hologram-palette.ts";
import { HUD_LABEL } from "./hologram-parts.tsx";

const TICKS = 72;

const ARC_TONE: Record<ThreadStatus, string> = {
	attention: "stroke-(--holo-alert)",
	quiet: "stroke-(--holo-faint)",
	waiting: "stroke-(--holo-dim)",
	working: "stroke-(--holo-ink)",
	"your-turn": "stroke-(--holo-turn)",
};

/** An SVG arc path, angles in degrees clockwise from 12 o'clock. */
function arcPath(radius: number, from: number, to: number): string {
	const start = polar(from, radius);
	const end = polar(to, radius);
	const large = to - from > 180 ? 1 : 0;
	return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`;
}

/** Arcs for each status's share of all threads, with a small gap between. */
function statusArcs(
	distribution: { count: number; status: ThreadStatus }[],
	radius: number
): { count: number; d: string; status: ThreadStatus }[] {
	const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
	if (total === 0) {
		return [];
	}
	const present = distribution.filter((entry) => entry.count > 0);
	const gap = present.length > 1 ? 3 : 0;
	const arcs: { count: number; d: string; status: ThreadStatus }[] = [];
	let cursor = 0;
	for (const entry of present) {
		const sweep = (entry.count / total) * 360;
		const from = cursor + gap / 2;
		const to = Math.min(cursor + sweep - gap / 2, from + 359.9);
		if (to > from) {
			arcs.push({
				count: entry.count,
				d: arcPath(radius, from, to),
				status: entry.status,
			});
		}
		cursor += sweep;
	}
	return arcs;
}

/**
 * The reactor at the centre of the deck: a tick ring and a dashed ring that
 * turn with the agent ring, a ring of thread status shares, and a disc whose
 * pulse rate and brightness follow how many agents are working. The middle
 * reads out the working count.
 */
export function HoloCore({
	diameter,
	distribution,
	dimmed,
	pulse,
	reduceMotion,
	totals,
}: {
	diameter: number;
	/** Static and faint while loading. */
	dimmed: boolean;
	distribution: { count: number; status: ThreadStatus }[];
	pulse: HoloPulse;
	reduceMotion: boolean;
	totals: HoloTotals;
}) {
	const tl = useLiteralMessages();
	const gradientId = `holo-core-${useId().replaceAll(":", "")}`;
	const outer = diameter / 2;
	const statusRadius = outer - 12;
	const dashRadius = outer - 22;
	const discRadius = outer - 26;
	const ticks = Array.from({ length: TICKS }, (_, index) => {
		const angle = (index * 360) / TICKS;
		const long = index % 6 === 0;
		const from = polar(angle, outer - (long ? 7 : 4));
		const to = polar(angle, outer);
		return { from, key: `tick-${index}`, long, to };
	});
	const arcs = statusArcs(distribution, statusRadius);
	const animate = !(reduceMotion || dimmed);
	const peak = dimmed ? 0.3 : pulse.intensity;
	const working = totals.workingAgents;
	const shares = distribution
		.filter((entry) => entry.count > 0)
		.map((entry) => `${THREAD_STATUS_LABELS[entry.status]} ${entry.count}`)
		.join(", ");
	const summary = dimmed
		? "Syncing with your agents"
		: tl(
				"{working} of {agents} agents working. Status ring, threads by status: {shares}.",
				{ agents: totals.agents, shares: shares || tl("none"), working }
			);
	/** Small cores (and phone width) keep the figures and drop the label. */
	const roomy = diameter >= 150;

	return (
		<div
			aria-label={summary}
			className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
			data-holo-core=""
			role="img"
			style={{ height: diameter, width: diameter }}
		>
			<svg
				aria-hidden="true"
				className="absolute inset-0 overflow-visible"
				height={diameter}
				viewBox={`${-outer} ${-outer} ${diameter} ${diameter}`}
				width={diameter}
			>
				<defs>
					<radialGradient id={gradientId}>
						{CORE_FILL_STOPS.map((stop) => (
							<stop
								className="[stop-color:var(--holo-glow)]"
								key={stop.offset}
								offset={stop.offset}
								stopOpacity={stop.opacity}
							/>
						))}
					</radialGradient>
				</defs>
				<g style={{ transform: "rotate(calc(var(--holo-spin, 0deg) * 3))" }}>
					{ticks.map((tick) => (
						<line
							className={
								tick.long ? "stroke-(--holo-ink)" : "stroke-(--holo-line)"
							}
							key={tick.key}
							strokeWidth={1}
							x1={tick.from.x}
							x2={tick.to.x}
							y1={tick.from.y}
							y2={tick.to.y}
						/>
					))}
				</g>
				<circle
					className="stroke-(--holo-line)"
					fill="none"
					r={statusRadius}
					strokeWidth={3}
				/>
				{arcs.map((arc) => (
					<g key={arc.status}>
						<path
							className={ARC_TONE[arc.status]}
							d={arc.d}
							fill="none"
							strokeWidth={3}
						/>
						{/* A wider, invisible hit path so the segment names itself on hover. */}
						<path
							className="pointer-events-auto stroke-transparent"
							d={arc.d}
							fill="none"
							strokeWidth={12}
						>
							<title>{`${THREAD_STATUS_LABELS[arc.status]} · ${arc.count}`}</title>
						</path>
					</g>
				))}
				<g style={{ transform: "rotate(calc(var(--holo-spin, 0deg) * -5))" }}>
					<circle
						className="stroke-(--holo-ink)/60"
						fill="none"
						r={dashRadius}
						strokeDasharray="2 6"
						strokeWidth={1}
					/>
				</g>
				<circle
					className={
						animate
							? "origin-center opacity-(--holo-pulse-hi) [transform-box:fill-box] motion-safe:animate-[holo-pulse_var(--holo-pulse-period)_ease-in-out_infinite]"
							: "opacity-(--holo-pulse-hi)"
					}
					fill={`url(#${gradientId})`}
					r={discRadius}
					style={
						{
							"--holo-pulse-hi": peak,
							"--holo-pulse-lo": Math.round(peak * 55) / 100,
							"--holo-pulse-period": `${pulse.period}s`,
						} as CSSProperties
					}
				/>
				<circle
					className="stroke-(--holo-ink)/50"
					fill="none"
					r={discRadius * 0.62}
					strokeWidth={1}
				/>
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
				<span className="font-light font-mono text-(--holo-text) text-[40px] tabular-nums leading-none">
					{dimmed ? "—" : String(working).padStart(2, "0")}
				</span>
				{roomy ? (
					<span
						aria-hidden="true"
						className={cn(
							HUD_LABEL,
							"@max-[420px]/holo:hidden text-(--holo-ink) tracking-[0.04em]"
						)}
					>
						{working === 1 ? "Agent working" : "Agents working"}
					</span>
				) : null}
				<span
					aria-hidden="true"
					className={`${HUD_LABEL} text-(--holo-dim) tabular-nums`}
				>
					{dimmed ? "Syncing" : `Of ${String(totals.agents).padStart(2, "0")}`}
				</span>
			</div>
		</div>
	);
}
