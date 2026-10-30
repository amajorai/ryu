import styles from "./bot.module.css";
import { Check, Label, type MotionStyle, SceneCanvas } from "./scene.tsx";

/**
 * Homepage card scene for Bot: hand a task to managed AI in one thread, with
 * nothing to set up. You ask, Bot types and drafts it, and before it acts on
 * another app it asks for your approval; once approved it posts. The caption
 * names the two promises (no setup, one thread).
 *
 * The markup is the still (the thread waiting on your approval); the 9s loop
 * in `bot.module.css` approves it, clears the thread and plays the next task
 * back to the same point.
 */

const AVATAR = { x: 18, y: 54 } as const;
const BUBBLE_X = 34;
const CARD = { height: 58, width: 196, x: BUBBLE_X, y: 76 } as const;
const BUTTON = { height: 20, width: 70, x: BUBBLE_X + 12, y: 108 } as const;

const dot = (seconds: number): MotionStyle => ({ "--delay": `${seconds}s` });

export function BotScene() {
	return (
		<SceneCanvas className={styles.root} id="bot">
			<g className={styles.user}>
				<rect
					className={styles.mine}
					height={22}
					rx={11}
					width={160}
					x={126}
					y={10}
				/>
				<Label anchor="start" x={136} y={21}>
					write the launch notes
				</Label>
			</g>

			<g className={styles.thread}>
				<circle className={styles.avatar} cx={AVATAR.x} cy={AVATAR.y} r={9} />
				<circle
					className={styles.eye}
					cx={AVATAR.x - 3}
					cy={AVATAR.y - 1}
					r={1.3}
				/>
				<circle
					className={styles.eye}
					cx={AVATAR.x + 3}
					cy={AVATAR.y - 1}
					r={1.3}
				/>
				<rect
					className={styles.bubble}
					height={22}
					rx={11}
					width={128}
					x={BUBBLE_X}
					y={43}
				/>
				<g className={styles.typing}>
					{[0, 0.15, 0.3].map((seconds, index) => (
						<circle
							className={styles.dot}
							cx={BUBBLE_X + 14 + index * 9}
							cy={54}
							key={seconds}
							r={2}
							style={dot(seconds)}
						/>
					))}
				</g>
				<Label anchor="start" className={styles.reply} x={BUBBLE_X + 10} y={54}>
					here's the draft
				</Label>
			</g>

			<g className={styles.card}>
				<rect
					className={styles.frame}
					height={CARD.height}
					rx={10}
					width={CARD.width}
					x={CARD.x}
					y={CARD.y}
				/>
				<Label anchor="start" x={CARD.x + 12} y={CARD.y + 16}>
					post to #launch?
				</Label>
				<rect
					className={styles.button}
					height={BUTTON.height}
					rx={10}
					width={BUTTON.width}
					x={BUTTON.x}
					y={BUTTON.y}
				/>
				<rect
					className={styles.press}
					height={BUTTON.height}
					rx={10}
					width={BUTTON.width}
					x={BUTTON.x}
					y={BUTTON.y}
				/>
				<Label
					className={styles.approve}
					x={BUTTON.x + BUTTON.width / 2}
					y={BUTTON.y + 10}
				>
					approve
				</Label>
				<g className={styles.posted}>
					<g transform={`translate(${BUTTON.x + 14} ${BUTTON.y + 10})`}>
						<Check />
					</g>
					<Label anchor="start" x={BUTTON.x + 22} y={BUTTON.y + 10}>
						posted
					</Label>
				</g>
			</g>

			<Label anchor="start" muted x={BUBBLE_X} y={156}>
				no setup · one thread
			</Label>
		</SceneCanvas>
	);
}
