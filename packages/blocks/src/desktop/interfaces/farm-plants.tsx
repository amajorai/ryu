import type { CSSProperties, ReactNode } from "react";
import {
	type CropStage,
	cropHeight,
	type FruitKind,
	GROWING_SCALE,
} from "./farm-model.ts";
import { fm } from "./farm-palette.ts";

/**
 * Crop art. Every plant stands with its stem at (0, 0) and grows upward, so
 * a slot only has to translate it. One drawing per fruit covers the growing
 * and ripe stages through a look (leaf and fruit colors, whether fruit hangs
 * yet); each fruit has its own wilted drawing for a failed run; seeds and
 * fallow ground are shared by every fruit.
 */

interface Look {
	fruit: string;
	fruitLight: string;
	leaf: string;
	leafDark: string;
	/** 0 = blossoms only, 1 = full fruit. */
	ripeness: number;
}

const FRUIT_COLORS: Record<FruitKind, [string, string]> = {
	apple: ["apple", "apple-light"],
	blueberry: ["blueberry", "blueberry-light"],
	grapes: ["grape", "grape-light"],
	pumpkin: ["pumpkin", "pumpkin-light"],
	strawberry: ["strawberry", "apple-light"],
	tomato: ["tomato", "tomato-light"],
};

function lookFor(fruit: FruitKind, stage: CropStage): Look {
	const [main, light] = FRUIT_COLORS[fruit];
	if (stage === "ripe") {
		return {
			fruit: fm(main),
			fruitLight: fm(light),
			leaf: fm("leaf"),
			leafDark: fm("leaf-dark"),
			ripeness: 1,
		};
	}
	return {
		fruit: fm("leaf-light"),
		fruitLight: fm("grass-light"),
		leaf: fm("leaf"),
		leafDark: fm("leaf-dark"),
		ripeness: 0,
	};
}

/** Small white five-petal blossom, for plants that have not fruited yet. */
function Blossom({ x, y }: { x: number; y: number }) {
	return (
		<g transform={`translate(${x} ${y})`}>
			<circle fill={fm("blossom")} r={2.6} />
			<circle fill={fm("flower-b")} r={1} />
		</g>
	);
}

function Strawberry({ look }: { look: Look }) {
	const berries: [number, number][] = [
		[-12, -6],
		[11, -6],
		[0, -3],
		[-3, -16],
	];
	return (
		<g>
			<ellipse cx={-8} cy={-14} fill={look.leafDark} rx={11} ry={8} />
			<ellipse cx={8} cy={-15} fill={look.leafDark} rx={11} ry={8} />
			<ellipse cx={0} cy={-20} fill={look.leaf} rx={10} ry={8} />
			<ellipse cx={-11} cy={-10} fill={look.leaf} rx={7} ry={5} />
			<ellipse cx={11} cy={-10} fill={look.leaf} rx={7} ry={5} />
			{berries.map(([bx, by]) =>
				look.ripeness > 0 ? (
					<g
						key={`${bx}:${by}`}
						transform={`translate(${bx} ${by}) scale(1.35)`}
					>
						<path
							d="M-4.5 -3 Q0 -5 4.5 -3 Q4 3 0 6 Q-4 3 -4.5 -3 Z"
							fill={look.fruit}
						/>
						<circle cx={-1.6} cy={0} fill={fm("strawberry-seed")} r={0.6} />
						<circle cx={1.6} cy={0.6} fill={fm("strawberry-seed")} r={0.6} />
						<circle cx={0} cy={2.8} fill={fm("strawberry-seed")} r={0.6} />
						<path
							d="M-3.5 -3.6 L0 -2 L3.5 -3.6 L0 -5.4 Z"
							fill={look.leafDark}
						/>
					</g>
				) : (
					<Blossom key={`${bx}:${by}`} x={bx} y={by - 4} />
				)
			)}
		</g>
	);
}

