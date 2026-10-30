/* eslint-disable react/no-unknown-property */
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import type { WorkersArt } from "./workers-palette.ts";

/** How long the oldest blocking ask has waited (0 with none). */
export function oldestBlockingWaitMs(
	snapshot: Pick<InterfaceSnapshot, "asks">,
	nowMs: number
): number {
	let oldest = nowMs;
	for (const ask of snapshot.asks ?? []) {
		const since = ask.blocking ? Date.parse(ask.since ?? "") : Number.NaN;
		if (Number.isFinite(since)) {
			oldest = Math.min(oldest, since);
		}
	}
	return nowMs - oldest;
}

const TURN = Math.PI * 2;
const MINUTE_MS = 60_000;

/**
 * Your office door at the you-spot, standing ajar, with the wall clock
 * over it: its hands show how long the oldest blocking ask has waited
 * (from twelve; they rest at twelve when nothing waits).
 */
export function OfficeDoor({
	art,
	at,
	waitMs,
}: {
	art: WorkersArt;
	at: Vec3;
	waitMs: number;
}) {
	const minutes = Math.max(0, waitMs) / MINUTE_MS;
	const minuteTurn = -((minutes % 60) / 60) * TURN;
	const hourTurn = -(((minutes / 60) % 12) / 12) * TURN;
	return (
		<group position={at} rotation={[0, FACE_CAMERA, 0]}>
			{[-1, 1].map((side) => (
				<ToonMesh
					castShadow
					color={art.doorFrame}
					ink={PROP_INK}
					key={side}
					position={[side * 0.56, 1.0, 0]}
				>
					<boxGeometry args={[0.12, 2.0, 0.16]} />
				</ToonMesh>
			))}
			<ToonMesh
				castShadow
				color={art.doorFrame}
				ink={PROP_INK}
				position={[0, 2.05, 0]}
			>
				<boxGeometry args={[1.24, 0.12, 0.16]} />
			</ToonMesh>
			{/* The door, hinged on the left and standing open for you. */}
			<group position={[-0.5, 0, 0]} rotation={[0, -0.7, 0]}>
				<ToonMesh
					castShadow
					color={art.door}
					ink={PROP_INK}
					position={[0.5, 0.99, 0]}
				>
					<boxGeometry args={[0.98, 1.96, 0.06]} />
				</ToonMesh>
				<ToonMesh color={art.clockHand} position={[0.86, 0.98, 0.06]}>
					<sphereGeometry args={[0.04, 10, 8]} />
				</ToonMesh>
			</group>
			{/* The wall clock over the door. */}
			<group position={[0, 2.42, 0.02]}>
				<ToonMesh
					color={art.clockFace}
					ink={PROP_INK}
					rotation={[Math.PI / 2, 0, 0]}
				>
					<cylinderGeometry args={[0.24, 0.24, 0.05, 24]} />
				</ToonMesh>
				<group rotation={[0, 0, hourTurn]}>
					<ToonMesh color={art.clockHand} position={[0, 0.06, 0.035]}>
						<boxGeometry args={[0.035, 0.13, 0.01]} />
					</ToonMesh>
				</group>
				<group rotation={[0, 0, minuteTurn]}>
					<ToonMesh color={art.clockHand} position={[0, 0.09, 0.04]}>
						<boxGeometry args={[0.022, 0.19, 0.01]} />
					</ToonMesh>
				</group>
			</group>
		</group>
	);
}

/** Your inbox tray on a little side table by the door. */
export function InboxTray({ art, at }: { art: WorkersArt; at: Vec3 }) {
	return (
		<group position={at} rotation={[0, FACE_CAMERA, 0]}>
			<ToonMesh
				castShadow
				color={art.counterTop}
				ink={PROP_INK}
				position={[0, 0.56, 0]}
			>
				<boxGeometry args={[0.8, 0.05, 0.55]} />
			</ToonMesh>
			{[-1, 1].map((side) => (
				<ToonMesh
					color={art.deskLeg}
					key={side}
					position={[side * 0.32, 0.27, 0]}
				>
					<boxGeometry args={[0.05, 0.54, 0.45]} />
				</ToonMesh>
			))}
			<ToonMesh color={art.inbox} ink={PROP_INK} position={[0, 0.6, 0]}>
				<boxGeometry args={[0.7, 0.03, 0.46]} />
			</ToonMesh>
			{[
				[0, 0.23],
				[0, -0.23],
			].map(([x, z]) => (
				<ToonMesh color={art.inbox} key={z} position={[x ?? 0, 0.64, z ?? 0]}>
					<boxGeometry args={[0.7, 0.08, 0.03]} />
				</ToonMesh>
			))}
		</group>
	);
}
