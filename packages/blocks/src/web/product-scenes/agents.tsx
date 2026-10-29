import type { CSSProperties, ReactNode } from "react";
import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./agents.module.css";
import { Scene } from "./scene.tsx";

/**
 * The Agents card: an agent core with its parts plugged in. Chat, voice and
 * image models sit on the left; tools, memory and versioned instructions on the
 * right. Signal marches along every wire toward the core, the chat model is
 * swapped while the agent keeps running, and the instructions gain a new
 * version on top of the ones they keep. The server renders the still frame;
 * CSS animates it only while the card is in view (`Stage` marks that).
 */

type MotionStyle = CSSProperties & Record<`--${string}`, string>;

interface Part {
	/** Chip centre on the ellipse around the core. */
	cx: number;
	cy: number;
	glyph: ReactNode;
	label: string;
	/** Where the wire meets the core's nearest face. */
	toX: number;
	toY: number;
}

const CORE_X = 160;
const CORE_Y = 82;
const CHIP_WIDTH = 64;
const CHIP_HEIGHT = 18;
const HALF_CHIP = CHIP_WIDTH / 2;

const CIRCLE = <circle r={2} />;
const SQUARE = <rect height={3.6} width={3.6} x={-1.8} y={-1.8} />;
const TRIANGLE = <path d="M0 -2.2 L2 1.6 H-2 Z" />;
const DIAMOND = <path d="M0 -2.4 L2.4 0 L0 2.4 L-2.4 0 Z" />;
const WRENCH = (
	<g className={styles.outline}>
		<path d="M-1.9 1.9 L0.5 -0.5" />
		<circle cx={1.2} cy={-1.2} r={1.1} />
	</g>
);
const MEMORY = (
	<g className={styles.outline}>
		<ellipse cy={-1.5} rx={2.2} ry={0.8} />
		<ellipse rx={2.2} ry={0.8} />
		<ellipse cy={1.5} rx={2.2} ry={0.8} />
	</g>
);
const DOC_PATH = "M-1.75 -2.25 H0.75 L1.75 -1.25 V2.25 H-1.75 Z";

const CHAT: Part = {
	cx: 63,
	cy: 53,
	glyph: CIRCLE,
	label: "chat",
	toX: 142,
	toY: 74,
};
const LEFT_PARTS: readonly Part[] = [
	{ cx: 48, cy: 82, glyph: SQUARE, label: "voice", toX: 142, toY: 82 },
	{ cx: 63, cy: 111, glyph: TRIANGLE, label: "image", toX: 142, toY: 90 },
];
const RIGHT_PARTS: readonly Part[] = [
	{ cx: 257, cy: 53, glyph: WRENCH, label: "tools", toX: 178, toY: 74 },
	{ cx: 272, cy: 82, glyph: MEMORY, label: "memory", toX: 178, toY: 82 },
];
const INSTRUCTIONS: Part = {
	cx: 257,
	cy: 111,
	glyph: null,
	label: "instructions",
	toX: 178,
	toY: 90,
};

/** The chip edge a wire leaves from: its inner face, toward the core. */
const wireStart = (part: Part) =>
	part.cx < CORE_X ? part.cx + HALF_CHIP : part.cx - HALF_CHIP;

/** The outward unit step along the chat chip's radial, 10px long. */
const CHAT_LENGTH = Math.hypot(CHAT.cx - CORE_X, CHAT.cy - CORE_Y);
const CHAT_DX = (((CHAT.cx - CORE_X) / CHAT_LENGTH) * 10).toFixed(2);
const CHAT_DY = (((CHAT.cy - CORE_Y) / CHAT_LENGTH) * 10).toFixed(2);
const SWAP_STYLE: MotionStyle = {
	"--dx": `${CHAT_DX}px`,
	"--dy": `${CHAT_DY}px`,
};

function Wire({ index, part }: { index: number; part: Part }) {
	const d = `M${wireStart(part)} ${part.cy} L${part.toX} ${part.toY}`;
	const phase: MotionStyle = { "--i": String(index) };
	return (
		<g>
			<path className={styles.wire} d={d} />
			<path className={styles.flow} d={d} style={phase} />
			<circle className={styles.end} cx={part.toX} cy={part.toY} r={1.4} />
		</g>
	);
}