function Tomato({ look }: { look: Look }) {
	const fruit: [number, number][] = [
		[-7, -14],
		[6, -22],
		[-5, -32],
		[8, -9],
	];
	return (
		<g>
			<rect
				fill={fm("trunk")}
				height={46}
				rx={1.5}
				width={3}
				x={-1.5}
				y={-46}
			/>
			<path
				d="M0 0 Q-6 -12 -2 -24 Q4 -36 0 -44"
				fill="none"
				stroke={look.leafDark}
				strokeLinecap="round"
				strokeWidth={2.4}
			/>
			<ellipse cx={-9} cy={-20} fill={look.leafDark} rx={8} ry={5} />
			<ellipse cx={9} cy={-28} fill={look.leafDark} rx={8} ry={5} />
			<ellipse cx={-8} cy={-38} fill={look.leaf} rx={7} ry={4.5} />
			<ellipse cx={8} cy={-14} fill={look.leaf} rx={8} ry={5} />
			<ellipse cx={6} cy={-40} fill={look.leaf} rx={6} ry={4} />
			{fruit.map(([fx, fy], index) =>
				look.ripeness > 0 || index < 2 ? (
					<g key={`${fx}:${fy}`} transform={`translate(${fx} ${fy})`}>
						<circle fill={look.fruit} r={look.ripeness > 0 ? 6 : 3.2} />
						{look.ripeness > 0 ? (
							<circle cx={-2} cy={-2} fill={look.fruitLight} r={1.8} />
						) : null}
						<path
							d="M-2.4 -4.2 L0 -3 L2.4 -4.2 L0 -5.6 Z"
							fill={look.leafDark}
						/>
					</g>
				) : (
					<Blossom key={`${fx}:${fy}`} x={fx} y={fy} />
				)
			)}
		</g>
	);
}

function AppleTree({ look }: { look: Look }) {
	const apples: [number, number][] = [
		[-11, -38],
		[3, -52],
		[12, -36],
		[-1, -30],
	];
	return (
		<g>
			<path d="M-3.5 0 L-2.5 -26 L2.5 -26 L3.5 0 Z" fill={fm("trunk")} />
			<path d="M0 0 L0.5 -24 L2.5 -26 L3.5 0 Z" fill={fm("trunk-dark")} />
			<circle cx={-10} cy={-36} fill={look.leafDark} r={14} />
			<circle cx={11} cy={-38} fill={look.leafDark} r={13} />
			<circle cx={0} cy={-46} fill={look.leaf} r={16} />
			<circle cx={-9} cy={-40} fill={look.leaf} r={10} />
			<circle cx={-5} cy={-52} fill={fm("leaf-light")} opacity={0.7} r={6} />
			{apples.map(([ax, ay]) =>
				look.ripeness > 0 ? (
					<g key={`${ax}:${ay}`} transform={`translate(${ax} ${ay})`}>
						<circle fill={look.fruit} r={5.2} />
						<circle cx={-1.6} cy={-1.6} fill={look.fruitLight} r={1.6} />
						<path
							d="M0 -5 L1 -7.5"
							stroke={fm("trunk-dark")}
							strokeLinecap="round"
							strokeWidth={1.2}
						/>
					</g>
				) : (
					<Blossom key={`${ax}:${ay}`} x={ax} y={ay} />
				)
			)}
		</g>
	);
}

function Pumpkin({ look }: { look: Look }) {
	const size = look.ripeness > 0 ? 1 : 0.5;
	return (
		<g>
			<path
				d="M-18 -2 Q-10 -10 0 -6 Q10 -12 18 -3"
				fill="none"
				stroke={look.leafDark}
				strokeLinecap="round"
				strokeWidth={2}
			/>
			<ellipse cx={-14} cy={-10} fill={look.leafDark} rx={8} ry={6} />
			<ellipse cx={14} cy={-11} fill={look.leaf} rx={8} ry={6} />
			<ellipse cx={-8} cy={-17} fill={look.leaf} rx={6} ry={5} />
			<g transform={`translate(1 -1) scale(${size})`}>
				<ellipse cx={-7} cy={-9} fill={look.fruit} rx={8} ry={9} />
				<ellipse cx={7} cy={-9} fill={look.fruit} rx={8} ry={9} />
				<ellipse cx={0} cy={-9} fill={look.fruitLight} rx={7} ry={10} />
				<path
					d="M0 -19 Q-1 -23 2 -25"
					fill="none"
					stroke={fm("trunk-dark")}
					strokeLinecap="round"
					strokeWidth={2.4}
				/>
			</g>
		</g>
	);
}

