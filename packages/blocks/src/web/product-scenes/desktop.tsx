import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./desktop.module.css";
import { Scene } from "./scene.tsx";

/** Sidebar slot tops: thread rows sit 18 units apart under the title bar. */
const SLOT_Y = [34, 52, 70] as const;
/** The threads already in the sidebar: slot top and placeholder title width. */
const THREADS = [
	{ width: 38, y: SLOT_Y[0] },
	{ width: 30, y: SLOT_Y[1] },
	{ last: true, width: 34, y: SLOT_Y[2] },
] as const;

/** One model the composer's chip can hold, with the reply badge initial. */
const MODELS = [
	{ className: styles.local, initial: "L", label: "local" },
	{ className: styles.key, initial: "K", label: "your key" },
	{ className: styles.plan, initial: "P", label: "plan" },
] as const;

/** A thread row: a pill with a 3px left rule and a placeholder title. */
function ThreadRow({ width, y }: { width: number; y: number }) {
	return (
		<>
			<rect className={styles.row} height={14} rx={7} width={60} x={26} y={y} />
			<rect
				className={styles.ink}
				height={6}
				rx={1.5}
				width={3}
				x={31}
				y={y + 4}
			/>
			<rect
				className={styles.ink}
				height={3}
				rx={1.5}
				width={width}
				x={38}
				y={y + 5.5}
			/>
		</>
	);
}

/** An imported thread: it arrives from beyond the left edge with its source. */
function ImportedRow({
	className,
	label,
	y,
}: {
	className: string;
	label: string;
	y: number;
}) {
	return (
		<g className={className}>
			<rect
				className={styles.chipRow}
				height={14}
				rx={7}
				width={60}
				x={26}
				y={y}
			/>
			<rect
				className={styles.lit}
				height={6}
				rx={1.5}
				width={3}
				x={31}
				y={y + 4}
			/>
			<text className={styles.label} x={37} y={y + 9.4}>
				{label}
			</text>
			<rect
				className={styles.ink}
				height={3}
				rx={1.5}
				width={24}
				x={54}
				y={y + 5.5}
			/>
		</g>
	);
}

/**
 * Ryu Desktop: everything lands in one window. Claude Code and Codex threads
 * import into the sidebar, the composer's model slot switches between a local
 * model, your own key and a plan, and an app runs inside a sandbox in the
 * thread. The card's label and link carry the meaning; the drawing is
 * decorative (the `Scene` wrapper is `aria-hidden`).
 */
export function DesktopProductScene() {
	return (
		<Scene id="desktop">
			<Stage className={styles.root}>
				<svg
					aria-hidden="true"
					className={styles.svg}
					focusable="false"
					preserveAspectRatio="xMidYMid meet"
					viewBox="0 0 320 172"
				>
					<rect
						className={styles.frame}
						height={156}
						rx={8}
						width={280}
						x={20}
						y={8}
					/>
					<circle className={styles.dot} cx={31} cy={17} r={2.5} />
					<circle className={styles.dot} cx={39} cy={17} r={2.5} />
					<circle className={styles.dot} cx={47} cy={17} r={2.5} />
					<line className={styles.rule} x1={20} x2={300} y1={26} y2={26} />
					<line className={styles.rule} x1={92} x2={92} y1={26} y2={164} />

					<g className={styles.rowsShift}>
						{THREADS.map((thread) => (
							<g
								className={"last" in thread ? styles.rowLast : undefined}
								key={thread.y}
							>
								<ThreadRow width={thread.width} y={thread.y} />
							</g>
						))}
					</g>
					<ImportedRow className={styles.chipA} label="CC" y={SLOT_Y[0]} />
					<ImportedRow className={styles.chipB} label="Cx" y={SLOT_Y[1]} />

					<rect
						className={styles.ink}
						height={10}
						rx={5}
						width={90}
						x={200}
						y={36}
					/>
					<circle className={styles.badge} cx={108} cy={62} r={6} />
					{MODELS.map((model) => (
						<text
							className={`${styles.label} ${model.className}`}
							key={model.initial}
							textAnchor="middle"
							x={108}
							y={64.3}
						>
							{model.initial}
						</text>
					))}
					<rect
						className={styles.replyBar}
						height={10}
						rx={5}
						width={120}
						x={120}
						y={57}
					/>
					<rect
						className={styles.ink}
						height={6}
						rx={3}
						width={76}
						x={120}
						y={71}
					/>

					<rect
						className={styles.sandbox}
						height={40}
						rx={6}
						width={100}
						x={120}
						y={82}
					/>
					<rect
						className={styles.tile}
						height={22}
						rx={5}
						width={22}
						x={128}
						y={91}
					/>
					<rect
						className={styles.ink}
						height={5}
						rx={1}
						width={5}
						x={133}
						y={96}
					/>
					<rect
						className={styles.ink}
						height={5}
						rx={1}
						width={5}
						x={140}
						y={96}
					/>
					<rect
						className={styles.ink}
						height={5}
						rx={1}
						width={5}
						x={133}
						y={103}
					/>
					<rect
						className={styles.lit}
						height={5}
						rx={1}
						width={5}
						x={140}
						y={103}
					/>
					<line className={styles.track} x1={160} x2={208} y1={102} y2={102} />
					<rect
						className={styles.tick}
						height={8}
						rx={1}
						width={4}
						x={182}
						y={98}
					/>

					<rect
						className={styles.frame}
						height={18}
						rx={9}
						width={192}
						x={100}
						y={128}
					/>
					<rect
						className={styles.ink}
						height={4}
						rx={2}
						width={64}
						x={110}
						y={135}
					/>
					<rect
						className={styles.chipRow}
						height={12}
						rx={6}
						width={52}
						x={234}
						y={131}
					/>
					{MODELS.map((model) => (
						<text
							className={`${styles.label} ${model.className}`}
							key={model.label}
							textAnchor="middle"
							x={260}
							y={139.3}
						>
							{model.label}
						</text>
					))}
				</svg>
			</Stage>
		</Scene>
	);
}
