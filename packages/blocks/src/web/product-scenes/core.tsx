import styles from "./core.module.css";
import {
	Check,
	Chip,
	Label,
	Packet,
	type Point,
	SceneCanvas,
	Wire,
} from "./scene.tsx";

/**
 * Ryu Core's homepage card: the orchestration map. A task drops into the hub;
 * Core spawns sub-agents out of its left face and binds them to coding
 * engines, dispatches work over MCP, memory and git on the right, lands a
 * commit, recalls the sub-agents and takes the next task.
 *
 * The markup is the still, mid-orchestration: two sub-agents bound to their
 * engines and work flowing out to the resources. The 10s loop in
 * `core.module.css` starts and ends on it. Sub-agents leave from the hub's
 * face, never across the "core" label.
 */

const HUB: Point = { x: 148, y: 92 };
const HUB_HALF = 22;
const ENGINE_X = 46;
const ENGINE_WIDTH = 80;
const RESOURCE_X = 252;
const RESOURCE_WIDTH = 64;
/** One row per engine and resource; `face` is where its wire meets the hub. */
const ROWS = [
	{ face: 84, y: 50 },
	{ face: 92, y: 92 },
	{ face: 100, y: 134 },
] as const;
const [, , LAST_ROW] = ROWS;

const ENGINES = [
	{ bound: true, label: "claude code", row: ROWS[0] },
	{ bound: true, label: "codex", row: ROWS[1] },
	{ bound: false, label: "gemini", row: ROWS[2] },
] as const;

const RESOURCES = [
	{ label: "mcp", row: ROWS[0] },
	{ label: "memory", row: ROWS[1] },
	{ label: "git", row: ROWS[2] },
] as const;

const TASK_OUT: Point = { x: HUB.x, y: 32 };
const HUB_TOP: Point = { x: HUB.x, y: HUB.y - HUB_HALF };

/** A point `fraction` of the way from `from` to `to`. */
const along = (from: Point, to: Point, fraction: number): Point => ({
	x: from.x + (to.x - from.x) * fraction,
	y: from.y + (to.y - from.y) * fraction,
});

export function CoreProductScene() {
	return (
		<SceneCanvas className={styles.root} id="core">
			<Wire from={TASK_OUT} to={HUB_TOP} />
			{ENGINES.map((engine) => (
				<Wire
					from={{ x: HUB.x - HUB_HALF, y: engine.row.face }}
					key={engine.label}
					to={{ x: ENGINE_X + ENGINE_WIDTH / 2, y: engine.row.y }}
				/>
			))}
			{RESOURCES.map(({ label, row }, index) => {
				const from = { x: HUB.x + HUB_HALF, y: row.face };
				const to = { x: RESOURCE_X - RESOURCE_WIDTH / 2, y: row.y };
				return (
					<g key={label}>
						<Wire from={from} to={to} />
						<Packet delay={index * 0.6} from={from} loop to={to} />
					</g>
				);
			})}

			<Chip label="task" width={48} x={HUB.x} y={22} />

			{ENGINES.map((engine) => (
				<g key={engine.label}>
					<Chip
						label={engine.label}
						width={ENGINE_WIDTH}
						x={ENGINE_X}
						y={engine.row.y}
					/>
					{engine.bound ? (
						<rect
							className={styles.bound}
							height={20}
							rx={10}
							width={ENGINE_WIDTH}
							x={ENGINE_X - ENGINE_WIDTH / 2}
							y={engine.row.y - 10}
						/>
					) : null}
				</g>
			))}

			{RESOURCES.map(({ label, row }) => (
				<Chip
					key={label}
					label={label}
					width={RESOURCE_WIDTH}
					x={RESOURCE_X}
					y={row.y}
				/>
			))}
			<g transform={`translate(${RESOURCE_X + 21} ${LAST_ROW.y})`}>
				<Check className={styles.commit} />
			</g>

			<circle className={styles.ring} cx={HUB.x} cy={HUB.y} r={32} />
			<rect
				className={styles.hub}
				height={HUB_HALF * 2}
				rx={12}
				width={HUB_HALF * 2}
				x={HUB.x - HUB_HALF}
				y={HUB.y - HUB_HALF}
			/>
			<Label x={HUB.x} y={HUB.y}>
				core
			</Label>

			<Packet className={styles.task} from={TASK_OUT} to={HUB_TOP} />
			{ENGINES.filter((engine) => engine.bound).map((engine) => {
				const face = { x: HUB.x - HUB_HALF, y: engine.row.face };
				const edge = { x: ENGINE_X + ENGINE_WIDTH / 2, y: engine.row.y };
				return (
					<Packet
						className={styles.sub}
						from={face}
						key={engine.label}
						parked
						radius={4}
						to={along(face, edge, 0.72)}
					/>
				);
			})}
		</SceneCanvas>
	);
}