function Grapes({ look }: { look: Look }) {
	const bunch = (bx: number, by: number) => {
		const berries: [number, number][] = [
			[-3, 0],
			[3, 0],
			[0, 4],
			[-5.5, -4],
			[0, -4],
			[5.5, -4],
			[-3, 8],
			[3, 8],
			[0, 12],
		];
		const r = look.ripeness > 0 ? 2.8 : 1.8;
		const scale = look.ripeness > 0 ? 1 : 0.6;
		return (
			<g
				key={`${bx}:${by}`}
				transform={`translate(${bx} ${by}) scale(${scale})`}
			>
				{berries.map(([x, y]) => (
					<circle cx={x} cy={y} fill={look.fruit} key={`${x}:${y}`} r={r} />
				))}
				{look.ripeness > 0 ? (
					<circle cx={-1} cy={-5} fill={look.fruitLight} r={1} />
				) : null}
			</g>
		);
	};
	return (
		<g>
			<rect fill={fm("trunk")} height={46} rx={1.5} width={3} x={-21} y={-46} />
			<rect fill={fm("trunk")} height={46} rx={1.5} width={3} x={18} y={-46} />
			<rect
				fill={fm("trunk-dark")}
				height={3}
				rx={1.5}
				width={44}
				x={-22}
				y={-44}
			/>
			<ellipse cx={-12} cy={-44} fill={look.leafDark} rx={9} ry={6} />
			<ellipse cx={4} cy={-46} fill={look.leaf} rx={10} ry={6} />
			<ellipse cx={15} cy={-42} fill={look.leafDark} rx={7} ry={5} />
			<ellipse cx={-4} cy={-40} fill={look.leaf} rx={7} ry={4.5} />
			{bunch(-9, -33)}
			{bunch(8, -32)}
		</g>
	);
}

function Blueberry({ look }: { look: Look }) {
	const berries: [number, number][] = [
		[-11, -12],
		[-5, -23],
		[3, -13],
		[10, -22],
		[12, -10],
	];
	return (
		<g>
			<circle cx={-9} cy={-13} fill={look.leafDark} r={12} />
			<circle cx={9} cy={-14} fill={look.leafDark} r={12} />
			<circle cx={0} cy={-22} fill={look.leaf} r={12} />
			<circle cx={-6} cy={-16} fill={look.leaf} r={8} />
			{berries.map(([bx, by]) =>
				look.ripeness > 0 ? (
					<g key={`${bx}:${by}`}>
						<circle cx={bx} cy={by} fill={look.fruit} r={4} />
						<circle
							cx={bx - 1.2}
							cy={by - 1.2}
							fill={look.fruitLight}
							r={1.2}
						/>
					</g>
				) : (
					<Blossom key={`${bx}:${by}`} x={bx} y={by} />
				)
			)}
		</g>
	);
}

// ---------------------------------------------------------------------------
// Withered: each fruit's own plant, wilted. Stems bend over, leaves hang
// limp, and dried fruit lies at the base, all in low-chroma browns that sit
// darker than any healthy green, by day and by night.
// ---------------------------------------------------------------------------

const WILT_STROKE = {
	stroke: fm("wither-edge"),
	strokeLinejoin: "round",
	strokeWidth: 1,
} as const;

/** A limp leaf hanging from (x, y), tipped `angle` degrees off straight down. */
function LimpLeaf({
	angle,
	dark = false,
	length = 12,
	x,
	y,
}: {
	angle: number;
	dark?: boolean;
	length?: number;
	x: number;
	y: number;
}) {
	const half = length * 0.5;
	return (
		<path
			d={`M0 0 Q${half} ${length * 0.45} 0 ${length} Q${-half} ${length * 0.45} 0 0 Z`}
			fill={fm(dark ? "wither-dark" : "wither")}
			transform={`translate(${x} ${y}) rotate(${angle})`}
			{...WILT_STROKE}
		/>
	);
}

