import { Stage } from "../iso/kit/react/live.tsx";
import { Scene } from "./scene.tsx";
import styles from "./sdk.module.css";

/**
 * Homepage card scene for the Ryu SDK: code becomes an agent. Each TypeScript
 * line on the left materialises its part of a running system on the right
 * (the agent, a model reached through the Gateway, a tool over MCP, a skill),
 * and once the code is complete a request runs through the Gateway and back.
 *
 * The markup is the finished, reduced-motion pose. `sdk.module.css` adds the
 * build-and-run loop only while the card is in view and motion is allowed, so
 * the server render, offscreen cards and still viewers all see the full graph.
 */

/** Line centres for the four keyword lines, 22 units apart below the prompt. */
const CODE_LINES = [
	{ bar: 62, className: styles.line2, keyword: "agent", y: 56 },
	{ bar: 54, className: styles.line3, keyword: "model", y: 78 },
	{ bar: 68, className: styles.line4, keyword: "tool", y: 100 },
	{ bar: 50, className: styles.line5, keyword: "skill", y: 122 },
] as const;

const MODEL_EDGE = "M244 66 L272 42";
const MCP_EDGE = "M231 94 V127 Q231 137 220 137";
const SKILL_EDGE = "M252 84 H268 Q278 84 278 94 V124";

function CodePanel() {
	return (
		<g>
			<rect
				className={styles.panel}
				height={146}
				rx={6}
				width={140}
				x={12}
				y={12}
			/>
			<rect
				className={styles.cursor}
				height={14}
				rx={3}
				width={132}
				x={16}
				y={27}
			/>
			<text className={styles.prompt} dominantBaseline="central" x={22} y={34}>
				$ create-ryu-app
			</text>
			<rect className={styles.caret} height={9} width={4} x={107} y={29.5} />
			<g className={styles.reset}>
				{CODE_LINES.map((line) => (
					<g className={line.className} key={line.keyword}>
						<text
							className={styles.keyword}
							dominantBaseline="central"
							x={22}
							y={line.y}
						>
							{line.keyword}
						</text>
						<rect
							className={styles.bar}
							height={4}
							rx={2}
							width={line.bar}
							x={54}
							y={line.y - 2}
						/>
					</g>
				))}
			</g>
		</g>
	);
}

function Chip({
	className,
	label,
	width,
	x,
	y,
}: {
	className: string;
	label: string;
	width: number;
	x: number;
	y: number;
}) {
	return (
		<g className={className}>
			<rect
				className={styles.chip}
				height={18}
				rx={9}
				width={width}
				x={x}
				y={y}
			/>
			<text
				className={styles.chipText}
				dominantBaseline="central"
				textAnchor="middle"
				x={x + width / 2}
				y={y + 9}
			>
				{label}
			</text>
		</g>
	);
}

function SystemGraph() {
	return (
		<g className={styles.reset}>
			<path
				className={`${styles.edge} ${styles.modelEdge}`}
				d={MODEL_EDGE}
				pathLength={100}
			/>
			<path
				className={`${styles.edge} ${styles.mcpEdge}`}
				d={MCP_EDGE}
				pathLength={100}
			/>
			<path
				className={`${styles.edge} ${styles.skillEdge}`}
				d={SKILL_EDGE}
				pathLength={100}
			/>
			<g className={styles.gateway}>
				<path
					className={styles.diamond}
					d="M258 50 L262 54 L258 58 L254 54 Z"
				/>
			</g>
			<path className={styles.packet} d={MODEL_EDGE} pathLength={100} />
			<g className={styles.agent}>
				<rect
					className={styles.node}
					height={28}
					rx={8}
					width={28}
					x={224}
					y={66}
				/>
				<circle className={styles.ink} cx={234} cy={79} r={1.6} />
				<circle className={styles.ink} cx={242} cy={79} r={1.6} />
			</g>
			<Chip className={styles.model} label="model" width={44} x={258} y={24} />
			<Chip className={styles.mcp} label="mcp" width={34} x={176} y={128} />
			<g className={styles.plug}>
				<rect
					className={styles.ink}
					height={7}
					rx={1}
					width={5}
					x={215}
					y={133.5}
				/>
				<path className={styles.prongs} d="M211 135.5 H215 M211 138.5 H215" />
			</g>
			<g className={styles.skill}>
				<path className={styles.sheet} d="M270 124 H281 L286 129 V144 H270 Z" />
				<path className={styles.fold} d="M281 124 V129 H286" />
				<path
					className={styles.fold}
					d="M273 133 H283 M273 136.5 H281 M273 140 H282"
				/>
			</g>
		</g>
	);
}

export function SdkScene() {
	return (
		<Scene id="sdk">
			<Stage
				className={`${styles.stage} absolute inset-x-0 top-0 flex justify-center px-2 pt-2`}
			>
				<svg
					aria-hidden="true"
					className="h-auto max-h-44 w-full"
					focusable="false"
					preserveAspectRatio="xMidYMin meet"
					viewBox="0 0 320 172"
				>
					<CodePanel />
					<SystemGraph />
				</svg>
			</Stage>
		</Scene>
	);
}
