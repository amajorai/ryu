/* eslint-disable react/no-unknown-property */
import { Html, RoundedBox } from "@react-three/drei";
import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import type { StationLayout } from "./game3d-act-stage.tsx";
import {
	bubbleOverlayId,
	type OffStage,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { LifeBubbleTag } from "./game3d-life.tsx";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	LampPosts,
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	isWorkBubble,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	coffeeOf,
	type DeskActivity,
	deskActivity,
	doorLayout,
	doorSpots,
	officePaths,
	plateBubble,
	screenActivity,
	WORKER_TOOLS,
	WorkerDeskActs,
	type WorkersActHandlers,
	WorkersDoorActs,
	workerLife,
} from "./workers-acts.tsx";
import {
	CHAIR_OUT,
	DESK_DEPTH,
	type OfficeDesk,
	type OfficePlan,
	WORKER_STATE_LABELS,
	type WorkerState,
	type WorkerView,
} from "./workers-model.ts";
import { swatch, type WorkersArt } from "./workers-palette.ts";
import { deskLabel, StatusLight, screenTitle } from "./workers-status.tsx";

/**
 * Workers as an isometric diorama on the game kit (game3d-stage.tsx): a
 * cut-away open-plan office on the island, its back and left walls lined
 * with big windows, a whiteboard and a bookshelf, on a plank floor with a
 * rug. Every agent is a villager at its own desk, on an office chair before
 * a monitor whose screen glows in its conversation's colour (working,
 * waiting on you, a failed run, or a dim screensaver when idle), with the
 * conversation's title on a small screen plate. Working villagers face
 * their screen; one with a reply for you, or a failed run, turns round to
 * the room. Potted plants, desk lamps (lit at night) and a coffee corner
 * fill the office; lawn, trees and lamps sit outside.
 */

const SLAB = 0.16;
const WALL_HEIGHT = 2.3;
const WALL_THICK = 0.18;
/** Desk and chair, at villager scale: a chibi's torso shows over the desk. */
const DESK_TOP = 0.56;
const DESK_WIDTH = 1.5;
const SEAT = 0.3;
/** The monitor's screen: centre height over the floor, width and height. */
const SCREEN_Y = 1.3;
const SCREEN: [number, number] = [0.82, 0.48];
export const OFFICE_RIM = 2.6;

const NO_SHOWN: ReadonlySet<string> = new Set();

/** A worker's villager pose from its state. */
export function workerPose(state: WorkerState): VillagerPose {
	if (state === "attention") {
		return "failed";
	}
	if (state === "your-turn") {
		return "needs-you";
	}
	return state === "working" ? "working" : "idle";
}

/** The chair sits a little right of the screen: it shows over a shoulder. */
const SEAT_X = 0.3;
/** Desks are turned to face the camera, so screens show over shoulders. */
const DESK_YAW = FACE_CAMERA;

/** Facing the screen (back to the camera) or turned round to the room. */
function facingOf(state: WorkerState): number {
	return state === "working" || state === "idle"
		? DESK_YAW + Math.PI
		: FACE_CAMERA;
}

/** A desk-frame point (chair toward +z) in the world. */
function deskPoint(x: number, z: number, local: Vec3): Vec3 {
	return turned([x, 0, z], DESK_YAW, local);
}

/** Turns `local` by `yaw` about the vertical axis and moves it to `at`. */
function turned(at: Vec3, yaw: number, local: Vec3): Vec3 {
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return [
		at[0] + local[0] * cos + local[2] * sin,
		at[1] + local[1],
		at[2] - local[0] * sin + local[2] * cos,
	];
}

interface DeskParts {
	bezels: InstanceSpec[];
	cabinets: InstanceSpec[];
	chairBacks: InstanceSpec[];
	chairBases: InstanceSpec[];
	chairSeats: InstanceSpec[];
	drawers: InstanceSpec[];
	keyboards: InstanceSpec[];
	/** Keys lit while the worker types (edits or writes). */
	keyGlows: InstanceSpec[];
	lampBulbs: Vec3[];
	lampShades: InstanceSpec[];
	legs: InstanceSpec[];
	mugs: InstanceSpec[];
	plants: PlacedBush[];
	pots: InstanceSpec[];
	screens: InstanceSpec[];
	/** A terminal's lines of text on its screen. */
	terminalLines: InstanceSpec[];
	tops: InstanceSpec[];
}

/** The filing cabinet beside each desk, in the desk's frame. */
const CABINET: Vec3 = [1.0, 0, -0.12];
const CABINET_SIZE: Vec3 = [0.36, 0.66, 0.5];