/** A shrivelled fruit, fallen or still hanging: the fruit's shape, wrinkled. */
function DriedFruit({
	fruit,
	size = 1,
	x,
	y,
}: {
	fruit: FruitKind;
	size?: number;
	x: number;
	y: number;
}) {
	let body = <ellipse fill={fm("wither-fruit")} rx={4.2} ry={3.2} />;
	if (fruit === "strawberry") {
		body = (
			<path
				d="M-4 -2 Q0 -4 4 -2 Q3.4 2.6 0 4.6 Q-3.4 2.6 -4 -2 Z"
				fill={fm("wither-fruit")}
			/>
		);
	} else if (fruit === "pumpkin") {
		body = <ellipse fill={fm("wither-fruit")} rx={7} ry={3.6} />;
	} else if (fruit === "grapes" || fruit === "blueberry") {
		body = (
			<g fill={fm("wither-fruit")}>
				<circle cx={-2.4} cy={0} r={2.2} />
				<circle cx={2.2} cy={0.4} r={2.2} />
				<circle cx={0} cy={-2.4} r={2.2} />
			</g>
		);
	}
	return (
		<g transform={`translate(${x} ${y}) scale(${size})`} {...WILT_STROKE}>
			{body}
			<path
				d="M-1.8 -0.6 Q0 0.6 1.8 -0.4"
				fill="none"
				stroke={fm("wither-edge")}
				strokeLinecap="round"
				strokeWidth={0.8}
			/>
		</g>
	);
}

/** A bent stem: rises, then hooks over and droops. */
function BentStem({ d, width = 3 }: { d: string; width?: number }) {
	return (
		<>
			<path
				d={d}
				fill="none"
				stroke={fm("wither-edge")}
				strokeLinecap="round"
				strokeWidth={width + 2}
			/>
			<path
				d={d}
				fill="none"
				stroke={fm("wither")}
				strokeLinecap="round"
				strokeWidth={width}
			/>
		</>
	);
}

function WiltedTomato() {
	return (
		<g>
			<rect
				fill={fm("trunk")}
				height={36}
				rx={1.5}
				width={3}
				x={-9.5}
				y={-36}
				{...WILT_STROKE}
			/>
			<BentStem d="M0 0 Q-2 -16 1 -27 Q5 -38 14 -33 Q19 -29 18 -20" />
			<LimpLeaf angle={42} dark x={-1} y={-9} />
			<LimpLeaf angle={-36} x={1} y={-17} />
			<LimpLeaf angle={30} x={0} y={-26} />
			<LimpLeaf angle={-10} dark length={11} x={7} y={-35} />
			<LimpLeaf angle={-30} length={11} x={15} y={-31} />
			<DriedFruit fruit="tomato" size={0.9} x={18} y={-17} />
			<DriedFruit fruit="tomato" x={-11} y={-1} />
			<DriedFruit fruit="tomato" size={0.85} x={9} y={1} />
		</g>
	);
}

function WiltedStrawberry() {
	return (
		<g>
			<BentStem d="M0 -1 Q-6 -14 -14 -10 Q-18 -7 -18 -3" width={1.8} />
			<BentStem d="M0 -1 Q5 -16 13 -12 Q17 -9 17 -4" width={1.8} />
			<BentStem d="M0 -1 Q1 -14 -2 -18" width={1.8} />
			<LimpLeaf angle={60} dark length={10} x={-15} y={-9} />
			<LimpLeaf angle={-60} length={10} x={14} y={-11} />
			<LimpLeaf angle={14} length={9} x={-2} y={-18} />
			<DriedFruit fruit="strawberry" x={-8} y={0} />
			<DriedFruit fruit="strawberry" size={0.85} x={7} y={1} />
		</g>
	);
}

