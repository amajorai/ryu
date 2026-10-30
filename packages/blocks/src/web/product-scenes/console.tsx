import styles from "./console.module.css";
import { Check, Chip, Label, type MotionStyle, SceneCanvas } from "./scene.tsx";

/**
 * The homepage card for Agent (the Console realm): the operator's board, not
 * one agent. Across the top are the models, tools and approvals the team sets.
 * Runs proceed side by side: support completes and files itself into the
 * history, research stops at an approval gate until it is approved, and triage
 * waits its turn. That reads apart from the Agents card, which draws a single
 * agent and its parts.
 *
 * The markup is the still: support just filed, research waiting on approval,
 * triage queued. The 9s loop in `console.module.css` starts and ends on it.
 */

const ROWS = { research: 90, support: 56, triage: 124 } as const;
const STEPS = [92, 118, 144, 170, 196] as const;
const GATE = 2;
const PANEL_X = 210;
const PANEL_WIDTH = 76;
const ENTRY_Y = [46, 62, 78, 94, 110, 126] as const;

const delay = (seconds: number): MotionStyle => ({ "--delay": `${seconds}s` });

function Track({ y }: { y: number }) {
	return (
		<line
			className={styles.track}
			x1={STEPS[0]}
			x2={STEPS.at(-1)}
			y1={y}
			y2={y}
		/>
	);
}

function Step({
	className,
	index,
	seconds = 0,
	y,
}: {
	className: string;
	index: number;
	seconds?: number;
	y: number;
}) {
	return (
		<circle
			className={className}
			cx={STEPS[index]}
			cy={y}
			r={3}
			style={delay(seconds)}
		/>
	);
}

/** A run's state: filled when done, a ring while it runs or waits. */
function Status({ done, y }: { done: string; y: number }) {
	return (
		<g>
			<circle className={styles.ring} cx={16} cy={y} r={3.5} />
			<circle className={done} cx={16} cy={y} r={3.5} />
		</g>
	);
}

function Entry({ className, y }: { className?: string; y: number }) {
	return (
		<g className={className}>
			<g transform={`translate(${PANEL_X + 12} ${y})`}>
				<Check />
			</g>
			<rect
				className={styles.entry}
				height={3}
				rx={1.5}
				width={42}
				x={PANEL_X + 22}
				y={y - 1.5}
			/>
		</g>
	);
}

export function ConsoleScene() {
	const gateX = STEPS[GATE];
	return (
		<SceneCanvas className={styles.root} id="console">
			<Chip label="models" width={52} x={40} y={18} />
			<Chip label="tools" width={46} x={95} y={18} />
			<Chip label="approvals" width={70} x={159} y={18} />

			<Status done={styles.supportDone} y={ROWS.support} />
			<Label anchor="start" x={26} y={ROWS.support}>
				support
			</Label>
			<Track y={ROWS.support} />
			{STEPS.map((x, index) => (
				<Step
					className={styles.supportStep}
					index={index}
					key={x}
					seconds={index * 0.5}
					y={ROWS.support}
				/>
			))}

			<Status done={styles.researchDone} y={ROWS.research} />
			<Label anchor="start" x={26} y={ROWS.research}>
				research
			</Label>
			<Track y={ROWS.research} />
			<Step className={styles.early} index={0} y={ROWS.research} />
			<Step
				className={styles.early}
				index={1}
				seconds={0.5}
				y={ROWS.research}
			/>
			<Step className={styles.late} index={3} y={ROWS.research} />
			<Step className={styles.late} index={4} seconds={0.5} y={ROWS.research} />
			<path
				className={styles.gate}
				d={`M${gateX} ${ROWS.research - 5} L${gateX + 5} ${ROWS.research} L${gateX} ${ROWS.research + 5} L${gateX - 5} ${ROWS.research} Z`}
			/>
			<g
				className={styles.approved}
				transform={`translate(${gateX} ${ROWS.research})`}
			>
				<Check />
			</g>
			<g className={styles.ask}>
				<rect
					className={styles.tag}
					height={16}
					rx={4}
					width={58}
					x={gateX - 29}
					y={64}
				/>
				<Label x={gateX} y={72}>
					approve?
				</Label>
			</g>

			<circle className={styles.queued} cx={16} cy={ROWS.triage} r={3.5} />
			<Label anchor="start" muted x={26} y={ROWS.triage}>
				triage
			</Label>
			<Track y={ROWS.triage} />
			<Step className={styles.lit} index={0} y={ROWS.triage} />
			<Step className={styles.triageA} index={1} y={ROWS.triage} />
			<Step className={styles.triageB} index={2} y={ROWS.triage} />
			{STEPS.slice(3).map((x, index) => (
				<Step
					className={styles.pending}
					index={index + 3}
					key={x}
					y={ROWS.triage}
				/>
			))}

			<rect
				className={styles.panel}
				height={142}
				rx={8}
				width={PANEL_WIDTH}
				x={PANEL_X}
				y={8}
			/>
			<Label muted x={PANEL_X + PANEL_WIDTH / 2} y={20}>
				history
			</Label>
			<line
				className={styles.track}
				x1={PANEL_X}
				x2={PANEL_X + PANEL_WIDTH}
				y1={32}
				y2={32}
			/>
			<g className={styles.list}>
				<Entry className={styles.incoming} y={ENTRY_Y[0] - 16} />
				{ENTRY_Y.map((y, index) => (
					<Entry
						className={
							index === ENTRY_Y.length - 1 ? styles.outgoing : undefined
						}
						key={y}
						y={y}
					/>
				))}
			</g>
		</SceneCanvas>
	);
}