function buildDesks(
	desks: readonly OfficeDesk[],
	art: WorkersArt,
	activity: ReadonlyMap<string, DeskActivity> | null
): DeskParts {
	const parts: DeskParts = {
		bezels: [],
		cabinets: [],
		drawers: [],
		keyGlows: [],
		chairBacks: [],
		chairBases: [],
		chairSeats: [],
		keyboards: [],
		lampBulbs: [],
		lampShades: [],
		legs: [],
		mugs: [],
		plants: [],
		pots: [],
		screens: [],
		terminalLines: [],
		tops: [],
	};
	for (const [index, { worker, x, z }] of desks.entries()) {
		const y = SLAB;
		// Each desk is laid out in its own frame (the chair toward +z) and
		// turned to face the camera, so its screen shows over its worker.
		const at: Vec3 = [x, 0, z];
		const p = (local: Vec3): Vec3 => turned(at, DESK_YAW, local);
		const turn: Vec3 = [0, DESK_YAW, 0];
		const box = (local: Vec3, scale: Vec3, color?: string): InstanceSpec => ({
			color,
			position: p(local),
			rotation: turn,
			scale,
		});
		parts.tops.push(
			box([0, y + DESK_TOP - 0.03, 0], [DESK_WIDTH, 0.06, DESK_DEPTH])
		);
		for (const side of [-1, 1]) {
			parts.legs.push(
				box(
					[side * (DESK_WIDTH / 2 - 0.08), y + DESK_TOP / 2, 0],
					[0.06, DESK_TOP, DESK_DEPTH - 0.1]
				)
			);
		}
		// The monitor on its stand at the back of the desk, facing the chair.
		const mz = -DESK_DEPTH / 2 + 0.16;
		parts.bezels.push(
			box([0, y + SCREEN_Y, mz], [SCREEN[0] + 0.08, SCREEN[1] + 0.08, 0.06]),
			box(
				[0, y + (DESK_TOP + SCREEN_Y) / 2 - 0.1, mz - 0.03],
				[0.06, SCREEN_Y - DESK_TOP - 0.1, 0.05]
			),
			box([0, y + DESK_TOP + 0.015, mz - 0.02], [0.3, 0.03, 0.18])
		);
		// The screen glows in the worker's state; a run shows a terminal.
		const doing = activity?.get(worker.id) ?? null;
		parts.screens.push(
			box(
				[0, y + SCREEN_Y, mz + 0.035],
				[SCREEN[0], SCREEN[1], 0.01],
				doing === "terminal" ? art.terminal : art.screen[worker.state]
			)
		);
		if (doing === "terminal") {
			for (const [line, width] of [0.42, 0.3, 0.52].entries()) {
				parts.terminalLines.push(
					box(
						[
							width / 2 - SCREEN[0] / 2 + 0.08,
							y + SCREEN_Y + 0.12 - line * 0.1,
							mz + 0.042,
						],
						[width, 0.035, 0.004],
						art.terminalText
					)
				);
			}
		}
		// The filing cabinet: its top drawer slides out while the worker reads.
		if (activity) {
			parts.cabinets.push(
				box([CABINET[0], y + CABINET_SIZE[1] / 2, CABINET[2]], CABINET_SIZE)
			);
			const open = doing === "cabinet" ? 0.3 : 0;
			for (const [drawer, height] of [0.5, 0.2].entries()) {
				const out = drawer === 0 ? open : 0;
				parts.drawers.push(
					box(
						[
							CABINET[0],
							y + height,
							CABINET[2] + CABINET_SIZE[2] / 2 + out / 2 - 0.005,
						],
						[CABINET_SIZE[0] - 0.06, 0.2, 0.02 + out]
					)
				);
			}
		}
		parts.keyboards.push(
			box([-0.05, y + DESK_TOP + 0.015, 0.12], [0.5, 0.025, 0.16])
		);
		if (doing === "typing") {
			parts.keyGlows.push(
				box(
					[-0.05, y + DESK_TOP + 0.03, 0.12],
					[0.44, 0.006, 0.12],
					art.screen.working
				)
			);
		}
		parts.mugs.push(
			box(
				[0.52, y + DESK_TOP + 0.07, 0.1],
				[0.06, 0.12, 0.06],
				swatch(art.mugs, index)
			)
		);
		// Every other desk a little plant, the rest a desk lamp.
		if (index % 2 === 0) {
			parts.pots.push(
				box([-0.58, y + DESK_TOP + 0.07, -0.12], [0.08, 0.14, 0.08])
			);
			parts.plants.push({
				at: p([-0.58, y + DESK_TOP + 0.1, -0.12]),
				scale: 0.42,
				seed: index * 5 + 2,
			});
		} else {
			parts.lampShades.push(
				box([-0.58, y + DESK_TOP + 0.36, -0.14], [0.14, 0.12, 0.14])
			);
			parts.legs.push(
				box([-0.58, y + DESK_TOP + 0.15, -0.2], [0.025, 0.3, 0.025])
			);
			parts.lampBulbs.push(p([-0.58, y + DESK_TOP + 0.3, -0.14]));
		}
		// The office chair, turned with its worker.
		const yaw = facingOf(worker.state);
		const seat = p([SEAT_X, y, CHAIR_OUT]);
		parts.chairSeats.push({
			position: [seat[0], y + SEAT - 0.04, seat[2]],
			rotation: [0, yaw, 0],
			scale: [0.42, 0.08, 0.4],
		});
		parts.chairBacks.push({
			position: turned([seat[0], y, seat[2]], yaw, [0, SEAT + 0.24, -0.2]),
			rotation: [0, yaw, 0],
			scale: [0.4, 0.42, 0.07],
		});
		parts.chairBases.push(
			{
				position: [seat[0], y + SEAT / 2 - 0.04, seat[2]],
				scale: [0.04, SEAT - 0.08, 0.04],
			},
			{
				position: [seat[0], y + 0.03, seat[2]],
				scale: [0.3, 0.04, 0.3],
			}
		);
	}
	return parts;
}

