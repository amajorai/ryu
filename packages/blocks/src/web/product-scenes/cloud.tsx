import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./cloud.module.css";
import { Scene } from "./scene.tsx";

/**
 * Ryu Cloud's homepage card: agents keep running on a managed node while your
 * devices sleep. The laptop hands a run to the node and sleeps, the node keeps
 * three runs going while every outbound call crosses the same Gateway policy
 * bars as the Gateway card, and the result is waiting on the laptop at wake.
 *
 * The SVG is static server markup in its resting pose; `cloud.module.css`
 * animates it (transform and opacity only), holds a still "asleep, still
 * running" pose under reduced motion, and pauses while the card is off screen.
 */

const HAIRLINE = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1,
	vectorEffect: "non-scaling-stroke",
} as const;

const SLOTS = [
	{ y: 62, led: styles.ledOne, pulse: "", fill: styles.fillOne },
	{ y: 84, led: styles.ledTwo, pulse: styles.pulseTwo, fill: styles.fillTwo },
	{
		y: 106,
		led: styles.ledThree,
		pulse: styles.pulseThree,
		fill: styles.fillThree,
	},
] as const;

const BARS = [
	{ x: 220, className: styles.bar },
	{ x: 226, className: `${styles.bar} ${styles.barTwo}` },
	{ x: 232, className: `${styles.bar} ${styles.barThree}` },
] as const;

/** The laptop: screen, base, two screen bars and the activity dot. */
function Laptop() {
	return (
		<g>
			<rect
				{...HAIRLINE}
				height={38}
				rx={3}
				strokeOpacity={0.55}
				width={58}
				x={14}
				y={70}
			/>
			<line
				{...HAIRLINE}
				strokeOpacity={0.55}
				x1={8}
				x2={78}
				y1={112}
				y2={112}
			/>
			<g className={styles.screen}>
				<rect
					fill="currentColor"
					fillOpacity={0.5}
					height={3}
					rx={1.5}
					width={28}
					x={20}
					y={77}
				/>
				<rect
					fill="currentColor"
					fillOpacity={0.3}
					height={3}
					rx={1.5}
					width={18}
					x={20}
					y={84}
				/>
				<circle cx={64} cy={88} fill="currentColor" fillOpacity={0.6} r={2} />
			</g>
			<circle
				className={`${styles.result} text-realm-complete dark:text-realm-complete-dark`}
				cx={64}
				cy={88}
				fill="currentColor"
				r={2}
			/>
			<g transform="translate(54 52)">
				<path
					{...HAIRLINE}
					className={styles.moon}
					d="M-0.27 -6.99A7 7 0 1 0 6.79 1.7A5.6 5.6 0 1 1 -0.27 -6.99Z"
					strokeOpacity={0.7}
				/>
			</g>
		</g>
	);
}

/** The managed node: region header and three run slots. */
function Rack() {
	return (
		<g>
			<rect
				{...HAIRLINE}
				fill="currentColor"
				fillOpacity={0.03}
				height={96}
				rx={6}
				strokeOpacity={0.5}
				width={84}
				x={106}
				y={34}
			/>
			<text fill="currentColor" fillOpacity={0.6} fontSize={7} x={114} y={46}>
				EU · SG
			</text>
			<line
				{...HAIRLINE}
				strokeOpacity={0.2}
				x1={106}
				x2={190}
				y1={51}
				y2={51}
			/>
			{SLOTS.map((slot) => (
				<g key={slot.y}>
					<circle
						{...HAIRLINE}
						cx={116}
						cy={slot.y}
						r={2.5}
						strokeOpacity={0.4}
					/>
					<g className={slot.led}>
						<circle
							className={`${styles.pulse} ${slot.pulse}`}
							cx={116}
							cy={slot.y}
							fill="currentColor"
							r={2.5}
						/>
					</g>
					<rect
						fill="currentColor"
						fillOpacity={0.12}
						height={3}
						rx={1.5}
						width={52}
						x={124}
						y={slot.y - 1.5}
					/>
					<rect
						className={slot.fill}
						fill="currentColor"
						fillOpacity={0.6}
						height={3}
						rx={1.5}
						width={52}
						x={124}
						y={slot.y - 1.5}
					/>
				</g>
			))}
		</g>
	);
}

/** Gateway policy bars and the models chip every call ends at. */
function Egress() {
	return (
		<g>
			{BARS.map((bar) => (
				<rect
					className={bar.className}
					fill="currentColor"
					height={48}
					key={bar.x}
					width={2}
					x={bar.x - 1}
					y={64}
				/>
			))}
			<g className={styles.chip}>
				<rect
					{...HAIRLINE}
					height={18}
					rx={9}
					strokeOpacity={0.6}
					width={40}
					x={262}
					y={79}
				/>
				<text
					fill="currentColor"
					fontSize={7}
					textAnchor="middle"
					x={282}
					y={90.5}
				>
					models
				</text>
			</g>
		</g>
	);
}

export function CloudScene() {
	return (
		<Scene id="cloud">
			<Stage
				className={`${styles.root} absolute inset-x-0 top-0 flex h-[calc(100%-7rem)] items-center justify-center px-4 pt-4`}
			>
				<svg
					aria-hidden="true"
					className="h-full w-full max-w-[28rem] font-mono text-foreground"
					focusable="false"
					preserveAspectRatio="xMidYMid meet"
					viewBox="0 28 316 112"
				>
					<text
						className={styles.caption}
						fill="currentColor"
						fillOpacity={0.6}
						fontSize={7}
						x={8}
						y={40}
					>
						running while you sleep
					</text>
					<g strokeOpacity={0.3}>
						<line {...HAIRLINE} x1={72} x2={106} y1={88} y2={88} />
						<line {...HAIRLINE} x1={190} x2={216} y1={88} y2={88} />
						<line {...HAIRLINE} x1={236} x2={262} y1={88} y2={88} />
					</g>
					<Laptop />
					<Rack />
					<Egress />
					<circle
						className={styles.handoff}
						cx={72}
						cy={88}
						fill="currentColor"
						r={2}
					/>
					<circle
						className={styles.outbound}
						cx={190}
						cy={88}
						fill="currentColor"
						r={2}
					/>
					<g className={styles.returning}>
						<circle {...HAIRLINE} cx={106} cy={88} r={3.5} />
						<circle
							className="text-realm-complete dark:text-realm-complete-dark"
							cx={106}
							cy={88}
							fill="currentColor"
							r={1.75}
						/>
					</g>
				</svg>
			</Stage>
		</Scene>
	);
}
