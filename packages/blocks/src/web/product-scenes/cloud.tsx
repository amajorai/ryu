import styles from "./cloud.module.css";
import {
	Check,
	Chip,
	Label,
	type MotionStyle,
	Packet,
	type Point,
	SceneCanvas,
	Wire,
} from "./scene.tsx";

/**
 * Ryu Cloud's homepage card: we host and run your agents, so they keep going
 * while your laptop sleeps. The laptop is asleep and the cloud node keeps
 * three runs going, calling models and tools. In the loop the runs finish and
 * start again, the laptop wakes to the result waiting for it, hands the node
 * the next run and goes back to sleep.
 *
 * The markup is the still (asleep, still running); the 10s loop in
 * `cloud.module.css` starts and ends on it.
 */

const LAPTOP_OUT: Point = { x: 80, y: 88 };
const NODE = { height: 112, width: 88, x: 112, y: 36 } as const;
const NODE_IN: Point = { x: NODE.x, y: 88 };
const NODE_OUT: Point = { x: NODE.x + NODE.width, y: 92 };
const BAR_X = NODE.x + 22;
const BAR_WIDTH = 54;

/** Each run's progress at the still, as a fraction of the bar. */
const RUNS = [
	{ className: styles.runA, fill: 0.7, y: 82 },
	{ className: styles.runB, fill: 0.4, y: 106 },
	{ className: styles.runC, fill: 0.85, y: 130 },
] as const;

const OUTSIDE = [
	{ label: "models", y: 62 },
	{ label: "tools", y: 122 },
] as const;

function Laptop() {
	return (
		<g>
			<rect
				className={styles.lid}
				height={46}
				rx={4}
				width={64}
				x={16}
				y={64}
			/>
			<rect
				className={styles.screen}
				height={36}
				rx={2}
				width={54}
				x={21}
				y={69}
			/>
			<path className={styles.base} d="M8 114 H88" />
			<g className={styles.result} transform="translate(48 87)">
				<Check />
			</g>
			<path
				className={styles.moon}
				d="M52 34 A8 8 0 1 0 60 46 A6.5 6.5 0 0 1 52 34 Z"
			/>
			<Label className={styles.asleep} muted x={48} y={130}>
				asleep
			</Label>
			<Label className={styles.awake} x={48} y={130}>
				awake
			</Label>
		</g>
	);
}

export function CloudScene() {
	return (
		<SceneCanvas className={styles.root} id="cloud">
			<Wire from={LAPTOP_OUT} to={NODE_IN} />
			{OUTSIDE.map((target, index) => {
				const to = { x: 224, y: target.y };
				return (
					<g key={target.label}>
						<Wire from={NODE_OUT} to={to} />
						<Packet delay={index * 1.1} from={NODE_OUT} loop to={to} />
					</g>
				);
			})}

			<Laptop />

			<rect
				className={styles.node}
				height={NODE.height}
				rx={10}
				width={NODE.width}
				x={NODE.x}
				y={NODE.y}
			/>
			<Label x={NODE.x + NODE.width / 2} y={NODE.y + 16}>
				cloud
			</Label>
			<line
				className={styles.rule}
				x1={NODE.x}
				x2={NODE.x + NODE.width}
				y1={NODE.y + 30}
				y2={NODE.y + 30}
			/>
			{RUNS.map((run) => (
				<g key={run.y}>
					<circle className={styles.led} cx={NODE.x + 12} cy={run.y} r={2.5} />
					<rect
						className={styles.track}
						height={4}
						rx={2}
						width={BAR_WIDTH}
						x={BAR_X}
						y={run.y - 2}
					/>
					<rect
						className={`${styles.fill} ${run.className}`}
						height={4}
						rx={2}
						style={{ "--fill": String(run.fill) } as MotionStyle}
						width={BAR_WIDTH}
						x={BAR_X}
						y={run.y - 2}
					/>
				</g>
			))}

			{OUTSIDE.map((target) => (
				<Chip
					key={target.label}
					label={target.label}
					width={60}
					x={254}
					y={target.y}
				/>
			))}

			<Packet className={styles.handoff} from={LAPTOP_OUT} to={NODE_IN} />
		</SceneCanvas>
	);
}
