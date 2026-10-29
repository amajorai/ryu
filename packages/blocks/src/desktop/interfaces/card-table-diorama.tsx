/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { type SeatInfo, seatTone, stackChips } from "./card-table-model.ts";
import { CARD_ROOM_3D } from "./card-table-palette.ts";
import {
	POT,
	ROOM,
	type RoomSeat,
	roomSeats,
	TABLE,
} from "./card-table-room.ts";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, jitter } from "./game3d-math.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import {
	Bushes,
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";

/**
 * The card room (see card-table-room.ts for the layout): a wood-floored
 * room with two papered walls, a rug and an oval felt table under a hanging
 * lamp. The seated agents are villagers on chairs round its far side, each
 * with their chips stacked on the felt (one per thread) and two cards face
 * down when they hold the action; the pot's pile sits in the middle with a
 * few cards dealt beside it. The seats' and the pot's own controls float
 * over them (`seatPlate`, `potPlate`), so the room keeps every menu the
 * plain table has.
 */

const ART = CARD_ROOM_3D;
const CHIP_RADIUS = 0.16;
const CHIP_HEIGHT = 0.045;
/** A seated villager's feet rest on the chair, so they sit at the table. */
const SEATED = 0.3;

const POSE: Record<ReturnType<typeof seatTone>, VillagerPose> = {
	attention: "failed",
	idle: "idle",
	working: "working",
	"your-turn": "needs-you",
};

/** A stack of `count` chips at (x, z) on the felt. */
function chipStack(
	out: InstanceSpec[],
	x: number,
	z: number,
	count: number,
	color: string
) {
	for (let chip = 0; chip < count; chip++) {
		out.push({
			color,
			position: [
				x + (jitter(chip, count, 3) - 0.5) * 0.02,
				TABLE.height + 0.03 + CHIP_HEIGHT * (chip + 0.5),
				z + (jitter(chip, count, 5) - 0.5) * 0.02,
			],
			scale: [CHIP_RADIUS, CHIP_HEIGHT * 0.92, CHIP_RADIUS],
		});
	}
}

/** A card lying on the felt, `yaw` turned, face up or down. */
function card(x: number, z: number, yaw: number, lift = 0): InstanceSpec {
	return {
		position: [x, TABLE.height + 0.035 + lift, z],
		rotation: [0, yaw, 0],
		scale: [0.32, 0.012, 0.46],
	};
}

/** Every chip and card on the table: the seats' and the pot's. */
function tableParts(
	seats: readonly RoomSeat[],
	seated: readonly SeatInfo[],
	pot: number
) {
	const chips: InstanceSpec[] = [];
	const backs: InstanceSpec[] = [];
	const faces: InstanceSpec[] = [];
	for (const [slot, seat] of seated.entries()) {
		const place = seats[slot];
		if (!place) {
			continue;
		}
		const count = stackChips(seat.threads.length);
		const color = ART.chips[slot % ART.chips.length] ?? ART.chipEdge;
		const [cx, cz] = place.chips;
		// Two stacks when there are many, so a tall one does not tip.
		const first = Math.ceil(count / 2);
		chipStack(chips, cx, cz, count > 4 ? first : count, color);
		if (count > 4) {
			chipStack(chips, cx + 0.2, cz + 0.12, count - first, color);
		}
		if (seat.agentTurn > 0) {
			const yaw = place.facing;
			const side: [number, number] = [Math.cos(yaw), -Math.sin(yaw)];
			backs.push(
				card(cx - side[0] * 0.42, cz - side[1] * 0.42, yaw + 0.18),
				card(cx - side[0] * 0.3, cz - side[1] * 0.3, yaw - 0.12, 0.014)
			);
		}
	}
	// The pot: a heap of mixed chips, and three cards dealt face up by it.
	const [px, , pz] = POT;
	const heap = Math.min(12, Math.max(0, pot * 3));
	for (let index = 0; index < heap; index++) {
		const angle = index * 2.3;
		const radius = index < 4 ? 0.12 : 0.34;
		chipStack(
			chips,
			px + Math.cos(angle) * radius,
			pz + Math.sin(angle) * radius,
			1 + (index % 3),
			ART.chips[index % ART.chips.length] ?? ART.chipEdge
		);
	}
	for (let index = 0; index < 3; index++) {
		const along = (index - 1) * 0.4;
		faces.push(
			card(
				px + Math.SQRT1_2 * along - 0.55,
				pz - Math.SQRT1_2 * along + 0.55,
				FACE_CAMERA + (jitter(index, 1, 3) - 0.5) * 0.2
			)
		);
	}
	return { backs, chips, faces };
}

