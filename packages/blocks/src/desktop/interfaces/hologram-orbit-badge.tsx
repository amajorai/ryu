import { cn } from "@ryu/ui/lib/utils";
import type { HoloAgent } from "./hologram-model.ts";
import { polar } from "./hologram-model.ts";
import {
	arcPath,
	NODE,
	NODE_RADIUS,
	SWEEP,
	TICK_INNER,
	TICK_OUTER,
	TICK_STEP,
	tickTones,
} from "./hologram-orbit-geometry.ts";

/**
 * The node's badge: avatar or initials in a disc, one tick per thread on a
 * ring outside it (toned by what each thread needs), and, while the agent
 * works, a lit sweep turning round the rim. `marked` gives the rim a solid
 * ink edge (the agent is targeted or its threads are open).
 */
export function NodeBadge({
	agent,
	marked,
	reduceMotion,
}: {
	agent: HoloAgent;
	marked: boolean;
	reduceMotion: boolean;
}) {
	const working = agent.status === "working";
	const tones = tickTones(agent);
	return (
		<span className="relative block size-12">
			<svg
				aria-hidden="true"
				className="absolute inset-0 overflow-visible"
				height={NODE}
				viewBox={`${-NODE / 2} ${-NODE / 2} ${NODE} ${NODE}`}
				width={NODE}
			>
				<circle
					className={cn(
						"fill-(--holo-deck)",
						marked || working ? "stroke-(--holo-ink)" : "stroke-(--holo-line)"
					)}
					r={NODE_RADIUS}
					strokeWidth={marked ? 2 : 1}
				/>
				<circle
					className={working ? "fill-(--holo-ink)/14" : "fill-(--holo-ink)/5"}
					r={NODE_RADIUS - 1}
				/>
				<circle
					className="stroke-(--holo-line)"
					fill="none"
					r={(TICK_INNER + TICK_OUTER) / 2}
					strokeWidth={1}
				/>
				{tones.map((tone, index) => {
					const angle = index * TICK_STEP;
					const from = polar(angle, TICK_INNER);
					const to = polar(angle, TICK_OUTER);
					return (
						<line
							className={tone}
							// biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional
							key={index}
							strokeWidth={3}
							x1={from.x}
							x2={to.x}
							y1={from.y}
							y2={to.y}
						/>
					);
				})}
			</svg>
			{working ? (
				<svg
					aria-hidden="true"
					className={cn(
						"absolute inset-0 overflow-visible",
						!reduceMotion && "motion-safe:animate-[spin_1.8s_linear_infinite]"
					)}
					height={NODE}
					viewBox={`${-NODE / 2} ${-NODE / 2} ${NODE} ${NODE}`}
					width={NODE}
				>
					<path
						className="stroke-(--holo-ink)"
						d={arcPath(NODE_RADIUS, 0, SWEEP)}
						fill="none"
						strokeLinecap="round"
						strokeWidth={3}
					/>
				</svg>
			) : null}
			{agent.agent.avatarUrl ? (
				<img
					alt=""
					className="absolute inset-[6px] size-9 rounded-full object-cover"
					height={36}
					src={agent.agent.avatarUrl}
					width={36}
				/>
			) : (
				<span
					className={cn(
						"absolute inset-0 flex items-center justify-center font-medium font-mono text-[14px]",
						working ? "text-(--holo-ink)" : "text-(--holo-text)"
					)}
				>
					{agent.initials}
				</span>
			)}
		</span>
	);
}