/** The desks, monitors, chairs and desk clutter, every part instanced. */
function Desks({
	activity,
	art,
	desks,
	night,
	theme,
}: {
	/** With acts, each desk's activity (and a filing cabinet per desk). */
	activity: ReadonlyMap<string, DeskActivity> | null;
	art: WorkersArt;
	desks: readonly OfficeDesk[];
	night: boolean;
	theme: Scene3dTheme;
}) {
	const parts = useMemo(
		() => buildDesks(desks, art, activity),
		[activity, art, desks]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={art.deskLeg}
				items={parts.tops}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.deskTop} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.legs}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.deskLeg} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.bezel}
				items={parts.bezels}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bezel} />
			</InstancedParts>
			<InstancedParts items={parts.screens}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={parts.keyGlows}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={parts.terminalLines}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.chairBase}
				items={parts.cabinets}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cabinet} />
			</InstancedParts>
			<InstancedParts items={parts.drawers}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cabinetDrawer} />
			</InstancedParts>
			<InstancedParts items={parts.keyboards}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.keyboard} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.mugs}>
				<cylinderGeometry args={[1, 0.85, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.pots}>
				<cylinderGeometry args={[1, 0.75, 1, 12]} />
				<ToonMaterial color={art.pot} />
			</InstancedParts>
			<Bushes bushes={parts.plants} theme={theme} />
			<InstancedParts castShadow items={parts.lampShades}>
				<coneGeometry args={[1, 1, 14, 1, true]} />
				<ToonMaterial color={art.lampShade} side={2} />
			</InstancedParts>
			<InstancedParts
				items={parts.lampBulbs.map((at) => ({ position: at, scale: 0.05 }))}
			>
				<sphereGeometry args={[1, 10, 8]} />
				{night ? (
					<CurvedBasicMaterial color={art.lampBulb} toneMapped={false} />
				) : (
					<ToonMaterial color={art.lampBulb} />
				)}
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.chairBase}
				items={parts.chairSeats}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.chair} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.chairBase}
				items={parts.chairBacks}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.chair} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.chairBases}>
				<cylinderGeometry args={[1, 1, 1, 10]} />
				<ToonMaterial color={art.chairBase} />
			</InstancedParts>
			{night
				? parts.lampBulbs
						.slice(0, 4)
						.map((at) => (
							<pointLight
								color={art.lampBulb}
								decay={2}
								distance={3}
								intensity={1.2}
								key={`${at[0]}:${at[2]}`}
								position={[at[0], at[1] + 0.2, at[2] + 0.2]}
							/>
						))
				: null}
		</group>
	);
}

const PLANK = 1.8;
const BOARD = 0.42;

/** Staggered floor boards in two tones, clipped to the room. */
function plankRows(plan: OfficePlan, art: WorkersArt): InstanceSpec[] {
	const planks: InstanceSpec[] = [];
	const { halfDepth, halfWidth } = plan;
	const rows = Math.floor((halfDepth * 2) / BOARD);
	for (let row = 0; row < rows; row++) {
		const z = -halfDepth + BOARD / 2 + row * BOARD;
		const start = -halfWidth - (row % 2 ? PLANK / 2 : 0);
		for (let x = start, seed = row; x < halfWidth; x += PLANK, seed++) {
			const from = Math.max(x, -halfWidth);
			const to = Math.min(x + PLANK, halfWidth);
			if (to - from < 0.05) {
				continue;
			}
			planks.push({
				color: art.floor[seed % 2],
				position: [(from + to) / 2, SLAB + 0.004, z],
				scale: [to - from - 0.02, 0.012, BOARD - 0.02],
			});
		}
	}
	return planks;
}

/** Window panes along a wall: frames, mullions and glass. */
function windowsAlong(
	plan: OfficePlan,
	wall: "back" | "left"
): { frames: InstanceSpec[]; glass: InstanceSpec[] } {
	const frames: InstanceSpec[] = [];
	const glass: InstanceSpec[] = [];
	const span = wall === "back" ? plan.halfWidth : plan.halfDepth;
	const count = Math.max(2, Math.floor((span * 2) / 1.7));
	const pitch = (span * 2) / count;
	const bottom = SLAB + 0.8;
	const height = 1.25;
	for (let index = 0; index < count; index++) {
		const along = -span + pitch * (index + 0.5);
		const width = pitch - 0.5;
		const at: Vec3 =
			wall === "back"
				? [along, bottom + height / 2, -plan.halfDepth + WALL_THICK / 2 + 0.01]
				: [-plan.halfWidth + WALL_THICK / 2 + 0.01, bottom + height / 2, along];
		const size = (w: number, h: number, d: number): Vec3 =>
			wall === "back" ? [w, h, d] : [d, h, w];
		frames.push({
			position: at,
			scale: size(width + 0.12, height + 0.12, 0.04),
		});
		glass.push({
			position:
				wall === "back"
					? [at[0], at[1], at[2] + 0.025]
					: [at[0] + 0.025, at[1], at[2]],
			scale: size(width, height, 0.02),
		});
		// A mullion down the middle and a transom across.
		frames.push(
			{
				position:
					wall === "back"
						? [at[0], at[1], at[2] + 0.04]
						: [at[0] + 0.04, at[1], at[2]],
				scale: size(0.05, height, 0.02),
			},
			{
				position:
					wall === "back"
						? [at[0], at[1] + height * 0.22, at[2] + 0.04]
						: [at[0] + 0.04, at[1] + height * 0.22, at[2]],
				scale: size(width, 0.05, 0.02),
			}
		);
	}
	return { frames, glass };
}