/** Chairs: a seat, a cushion, four legs and a back away from the table. */
function chairParts(seats: readonly RoomSeat[]) {
	const frames: InstanceSpec[] = [];
	const cushions: InstanceSpec[] = [];
	for (const seat of seats) {
		const [x, z] = seat.at;
		const yaw = seat.facing;
		const back: [number, number] = [-Math.sin(yaw), -Math.cos(yaw)];
		frames.push({
			position: [x, 0.36, z],
			rotation: [0, yaw, 0],
			scale: [0.62, 0.08, 0.6],
		});
		cushions.push({
			position: [x, 0.42, z],
			rotation: [0, yaw, 0],
			scale: [0.54, 0.06, 0.52],
		});
		frames.push({
			position: [x + back[0] * 0.3, 0.8, z + back[1] * 0.3],
			rotation: [0, yaw, 0],
			scale: [0.62, 0.8, 0.08],
		});
		for (const [sx, sz] of [
			[-1, -1],
			[1, -1],
			[-1, 1],
			[1, 1],
		] as const) {
			const cos = Math.cos(yaw);
			const sin = Math.sin(yaw);
			const lx = sx * 0.26;
			const lz = sz * 0.25;
			frames.push({
				position: [x + lx * cos + lz * sin, 0.17, z - lx * sin + lz * cos],
				scale: [0.06, 0.34, 0.06],
			});
		}
	}
	return { cushions, frames };
}

/** The room's two back walls, their wainscot, and the pictures on them. */
function wallParts() {
	const walls: InstanceSpec[] = [];
	const trims: InstanceSpec[] = [];
	const frames: InstanceSpec[] = [];
	const pictures: InstanceSpec[] = [];
	const { half, wall } = ROOM;
	walls.push(
		{ position: [0, wall / 2, -half], scale: [half * 2, wall, 0.2] },
		{ position: [-half, wall / 2, 0], scale: [0.2, wall, half * 2] }
	);
	trims.push(
		{ position: [0, 0.45, -half + 0.12], scale: [half * 2, 0.9, 0.06] },
		{ position: [-half + 0.12, 0.45, 0], scale: [0.06, 0.9, half * 2] }
	);
	for (const [index, along] of [-2.6, 0.2, 2.9].entries()) {
		const color = ART.pictures[index % ART.pictures.length];
		frames.push({
			position: [along, 1.65, -half + 0.13],
			scale: [1.1, 0.8, 0.05],
		});
		pictures.push({
			color,
			position: [along, 1.65, -half + 0.16],
			scale: [0.9, 0.6, 0.02],
		});
		frames.push({
			position: [-half + 0.13, 1.65, -along],
			scale: [0.05, 0.8, 1.1],
		});
		pictures.push({
			color: ART.pictures[(index + 1) % ART.pictures.length],
			position: [-half + 0.16, 1.65, -along],
			scale: [0.02, 0.6, 0.9],
		});
	}
	return { frames, pictures, trims, walls };
}

/** Lawn and trees round the room, outside its walls. */
function grounds(shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const inRoom =
				Math.abs(fx) < ROOM.half + 0.8 && Math.abs(fz) < ROOM.half + 0.8;
			if (!onIsland(shape, fx, fz, 0.6) || inRoom) {
				continue;
			}
			// Trees behind the walls; shrubs round the open front.
			if (fx + fz < 0 && hash < 0.55) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.25 ? "cedar" : "fruit",
					scale: 0.8 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash > 0.8) {
				bushes.push({ at: [fx, 0, fz], scale: 0.8, seed: x * 31 + y });
			}
		}
	}
	return { bushes, trees };
}

