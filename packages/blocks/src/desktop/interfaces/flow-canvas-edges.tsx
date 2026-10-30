import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Inbox } from "lucide-react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import {
	edgePath,
	type FlowChip,
	type FlowEdge,
	type FlowJoint,
} from "./flow-model.ts";

export function transitionFor(reduceMotion: boolean): Transition {
	return reduceMotion
		? { duration: 0 }
		: { damping: 34, mass: 0.8, stiffness: 380, type: "spring" };
}

export function Edges({
	edges,
	path,
	reduceMotion,
}: {
	edges: FlowEdge[];
	path: ReadonlySet<string>;
	reduceMotion: boolean;
}) {
	const transition = transitionFor(reduceMotion);
	const lit = path.size > 1 ? edges.filter((edge) => path.has(edge.to)) : [];
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0 overflow-visible"
			height="1"
			width="1"
		>
			<defs>
				<marker
					id="flow-arrow"
					markerHeight="8"
					markerUnits="userSpaceOnUse"
					markerWidth="8"
					orient="auto"
					refX="7"
					refY="4"
				>
					<path d="M 1 1 L 7 4 L 1 7 z" style={{ fill: "var(--flow-line)" }} />
				</marker>
				<marker
					id="flow-arrow-lit"
					markerHeight="8"
					markerUnits="userSpaceOnUse"
					markerWidth="8"
					orient="auto"
					refX="7"
					refY="4"
				>
					<path d="M 1 1 L 7 4 L 1 7 z" style={{ fill: "var(--flow-lit)" }} />
				</marker>
			</defs>
			<AnimatePresence initial={false}>
				{edges.map((edge) => {
					const d = edgePath(edge.points);
					return (
						<motion.path
							animate={{ d, opacity: 1 }}
							exit={{ opacity: 0 }}
							fill="none"
							initial={{ d, opacity: 0 }}
							key={edge.id}
							markerEnd={edge.arrow ? "url(#flow-arrow)" : undefined}
							strokeDasharray={edge.dashed ? "3 3" : undefined}
							strokeLinecap="round"
							strokeWidth={1.25}
							style={{ stroke: "var(--flow-line)" }}
							transition={transition}
						/>
					);
				})}
			</AnimatePresence>
			{/* The open path, traced over the shared bus in the accent. */}
			<AnimatePresence initial={false}>
				{lit.map((edge) => {
					const d = edgePath(edge.points);
					return (
						<motion.path
							animate={{ d, opacity: 1 }}
							data-flow-lit=""
							exit={{ opacity: 0 }}
							fill="none"
							initial={{ d, opacity: 0 }}
							key={edge.id}
							markerEnd={edge.arrow ? "url(#flow-arrow-lit)" : undefined}
							strokeDasharray={edge.dashed ? "3 3" : undefined}
							strokeLinecap="round"
							strokeWidth={1.25}
							style={{ stroke: "var(--flow-lit)" }}
							transition={transition}
						/>
					);
				})}
			</AnimatePresence>
		</svg>
	);
}

/**
 * A connector's count of what waits on you. It rides the same spring as the
 * nodes, so it never drifts off its line while the flow reflows.
 */
export function Chip({
	chip,
	onChip,
	transition,
}: {
	chip: FlowChip;
	onChip: (chip: FlowChip) => void;
	transition: Transition;
}) {
	const tl = useLiteralMessages();
	return (
		<motion.button
			animate={{ opacity: 1, x: chip.x, y: chip.y }}
			aria-label={tl("Review next: {description}", {
				description: chip.description,
			})}
			className="group/chip absolute top-0 left-0 outline-none"
			data-flow-chip=""
			exit={{ opacity: 0 }}
			initial={{ opacity: 0, x: chip.x, y: chip.y }}
			onClick={() => onChip(chip)}
			// Reached by pointer; the keyboard path is the node itself.
			tabIndex={-1}
			title={tl("{description}. Open the next one.", {
				description: chip.description,
			})}
			transition={transition}
			type="button"
		>
			<span
				className={cn(
					"flex h-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-1 rounded-[5px] border border-[var(--flow-line)] bg-background px-1.5 font-medium text-[11px] text-foreground tabular-nums leading-none transition-colors group-hover/chip:border-foreground/40 group-focus-visible/chip:ring-2 group-focus-visible/chip:ring-ring/40"
				)}
			>
				<Inbox aria-hidden="true" className="size-3 stroke-[1.75]" />
				<span aria-hidden="true">{chip.label}</span>
			</span>
		</motion.button>
	);
}

/** The quiet round glyph a connector shows when nothing waits behind it. */
export function Joint({
	joint,
	transition,
}: {
	joint: FlowJoint;
	transition: Transition;
}) {
	return (
		<motion.span
			animate={{ opacity: 1, x: joint.x, y: joint.y }}
			aria-hidden="true"
			className="pointer-events-none absolute top-0 left-0"
			exit={{ opacity: 0 }}
			initial={{ opacity: 0, x: joint.x, y: joint.y }}
			transition={transition}
		>
			<span className="flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--flow-line)] bg-background">
				<span className="size-1 rounded-full bg-[var(--flow-line)]" />
			</span>
		</motion.span>
	);
}