/** The cut-away room: slab, plank floor, rug, walls, windows, whiteboard. */
function Room({
	art,
	night,
	plan,
}: {
	art: WorkersArt;
	night: boolean;
	plan: OfficePlan;
}) {
	const { halfDepth, halfWidth, rug } = plan;
	const planks = useMemo(() => plankRows(plan, art), [art, plan]);
	const panes = useMemo(() => {
		const back = windowsAlong(plan, "back");
		const left = windowsAlong(plan, "left");
		return {
			frames: [...back.frames, ...left.frames],
			glass: [...back.glass, ...left.glass],
		};
	}, [plan]);
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={art.floorEdge} />
			</RoundedBox>
			<InstancedParts items={planks} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<RoundedBox
				args={[rug.halfWidth * 2 + 0.2, 0.02, rug.halfDepth * 2 + 0.2]}
				position={[rug.x, SLAB + 0.014, rug.z]}
				radius={0.01}
				receiveShadow
			>
				<ToonMaterial color={art.rugBorder} />
			</RoundedBox>
			<RoundedBox
				args={[rug.halfWidth * 2, 0.024, rug.halfDepth * 2]}
				position={[rug.x, SLAB + 0.016, rug.z]}
				radius={0.01}
				receiveShadow
			>
				<ToonMaterial color={art.rug} />
			</RoundedBox>
			{/* Back and left walls: painted upper wall over a wainscot. */}
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, -halfDepth]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[0, SLAB + 0.36, -halfDepth + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.72, 0.02]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[-halfWidth, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[-halfWidth + WALL_THICK / 2 + 0.01, SLAB + 0.36, 0]}
			>
				<boxGeometry args={[0.02, 0.72, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<InstancedParts items={panes.frames}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.windowFrame} />
			</InstancedParts>
			<InstancedParts items={panes.glass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial
					color={art.window}
					emissive={art.window}
					emissiveIntensity={night ? 0.5 : 0.35}
				/>
			</InstancedParts>
		</group>
	);
}

/** The bistro table's offset from the coffee counter, and its top. */
const BISTRO: [number, number] = [0.1, 1.35];
const BISTRO_TOP = 0.53;

