import { cn } from "@ryu/ui/lib/utils";
import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./core.module.css";
import { Scene } from "./scene.tsx";

/**
 * Ryu Core's homepage card: the orchestration map. A task drops into the hub,
 * Core spawns two sub-agents and binds them to engines, dispatches work to
 * MCP tools, memory and git, collects the results, and lands a commit.
 *
 * Deliberately not a "use client" module: the markup is the still frame
 * (mid-orchestration), server rendered with no random value or Date, so the
 * server render, reduced motion and hydration all agree. CSS keyframes in
 * `core.module.css` play the 10s loop only while `Stage` marks the card in view.
 */

interface Engine {
	/** Whether a sub-agent binds to this engine during the loop. */
	readonly bound: boolean;
	readonly label: string;
	/** Where the wire leaves the hub's left face. */
	readonly wireY: number;
	readonly y: number;
}

const ENGINES: readonly Engine[] = [
	{ bound: true, label: "claude code", wireY: 74, y: 30 },
	{ bound: true, label: "codex", wireY: 82, y: 62 },
	{ bound: false, label: "gemini", wireY: 90, y: 94 },
	{ bound: false, label: "openai", wireY: 98, y: 126 },
];

const RESOURCES = [
	{ label: "mcp", wireY: 77, y: 38 },
	{ label: "memory", wireY: 85, y: 78 },
	{ label: "git", wireY: 93, y: 118 },
] as const;

const CHIP_HEIGHT = 18;
const ENGINE_X = 10;
const ENGINE_WIDTH = 84;
const RESOURCE_X = 234;
const RESOURCE_WIDTH = 76;
const HUB = { size: 46, x: 137, y: 62 } as const;
const HUB_CENTER = { x: HUB.x + HUB.size / 2, y: HUB.y + HUB.size / 2 };

/** Engine wires run from the hub's left face to each chip's right edge. */
function engineWire({ wireY, y }: Engine): string {
	const end = y + CHIP_HEIGHT / 2;
	const chipEdge = ENGINE_X + ENGINE_WIDTH;
	return `M${HUB.x} ${wireY}C${HUB.x - 21} ${wireY} ${chipEdge + 21} ${end} ${chipEdge} ${end}`;
}

/** Resource wires run from the hub's right face to each chip's left edge. */
function resourceWire({ wireY, y }: (typeof RESOURCES)[number]): string {
	const end = y + CHIP_HEIGHT / 2;
	const face = HUB.x + HUB.size;
	return `M${face} ${wireY}C${face + 26} ${wireY} ${RESOURCE_X - 26} ${end} ${RESOURCE_X} ${end}`;
}

/**
 * The two sub-agents, each tethered to the hub's top face and bridged to its
 * engine. They spawn out of the hub centre (160, 85) to (112, 30) and (208, 30).
 */
const SUBS = [
	{
		bridge: "M94 39C100 39 99 30 105 30",
		className: styles.subA,
		tether: "M117 35C128 38 146 48 150 62",
		x: 112,
	},
	{
		bridge: "M94 71C124 71 126 15 160 15C190 15 192 30 201 30",
		className: styles.subB,
		tether: "M203 35C192 38 174 48 170 62",
		x: 208,
	},
] as const;
const SUB_Y = 30;
const SUB_RADIUS = 7;

/** Staggers the dispatch to mcp, memory and git 0.8s apart. */
const DISPATCH_STEPS = ["", styles.step1, styles.step2] as const;

function Chip({
	className,
	label,
	width,
	x,
	y,
}: {
	className?: string;
	label: string;
	width: number;
	x: number;
	y: number;
}) {
	return (
		<g className={className}>
			<rect
				className={styles.chip}
				height={CHIP_HEIGHT}
				rx={CHIP_HEIGHT / 2}
				width={width}
				x={x}
				y={y}
			/>
			<text className={styles.label} x={x + 9} y={y + 11.8}>
				{label}
			</text>
		</g>
	);
}

/** The git chip's branch: two commits, plus the one Core lands each loop. */
function GitBranch() {
	const y = RESOURCES[2].y + CHIP_HEIGHT / 2;
	return (
		<g>
			<path className={styles.branch} d={`M260 ${y}H302`} />
			<circle className={styles.dot} cx={268} cy={y} r={2.2} />
			<circle className={styles.dot} cx={281} cy={y} r={2.2} />
			<circle className={styles.commitSettled} cx={294} cy={y} r={2.2} />
			<circle className={styles.commitNew} cx={294} cy={y} r={2.4} />
		</g>
	);
}

