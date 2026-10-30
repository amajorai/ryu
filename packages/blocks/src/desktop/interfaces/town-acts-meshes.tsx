import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { limitWords } from "./game3d-act-stage.tsx";
import type { YouSpotSlot } from "./game3d-acts.ts";
import { LimitCue } from "./game3d-alarm.tsx";
import { ProgressPips3D, WaitTimer3D } from "./game3d-meters.tsx";
import { NextSign } from "./game3d-signs.tsx";
import {
	CLOCK_TOWER,
	doorOf,
	HALL_SPOTS,
	oldestBlockingAsk,
	townLimitText,
} from "./town-acts-spots.tsx";
import type { Vec3 } from "./town-art.tsx";
import { PAD_Y } from "./town-buildings.tsx";
import { LOT, type Town } from "./town-model.ts";

/** The kit's meshes are villager-sized: the town draws them at its folk scale. */
const PROP_SCALE = 0.72;

const unscaled = ([x, y, z]: Vec3): Vec3 => [
	x / PROP_SCALE,
	y / PROP_SCALE,
	z / PROP_SCALE,
];

/**
 * The act layer's meshes in the town's own canvas (spec §5 town row); the
 * DOM buttons in the overlay stay their targets. Per building: scaffold
 * pips for the plan's steps, a billboard for the next step, a "Closed"
 * sign on a limited agent's door. At City Hall: a petition letter on a
 * post for each notice in the queue, the clock tower's hourglass showing
 * the oldest blocking wait, and a delivery crate per answer at the inbox.
 */
export function TownActMeshes({
	acts,
	clock,
	nowMs,
	palette,
	reduced,
	slots,
	snapshot,
	town,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	palette: { craneDark: string; crane: string; lotPad: string };
	reduced: boolean;
	slots: readonly YouSpotSlot[];
	snapshot: Pick<InterfaceSnapshot, "asks">;
	town: Town;
}) {
	const oldest = oldestBlockingAsk(snapshot.asks);
	const delivering = [...acts.values()].filter(
		(act) => act.act === "delivering" && act.ask
	);
	return (
		<group scale={PROP_SCALE}>
			{town.buildings.map((building) => {
				const act = acts.get(building.agent.id);
				if (!act) {
					return null;
				}
				const { x, z } = building.lot;
				return (
					<group key={building.agent.id}>
						<ProgressPips3D
							at={unscaled([x - LOT * 0.42, PAD_Y + 0.05, z + LOT * 0.46])}
							progress={act.progress}
							reducedMotion={reduced}
							showText={false}
							skin={{
								done: palette.crane,
								estimate: palette.crane,
								todo: palette.lotPad,
							}}
						/>
						<NextSign
							at={unscaled([x - LOT * 0.42, PAD_Y, z - LOT * 0.1])}
							showText={false}
							text={act.next}
						/>
						{act.act === "limited" ? (
							<LimitCue
								at={unscaled(doorOf(building))}
								showText={false}
								text={limitWords(act, {
									clock,
									limitText: townLimitText,
									nowMs,
								})}
							/>
						) : null}
					</group>
				);
			})}
			{slots.map((slot, index) => {
				if (slot.carrier !== "notice") {
					return null;
				}
				const at = HALL_SPOTS.slots[index] ?? HALL_SPOTS.you;
				return (
					<group key={slot.ask.id} position={unscaled(at)}>
						<mesh castShadow position={[0, 0.35, 0]}>
							<cylinderGeometry args={[0.04, 0.05, 0.7, 8]} />
							<meshStandardMaterial color={palette.craneDark} />
						</mesh>
						<mesh castShadow position={[0, 0.72, 0.03]}>
							<boxGeometry args={[0.32, 0.22, 0.03]} />
							<meshStandardMaterial color={palette.lotPad} />
						</mesh>
					</group>
				);
			})}
			{oldest ? (
				<WaitTimer3D
					at={unscaled(CLOCK_TOWER)}
					nowMs={nowMs}
					reducedMotion={reduced}
					timer={{
						approx: oldest.sinceApprox,
						since: oldest.since,
						until: oldest.expiresAt ?? null,
						untilApprox: oldest.expiresApprox,
					}}
				/>
			) : null}
			{delivering.map((act, index) => (
				<mesh
					castShadow
					key={act.agentId}
					position={unscaled([
						HALL_SPOTS.tray[0] + index * 0.6,
						PAD_Y + 0.14,
						HALL_SPOTS.tray[2] + index * 0.3,
					])}
				>
					<boxGeometry args={[0.38, 0.28, 0.38]} />
					<meshStandardMaterial color={palette.crane} />
				</mesh>
			))}
		</group>
	);
}
