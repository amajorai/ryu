import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./gateway.module.css";
import { Scene } from "./scene.tsx";

/**
 * Homepage card scene for Gateway: the checkpoint between an agent and
 * everything it calls. One call crosses three policy bars and routes to a
 * provider; the second call falls back when the first provider is down; the
 * third parks on the gate until you approve it. Every crossing writes an audit
 * tick, and the key vault stays on the gate side.
 *
 * The markup is the static pose (the call held for approval, the fallback
 * lit, three ticks written), which is what reduced-motion visitors see. The
 * module CSS animates the 7.2s loop with transforms and opacity only.
 */

interface Point {
	readonly x: number;
	readonly y: number;
}

const AGENT_EXIT: Point = { x: 58, y: 84 };
const GATE_ENTRY: Point = { x: 146, y: 84 };
const GATE_EXIT: Point = { x: 166, y: 84 };
const CHIP_X = 262;
const CHIP_WIDTH = 44;
const CHIP_HEIGHT = 18;

const PROVIDERS = [
	{ className: styles.providerTop, key: "primary", label: "model", y: 34 },
	{ className: styles.providerMid, key: "fallback", label: "model", y: 75 },
	{ className: styles.providerTool, key: "tool", label: "tool", y: 116 },
] as const;

const POLICY_BARS = [
	{ className: styles.barFirst, x: 146 },
	{ className: styles.barSecond, x: 154 },
	{ className: styles.barThird, x: 162 },
] as const;

const AUDIT_TICKS = [
	{ className: styles.tickFirst, x: 46 },
	{ className: styles.tickSecond, x: 52 },
	{ className: styles.tickThird, x: 58 },
] as const;

const chipCenter = (y: number): Point => ({
	x: CHIP_X,
	y: y + CHIP_HEIGHT / 2,
});

/** A hairline wire with the faint dashed flow drawn over it. */
function Wire({ from, to }: { from: Point; to: Point }) {
	return (
		<g>
			<line
				className={styles.wire}
				vectorEffect="non-scaling-stroke"
				x1={from.x}
				x2={to.x}
				y1={from.y}
				y2={to.y}
			/>
			<line
				className={styles.flow}
				x1={from.x}
				x2={to.x}
				y1={from.y}
				y2={to.y}
			/>
		</g>
	);
}

export function GatewayScene() {
	return (
		<Scene id="gateway">
			<Stage className={styles.root}>
				<svg
					aria-hidden="true"
					className={styles.svg}
					focusable="false"
					preserveAspectRatio="xMidYMid meet"
					viewBox="0 0 320 176"
				>
					<Wire from={AGENT_EXIT} to={GATE_ENTRY} />
					{PROVIDERS.map((provider) => (
						<Wire
							from={GATE_EXIT}
							key={provider.key}
							to={chipCenter(provider.y)}
						/>
					))}

					<g>
						<rect
							className={styles.frame}
							height="22"
							rx="8"
							vectorEffect="non-scaling-stroke"
							width="44"
							x="14"
							y="73"
						/>
						<text className={styles.label} textAnchor="middle" x="36" y="86.5">
							agent
						</text>
					</g>

					<text className={styles.micro} textAnchor="middle" x="154" y="44">
						policy
					</text>
					{POLICY_BARS.map((bar) => (
						<g className={bar.className} key={bar.x}>
							<rect
								className={styles.barBase}
								height="68"
								width="2"
								x={bar.x - 1}
								y="50"
							/>
							<rect
								className={styles.barAmber}
								height="68"
								width="2"
								x={bar.x - 1}
								y="50"
							/>
						</g>
					))}

					<g className={styles.vault}>
						<line
							className={styles.tether}
							vectorEffect="non-scaling-stroke"
							x1="154"
							x2="154"
							y1="120"
							y2="128"
						/>
						<circle
							className={styles.keyStroke}
							cx="150"
							cy="132"
							r="3"
							vectorEffect="non-scaling-stroke"
						/>
						<path
							className={styles.keyStroke}
							d="M153 132h8M158.5 132v2.5M160.5 132v2"
							vectorEffect="non-scaling-stroke"
						/>
						<text className={styles.micro} textAnchor="middle" x="154" y="146">
							vault
						</text>
					</g>

					{PROVIDERS.map((provider) => (
						<g className={provider.className} key={provider.key}>
							<rect
								className={styles.frame}
								height={CHIP_HEIGHT}
								rx="5"
								vectorEffect="non-scaling-stroke"
								width={CHIP_WIDTH}
								x={CHIP_X}
								y={provider.y}
							/>
							<text
								className={styles.label}
								textAnchor="middle"
								x={CHIP_X + CHIP_WIDTH / 2}
								y={provider.y + 11.5}
							>
								{provider.label}
							</text>
						</g>
					))}
					<line
						className={styles.strike}
						vectorEffect="non-scaling-stroke"
						x1="257"
						x2="311"
						y1="43"
						y2="43"
					/>

					<text className={styles.approval} textAnchor="end" x="140" y="75">
						approval
					</text>
					<g className={styles.packet}>
						<rect
							className={styles.packetBody}
							height="7"
							rx="1.5"
							width="7"
							x="-3.5"
							y="-3.5"
						/>
						<rect
							className={styles.packetAmber}
							height="7"
							rx="1.5"
							width="7"
							x="-3.5"
							y="-3.5"
						/>
					</g>

					<text className={styles.micro} x="14" y="158.5">
						audit
					</text>
					<line
						className={styles.baseline}
						vectorEffect="non-scaling-stroke"
						x1="40"
						x2="280"
						y1="156"
						y2="156"
					/>
					{AUDIT_TICKS.map((tick) => (
						<g key={tick.x}>
							<rect
								className={styles.tickSlot}
								height="5"
								width="1"
								x={tick.x}
								y="150.5"
							/>
							<rect
								className={tick.className}
								height="5"
								width="1"
								x={tick.x}
								y="150.5"
							/>
						</g>
					))}
				</svg>
			</Stage>
		</Scene>
	);
}