function Hub() {
	const { x, y } = HUB_CENTER;
	return (
		<g>
			<path className={styles.inlet} d={`M${x} 4V${HUB.y}`} />
			<rect
				className={styles.drop}
				height={6}
				rx={1.5}
				width={3}
				x={x - 1.5}
				y={4}
			/>
			<text className={styles.label} textAnchor="end" x={x - 5} y={9}>
				task
			</text>
			<rect
				className={styles.hub}
				height={HUB.size}
				rx={10}
				width={HUB.size}
				x={HUB.x}
				y={HUB.y}
			/>
			<circle className={styles.ring} cx={x} cy={y} r={14} />
			<circle className={styles.pulse} cx={x} cy={y} r={14} />
			<text
				className={cn(styles.label, styles.hubLabel)}
				textAnchor="middle"
				x={x}
				y={y + 2.6}
			>
				core
			</text>
			<g className={styles.tick}>
				<circle
					className={styles.tickBadge}
					cx={HUB.x + HUB.size}
					cy={HUB.y}
					r={6}
				/>
				<path
					className={styles.tickMark}
					d={`M${HUB.x + HUB.size - 2.6} ${HUB.y + 0.1}l1.9 1.9 3.4-3.6`}
				/>
			</g>
		</g>
	);
}

export function CoreProductScene() {
	return (
		<Scene id="core">
			<Stage
				className={cn(
					styles.root,
					"absolute inset-x-0 top-0 bottom-28 px-4 pt-5"
				)}
			>
				<svg
					aria-hidden="true"
					className={styles.svg}
					data-scene="core"
					focusable="false"
					preserveAspectRatio="xMidYMid meet"
					viewBox="4 0 312 150"
				>
					{ENGINES.map((engine) => (
						<path
							className={styles.wire}
							d={engineWire(engine)}
							key={engine.label}
							pathLength={100}
						/>
					))}
					{RESOURCES.map((resource, index) => (
						<g key={resource.label}>
							<path
								className={styles.wire}
								d={resourceWire(resource)}
								pathLength={100}
							/>
							<path
								className={cn(styles.lit, DISPATCH_STEPS[index])}
								d={resourceWire(resource)}
								pathLength={100}
							/>
							<path
								className={cn(styles.packet, DISPATCH_STEPS[index])}
								d={resourceWire(resource)}
								pathLength={100}
							/>
						</g>
					))}
					{SUBS.map((sub, index) => (
						<g key={sub.x}>
							<path className={styles.tether} d={sub.tether} pathLength={100} />
							<path
								className={cn(
									styles.packet,
									styles.returning,
									index > 0 && styles.later
								)}
								d={sub.tether}
								pathLength={100}
							/>
							<path
								className={cn(styles.bridge, index > 0 && styles.later)}
								d={sub.bridge}
								pathLength={100}
							/>
							<path
								className={cn(styles.march, index > 0 && styles.later)}
								d={sub.bridge}
								pathLength={100}
							/>
						</g>
					))}
					{ENGINES.map((engine) => (
						<Chip
							className={engine.bound ? styles.bound : styles.idle}
							key={engine.label}
							label={engine.label}
							width={ENGINE_WIDTH}
							x={ENGINE_X}
							y={engine.y}
						/>
					))}
					{RESOURCES.map((resource, index) => (
						<Chip
							className={cn(styles.resource, DISPATCH_STEPS[index])}
							key={resource.label}
							label={resource.label}
							width={RESOURCE_WIDTH}
							x={RESOURCE_X}
							y={resource.y}
						/>
					))}
					<GitBranch />
					<Hub />
					{SUBS.map((sub) => (
						<g className={cn(styles.sub, sub.className)} key={sub.x}>
							<circle
								className={styles.subBody}
								cx={sub.x}
								cy={SUB_Y}
								r={SUB_RADIUS}
							/>
							<circle className={styles.subCore} cx={sub.x} cy={SUB_Y} r={2} />
						</g>
					))}
				</svg>
			</Stage>
		</Scene>
	);
}
