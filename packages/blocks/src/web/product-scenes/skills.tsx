import { Label, type MotionStyle, SceneCanvas } from "./scene.tsx";
import styles from "./skills.module.css";

/**
 * Homepage card scene for Skills: a hand of skill documents fanned out of the
 * shared `skills/` folder. Each skill is one document with a name; the centre
 * one is lifted and open, its instructions showing. In the loop the hand
 * closes, a new skill installs from skills.sh into the stack in one move, the
 * hand fans back open and the top skill unfolds its instructions on demand.
 *
 * The markup is the still (the hand open, SKILL.md lifted and read); the 8s
 * loop in `skills.module.css` starts and ends on it.
 */

const DOC_WIDTH = 64;
const DOC_HEIGHT = 76;
const DOC_X = 148 - DOC_WIDTH / 2;
const DOC_Y = 58;
const FOLD = 9;

/** A portrait sheet with a folded top-right corner, centred on x = 148. */
const SHEET_PATH = `M${DOC_X + 3} ${DOC_Y}H${DOC_X + DOC_WIDTH - FOLD}L${DOC_X + DOC_WIDTH} ${DOC_Y + FOLD}V${DOC_Y + DOC_HEIGHT}H${DOC_X}V${DOC_Y + 3}Q${DOC_X} ${DOC_Y} ${DOC_X + 3} ${DOC_Y}Z`;
const FOLD_PATH = `M${DOC_X + DOC_WIDTH - FOLD} ${DOC_Y}V${DOC_Y + FOLD}H${DOC_X + DOC_WIDTH}`;

/** Outer skills, drawn from the outside in so nearer sheets overlap them. */
const OUTER = [
	{ angle: -44, anchor: "start", label: "pdf" },
	{ angle: 44, anchor: "end", label: "docs" },
	{ angle: -22, anchor: "start", label: "lint" },
	{ angle: 22, anchor: "end", label: "test" },
] as const;

const BODY = [
	{ delay: 0, width: 40 },
	{ delay: 0.12, width: 44 },
	{ delay: 0.24, width: 32 },
	{ delay: 0.36, width: 38 },
] as const;

const fan = (angle: number): MotionStyle => ({ "--fan": `${angle}deg` });

function Sheet() {
	return (
		<>
			<path className={styles.sheet} d={SHEET_PATH} />
			<path className={styles.fold} d={FOLD_PATH} />
		</>
	);
}

export function SkillsScene() {
	return (
		<SceneCanvas className={styles.root} id="skills">
			<g>
				<rect
					className={styles.pill}
					height={20}
					rx={10}
					width={94}
					x={10}
					y={8}
				/>
				<circle className={styles.fold} cx={22} cy={17} r={3.4} />
				<path className={styles.fold} d="M24.6 19.6 L27 22" />
				<Label anchor="start" x={32} y={18}>
					skills.sh
				</Label>
			</g>

			{OUTER.map((sheet) => (
				<g className={styles.fan} key={sheet.label} style={fan(sheet.angle)}>
					<Sheet />
					<Label
						anchor={sheet.anchor}
						x={sheet.anchor === "start" ? DOC_X + 6 : DOC_X + DOC_WIDTH - 6}
						y={DOC_Y + 16}
					>
						{sheet.label}
					</Label>
				</g>
			))}

			<g className={styles.fan} style={fan(0)}>
				<g className={styles.lift}>
					<Sheet />
					<Label anchor="start" x={DOC_X + 6} y={DOC_Y + 16}>
						SKILL.md
					</Label>
					{BODY.map((bar, index) => (
						<rect
							className={styles.bar}
							height={3}
							key={bar.width}
							rx={1.5}
							style={{ "--delay": `${bar.delay}s` } as MotionStyle}
							width={bar.width}
							x={DOC_X + 6}
							y={DOC_Y + 30 + index * 8}
						/>
					))}
				</g>
			</g>

			<g className={styles.install}>
				<Sheet />
			</g>

			<rect
				className={styles.pocket}
				height={30}
				rx={5}
				width={124}
				x={86}
				y={134}
			/>
			<Label muted x={148} y={149}>
				skills/
			</Label>
		</SceneCanvas>
	);
}
