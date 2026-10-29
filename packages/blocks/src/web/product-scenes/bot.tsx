import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./bot.module.css";
import { Scene } from "./scene.tsx";

const HAIRLINE = {
	strokeWidth: 1,
	vectorEffect: "non-scaling-stroke",
} as const;

/**
 * Homepage card scene for Bot: one thread, no setup. The user asks, Bot types,
 * replies, and attaches a brief that moves from "ready for review" (amber) to
 * done (emerald). The base frame, which reduced motion shows, is the finished
 * thread; off screen the loop pauses on whatever frame it had reached.
 */
export function BotScene() {
	return (
		<Scene id="bot">
			<Stage className={`absolute inset-0 ${styles.scene}`}>
				<svg
					aria-hidden="true"
					className="absolute inset-x-0 top-1 h-44 w-full"
					focusable="false"
					preserveAspectRatio="xMidYMin meet"
					viewBox="0 0 320 140"
				>
					<g className={styles.thread}>
						<g className={styles.user}>
							<rect
								className="fill-muted stroke-border"
								height={26}
								rx={10}
								width={160}
								x={124}
								y={14}
								{...HAIRLINE}
							/>
							<rect
								className="fill-foreground/20"
								height={3}
								rx={1.5}
								width={128}
								x={136}
								y={22}
							/>
							<rect
								className="fill-foreground/20"
								height={3}
								rx={1.5}
								width={84}
								x={136}
								y={29}
							/>
						</g>

						<g className={`fill-foreground/60 ${styles.typing}`}>
							<circle className={styles.dotA} cx={52} cy={62} r={2.5} />
							<circle className={styles.dotB} cx={60} cy={62} r={2.5} />
							<circle className={styles.dotC} cx={68} cy={62} r={2.5} />
						</g>

						<g className={styles.reply}>
							<rect
								className="fill-background/70 stroke-border"
								height={40}
								rx={10}
								width={196}
								x={36}
								y={54}
								{...HAIRLINE}
							/>
							<rect
								className={`fill-foreground/35 ${styles.barA}`}
								height={4}
								rx={2}
								width={150}
								x={48}
								y={67}
							/>
							<rect
								className={`fill-foreground/35 ${styles.barB}`}
								height={4}
								rx={2}
								width={110}
								x={48}
								y={77}
							/>
						</g>

						<g className={styles.chip}>
							<rect
								className="fill-background stroke-border"
								height={22}
								rx={6}
								width={136}
								x={36}
								y={104}
								{...HAIRLINE}
							/>
							<path
								className="fill-none stroke-foreground/50"
								d="M45.5 109.5h6l3 3v8h-9z M51.5 109.5v3h3"
								strokeLinejoin="round"
								{...HAIRLINE}
							/>
							<text
								className="fill-muted-foreground font-mono"
								fontSize={9}
								x={60}
								y={118.2}
							>
								brief
							</text>
							<circle
								className={`fill-realm-review-marker ${styles.pending}`}
								cx={160}
								cy={115}
								r={3}
							/>
							<path
								className={`fill-none stroke-realm-complete dark:stroke-realm-complete-dark ${styles.done}`}
								d="M156 115.2l2.6 2.6 5.4-5.6"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={1.5}
							/>
						</g>
					</g>
				</svg>
			</Stage>
		</Scene>
	);
}
