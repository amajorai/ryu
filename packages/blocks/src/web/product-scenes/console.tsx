import type { CSSProperties } from "react";
import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./console.module.css";
import { Scene } from "./scene.tsx";

/**
 * The Console homepage card: the operator's board. Runs proceed side by side,
 * one stops at an approval, and a finished run files itself into the audit
 * ledger. The unanimated frame (and the reduced-motion frame) is the end of
 * that story: run 1 done and filed, run 2 waiting on the approval, run 3 idle.
 */

interface TickIndexStyle extends CSSProperties {
	"--i": number;
}

const tickIndex = (index: number): TickIndexStyle => ({ "--i": index });

const ROW_Y = [58, 86, 114] as const;
const TICK_X = [110, 130, 150, 170, 190, 210] as const;
const APPROVAL_TICK = 3;
const LEDGER_LINE_WIDTHS = [40, 46, 34, 44, 38, 42] as const;

const PROGRESS = "fill-realm-progress dark:fill-realm-progress-dark";
const COMPLETE = "fill-realm-complete dark:fill-realm-complete-dark";

function Tick({
	className,
	index,
	y,
}: {
	className: string;
	index: number;
	y: number;
}) {
	return (
		<rect
			className={`fill-foreground ${className}`}
			height={3}
			style={tickIndex(index)}
			width={3}
			x={(TICK_X[index] ?? 0) - 1.5}
			y={y - 1.5}
		/>
	);
}

function RunLabel({ label, y }: { label: string; y: number }) {
	return (
		<>
			<text className="fill-foreground" fontSize={9} x={30} y={y + 3}>
				{label}
			</text>
			<line
				className="stroke-border"
				strokeWidth={0.75}
				x1={106}
				x2={214}
				y1={y}
				y2={y}
			/>
		</>
	);
}

function SupportRun() {
	const y = ROW_Y[0];
	return (
		<g>
			<circle
				className={`${PROGRESS} ${styles.runPending}`}
				cx={20}
				cy={y}
				r={3}
			/>
			<circle
				className={`${COMPLETE} ${styles.runDone}`}
				cx={20}
				cy={y}
				r={3}
			/>
			<RunLabel label="support" y={y} />
			{TICK_X.map((x, index) => (
				<Tick className={styles.fastTick} index={index} key={x} y={y} />
			))}
		</g>
	);
}

function ResearchRun() {
	const y = ROW_Y[1];
	const x = TICK_X[APPROVAL_TICK];
	return (
		<g>
			<circle className={PROGRESS} cx={20} cy={y} r={3} />
			<RunLabel label="research" y={y} />
			{TICK_X.map((tickX, index) => {
				if (index === APPROVAL_TICK) {
					return null;
				}
				let className = styles.idleTick;
				if (index < APPROVAL_TICK) {
					className = styles.slowTick;
				} else if (index === APPROVAL_TICK + 1) {
					className = styles.resumeTick;
				}
				return <Tick className={className} index={index} key={tickX} y={y} />;
			})}
			<polygon
				className={`${PROGRESS} ${styles.approval}`}
				points={`${x},${y - 4} ${x + 4},${y} ${x},${y + 4} ${x - 4},${y}`}
			/>
			<path
				className={`fill-none stroke-realm-complete dark:stroke-realm-complete-dark ${styles.approved}`}
				d={`M${x - 3} ${y} l2 2 l4 -4.5`}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth={1.25}
			/>
		</g>
	);
}

function TriageRun() {
	const y = ROW_Y[2];
	return (
		<g>
			<circle
				className="fill-muted-foreground"
				cx={20}
				cy={y}
				opacity={0.55}
				r={3}
			/>
			<RunLabel label="triage" y={y} />
			{TICK_X.map((x, index) => (
				<Tick
					className={index === 0 ? styles.litTick : styles.idleTick}
					index={index}
					key={x}
					y={y}
				/>
			))}
		</g>
	);
}

function AuditLedger() {
	return (
		<g>
			<rect
				className="fill-background/40 stroke-border"
				height={80}
				rx={6}
				strokeWidth={0.75}
				width={68}
				x={236}
				y={50}
			/>
			<rect
				className="fill-foreground"
				height={3}
				opacity={0.7}
				width={3}
				x={243}
				y={56.5}
			/>
			<text className="fill-muted-foreground" fontSize={7.5} x={250} y={60.5}>
				audit
			</text>
			<line
				className="stroke-border"
				strokeWidth={0.75}
				x1={236}
				x2={304}
				y1={66}
				y2={66}
			/>
			<svg
				height={51}
				overflow="hidden"
				viewBox="236 66 68 51"
				width={68}
				x={236}
				y={66}
			>
				<g className={styles.ledgerShift}>
					{LEDGER_LINE_WIDTHS.map((width, index) => (
						<g className="fill-muted-foreground" key={width} opacity={0.55}>
							<circle cx={244.5} cy={80 + index * 8} r={1.5} />
							<rect
								height={2}
								rx={1}
								width={width}
								x={250}
								y={79 + index * 8}
							/>
						</g>
					))}
				</g>
			</svg>
			<circle
				className={`${COMPLETE} ${styles.recordMark}`}
				cx={244.5}
				cy={72}
				r={1.5}
			/>
			<rect
				className={`fill-foreground ${styles.record}`}
				height={2}
				opacity={0.8}
				rx={1}
				width={48}
				x={250}
				y={71}
			/>
		</g>
	);
}

/** The Console card scene, inside the shared decorative `Scene` backdrop. */
export function ConsoleScene() {
	return (
		<Scene id="console">
			<Stage className={`absolute inset-0 ${styles.root}`}>
				<svg
					aria-hidden="true"
					className="absolute inset-x-0 top-0 mx-auto block h-auto w-full max-w-[26rem] font-mono"
					fill="none"
					focusable="false"
					viewBox="0 0 320 144"
				>
					<text className="fill-muted-foreground" fontSize={8.5} x={16} y={25}>
						12 nodes · 04 models · 28 agents
					</text>
					<line
						className="stroke-border"
						strokeWidth={0.75}
						x1={16}
						x2={304}
						y1={38}
						y2={38}
					/>
					<SupportRun />
					<ResearchRun />
					<TriageRun />
					<AuditLedger />
				</svg>
			</Stage>
		</Scene>
	);
}
