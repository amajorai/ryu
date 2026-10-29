import type { CSSProperties } from "react";
import { Stage } from "../iso/kit/react/live.tsx";
import { Scene } from "./scene.tsx";
import styles from "./skills.module.css";

/**
 * Homepage card scene for Skills: a fanned hand of SKILL.md documents rising
 * out of the shared `skills/` folder. Every skill shows only its title until
 * an agent needs it; the centre sheet lifts and its instructions unfold on
 * demand, a ghost sheet installs from skills.sh, and one source dot blinks as
 * the source is tracked for updates.
 *
 * The server renders the open, lifted pose (also the reduced-motion frame).
 * The loop runs from CSS keyframes in `skills.module.css`, only while `Stage`
 * marks the card in view.
 */

interface SheetStyle extends CSSProperties {
	"--skills-fan": string;
	"--skills-fan-delay": string;
}

interface BarStyle extends CSSProperties {
	"--skills-bar-delay": string;
}

/** A 60x80 portrait sheet at (130,70), r 3, with a folded top-right corner. */
const SHEET_PATH =
	"M133 70H181L190 79V147Q190 150 187 150H133Q130 150 130 147V73Q130 70 133 70Z";
const SHEET_FOLD_PATH = "M181 70V76Q181 79 184 79H190";
const FOLDER_BACK_PATH =
	"M100 170V141Q100 138 103 138H127Q129 138 130.5 140L132 142H217Q220 142 220 145V170Z";
const FOLDER_POCKET_PATH =
	"M103 146H217Q220 146 220 149V167Q220 170 217 170H103Q100 170 100 167V149Q100 146 103 146Z";

/** Outer sheets drawn first, so the centre sheet tops the closed stack. */
const OUTER_SHEETS = [
	{ angle: -26, delay: 120, key: "far-left", tracked: false },
	{ angle: 26, delay: 120, key: "far-right", tracked: true },
	{ angle: -13, delay: 60, key: "left", tracked: false },
	{ angle: 13, delay: 60, key: "right", tracked: false },
] as const;

const BODY_BARS = [
	{ delay: 0, width: 46, y: 94 },
	{ delay: 120, width: 50, y: 101 },
	{ delay: 240, width: 38, y: 108 },
	{ delay: 360, width: 44, y: 115 },
] as const;

const fanStyle = (angle: number, delay: number): SheetStyle => ({
	"--skills-fan": `${angle}deg`,
	"--skills-fan-delay": `${delay}ms`,
});

const barStyle = (delay: number): BarStyle => ({
	"--skills-bar-delay": `${delay}ms`,
});

function SheetOutline() {
	return (
		<>
			<path className={styles.sheet} d={SHEET_PATH} />
			<path className={styles.hairline} d={SHEET_FOLD_PATH} />
		</>
	);
}

export function SkillsScene() {
	return (
		<Scene id="skills">
			<Stage className={styles.stage}>
				<svg
					className={styles.root}
					focusable="false"
					preserveAspectRatio="xMidYMin meet"
					viewBox="0 0 320 176"
				>
					<g>
						<rect
							className={styles.pill}
							height={18}
							rx={9}
							width={92}
							x={16}
							y={10}
						/>
						<circle className={styles.hairline} cx={27} cy={18.5} r={3.5} />
						<path className={styles.hairline} d="M29.6 21.1L32 23.5" />
						<text className={styles.mono} x={37} y={21.8}>
							skills.sh
						</text>
					</g>

					<path className={styles.folderBack} d={FOLDER_BACK_PATH} />

					{OUTER_SHEETS.map((sheet) => (
						<g
							className={styles.fan}
							key={sheet.key}
							style={fanStyle(sheet.angle, sheet.delay)}
						>
							<SheetOutline />
							<rect
								className={styles.titleBar}
								height={3}
								rx={1.5}
								width={28}
								x={136}
								y={80}
							/>
							<circle
								className={sheet.tracked ? styles.trackedDot : styles.dot}
								cx={174}
								cy={81.5}
								r={2}
							/>
						</g>
					))}

					<g className={styles.fan} style={fanStyle(0, 0)}>
						<g className={styles.lift}>
							<SheetOutline />
							<text className={styles.mono} x={135} y={84}>
								SKILL.md
							</text>
							{BODY_BARS.map((bar) => (
								<rect
									className={styles.bar}
									height={3}
									key={bar.y}
									rx={1.5}
									style={barStyle(bar.delay)}
									width={bar.width}
									x={135}
									y={bar.y}
								/>
							))}
						</g>
					</g>

					<g className={styles.ghost}>
						<SheetOutline />
					</g>

					<path className={styles.folderPocket} d={FOLDER_POCKET_PATH} />
					<text className={styles.folderLabel} x={108} y={161}>
						skills/
					</text>
				</svg>
			</Stage>
		</Scene>
	);
}
