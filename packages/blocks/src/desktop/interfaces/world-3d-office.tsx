/* eslint-disable react/no-unknown-property */
import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { roundedTile } from "./game3d-island.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import {
	type AgentSwatch,
	OFFICE_PALETTE,
	swatchOf,
	type Vec3,
} from "./game3d-palette.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import type { VillageHouse, VillageLayout } from "./world-village.ts";

/**
 * Office theme: every agent gets a cubicle pod on its 3x2 plot instead of a
 * cottage. Partitions are upholstered in the agent's color, the desk faces
 * the open side, and the monitors glow while the agent is working.
 */

const PANEL_HEIGHT = 1;
const POD_WIDTH = 2.8;
const POD_BACK = -0.85;
const DESK_Y = 0.74;
const DESK_Z = -0.42;
const SCREEN_Y = 1.12;
const SCREEN_Z = -0.6;

const {
	aluminum: ALUMINUM,
	bezel: BEZEL,
	chair: CHAIR,
	deskLeg: DESK_LEG,
	deskTop: DESK_TOP,
	keyboard: KEYBOARD,
	leaves: LEAVES,
	mug: MUG,
	pot: POT,
	screenOff: SCREEN_OFF,
	screenOn: SCREEN_ON,
} = OFFICE_PALETTE;

interface PodParts {
	boxes: InstanceSpec[];
	leaves: InstanceSpec[];
	round: InstanceSpec[];
	/** A soft rug under each desk, in a pale tint of the agent's color. */
	rugs: InstanceSpec[];
	screens: InstanceSpec[];
}

function podOrigin(layout: WorldLayout, house: VillageHouse): Vec3 {
	return tileToWorld(layout, {
		x: house.x + (house.w - 1) / 2,
		y: house.y + (house.h - 1) / 2,
	});
}

function at(origin: Vec3, local: Vec3): Vec3 {
	return [origin[0] + local[0], origin[1] + local[1], origin[2] + local[2]];
}

function addPartitions(parts: PodParts, origin: Vec3, swatch: AgentSwatch) {
	const sideDepth = 1.4;
	const sideZ = POD_BACK + sideDepth / 2;
	parts.boxes.push(
		{
			color: swatch.roof[0],
			position: at(origin, [0, PANEL_HEIGHT / 2, POD_BACK]),
			scale: [POD_WIDTH, PANEL_HEIGHT, 0.08],
		},
		{
			color: ALUMINUM,
			position: at(origin, [0, PANEL_HEIGHT + 0.02, POD_BACK]),
			scale: [POD_WIDTH + 0.04, 0.05, 0.12],
		}
	);
	for (const side of [-1, 1]) {
		const x = side * (POD_WIDTH / 2);
		parts.boxes.push(
			{
				color: swatch.roof[1],
				position: at(origin, [x, PANEL_HEIGHT / 2, sideZ]),
				scale: [0.08, PANEL_HEIGHT, sideDepth],
			},
			{
				color: ALUMINUM,
				position: at(origin, [x, PANEL_HEIGHT + 0.02, sideZ]),
				scale: [0.12, 0.05, sideDepth + 0.04],
			}
		);
	}
}

function addDesk(parts: PodParts, origin: Vec3, working: boolean) {
	parts.boxes.push({
		color: DESK_TOP,
		position: at(origin, [0, DESK_Y, DESK_Z]),
		scale: [2.5, 0.06, 0.7],
	});
	for (const side of [-1, 1]) {
		parts.boxes.push({
			color: DESK_LEG,
			position: at(origin, [side * 1.15, DESK_Y / 2, DESK_Z]),
			scale: [0.05, DESK_Y, 0.62],
		});
	}
	for (const x of [-0.5, 0.5]) {
		parts.boxes.push(
			{
				color: BEZEL,
				position: at(origin, [x, DESK_Y + 0.04, SCREEN_Z]),
				scale: [0.24, 0.02, 0.16],
			},
			{
				color: BEZEL,
				position: at(origin, [x, DESK_Y + 0.15, SCREEN_Z]),
				scale: [0.05, 0.22, 0.05],
			},
			{
				color: BEZEL,
				position: at(origin, [x, SCREEN_Y, SCREEN_Z]),
				rotation: [0, -x * 0.3, 0],
				scale: [0.66, 0.4, 0.04],
			}
		);
		parts.screens.push({
			color: working ? SCREEN_ON : SCREEN_OFF,
			position: at(origin, [x * 0.995, SCREEN_Y, SCREEN_Z + 0.022]),
			rotation: [0, -x * 0.3, 0],
			scale: [0.58, 0.32, 0.01],
		});
	}
	parts.boxes.push({
		color: KEYBOARD,
		position: at(origin, [0, DESK_Y + 0.04, DESK_Z + 0.16]),
		scale: [0.46, 0.02, 0.14],
	});
	parts.round.push({
		color: MUG,
		position: at(origin, [0.95, DESK_Y + 0.08, DESK_Z + 0.1]),
		scale: [0.05, 0.1, 0.05],
	});
}