function WiltedApple() {
	return (
		<g>
			<path
				d="M-3 0 L-2 -26 L-12 -38 M-2 -26 L1 -46 M0 -32 L12 -40 M1 -46 L-6 -52 M1 -46 L8 -52"
				fill="none"
				stroke={fm("wither-edge")}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={4.6}
			/>
			<path
				d="M-3 0 L-2 -26 L-12 -38 M-2 -26 L1 -46 M0 -32 L12 -40 M1 -46 L-6 -52 M1 -46 L8 -52"
				fill="none"
				stroke={fm("trunk")}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={2.6}
			/>
			<path
				d="M-3.5 0 L-2.5 -24 L2 -24 L3 0 Z"
				fill={fm("trunk")}
				{...WILT_STROKE}
			/>
			<LimpLeaf angle={10} dark x={-12} y={-38} />
			<LimpLeaf angle={-14} x={12} y={-40} />
			<LimpLeaf angle={6} length={8} x={-6} y={-52} />
			<LimpLeaf angle={-20} dark length={8} x={8} y={-52} />
			<DriedFruit fruit="apple" x={-12} y={0} />
			<DriedFruit fruit="apple" size={0.9} x={11} y={1} />
		</g>
	);
}

function WiltedPumpkin() {
	return (
		<g>
			<BentStem d="M-19 -1 Q-10 -6 0 -3 Q10 -7 19 -1" width={2} />
			<path
				d="M-16 -3 Q-20 -10 -12 -11 Q-6 -10 -8 -3 Z"
				fill={fm("wither-dark")}
				{...WILT_STROKE}
			/>
			<path
				d="M10 -3 Q8 -11 15 -11 Q21 -9 18 -2 Z"
				fill={fm("wither")}
				{...WILT_STROKE}
			/>
			<DriedFruit fruit="pumpkin" size={1.2} x={1} y={-3} />
			<path
				d="M1 -7 Q0 -11 3 -12"
				fill="none"
				stroke={fm("wither-edge")}
				strokeLinecap="round"
				strokeWidth={2}
			/>
		</g>
	);
}

function WiltedGrapes() {
	return (
		<g {...WILT_STROKE}>
			<rect fill={fm("trunk")} height={42} rx={1.5} width={3} x={-21} y={-42} />
			<rect fill={fm("trunk")} height={42} rx={1.5} width={3} x={18} y={-42} />
			<rect
				fill={fm("trunk-dark")}
				height={3}
				rx={1.5}
				width={44}
				x={-22}
				y={-41}
			/>
			<LimpLeaf angle={14} dark length={11} x={-14} y={-39} />
			<LimpLeaf angle={-6} length={12} x={-3} y={-39} />
			<LimpLeaf angle={18} dark length={10} x={9} y={-39} />
			<LimpLeaf angle={-16} length={10} x={16} y={-39} />
			<DriedFruit fruit="grapes" size={0.9} x={-8} y={-24} />
			<DriedFruit fruit="grapes" size={0.9} x={4} y={0} />
			<DriedFruit fruit="grapes" size={0.75} x={-10} y={1} />
		</g>
	);
}

function WiltedBlueberry() {
	return (
		<g>
			<BentStem d="M0 0 Q-4 -14 -12 -18 Q-17 -19 -18 -12" width={2} />
			<BentStem d="M0 0 Q3 -16 11 -20 Q17 -21 18 -14" width={2} />
			<BentStem d="M0 0 Q0 -14 2 -22" width={2} />
			<LimpLeaf angle={8} dark x={-12} y={-18} />
			<LimpLeaf angle={-10} x={11} y={-20} />
			<LimpLeaf angle={-24} length={8} x={2} y={-22} />
			<LimpLeaf angle={24} dark length={8} x={-5} y={-12} />
			<DriedFruit fruit="blueberry" x={-9} y={0} />
			<DriedFruit fruit="blueberry" size={0.85} x={9} y={1} />
		</g>
	);
}

const WILTED: Record<FruitKind, () => ReactNode> = {
	apple: WiltedApple,
	blueberry: WiltedBlueberry,
	grapes: WiltedGrapes,
	pumpkin: WiltedPumpkin,
	strawberry: WiltedStrawberry,
	tomato: WiltedTomato,
};

const DRAW: Record<FruitKind, (props: { look: Look }) => ReactNode> = {
	apple: AppleTree,
	blueberry: Blueberry,
	grapes: Grapes,
	pumpkin: Pumpkin,
	strawberry: Strawberry,
	tomato: Tomato,
};

