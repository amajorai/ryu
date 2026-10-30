import type { ReactNode } from "react";
import styles from "./agents.module.css";
import { Label, Packet, type Point, SceneCanvas, Wire } from "./scene.tsx";

/**
 * The Agents card: what an agent is. A core with its parts plugged in: the
 * models it thinks and hears and sees with on the left, the tools, memory and
 * prompt it acts with on the right. Signal flows in from the models and out to
 * the tools, the core pulses as it works, and twice a loop the model is
 * unplugged and another plugs in while the agent keeps running: nothing is
 * locked in.
 *
 * The markup is the still (every part connected, signal mid-wire); the 9.6s
 * loop in `agents.module.css` starts and ends on it.
 */

interface Part {
	/** Where the wire meets the core's face. */
	readonly face: number;
	readonly glyph: ReactNode;
	readonly label: string;
	readonly y: number;
}

const CORE: Point = { x: 148, y: 84 };
const CORE_HALF = 20;
const CHIP_WIDTH = 66;
const LEFT_X = 43;
const RIGHT_X = 253;
const ROWS = [36, 84, 132] as const;
const FACES = [74, 84, 94] as const;

const CIRCLE = <circle r={2.6} />;
const DIAMOND = <path d="M0 -3 L3 0 L0 3 L-3 0 Z" />;
const SQUARE = <rect height={5} width={5} x={-2.5} y={-2.5} />;
const TRIANGLE = <path d="M0 -3 L2.8 2.2 H-2.8 Z" />;
const WRENCH = (
	<g className={styles.outline}>
		<path d="M-2.6 2.6 L0.6 -0.6" />
		<circle cx={1.6} cy={-1.6} r={1.5} />
	</g>
);
const MEMORY = (
	<g className={styles.outline}>
		<ellipse cy={-2} rx={3} ry={1.1} />
		<ellipse rx={3} ry={1.1} />
		<ellipse cy={2} rx={3} ry={1.1} />
	</g>
);
const DOC = (
	<path className={styles.outline} d="M-2.4 -3.2 H1 L2.4 -1.8 V3.2 H-2.4 Z" />
);

const MODELS: readonly Part[] = [
	{ face: FACES[0], glyph: CIRCLE, label: "model", y: ROWS[0] },
	{ face: FACES[1], glyph: SQUARE, label: "voice", y: ROWS[1] },
	{ face: FACES[2], glyph: TRIANGLE, label: "image", y: ROWS[2] },
];
const ABILITIES: readonly Part[] = [
	{ face: FACES[0], glyph: WRENCH, label: "tools", y: ROWS[0] },
	{ face: FACES[1], glyph: MEMORY, label: "memory", y: ROWS[1] },
	{ face: FACES[2], glyph: DOC, label: "prompt", y: ROWS[2] },
];

function Chip({
	className,
	glyph,
	label,
	x,
	y,
}: {
	className?: string;
	glyph: ReactNode;
	label: string;
	x: number;
	y: number;
}) {
	return (
		<g className={className}>
			<g transform={`translate(${x} ${y})`}>
				<rect
					className={styles.chip}
					height={20}
					rx={10}
					width={CHIP_WIDTH}
					x={-CHIP_WIDTH / 2}
					y={-10}
				/>
				<g className={styles.glyph} transform="translate(-21 0)">
					{glyph}
				</g>
			</g>
			<Label anchor="start" x={x - 13} y={y}>
				{label}
			</Label>
		</g>
	);
}

export function AgentsScene() {
	const left = LEFT_X + CHIP_WIDTH / 2;
	const right = RIGHT_X - CHIP_WIDTH / 2;
	return (
		<SceneCanvas className={styles.root} id="agents">
			{MODELS.map((part, index) => {
				const from = { x: left, y: part.y };
				const to = { x: CORE.x - CORE_HALF, y: part.face };
				return (
					<g key={part.label}>
						<Wire from={from} to={to} />
						<Packet delay={index * 0.4} from={from} loop to={to} />
					</g>
				);
			})}
			{ABILITIES.map((part, index) => {
				const from = { x: CORE.x + CORE_HALF, y: part.face };
				const to = { x: right, y: part.y };
				return (
					<g key={part.label}>
						<Wire from={from} to={to} />
						<Packet delay={1.2 + index * 0.4} from={from} loop to={to} />
					</g>
				);
			})}

			{/* The model slot: one chip unplugs outward as the other plugs in. */}
			<Chip
				className={styles.modelA}
				glyph={CIRCLE}
				label="model"
				x={LEFT_X}
				y={ROWS[0]}
			/>
			<Chip
				className={styles.modelB}
				glyph={DIAMOND}
				label="model"
				x={LEFT_X}
				y={ROWS[0]}
			/>
			{MODELS.slice(1).map((part) => (
				<Chip
					glyph={part.glyph}
					key={part.label}
					label={part.label}
					x={LEFT_X}
					y={part.y}
				/>
			))}
			{ABILITIES.map((part) => (
				<Chip
					glyph={part.glyph}
					key={part.label}
					label={part.label}
					x={RIGHT_X}
					y={part.y}
				/>
			))}

			<g transform={`translate(${CORE.x} ${CORE.y})`}>
				<circle className={styles.halo} r={31} />
				<rect
					className={styles.core}
					height={CORE_HALF * 2}
					rx={11}
					width={CORE_HALF * 2}
					x={-CORE_HALF}
					y={-CORE_HALF}
				/>
				<circle className={styles.dot} r={6} />
			</g>
			<Label x={CORE.x} y={CORE.y + 44}>
				agent
			</Label>
		</SceneCanvas>
	);
}
