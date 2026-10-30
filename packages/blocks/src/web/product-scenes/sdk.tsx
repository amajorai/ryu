import { Chip, Label, Packet, SceneCanvas, Wire } from "./scene.tsx";
import styles from "./sdk.module.css";

/**
 * Homepage card scene for the Ryu SDK: code becomes an agent. Each line of a
 * real `defineAgent` call on the left materialises its part of the running
 * agent on the right (the agent, its chat model, memory, and an MCP tool), and
 * once the call is closed, work flows between the agent and its parts.
 *
 * The markup is the still (the whole call written, the agent wired up); the
 * 9s loop in `sdk.module.css` erases it and rewrites it line by line, each
 * part appearing with the line that defines it.
 */

const LINE_X = 18;
const AGENT = { x: 186, y: 92 } as const;
const AGENT_HALF = 15;
const PART_X = 254;
const PART_WIDTH = 60;

/** The call, one line per part; SVG collapses spaces, so indent is an offset. */
const LINES = [
	{ indent: 0, text: "defineAgent({" },
	{ indent: 12, text: "chat," },
	{ indent: 12, text: "memory: true," },
	{ indent: 12, text: "tools: [mcp]," },
	{ indent: 0, text: "})" },
] as const;

const PARTS = [
	{ label: "chat", line: 1, y: 44 },
	{ label: "memory", line: 2, y: 92 },
	{ label: "mcp", line: 3, y: 140 },
] as const;

/** The motion class that writes line `index` and the part it defines. */
const LINE_CLASSES = [
	styles.l0,
	styles.l1,
	styles.l2,
	styles.l3,
	styles.l4,
] as const;

export function SdkScene() {
	return (
		<SceneCanvas className={styles.root} id="sdk">
			<rect
				className={styles.panel}
				height={152}
				rx={8}
				width={140}
				x={8}
				y={12}
			/>
			<Label anchor="start" muted x={LINE_X} y={28}>
				agent.ts
			</Label>
			<line className={styles.rule} x1={8} x2={148} y1={40} y2={40} />
			{LINES.map((line, index) => (
				<g className={LINE_CLASSES[index]} key={line.text}>
					<Label anchor="start" x={LINE_X + line.indent} y={58 + index * 20}>
						{line.text}
					</Label>
				</g>
			))}

			{PARTS.map((part) => {
				const from = { x: AGENT.x + AGENT_HALF, y: AGENT.y };
				const to = { x: PART_X - PART_WIDTH / 2, y: part.y };
				return (
					<g className={LINE_CLASSES[part.line]} key={part.label}>
						<Wire from={from} to={to} />
						<Packet delay={part.line * 0.5} from={from} loop to={to} />
						<Chip label={part.label} width={PART_WIDTH} x={PART_X} y={part.y} />
					</g>
				);
			})}

			<g className={LINE_CLASSES[0]}>
				<rect
					className={styles.agent}
					height={AGENT_HALF * 2}
					rx={9}
					width={AGENT_HALF * 2}
					x={AGENT.x - AGENT_HALF}
					y={AGENT.y - AGENT_HALF}
				/>
				<circle className={styles.dot} cx={AGENT.x} cy={AGENT.y} r={4.5} />
				<Label x={AGENT.x} y={AGENT.y + 28}>
					agent
				</Label>
			</g>
		</SceneCanvas>
	);
}