/** The coffee corner: a counter with a machine and mugs, a water cooler, a bistro table. */
function CoffeeCorner({
	art,
	at,
}: {
	art: WorkersArt;
	at: { x: number; z: number };
}) {
	const y = SLAB;
	const mugs = useMemo<InstanceSpec[]>(
		() =>
			[0, 1, 2].map((index) => ({
				color: swatch(art.mugs, index + 1),
				position: [at.x + 0.25 + index * 0.17, y + 0.68, at.z + 0.05],
				scale: [0.05, 0.1, 0.05],
			})),
		[art, at, y]
	);
	return (
		<group>
			<ToonMesh
				castShadow
				color={art.counter}
				ink={PROP_INK}
				position={[at.x, y + 0.3, at.z]}
				receiveShadow
			>
				<boxGeometry args={[1.7, 0.6, 0.6]} />
			</ToonMesh>
			<ToonMesh color={art.counterTop} position={[at.x, y + 0.62, at.z]}>
				<boxGeometry args={[1.78, 0.05, 0.66]} />
			</ToonMesh>
			{/* The coffee machine, its drip tray and a fresh cup. */}
			<ToonMesh
				castShadow
				color={art.machine}
				ink={PROP_INK}
				position={[at.x - 0.45, y + 0.86, at.z - 0.05]}
			>
				<boxGeometry args={[0.42, 0.44, 0.36]} />
			</ToonMesh>
			<ToonMesh
				color={art.coffee}
				position={[at.x - 0.45, y + 0.72, at.z + 0.1]}
			>
				<cylinderGeometry args={[0.05, 0.04, 0.09, 12]} />
			</ToonMesh>
			<InstancedParts castShadow items={mugs}>
				<cylinderGeometry args={[1, 0.85, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			{/* A water cooler beside the counter. */}
			<group position={[at.x + 1.15, y, at.z + 0.05]}>
				<ToonMesh
					castShadow
					color={art.counterTop}
					ink={PROP_INK}
					position={[0, 0.4, 0]}
				>
					<boxGeometry args={[0.34, 0.8, 0.34]} />
				</ToonMesh>
				<ToonMesh color={art.water} position={[0, 0.98, 0]}>
					<cylinderGeometry args={[0.15, 0.15, 0.36, 16]} />
				</ToonMesh>
			</group>
			{/* A round bistro table with two stools in front. */}
			<group position={[at.x + BISTRO[0], y, at.z + BISTRO[1]]}>
				<ToonMesh
					castShadow
					color={art.counterTop}
					ink={PROP_INK}
					position={[0, 0.5, 0]}
				>
					<cylinderGeometry args={[0.34, 0.34, 0.05, 20]} />
				</ToonMesh>
				<ToonMesh color={art.chairBase} position={[0, 0.25, 0]}>
					<cylinderGeometry args={[0.035, 0.035, 0.5, 8]} />
				</ToonMesh>
				{[-1, 1].map((side) => (
					<ToonMesh
						castShadow
						color={art.counter}
						key={side}
						position={[side * 0.55, 0.2, 0.05]}
					>
						<cylinderGeometry args={[0.15, 0.13, 0.4, 14]} />
					</ToonMesh>
				))}
			</group>
		</group>
	);
}

/** A bookshelf and a whiteboard along the left wall. */
function LeftWall({ art, plan }: { art: WorkersArt; plan: OfficePlan }) {
	const x = -plan.halfWidth + WALL_THICK / 2;
	const shelfZ = plan.halfDepth - 1.0;
	const books = useMemo<InstanceSpec[]>(() => {
		const items: InstanceSpec[] = [];
		for (const [level, y] of [0.42, 0.86, 1.3].entries()) {
			for (let index = 0; index < 7; index++) {
				if (jitter(index, level, 4) < 0.2) {
					continue;
				}
				const tall = 0.24 + jitter(index, level, 6) * 0.1;
				items.push({
					color: swatch(art.books, index + level * 2),
					position: [
						x + 0.2,
						SLAB + y + tall / 2,
						shelfZ - 0.42 + index * 0.13,
					],
					scale: [0.22, tall, 0.1],
				});
			}
		}
		return items;
	}, [art, shelfZ, x]);
	return (
		<group>
			<ToonMesh
				castShadow
				color={art.shelf}
				ink={PROP_INK}
				position={[x + 0.2, SLAB + 0.85, shelfZ]}
				receiveShadow
			>
				<boxGeometry args={[0.32, 1.7, 1.05]} />
			</ToonMesh>
			{[0.4, 0.84, 1.28].map((y) => (
				<ToonMesh
					color={art.counterTop}
					key={y}
					position={[x + 0.37, SLAB + y, shelfZ]}
				>
					<boxGeometry args={[0.02, 0.04, 1.0]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow items={books}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
		</group>
	);
}

/** Tall potted plants in the room's corners and by the windows. */
function cornerPlants(plan: OfficePlan): {
	bushes: PlacedBush[];
	pots: Vec3[];
} {
	const { halfDepth, halfWidth } = plan;
	const pots: Vec3[] = [
		[-halfWidth + 0.45, SLAB, -halfDepth + 0.45],
		[-halfWidth + 0.45, SLAB, halfDepth - 0.35],
		[halfWidth - 0.35, SLAB, halfDepth - 0.35],
	];
	const bushes: PlacedBush[] = pots.flatMap((at, index) => [
		{ at: [at[0], at[1] + 0.45, at[2]] as Vec3, scale: 1.1, seed: index + 70 },
		{ at: [at[0], at[1] + 0.8, at[2]] as Vec3, scale: 0.8, seed: index + 80 },
	]);
	return { bushes, pots };
}

/** The garden outside: trees, shrubs, flowers clear of the room. */
function garden(shape: IslandShape, plan: OfficePlan) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const inside =
				Math.abs(fx) < plan.halfWidth + 0.9 &&
				Math.abs(fz) < plan.halfDepth + 1.1;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			const front = fz > plan.halfDepth || fx > plan.halfWidth;
			if (!front && hash < 0.6) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.25 ? "cedar" : hash > 0.5 ? "blossom" : "fruit",
					scale: 0.85 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.3 && front) {
				trees.push({
					at: [fx, 0, fz],
					kind: "fruit",
					scale: 0.8,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.62) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.82) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

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
function OfficeDoor({
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

/** The inbox tray's top, over the floor: folders lie on it. */
const INBOX_TOP = 0.66;

/** Your inbox tray on a little side table by the door. */
function InboxTray({ art, at }: { art: WorkersArt; at: Vec3 }) {
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

/**
 * The act layer, when the host sends asks (workers-acts.tsx): workers act
 * out their acts, desks and the door carry the act props, and the
 * chair-back name plate is each agent's one target (it goes where its
 * worker stands: the door's queue while it asks, the coffee corner while
 * it rests). Without it the office is today's.
 */
export interface WorkersActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: WorkersActHandlers;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	/** What each screen plate says (the workers' `screenWords` setting). */
	screenWords?: "step" | "title";
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}

/** Where a desk's worker sits, in the world. */
function chairOf(desk: OfficeDesk): Vec3 {
	return deskPoint(desk.x, desk.z, [SEAT_X, SLAB + SEAT, CHAIR_OUT]);
}

/** A desk-frame offset, turned with the desks (for `ActStation` layouts). */
function deskOffset(local: Vec3): Vec3 {
	return turned([0, 0, 0], DESK_YAW, local);
}

/**
 * Where a desk's act props sit, in its own frame (the chair toward +z):
 * the plan pips as the bar under the monitor, the next-step note on the
 * desk, the board of words at the chair's left (a speech bubble hangs up
 * and right of the name plate), alarms beside the desk's back right
 * corner, hung right in a tight column (behind the desk no figure stands;
 * in front of it or at the chair's left they covered the next desk's
 * worker), unread answers and suggestions on the desk.
 */
const DESK_LAYOUT: Partial<StationLayout> = {
	alarms: deskOffset([1.05, 0, -0.55]),
	alarmSide: "right",
	alarmStep: [0, 0.6, 0],
	board: deskOffset([-0.8, 0.5, 1.25]),
	cue: deskOffset([SEAT_X, 0.02, CHAIR_OUT]),
	limit: deskOffset([0.55, SLAB + DESK_TOP, 0.05]),
	next: deskOffset([
		SCREEN[0] / 2 - 0.05,
		SLAB + SCREEN_Y,
		-DESK_DEPTH / 2 + 0.2,
	]),
	pips: deskOffset([
		0,
		SLAB + SCREEN_Y - SCREEN[1] / 2 - 0.12,
		-DESK_DEPTH / 2 + 0.24,
	]),
	suggestion: deskOffset([-0.6, SLAB + DESK_TOP, 0.25]),
	unread: deskOffset([-0.15, SLAB + DESK_TOP, 0.25]),
};

/**
 * Where a desk's board stands on a phone: further out in front of the
 * chair, below the name plates of the desks around it, which a phone's
 * small office packs in beside the chair.
 */
const PHONE_DESK_LAYOUT: Partial<StationLayout> = {
	...DESK_LAYOUT,
	board: deskOffset([-0.8, 0.5, 3]),
};

/** A desk's layout; a resting worker's mug stands by it in the coffee corner. */
export function deskLayout(
	desk: OfficeDesk,
	rest: Vec3 | null,
	coffee: { x: number; z: number },
	phone = false
): Partial<StationLayout> {
	if (!rest) {
		return phone ? PHONE_DESK_LAYOUT : DESK_LAYOUT;
	}
	// The worker rests in the coffee corner: its mug stands on the bistro
	// table and its words ("Back 15:10") hang beside it, not at the desk:
	// toward the wall (clear of the desks' alarms), or on a phone, where the
	// wall side runs off the stage, out over the back row clear of the name
	// plates crowding the coffee corner.
	const side = phone ? -5 : 0.75;
	return {
		...DESK_LAYOUT,
		board: [rest[0] + side - desk.x, SLAB + 0.5, rest[2] - 0.15 - desk.z],
		limit: [
			coffee.x + BISTRO[0] - desk.x,
			SLAB + BISTRO_TOP,
			coffee.z + BISTRO[1] - desk.z,
		],
	};
}

/** What a screen plate says to a screen reader, with acts. */
export function actScreenLabel(
	worker: WorkerView,
	act: InterfaceAgentAct,
	words: "step" | "title" = "step"
): string {
	return `${worker.name}'s screen: ${actScreenWords(worker, act, words) ?? "dark"}`;
}

/**
 * What a worker's screen shows with acts: its activity, but an idle worker's
 * screen shows its task's title, or nothing (never "Idle" over a desk whose
 * worker has an answer or a suggestion waiting). With `words` "title" every
 * screen with a task shows the task's title instead of the step.
 */
export function actScreenWords(
	worker: WorkerView,
	act: InterfaceAgentAct,
	words: "step" | "title" = "step"
): string | null {
	if (words === "title" && worker.current) {
		return screenTitle(worker);
	}
	if (act.act === "idle" && !act.stalled) {
		return worker.current ? screenTitle(worker) : null;
	}
	return screenActivity(act);
}

const NO_RESTS: ReadonlyMap<string, Vec3 | null> = new Map();

/**
 * The workers' DOM targets: a screen plate over each monitor (its activity
 * with acts, out of the Tab order then) and the name plate, each agent's
 * one target, hanging wherever its worker stands: on its chair back, in
 * the door's queue while it asks, in the coffee corner while it rests.
 */
export function WorkerMarkers({
	actScene,
	onOpenScreen,
	onOpenWorker,
	plan,
	rests,
	selectedId,
}: {
	actScene: WorkersActScene | null;
	onOpenScreen: (workerId: string) => void;
	onOpenWorker: (workerId: string) => void;
	plan: OfficePlan;
	/** Where resting workers stand (their coffee-corner spots). */
	rests: ReadonlyMap<string, Vec3 | null>;
	selectedId: string | null;
}) {
	const door = doorSpots(plan, SLAB);
	const shown = actScene?.handlers.shown ?? NO_SHOWN;
	const { workBubbles } = useGameKitSettings();
	/** Where a worker's name plate hangs: wherever the worker stands. */
	const plateAt = (desk: OfficeDesk, act: InterfaceAgentAct): Vec3 => {
		const slot = slotOf(actScene?.slots.slots ?? [], act.agentId);
		const queued = slot ? door.slots[Number(slot.slice(-1)) - 1] : undefined;
		if (act.act === "asking" && queued) {
			return [queued[0], queued[1] + 1.75, queued[2]];
		}
		const rest = rests.get(desk.worker.id);
		if (rest) {
			return [rest[0], rest[1] + 1.6, rest[2]];
		}
		return deskPoint(desk.x, desk.z, [SEAT_X, SLAB + 0.62, CHAIR_OUT + 0.42]);
	};
	/**
	 * Where a worker's figure is (head and feet): in its queue slot, at its
	 * resting spot, else seated on its chair. The kit's own figure probes
	 * ride villager plates, which the office draws as markers instead.
	 */
	const figureAt = (
		desk: OfficeDesk,
		act: InterfaceAgentAct
	): { feet: Vec3; head: Vec3 } => {
		const slot = slotOf(actScene?.slots.slots ?? [], act.agentId);
		const queued = slot ? door.slots[Number(slot.slice(-1)) - 1] : undefined;
		const standing =
			act.act === "asking" && queued ? queued : rests.get(desk.worker.id);
		if (standing) {
			return {
				feet: standing,
				head: [standing[0], standing[1] + FIGURE_TALL, standing[2]],
			};
		}
		return {
			feet: deskPoint(desk.x, desk.z, [SEAT_X, SLAB, CHAIR_OUT]),
			head: deskPoint(desk.x, desk.z, [SEAT_X, SLAB + SEAT + 0.95, CHAIR_OUT]),
		};
	};
	return (
		<>
			{plan.desks.map(({ worker, x, z }) => {
				const act = actScene?.acts.get(worker.id);
				if (!(worker.current || act)) {
					return null;
				}
				const words = act
					? actScreenWords(worker, act, actScene?.screenWords)
					: screenTitle(worker);
				if (words === null) {
					return null;
				}
				return (
					<IsoMarker
						at={deskPoint(x, z, [
							0,
							SLAB + SCREEN_Y + SCREEN[1] / 2 + 0.2,
							-DESK_DEPTH / 2 + 0.16,
						])}
						className="h-6 gap-1 px-2 text-[12px]"
						// With acts the name plate is each agent's one Tab stop; the
						// screen still opens its task on a click or tap.
						focusable={!act}
						icon={<StatusLight className="size-2.5" state={worker.state} />}
						iconOnly={actScene?.handlers.iconOnly ?? false}
						key={worker.id}
						label={
							act
								? `${actScreenLabel(worker, act, actScene?.screenWords)}. ${worker.current ? "Open the task" : "Open their desk"}`
								: screenLabel(worker)
						}
						onSelect={() => onOpenScreen(worker.id)}
					>
						<StatusLight className="size-2" state={worker.state} />
						<span className="max-w-32 truncate">{words}</span>
					</IsoMarker>
				);
			})}
			{/* Name plates hang on the chair backs, clear of the screens. */}
			{plan.desks.map((desk) => {
				const { worker, x, z } = desk;
				const act = actScene?.acts.get(worker.id);
				if (!(actScene && act)) {
					return (
						<IsoMarker
							at={deskPoint(x, z, [SEAT_X, SLAB + 0.62, CHAIR_OUT + 0.42])}
							className="gap-1.5"
							key={`name:${worker.id}`}
							label={`${deskLabel(worker)}. Open their desk`}
							onSelect={() => onOpenWorker(worker.id)}
							pressed={selectedId === worker.id}
						>
							<StatusLight className="size-2" state={worker.state} />
							{worker.name}
						</IsoMarker>
					);
				}
				const asking = act.act === "asking" && act.ask ? act.ask : null;
				const queued =
					asking !== null && slotOf(actScene.slots.slots, act.agentId) !== null;
				const figure = figureAt(desk, act);
				const bubbleId = bubbleOverlayId(act);
				const plate = bubbleId && shown.has(bubbleId) ? plateBubble(act) : null;
				// The kit's work-bubbles setting, as the kit's villagers read it.
				const bubble =
					plate && (workBubbles || !isWorkBubble(plate)) ? plate : null;
				return (
					<group key={`name:${worker.id}`}>
						<FigureProbe agentId={act.agentId} at={figure.head} edge="head" />
						<FigureProbe agentId={act.agentId} at={figure.feet} edge="feet" />
						<IsoMarker
							actAgent={act.agentId}
							activate={asking ? () => actScene.onAsk(asking.id) : undefined}
							at={plateAt(desk, act)}
							className="relative gap-1.5"
							iconOnly={queued ? false : actScene.handlers.iconOnly}
							key={`name:${worker.id}`}
							label={
								asking
									? `${act.ariaLabel} Answer their ask.`
									: `${act.ariaLabel} Open their desk.`
							}
							onSelect={() => onOpenWorker(worker.id)}
							pressed={selectedId === worker.id}
							youSpot={queued ? "slot" : undefined}
						>
							{bubble ? <LifeBubbleTag bubble={bubble} /> : null}
							<StatusLight className="size-2" state={worker.state} />
							{asking && queued
								? queuePlateText(
										act.agentName,
										{
											approx: asking.sinceApprox,
											since: asking.since,
											until: asking.expiresAt ?? null,
											untilApprox: asking.expiresApprox,
										},
										actScene.handlers.nowMs
									)
								: worker.name}
						</IsoMarker>
					</group>
				);
			})}
		</>
	);
}

/** A standing worker's head above its feet (world units). */
const FIGURE_TALL = 1.35;

/**
 * A hidden, zero-size marker at a worker's head or feet (the kit's
 * `data-act-figure` / `data-figure-edge` contract), for checks that no
 * prop covers the figure.
 */
function FigureProbe({
	agentId,
	at,
	edge,
}: {
	agentId: string;
	at: Vec3;
	edge: "feet" | "head";
}) {
	return (
		<Html position={at}>
			<span
				aria-hidden="true"
				className="pointer-events-none block size-0"
				data-act-figure={agentId}
				data-figure-edge={edge}
			/>
		</Html>
	);
}

export interface WorkersDioramaProps {
	actScene?: WorkersActScene | null;
	art: WorkersArt;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpenScreen: (workerId: string) => void;
	onOpenWorker: (workerId: string) => void;
	plan: OfficePlan;
	quality: RenderQuality;
	reducedMotion: boolean;
	selectedId: string | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/** What a screen plate says to a screen reader. */
export function screenLabel(worker: WorkerView): string {
	return `${worker.name}'s screen: ${screenTitle(worker)}, ${WORKER_STATE_LABELS[worker.state]}. Open the task`;
}

/** The office diorama: island, garden, the cut-away room, desks, workers. */
export function WorkersDioramaScene({
	actScene = null,
	art,
	looks,
	night,
	onOpenScreen,
	onOpenWorker,
	plan,
	quality,
	reducedMotion,
	selectedId,
	shape,
	theme,
}: WorkersDioramaProps) {
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < plan.halfWidth + 0.35 &&
			Math.abs(z) < plan.halfDepth + 0.35,
		[plan]
	);
	const green = useMemo(() => garden(shape, plan), [plan, shape]);
	const plants = useMemo(() => cornerPlants(plan), [plan]);
	// Stable items: InstancedParts rebuilds its ink hull whenever they change.
	const pots = useMemo(
		() =>
			plants.pots.map((at) => ({
				position: [at[0], at[1] + 0.2, at[2]] as Vec3,
				scale: [0.2, 0.4, 0.2] as Vec3,
			})),
		[plants]
	);
	const outside = useMemo(
		() => ({
			benches: [
				{ at: [plan.halfWidth * 0.3, 0, plan.halfDepth + 0.9] as Vec3, yaw: 0 },
			],
			lamps: [
				[plan.halfWidth + 0.55, 0, plan.halfDepth + 0.45],
				[-plan.halfWidth - 0.55, 0, plan.halfDepth + 0.45],
			] as Vec3[],
		}),
		[plan]
	);
	const villagers = useMemo<VillagerSpec[]>(
		() =>
			plan.desks.flatMap(({ worker, x, z }) => {
				const base = looks.get(worker.id);
				if (!base) {
					return [];
				}
				return [
					{
						facing: facingOf(worker.state),
						id: worker.id,
						label: `${deskLabel(worker)}. Open their desk`,
						looks: base,
						name: worker.name,
						pose: workerPose(worker.state),
						position: deskPoint(x, z, [SEAT_X, SLAB + SEAT, CHAIR_OUT]),
					},
				];
			}),
		[looks, plan.desks]
	);
	const actCast = useMemo(() => {
		if (!actScene) {
			return null;
		}
		const chairs = new Map(
			plan.desks.map((desk) => [desk.worker.id, chairOf(desk)])
		);
		const paths = officePaths(plan, chairs, SLAB);
		const coffee = coffeeOf(plan, actScene.acts);
		const specs: VillagerSpec[] = [];
		const activity = new Map<string, DeskActivity>();
		for (const desk of plan.desks) {
			const act = actScene.acts.get(desk.worker.id);
			const base = looks.get(desk.worker.id);
			const chair = chairs.get(desk.worker.id);
			if (!(act && base && chair)) {
				continue;
			}
			activity.set(desk.worker.id, deskActivity(act));
			const facing = facingOf(desk.worker.state);
			specs.push({
				facing,
				id: desk.worker.id,
				label: act.ariaLabel,
				life: workerLife(act, {
					coffee: coffee.get(desk.worker.id) ?? null,
					facing,
					paths,
					reduced: reducedMotion,
					slot: slotOf(actScene.slots.slots, act.agentId),
				}),
				looks: {
					...base,
					tool:
						act.act === "working" && !act.stalled
							? toolForActivity(act.carry, WORKER_TOOLS)
							: undefined,
				},
				name: desk.worker.name,
				pose: "idle",
				position: chair,
			});
			specs.push(
				...apprenticeSpecs({
					agentId: act.agentId,
					helpers: act.helpers,
					looks: base,
					station: deskPoint(desk.x, desk.z, [SEAT_X, SLAB, CHAIR_OUT + 0.4]),
				})
			);
		}
		const rests = new Map(
			[...coffee].map(([id, point]) => [id, paths.points[point] ?? null])
		);
		return { activity, paths, rests, specs };
	}, [actScene, looks, plan, reducedMotion]);
	const door = doorSpots(plan, SLAB);
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={[...green.bushes, ...plants.bushes]} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Benches benches={outside.benches} />
			<LampPosts lamps={outside.lamps} night={night} />
			<Room art={art} night={night} plan={plan} />
			<LeftWall art={art} plan={plan} />
			<InstancedParts castShadow ink={PROP_INK} inkColor={art.pot} items={pots}>
				<cylinderGeometry args={[1, 0.75, 1, 14]} />
				<ToonMaterial color={art.pot} />
			</InstancedParts>
			<CoffeeCorner art={art} at={plan.coffee} />
			<Desks
				activity={actCast?.activity ?? null}
				art={art}
				desks={plan.desks}
				night={night}
				theme={theme}
			/>
			{actScene ? (
				<>
					<OfficeDoor
						art={art}
						at={door.you}
						waitMs={oldestBlockingWaitMs(
							actScene.handlers.snapshot,
							actScene.handlers.nowMs
						)}
					/>
					<InboxTray art={art} at={door.tray} />
					{plan.desks.map((desk) => {
						const act = actScene.acts.get(desk.worker.id);
						return act ? (
							<WorkerDeskActs
								act={act}
								at={[desk.x, 0, desk.z]}
								handlers={actScene.handlers}
								key={desk.worker.id}
								layout={deskLayout(
									desk,
									actCast?.rests.get(desk.worker.id) ?? null,
									plan.coffee,
									actScene.handlers.iconOnly
								)}
							/>
						) : null;
					})}
					<WorkersDoorActs
						handlers={actScene.handlers}
						layout={doorLayout(plan, SLAB, SLAB + INBOX_TOP)}
						offStage={actScene.offStage}
						onStage={actScene.onStage}
						owners={actScene.owners}
						slots={actScene.slots}
					/>
				</>
			) : null}
			<WorkerMarkers
				actScene={actScene}
				onOpenScreen={onOpenScreen}
				onOpenWorker={onOpenWorker}
				plan={plan}
				rests={actCast?.rests ?? NO_RESTS}
				selectedId={selectedId}
			/>
			<Villagers
				onSelect={onOpenWorker}
				paths={actCast?.paths}
				plates={false}
				reducedMotion={reducedMotion}
				selectedId={selectedId}
				villagers={actCast?.specs ?? villagers}
			/>
		</group>
	);
}
