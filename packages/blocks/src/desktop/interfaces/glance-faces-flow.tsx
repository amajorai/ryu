import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import { useMemo } from "react";
import { ClockDigits } from "./glance-faces-clock-digits.tsx";
import {
	GLANCE_TYPE,
	type GlanceFaceProps,
} from "./glance-faces-type-scale.ts";
import {
	buildGlanceAgents,
	buildGlanceFlow,
	GLANCE_AGENT_STATE_LABELS,
	type GlanceFlowBlob,
	glanceThreadTitle,
	glanceWorkingLine,
} from "./glance-model.ts";
import { GlanceMark } from "./glance-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

// ---------------------------------------------------------------------------
// Flow (ambient art)
// ---------------------------------------------------------------------------

/** A soft light: full strength at the centre, eased out to nothing at the edge. */
function flowGradient(blob: GlanceFlowBlob): string {
	const ink = (share: number) =>
		`color-mix(in oklab, var(--${blob.tone}) ${Math.round(blob.strength * share * 100)}%, transparent)`;
	return `radial-gradient(closest-side, ${ink(1)} 0%, ${ink(0.72)} 30%, ${ink(0.32)} 60%, ${ink(0.08)} 85%, transparent 100%)`;
}

function FlowBlob({
	animate,
	blob,
}: {
	animate: boolean;
	blob: GlanceFlowBlob;
}) {
	const reach = `${blob.reach * 100}%`;
	const back = `${-blob.reach * 70}%`;
	return (
		<motion.div
			animate={
				animate
					? {
							scale: [1, blob.working ? 1.18 : 1.06, 0.96, 1],
							x: ["0%", reach, back, "0%"],
							y: ["0%", back, reach, "0%"],
						}
					: undefined
			}
			className="absolute rounded-full"
			data-flow-blob={blob.id}
			style={{
				background: flowGradient(blob),
				height: `${blob.size * 100}%`,
				left: `${(blob.x - blob.size / 2) * 100}%`,
				top: `${(blob.y - blob.size / 2) * 100}%`,
				width: `${blob.size * 100}%`,
			}}
			transition={{
				duration: blob.duration,
				ease: "easeInOut",
				repeat: Number.POSITIVE_INFINITY,
			}}
		/>
	);
}

/**
 * The flow face: soft light that drifts with the work. Each agent is a glow
 * placed by its id; live runs glow larger and move faster. Static when the
 * viewer prefers reduced motion.
 */
export function GlanceFlowFace({
	distance,
	loading,
	now,
	onOpenThread,
	snapshot,
}: GlanceFaceProps) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const blobs = useMemo(() => buildGlanceFlow(snapshot), [snapshot]);
	// Every coloured light in the art has a row that names it: agents that
	// need attention first, then the ones at work.
	const lit = useMemo(
		() =>
			buildGlanceAgents(snapshot)
				.filter(
					(tile) =>
						tile.thread !== null &&
						(tile.state === "attention" || tile.state === "working")
				)
				.sort(
					(a, b) =>
						Number(b.state === "attention") - Number(a.state === "attention")
				),
		[snapshot]
	);
	const workingAgents = snapshot.agents.filter(
		(agent) => agent.status === "working"
	).length;
	const near = distance === "near";
	return (
		<div className="relative size-full overflow-hidden">
			<div aria-hidden="true" className="absolute inset-0">
				{blobs.map((blob) => (
					<FlowBlob animate={!reduceMotion} blob={blob} key={blob.id} />
				))}
			</div>
			<div className="relative flex size-full flex-col p-[7cqw]">
				<ClockDigits near={near} now={now} onArt />
				<div className="mt-auto flex flex-col gap-[2.4cqw]">
					{loading ? (
						<Skeleton className="h-[4.4cqw] w-[40cqw] rounded-full" />
					) : (
						<p
							className={cn("font-semibold text-foreground", GLANCE_TYPE.lead)}
						>
							{glanceWorkingLine(workingAgents)}
						</p>
					)}
					{near && !loading && lit.length > 0 ? (
						<ul className="flex flex-col">
							{lit.slice(0, 3).map(({ agent, state, thread }) =>
								thread ? (
									<li key={agent.id}>
										<button
											aria-label={tl("Open {title}, {name}, {state}", {
												name: agent.name,
												state: GLANCE_AGENT_STATE_LABELS[state],
												title: glanceThreadTitle(thread),
											})}
											className={cn(
												"corner-squircle -mx-[2.4cqw] grid w-[calc(100%+4.8cqw)] min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-[1.8cqw] rounded-[2.4cqw] px-[2.4cqw] py-[1.2cqw] text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring",
												GLANCE_TYPE.body
											)}
											onClick={() => onOpenThread(thread.id)}
											type="button"
										>
											<GlanceMark
												className="-translate-y-[0.15em]"
												state={state}
											/>
											<span className="font-semibold text-foreground">
												{agent.name}
											</span>
											<span className="truncate text-foreground/75">
												{state === "attention" ? (
													<span className="font-medium text-destructive">
														{GLANCE_AGENT_STATE_LABELS[state]}
														{" · "}
													</span>
												) : null}
												{glanceThreadTitle(thread)}
											</span>
										</button>
									</li>
								) : null
							)}
						</ul>
					) : null}
				</div>
			</div>
		</div>
	);
}