function Chip({
	children,
	glyph,
	label,
	labelX = -13,
}: {
	children?: ReactNode;
	glyph: ReactNode;
	label: string;
	labelX?: number;
}) {
	return (
		<g>
			<rect
				className={styles.chip}
				height={CHIP_HEIGHT}
				rx={9}
				width={CHIP_WIDTH}
				x={-HALF_CHIP}
				y={-CHIP_HEIGHT / 2}
			/>
			{glyph ? (
				<g className={styles.glyph} transform="translate(-21 0)">
					{glyph}
				</g>
			) : null}
			{children}
			<text className={styles.label} dominantBaseline="central" x={labelX}>
				{label}
			</text>
		</g>
	);
}

/** Three kept versions behind the live one, plus the version about to land. */
function DocStack() {
	const layers = [
		[styles.docBack, "6 -6"],
		[styles.docMid, "3 -3"],
		[styles.docFront, "0 0"],
		[styles.docNew, "0 0"],
	] as const;
	return (
		<g transform="translate(-22 0)">
			{layers.map(([className, at]) => (
				<g key={className} transform={`translate(${at})`}>
					<path className={`${styles.doc} ${className}`} d={DOC_PATH} />
				</g>
			))}
		</g>
	);
}

function ChatSwap() {
	const d = `M${wireStart(CHAT)} ${CHAT.cy} L${CHAT.toX} ${CHAT.toY}`;
	return (
		<g style={SWAP_STYLE}>
			<g className={styles.chatOld}>
				<Wire index={0} part={CHAT} />
				<g transform={`translate(${CHAT.cx} ${CHAT.cy})`}>
					<g className={styles.chipOut}>
						<Chip glyph={CIRCLE} label={CHAT.label} />
					</g>
				</g>
			</g>
			<g className={styles.chatNew}>
				<path className={styles.trace} d={d} pathLength={1} />
				<path
					className={`${styles.flow} ${styles.newFlow}`}
					d={d}
					style={{ "--i": "0" } as MotionStyle}
				/>
				<circle
					className={`${styles.end} ${styles.blink}`}
					cx={CHAT.toX}
					cy={CHAT.toY}
					r={1.4}
				/>
				<g transform={`translate(${CHAT.cx} ${CHAT.cy})`}>
					<g className={styles.chipIn}>
						<Chip glyph={DIAMOND} label={CHAT.label} />
					</g>
				</g>
			</g>
		</g>
	);
}

function AgentCore() {
	return (
		<g transform={`translate(${CORE_X} ${CORE_Y})`}>
			<circle className={styles.halo} r={27} />
			<rect
				className={styles.core}
				height={36}
				rx={10}
				width={36}
				x={-18}
				y={-18}
			/>
			<circle className={styles.dot} r={6} />
			<text
				className={styles.coreLabel}
				dominantBaseline="central"
				textAnchor="middle"
				y={34}
			>
				agent
			</text>
		</g>
	);
}

export function AgentsScene() {
	const parts = [...LEFT_PARTS, ...RIGHT_PARTS];
	return (
		<Scene id="agents">
			<Stage
				className={`${styles.stage} absolute inset-x-0 top-0 bottom-24 px-3 pt-3`}
			>
				<svg
					className="block h-full w-full overflow-visible"
					focusable="false"
					viewBox="4 32 312 96"
				>
					{parts.map((part, index) => (
						<Wire index={index + 1} key={part.label} part={part} />
					))}
					<Wire index={5} part={INSTRUCTIONS} />
					<ChatSwap />
					{parts.map((part) => (
						<g key={part.label} transform={`translate(${part.cx} ${part.cy})`}>
							<Chip glyph={part.glyph} label={part.label} />
						</g>
					))}
					<g transform={`translate(${INSTRUCTIONS.cx} ${INSTRUCTIONS.cy})`}>
						<Chip glyph={null} label={INSTRUCTIONS.label} labelX={-11}>
							<DocStack />
						</Chip>
					</g>
					<AgentCore />
				</svg>
			</Stage>
		</Scene>
	);
}