/** How much larger crops are drawn in the farm's beds than in list glyphs. */
export const BED_PLANT_SCALE = 1.5;

/** Every sparkle is this size, in plant units. */
const SPARKLE_SIZE = 4;

/** A four-point sparkle, for ripe crops. */
function Sparkle({ delay, x, y }: { delay: number; x: number; y: number }) {
	const size = SPARKLE_SIZE;
	const style: CSSProperties = { animationDelay: `${delay}s` };
	return (
		<g transform={`translate(${x} ${y})`}>
			<path
				className="fm-twinkle"
				d={`M0 ${-size} Q0.6 -0.6 ${size} 0 Q0.6 0.6 0 ${size} Q-0.6 0.6 ${-size} 0 Q-0.6 -0.6 0 ${-size} Z`}
				fill={fm("sparkle")}
				stroke={fm("sparkle-edge")}
				strokeLinejoin="round"
				strokeWidth={0.7}
				style={style}
			/>
		</g>
	);
}

/** Planting hole with a sprout and a water drop: you wrote, the agent is next. */
function Seedling() {
	return (
		<g>
			<ellipse cx={0} cy={0} fill={fm("soil-dark")} rx={12} ry={4.5} />
			<ellipse cx={0} cy={-1} fill={fm("soil-light")} rx={9} ry={3} />
			<path
				d="M0 -1 L0 -9"
				stroke={fm("stem")}
				strokeLinecap="round"
				strokeWidth={1.8}
			/>
			<ellipse
				cx={-4}
				cy={-10}
				fill={fm("leaf-light")}
				rx={4.2}
				ry={2.2}
				transform="rotate(-25 -4 -10)"
			/>
			<ellipse
				cx={4}
				cy={-11}
				fill={fm("leaf")}
				rx={4.2}
				ry={2.2}
				transform="rotate(25 4 -11)"
			/>
		</g>
	);
}

function Fallow() {
	return (
		<g>
			<ellipse cx={0} cy={-1} fill={fm("soil-dark")} rx={14} ry={5} />
			<ellipse cx={0} cy={-3} fill={fm("soil")} rx={11} ry={4} />
			<path
				d="M-7 -3 L-3 -7 M-1 -3 L2 -8 M4 -3 L8 -6"
				stroke={fm("hay-dark")}
				strokeLinecap="round"
				strokeWidth={1.4}
			/>
		</g>
	);
}

/**
 * What a stage draws on the ground, under the plant: the growth gauge
 * circling a working plant's mound, a blighted patch under a withered one.
 * Ripe fruit needs no ground mark; its sparkles say it.
 */
function GroundMark({ stage }: { stage: CropStage }) {
	if (stage === "growing") {
		return (
			<g>
				<ellipse
					cx={0}
					cy={1}
					fill="none"
					rx={20}
					ry={7}
					stroke={fm("gauge-track")}
					strokeWidth={2}
				/>
				<ellipse
					className="fm-orbit"
					cx={0}
					cy={1}
					fill="none"
					pathLength={100}
					rx={20}
					ry={7}
					stroke={fm("gauge")}
					strokeDasharray="28 72"
					strokeLinecap="round"
					strokeWidth={2}
				/>
			</g>
		);
	}
	if (stage === "withered") {
		return (
			<ellipse
				cx={0}
				cy={1}
				fill={fm("blight")}
				opacity={0.45}
				rx={18}
				ry={5.5}
			/>
		);
	}
	return null;
}

