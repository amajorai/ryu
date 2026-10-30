import styles from "./gateway.module.css";
import {
	Chip,
	Label,
	Packet,
	type Point,
	SceneCanvas,
	Wire,
} from "./scene.tsx";

/**
 * Homepage card scene for Gateway: the checkpoint between an agent and
 * everything it calls. One call is held at the gate until it is approved, then
 * crosses the policy bars to a tool. The next call routes to a model that is
 * down and falls back to the backup model. The caption under the gate names
 * what every crossing goes through.
 *
 * The markup is the still: the call held for approval, with the model struck
 * out from the previous fallback. The 7.2s loop in `gateway.module.css` starts
 * and ends on that frame.
 */

const GATE_X = 140;
const GATE_IN: Point = { x: 116, y: 92 };
const GATE_OUT: Point = { x: 164, y: 92 };
const AGENT_OUT: Point = { x: 66, y: 92 };
const ROUTE_X = 218;
const PROVIDER_X = 250;

const PROVIDERS = [
	{ className: styles.model, label: "model", y: 44 },
	{ className: styles.backup, label: "backup", y: 92 },
	{ className: styles.tool, label: "tool", y: 140 },
] as const;

const BARS = [128, 140, 152] as const;

export function GatewayScene() {
	return (
		<SceneCanvas className={styles.root} id="gateway">
			<Wire from={AGENT_OUT} to={GATE_IN} />
			{PROVIDERS.map((provider) => (
				<Wire
					from={GATE_OUT}
					key={provider.label}
					to={{ x: ROUTE_X, y: provider.y }}
				/>
			))}

			<Chip label="agent" width={52} x={40} y={92} />

			<Label x={GATE_X} y={40}>
				gateway
			</Label>
			<rect
				className={styles.gate}
				height={84}
				rx={10}
				width={48}
				x={GATE_X - 24}
				y={50}
			/>
			{BARS.map((x) => (
				<line className={styles.bar} key={x} x1={x} x2={x} y1={62} y2={122} />
			))}
			<Label muted x={GATE_X} y={156}>
				policy · keys · audit
			</Label>

			{PROVIDERS.map((provider) => (
				<g className={provider.className} key={provider.label}>
					<Chip
						label={provider.label}
						width={64}
						x={PROVIDER_X}
						y={provider.y}
					/>
					<rect
						className={styles.lit}
						height={20}
						rx={10}
						width={64}
						x={PROVIDER_X - 32}
						y={provider.y - 10}
					/>
				</g>
			))}
			<line
				className={styles.strike}
				x1={PROVIDER_X - 36}
				x2={PROVIDER_X + 36}
				y1={44}
				y2={44}
			/>

			<g className={styles.tag}>
				<rect
					className={styles.tagFrame}
					height={18}
					rx={4}
					width={60}
					x={52}
					y={56}
				/>
				<Label className={styles.ask} x={82} y={65}>
					approve?
				</Label>
				<Label className={styles.ok} x={82} y={65}>
					approved
				</Label>
			</g>

			<Packet className={styles.inLeg} from={AGENT_OUT} parked to={GATE_IN} />
			<Packet className={styles.gateLeg} from={GATE_IN} to={GATE_OUT} />
			<Packet
				className={styles.toolLeg}
				from={GATE_OUT}
				to={{ x: ROUTE_X, y: 140 }}
			/>
			<Packet
				className={styles.modelLeg}
				from={GATE_OUT}
				to={{ x: ROUTE_X, y: 44 }}
			/>
			<Packet
				className={styles.backupLeg}
				from={GATE_OUT}
				to={{ x: ROUTE_X, y: 92 }}
			/>
		</SceneCanvas>
	);
}
