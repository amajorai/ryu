import styles from "./desktop.module.css";
import { Label, type MotionStyle, SceneCanvas } from "./scene.tsx";

/**
 * Homepage card scene for Ryu Desktop: one app for every agent and model. The
 * window's sidebar lists the agents by name (Ryu, Claude Code, Codex); the
 * composer names the model source it will use (a local model, your own key,
 * or a Ryu plan). In the loop the selection moves agent to agent, the model
 * source changes with it, and each one answers in the same thread.
 *
 * The markup is the still (Claude Code selected on your own key, its reply
 * written); the 9s loop in `desktop.module.css` starts and ends on it.
 */

const WINDOW = { height: 156, width: 280, x: 8, y: 8 } as const;
const SIDEBAR_RIGHT = 100;
const ROWS = [
	{ label: "ryu", y: 62 },
	{ label: "claude code", y: 84 },
	{ label: "codex", y: 106 },
] as const;
const SELECTED_Y = ROWS[1].y;
const PILL_X = 244;

/** The model source each beat uses, in loop order from the still. */
const SOURCES = [
	{ className: styles.sourceA, label: "your key" },
	{ className: styles.sourceB, label: "plan" },
	{ className: styles.sourceC, label: "local" },
] as const;

const REPLY = [
	{ delay: 0, width: 120, y: 74 },
	{ delay: 0.15, width: 96, y: 84 },
	{ delay: 0.3, width: 108, y: 94 },
] as const;

export function DesktopProductScene() {
	return (
		<SceneCanvas className={styles.root} id="desktop">
			<rect
				className={styles.window}
				height={WINDOW.height}
				rx={10}
				width={WINDOW.width}
				x={WINDOW.x}
				y={WINDOW.y}
			/>
			{[20, 29, 38].map((cx) => (
				<circle className={styles.light} cx={cx} cy={20} key={cx} r={2.5} />
			))}
			<line className={styles.rule} x1={8} x2={288} y1={32} y2={32} />
			<line
				className={styles.rule}
				x1={SIDEBAR_RIGHT}
				x2={SIDEBAR_RIGHT}
				y1={32}
				y2={164}
			/>

			<Label anchor="start" muted x={18} y={44}>
				agents
			</Label>
			<rect
				className={styles.selection}
				height={18}
				rx={9}
				width={84}
				x={12}
				y={SELECTED_Y - 9}
			/>
			{ROWS.map((row) => (
				<Label anchor="start" key={row.label} x={20} y={row.y}>
					{row.label}
				</Label>
			))}

			<rect
				className={styles.bubble}
				height={16}
				rx={8}
				width={68}
				x={208}
				y={42}
			/>
			<rect
				className={styles.ask}
				height={3}
				rx={1.5}
				width={44}
				x={220}
				y={48.5}
			/>
			{REPLY.map((line) => (
				<rect
					className={styles.reply}
					height={3}
					key={line.y}
					rx={1.5}
					style={{ "--delay": `${line.delay}s` } as MotionStyle}
					width={line.width}
					x={112}
					y={line.y}
				/>
			))}

			<rect
				className={styles.composer}
				height={24}
				rx={12}
				width={176}
				x={106}
				y={128}
			/>
			<Label anchor="end" muted x={PILL_X - 37} y={140}>
				model
			</Label>
			<rect
				className={styles.pill}
				height={16}
				rx={8}
				width={66}
				x={PILL_X - 33}
				y={132}
			/>
			{SOURCES.map((source) => (
				<Label
					className={source.className}
					key={source.label}
					x={PILL_X}
					y={140}
				>
					{source.label}
				</Label>
			))}
		</SceneCanvas>
	);
}