/** The status mark over or beside a plant, sized to read at a glance. */
function Marker({ stage, top }: { stage: CropStage; top: number }) {
	if (stage === "seed") {
		return (
			<g className="fm-drip" transform="translate(12 -20) scale(0.85)">
				<path
					d="M0 -9 Q6 -1 6 3 A6 6 0 0 1 -6 3 Q-6 -1 0 -9 Z"
					fill={fm("droplet")}
				/>
				<ellipse cx={-2} cy={2} fill={fm("droplet-light")} rx={1.6} ry={2.4} />
			</g>
		);
	}
	if (stage === "withered") {
		// A garden label on a stake, the way a farmer marks a failed crop.
		return (
			<g transform="translate(17 2)">
				<rect
					fill={fm("trunk-dark")}
					height={20}
					rx={0.8}
					width={1.6}
					x={-0.8}
					y={-20}
				/>
				<path
					d="M-6 -31 L6 -31 L6 -20 L0 -17 L-6 -20 Z"
					fill={fm("tag")}
					stroke={fm("tag-edge")}
					strokeLinejoin="round"
					strokeWidth={0.8}
				/>
				<rect
					fill={fm("tag-ink")}
					height={5.2}
					rx={0.6}
					width={1.8}
					x={-0.9}
					y={-29}
				/>
				<circle cx={0} cy={-21.6} fill={fm("tag-ink")} r={1} />
			</g>
		);
	}
	if (stage === "ripe") {
		return (
			<g>
				<Sparkle delay={0} x={-17} y={-top + 4} />
				<Sparkle delay={1.1} x={17} y={-top + 12} />
			</g>
		);
	}
	return null;
}

/** One crop in a bed slot, stem at (x, y). */
export function Plant({
	fruit,
	marker = true,
	size = 1,
	stage,
	x,
	y,
}: {
	fruit: FruitKind;
	/** False drops the floating status mark (list glyphs). */
	marker?: boolean;
	/** Drawing scale (beds plant at `BED_PLANT_SCALE`). */
	size?: number;
	stage: CropStage;
	x: number;
	y: number;
}) {
	if (stage === "seed" || stage === "fallow") {
		return (
			<g transform={`translate(${x} ${y}) scale(${size})`}>
				{stage === "seed" ? <Seedling /> : <Fallow />}
				{marker ? <Marker stage={stage} top={12} /> : null}
			</g>
		);
	}
	const top = cropHeight({ fruit, stage });
	if (stage === "withered") {
		const Wilted = WILTED[fruit];
		return (
			<g transform={`translate(${x} ${y}) scale(${size})`}>
				{marker ? <GroundMark stage={stage} /> : null}
				<Wilted />
				{marker ? <Marker stage={stage} top={top} /> : null}
			</g>
		);
	}
	const Draw = DRAW[fruit];
	const look = lookFor(fruit, stage);
	const scale = stage === "growing" ? GROWING_SCALE : 1;
	return (
		<g transform={`translate(${x} ${y}) scale(${size})`}>
			{marker ? <GroundMark stage={stage} /> : null}
			<ellipse cx={0} cy={1} fill={fm("shade")} opacity={0.18} rx={17} ry={4} />
			<g className={stage === "growing" ? "fm-sway" : undefined}>
				<g transform={`scale(${scale})`}>
					<Draw look={look} />
				</g>
			</g>
			{marker ? <Marker stage={stage} top={top} /> : null}
		</g>
	);
}

/**
 * How tall a plant's list glyph is drawn, in plant units: the ripe height
 * for standing plants, a lower one for a wilted plant, a mound for seeds.
 */
function glyphHeight(fruit: FruitKind, stage: CropStage): number {
	if (stage === "seed" || stage === "fallow") {
		return 16;
	}
	if (stage === "withered") {
		return fruit === "apple" ? 54 : 40;
	}
	return cropHeight({ fruit, stage });
}

/**
 * A plant on its own, for list rows and the ledger header. Every glyph is
 * framed the same way: a square at least as wide as the widest plant, with
 * its stem on one baseline, so a column of glyphs lines up.
 */
export function PlantGlyph({
	className,
	fruit,
	stage,
}: {
	className?: string;
	fruit: FruitKind;
	stage: CropStage;
}) {
	const low = stage === "seed" || stage === "fallow";
	const side = low ? 32 : Math.max(46, glyphHeight(fruit, stage) + 8);
	const baseline = Math.round(side * 0.1);
	return (
		<svg
			aria-hidden="true"
			className={className}
			focusable="false"
			viewBox={`${-side / 2} ${baseline - side} ${side} ${side}`}
		>
			<Plant fruit={fruit} marker={false} stage={stage} x={0} y={0} />
		</svg>
	);
}
