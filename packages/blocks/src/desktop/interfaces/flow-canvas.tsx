import { AnimatePresence, motion } from "motion/react";
import { Chip, Edges, Joint, transitionFor } from "./flow-canvas-edges.tsx";
import { HoverStub, NodeButton } from "./flow-canvas-node.tsx";
import { FlowComposerNode } from "./flow-composer.tsx";
import type {
	FlowChip,
	FlowLayout,
	FlowNode,
	FlowTarget,
} from "./flow-model.ts";

/** A solid mid-tone line color derived from the theme, so overlaps never darken. */
export const FLOW_LINE_STYLE = {
	"--flow-line":
		"color-mix(in oklab, var(--muted-foreground) 55%, var(--background))",
	"--flow-lit": "color-mix(in oklab, var(--primary) 60%, var(--background))",
} as React.CSSProperties;

export interface FlowCanvasHandlers {
	onActivate: (node: FlowNode) => void;
	onCancelComposer: () => void;
	onChip: (chip: FlowChip) => void;
	onFocusNode: (id: string) => void;
	onSubmitComposer: (target: FlowTarget, prompt: string) => void;
}

interface FlowCanvasProps extends FlowCanvasHandlers {
	focusId: string | null;
	layout: FlowLayout;
	/** Stub whose menu is open. */
	menuFor: string | null;
	/** Opens the "Connect to" menu from a lead's hover stub. */
	onConnect: (ownerId: string) => void;
	/** Nodes from the origin to the selected node; their edges are tinted. */
	path: ReadonlySet<string>;
	reduceMotion: boolean;
	selectedId: string | null;
}

const ENTER = { opacity: 0, scale: 0.96 };

/** Everything in world space: lines, connector chips, and nodes. */
export function FlowCanvas({
	focusId,
	layout,
	menuFor,
	onActivate,
	onCancelComposer,
	onChip,
	onConnect,
	onFocusNode,
	onSubmitComposer,
	path,
	reduceMotion,
	selectedId,
}: FlowCanvasProps) {
	const transition = transitionFor(reduceMotion);
	const stubOwners = new Set(
		layout.nodes.flatMap((node) => (node.kind === "stub" ? [node.ownerId] : []))
	);
	return (
		<>
			<Edges edges={layout.edges} path={path} reduceMotion={reduceMotion} />
			<AnimatePresence initial={false}>
				{layout.nodes.map((node) => (
					<motion.div
						animate={{
							opacity: 1,
							scale: 1,
							x: node.x,
							y: node.y - node.h / 2,
						}}
						className="group/node absolute top-0 left-0"
						exit={{ opacity: 0, scale: 0.96 }}
						initial={{ ...ENTER, x: node.x, y: node.y - node.h / 2 }}
						key={node.id}
						style={{ height: node.h, width: node.w }}
						transition={transition}
					>
						{node.kind === "composer" ? (
							<FlowComposerNode
								id={node.id}
								onCancel={onCancelComposer}
								onFocusNode={onFocusNode}
								onSubmit={(prompt) => onSubmitComposer(node.target, prompt)}
								target={node.target}
							/>
						) : (
							<NodeButton
								focusId={focusId}
								layout={layout}
								menuFor={menuFor}
								node={node}
								onActivate={onActivate}
								onFocusNode={onFocusNode}
								path={path}
								selectedId={selectedId}
							/>
						)}
						{(node.kind === "agent" || node.kind === "team") &&
						!stubOwners.has(node.id) ? (
							<HoverStub
								name={node.kind === "agent" ? node.agent.name : node.group.name}
								onConnect={() => onConnect(node.id)}
								open={menuFor === node.id}
								pinned={selectedId === node.id}
							/>
						) : null}
					</motion.div>
				))}
			</AnimatePresence>
			{/* Chips follow the nodes so Tab enters the canvas at "You". */}
			<AnimatePresence initial={false}>
				{layout.joints.map((joint) => (
					<Joint joint={joint} key={joint.id} transition={transition} />
				))}
				{layout.chips.map((chip) => (
					<Chip
						chip={chip}
						key={chip.id}
						onChip={onChip}
						transition={transition}
					/>
				))}
			</AnimatePresence>
		</>
	);
}