/** The act layer's additions to the room, when the snapshot carries acts. */
export interface CardRoomActors {
	/** Helpers standing by their players' chairs. */
	helpers: VillagerSpec[];
	/** Each seated player's pose and tool, by agent id. */
	poses: ReadonlyMap<
		string,
		Pick<VillagerSpec, "pose"> & { tool?: MemberLooks["tool"] }
	>;
	/** Travelling cards, the queue at your seat, tallies and seat cues. */
	props: ReactNode;
}

export interface CardRoomProps {
	/** With the act layer: progress pips replace the thread chip stacks. */
	actors?: CardRoomActors;
	/** The felt, felt line and card backs (`cardRoomCloth`); stock by default. */
	cloth?: { cardBack: string; felt: string; feltLine: string };
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	/** The pot's own control (the plain table's pot), floated over the felt. */
	potPlate: ReactNode;
	quality: RenderQuality;
	reducedMotion: boolean;
	running: number;
	seated: readonly SeatInfo[];
	/** Each chair's own control (the plain table's seat or empty seat). */
	seatPlate: (slot: number) => ReactNode;
	shape: IslandShape;
	theme: Scene3dTheme;
}

export function CardRoom({
	actors,
	cloth = ART,
	looks,
	night,
	potPlate,
	quality,
	reducedMotion,
	running,
	seated,
	seatPlate,
	shape,
	theme,
}: CardRoomProps) {
	const seats = useMemo(() => roomSeats(), []);
	const pieces = useMemo(
		() => tableParts(seats, actors ? [] : seated, running),
		[actors, running, seated, seats]
	);
	const chairs = useMemo(() => chairParts(seats), [seats]);
	const walls = useMemo(() => wallParts(), []);
	const outside = useMemo(() => grounds(shape), [shape]);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < ROOM.half + 0.4 && Math.abs(z) < ROOM.half + 0.4,
		[]
	);
	const villagers = useMemo<VillagerSpec[]>(() => {
		const out: VillagerSpec[] = [];
		for (const [slot, seat] of seated.entries()) {
			const place = seats[slot];
			const base = looks.get(seat.agent.id);
			if (!(place && base)) {
				continue;
			}
			const acted = actors?.poses.get(seat.agent.id);
			out.push({
				facing: place.facing,
				id: seat.agent.id,
				label: seat.agent.name,
				looks: acted ? { ...base, tool: acted.tool } : base,
				name: seat.agent.name,
				pose: acted ? acted.pose : POSE[seatTone(seat)],
				position: [place.at[0], SEATED, place.at[1]],
			});
		}
		return actors ? [...out, ...actors.helpers] : out;
	}, [actors, looks, seated, seats]);
	const floor = night ? ART.floorNight : ART.floor;
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
			<TreeGrove theme={theme} trees={outside.trees} />
			<Bushes bushes={outside.bushes} theme={theme} />
			{/* The floor, the rug, and the two back walls. */}
			<mesh position={[0, 0.04, 0]} receiveShadow>
				<boxGeometry args={[ROOM.half * 2, 0.08, ROOM.half * 2]} />
				<ToonMaterial color={floor} planks />
			</mesh>
			<mesh
				position={[0, 0.085, 0]}
				receiveShadow
				rotation={[0, FACE_CAMERA, 0]}
				scale={[TABLE.across + 1.9, 1, TABLE.deep + 1.7]}
			>
				<cylinderGeometry args={[1, 1, 0.02, 48]} />
				<ToonMaterial color={ART.rug} />
			</mesh>
			<mesh
				position={[0, 0.098, 0]}
				rotation={[-Math.PI / 2, 0, FACE_CAMERA]}
				scale={[TABLE.across + 1.6, TABLE.deep + 1.4, 1]}
			>
				<ringGeometry args={[0.9, 0.94, 64]} />
				<meshBasicMaterial color={ART.rugTrim} />
			</mesh>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.wainscot}
				items={walls.walls}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.wall} />
			</InstancedParts>
			<InstancedParts items={walls.trims}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.wainscot} planks />
			</InstancedParts>
			<InstancedParts items={walls.frames}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.frame} />
			</InstancedParts>
			<InstancedParts items={walls.pictures}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{/* The table: post, rail and felt. */}
			<ToonMesh
				castShadow
				color={ART.wood}
				ink={PROP_INK}
				position={[0, 0.36, 0]}
			>
				<cylinderGeometry args={[0.36, 0.7, 0.62, 20]} />
			</ToonMesh>
			<group
				rotation={[0, FACE_CAMERA, 0]}
				scale={[TABLE.across, 1, TABLE.deep]}
			>
				<mesh castShadow position={[0, TABLE.height - 0.05, 0]} receiveShadow>
					<cylinderGeometry args={[1.1, 1.06, 0.14, 64]} />
					<ToonMaterial color={ART.rail} rim={0.2} />
				</mesh>
				<mesh position={[0, TABLE.height + 0.025, 0]} receiveShadow>
					<cylinderGeometry args={[1, 1, 0.02, 64]} />
					<ToonMaterial color={cloth.felt} />
				</mesh>
				<mesh
					position={[0, TABLE.height + 0.037, 0]}
					rotation={[-Math.PI / 2, 0, 0]}
				>
					<ringGeometry args={[0.7, 0.72, 64]} />
					<meshBasicMaterial color={cloth.feltLine} />
				</mesh>
			</group>
			{/* Chairs, and the agents in them. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.chair}
				items={chairs.frames}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.chair} />
			</InstancedParts>
			<InstancedParts items={chairs.cushions}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.cushion} />
			</InstancedParts>
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={villagers}
			/>
			{/* Chips and cards on the felt. */}
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={ART.chipEdge}
				items={pieces.chips}
			>
				<cylinderGeometry args={[1, 1, 1, 20]} />
				<ToonMaterial rim={0.2} />
			</InstancedParts>
			<InstancedParts castShadow items={pieces.backs}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={cloth.cardBack} />
			</InstancedParts>
			<InstancedParts castShadow items={pieces.faces}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.cardFace} />
			</InstancedParts>
			{/* The lamp over the table, and its pool of light. */}
			<mesh position={[0, 3.3, 0]}>
				<cylinderGeometry args={[0.012, 0.012, 0.9, 6]} />
				<meshBasicMaterial color={ART.cord} />
			</mesh>
			<ToonMesh
				castShadow
				color={ART.shade}
				ink={PROP_INK}
				position={[0, 2.7, 0]}
			>
				<cylinderGeometry args={[0.24, 0.62, 0.36, 24, 1, true]} />
			</ToonMesh>
			<mesh position={[0, 2.58, 0]}>
				<sphereGeometry args={[0.12, 14, 10]} />
				<meshBasicMaterial color={ART.bulb} toneMapped={false} />
			</mesh>
			<mesh position={[0, 1.7, 0]}>
				<cylinderGeometry args={[0.55, 2.4, 1.8, 32, 1, true]} />
				<CurvedBasicMaterial
					blending={ADDITIVE_BLENDING}
					color={ART.light}
					depthWrite={false}
					opacity={night ? 0.12 : 0.05}
					toneMapped={false}
					transparent
				/>
			</mesh>
			{night ? (
				<pointLight
					color={ART.bulb}
					decay={1.4}
					distance={7}
					intensity={6}
					position={[0, 2.4, 0]}
				/>
			) : null}
			{/* The controls: each chair's plate over its head, the pot's over the felt. */}
			{seats.map((seat) => (
				<group key={seat.slot} position={[seat.at[0], 1.95, seat.at[1]]}>
					<Html center zIndexRange={[30, 0]}>
						{seatPlate(seat.slot)}
					</Html>
				</group>
			))}
			{/* With acts the pot's plate steps back, clear of the queue at your seat. */}
			<group
				position={
					actors
						? [POT[0] - 1.0, POT[1] + 0.25, POT[2] - 1.0]
						: [POT[0] + 0.5, POT[1] + 0.25, POT[2] + 0.5]
				}
			>
				<Html center zIndexRange={[30, 0]}>
					{potPlate}
				</Html>
			</group>
			{actors?.props ?? null}
		</group>
	);
}