function addChairAndPlant(parts: PodParts, origin: Vec3) {
	parts.boxes.push(
		{
			color: CHAIR,
			position: at(origin, [0, 0.46, 0.05]),
			scale: [0.44, 0.08, 0.42],
		},
		{
			color: CHAIR,
			position: at(origin, [0, 0.76, 0.26]),
			rotation: [-0.12, 0, 0],
			scale: [0.42, 0.5, 0.07],
		},
		{
			color: BEZEL,
			position: at(origin, [0, 0.22, 0.05]),
			scale: [0.05, 0.44, 0.05],
		}
	);
	parts.round.push({
		color: POT,
		position: at(origin, [1.12, 0.14, 0.42]),
		scale: [0.14, 0.28, 0.14],
	});
	parts.leaves.push(
		{
			color: LEAVES,
			position: at(origin, [1.12, 0.46, 0.42]),
			rotation: [0.4, 1, 0],
			scale: [0.24, 0.26, 0.24],
		},
		{
			color: LEAVES,
			position: at(origin, [1.06, 0.66, 0.38]),
			rotation: [1, 0.3, 0],
			scale: [0.15, 0.18, 0.15],
		}
	);
}

function buildPods(
	layout: WorldLayout,
	village: VillageLayout,
	working: ReadonlySet<string>,
	swatches: ReadonlyMap<string, AgentSwatch>
): PodParts {
	const parts: PodParts = {
		boxes: [],
		leaves: [],
		round: [],
		rugs: [],
		screens: [],
	};
	for (const house of village.houses) {
		const origin = podOrigin(layout, house);
		const swatch = swatchOf(swatches, house.agentId);
		parts.rugs.push(
			{
				color: swatch.tint,
				position: at(origin, [0, 0.008, 0.05]),
				scale: [POD_WIDTH + 0.2, 0.016, 2.1],
			},
			{
				color: MUG,
				position: at(origin, [0, 0.012, 0.05]),
				scale: [POD_WIDTH - 0.1, 0.016, 1.8],
			},
			{
				color: swatch.tint,
				position: at(origin, [0, 0.016, 0.05]),
				scale: [POD_WIDTH - 0.3, 0.016, 1.6],
			}
		);
		addPartitions(parts, origin, swatch);
		addDesk(parts, origin, working.has(house.agentId));
		addChairAndPlant(parts, origin);
	}
	return parts;
}

/** A rug: a rounded rectangle, one unit across and one tall. */
const RUG_SHAPE = roundedTile(0.22, 5);

function MeshRug() {
	return (
		<bufferGeometry>
			<bufferAttribute
				args={[RUG_SHAPE.position, 3]}
				attach="attributes-position"
			/>
			<bufferAttribute
				args={[RUG_SHAPE.normal, 3]}
				attach="attributes-normal"
			/>
			<bufferAttribute args={[RUG_SHAPE.index, 1]} attach="index" />
		</bufferGeometry>
	);
}

export function OfficePods({
	layout,
	swatches,
	village,
	working,
}: {
	layout: WorldLayout;
	swatches: ReadonlyMap<string, AgentSwatch>;
	village: VillageLayout;
	working: ReadonlySet<string>;
}) {
	const parts = useMemo(
		() => buildPods(layout, village, working, swatches),
		[layout, swatches, village, working]
	);
	return (
		<group>
			<InstancedParts castShadow ink={0.02} items={parts.boxes} receiveShadow>
				<boxGeometry />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={0.02} items={parts.round} receiveShadow>
				<cylinderGeometry args={[1, 0.8, 1, 16]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={0.024} items={parts.leaves}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.rugs} receiveShadow>
				<MeshRug />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.screens}>
				<boxGeometry />
				<CurvedBasicMaterial color={[1.5, 1.5, 1.5]} toneMapped={false} />
			</InstancedParts>
		</group>
	);
}
