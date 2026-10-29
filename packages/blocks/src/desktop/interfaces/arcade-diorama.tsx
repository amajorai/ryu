/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceActivityKind,
	InterfaceAgentAct,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	ArcadeActProps,
	type ArcadeActView,
	arcadePaths,
	arcadePlayer,
	arcadeYouSpot,
	type CabinetWords,
	cabinetWords,
} from "./arcade-acts.tsx";
import {
	GLYPH_BITMAPS,
	type GlyphMeshData,
	glyphMesh,
	type PixelSymbol,
} from "./arcade-glyphs.ts";
import {
	type Machine,
	machineSummary,
	type ReelSymbol,
} from "./arcade-model.ts";
import { ARCADE_3D, type CabinetSkin } from "./arcade-palette.ts";
import { GAME_DISPLAY_FAMILY } from "./game-font.ts";
import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
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
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";

/**
 * The Arcade as an isometric diorama on the game kit (game3d-stage.tsx):
 * a cut-away arcade hall on the island, its carpet starred, its walls
 * trimmed with neon tubes that glow at night, and one toon slot cabinet
 * per agent in rows across the floor, every screen turned to the camera:
 * three reels of bold pixel-art symbols for its latest conversations, a
 * jackpot topper that lights when a reply waits on you and a red lamp
 * when a run failed. Each agent stands beside their cabinet as a villager,
 * working the machine while it runs, waving at a jackpot and slumped by a
 * tilt; their name plate opens the machine.
 */

const SLAB = 0.16;
const WALL_HEIGHT = 2.75;
const WALL_THICK = 0.2;
/** Cabinets stand this far apart along a row, and rows this far apart. */
const PITCH = 1.95;
const ROW_GAP = 3.2;
/**
 * With the act layer every player carries plates (its name, its station
 * board, alarms, marks), so cabinets stand further apart and rows leave a
 * wider aisle.
 */
const ACT_PITCH = 2.6;
const ACT_ROW_GAP = 4.6;
/** Where a player stands: beside their cabinet's right, a step forward. */
const PLAYER_SIDE = 0.95;
const PLAYER_OUT = 0.42;
/** Cabinets per row: wide stages, and portrait ones (rows stack taller). */
const WIDE_COLUMNS = 6;
const PORTRAIT_COLUMNS = 2;
/**
 * With the act layer a phone's hall gets a third column: two columns of
 * ten players stack into one tall line whose plates sit on each other.
 */
const PORTRAIT_ACT_COLUMNS = 3;
/** Every cabinet turns to face the camera (the kit's 45 degree yaw). */
const FACE_VIEW = Math.PI / 4;
/** Carpet kept around the rows, the counter and the claw. */
const HALL_MARGIN = 1.1;
/** Lawn around the hall for the garden. */
export const ARCADE_RIM = 2.6;

/** A cabinet on the floor: its centre and which way its screen faces. */
export interface PlacedCabinet {
	machine: Machine;
	x: number;
	/** The screen's facing: a quarter turn from +z toward +x is 45 degrees. */
	yaw: number;
	z: number;
}

export interface HallLayout {
	cabinets: PlacedCabinet[];
	/** The prize counter (centre, along x) and the claw machine. */
	claw: [number, number];
	counter: [number, number];
	halfDepth: number;
	halfWidth: number;
	/** The act layer's you-spot points (queue, tray), when laid out for acts. */
	you: {
		layout: YouSpotLayout;
		points: Record<string, Vec3>;
		portrait: boolean;
	} | null;
}

/** How many cabinets share a row. */
export function hallColumns(
	count: number,
	portrait: boolean,
	acts = false
): number {
	let cap = WIDE_COLUMNS;
	if (portrait) {
		cap = acts ? PORTRAIT_ACT_COLUMNS : PORTRAIT_COLUMNS;
	}
	if (count <= cap) {
		return Math.max(1, count);
	}
	return Math.ceil(count / Math.ceil(count / cap));
}

/** A point `across` the view (screen right) and `out` toward the camera. */
function onFloor(across: number, out: number): [number, number] {
	const c = Math.SQRT1_2;
	return [across * c + out * c, -across * c + out * c];
}

/**
 * Cabinets in rows across the hall, every screen turned to face the camera
 * (no cabinet is ever seen edge-on), rows one behind the other with an
 * aisle wide enough that a front marquee never hides a back screen. A
 * player stands beside their cabinet, not in front of its screen. The
 * prize counter and the claw machine stand in front of the rows. Portrait
 * stages get fewer cabinets per row and more rows.
 */
export function layoutHall(
	machines: readonly Machine[],
	portrait = false,
	withYouSpot = false
): HallLayout {
	const count = machines.length;
	const columns = hallColumns(count, portrait, withYouSpot);
	const pitch = withYouSpot ? ACT_PITCH : PITCH;
	const rowGap = withYouSpot ? ACT_ROW_GAP : ROW_GAP;
	const rows = Math.max(1, Math.ceil(count / columns));
	const cabinets: PlacedCabinet[] = machines.map((machine, index) => {
		const row = Math.floor(index / columns);
		const inRow = Math.min(columns, count - row * columns);
		const column = index % columns;
		const across = (column - (inRow - 1) / 2) * pitch - PLAYER_SIDE / 2;
		const out = (row - (rows - 1) / 2) * rowGap;
		const [x, z] = onFloor(across, out);
		return { machine, x, yaw: FACE_VIEW, z };
	});
	const reach = ((Math.max(columns, 2) - 1) / 2) * pitch + PLAYER_SIDE;
	// Far enough forward that the counter never stands in front of a screen.
	const front = ((rows - 1) / 2) * rowGap + (portrait ? 2.6 : 4.4);
	// The counter and claw stand in front of the rows (the near side of
	// the hall), so the cabinets and the prizes fill the frame together.
	// With the act layer the queue runs right from the counter, so the
	// claw stands further right, past it.
	const counter = onFloor(portrait ? -0.9 : -reach * 0.45, front);
	let clawAcross = reach * 0.55;
	if (portrait) {
		clawAcross = Math.max(reach - 0.4, 1.6);
	} else if (withYouSpot) {
		clawAcross = -reach * 0.45 + 8.2;
	}
	const claw = onFloor(clawAcross, front - (withYouSpot ? 0.6 : 0.2));
	let halfWidth = 0;
	let halfDepth = 0;
	const box = {
		maxX: Number.NEGATIVE_INFINITY,
		maxZ: Number.NEGATIVE_INFINITY,
		minX: Number.POSITIVE_INFINITY,
		minZ: Number.POSITIVE_INFINITY,
	};
	const extend = (x: number, z: number, room: number) => {
		halfWidth = Math.max(halfWidth, Math.abs(x) + room);
		halfDepth = Math.max(halfDepth, Math.abs(z) + room);
		box.minX = Math.min(box.minX, x - room);
		box.maxX = Math.max(box.maxX, x + room);
		box.minZ = Math.min(box.minZ, z - room);
		box.maxZ = Math.max(box.maxZ, z + room);
	};
	for (const cabinet of cabinets) {
		extend(cabinet.x, cabinet.z, HALL_MARGIN + 0.5);
		const [px, pz] = onFloor(PLAYER_SIDE, PLAYER_OUT);
		extend(cabinet.x + px, cabinet.z + pz, HALL_MARGIN);
	}
	extend(counter[0], counter[1], HALL_MARGIN + 0.6);
	extend(claw[0], claw[1], HALL_MARGIN + 0.4);
	if (!withYouSpot) {
		// A square-ish hall reads as a room, not a corridor.
		const half = Math.max(halfWidth, halfDepth);
		return {
			cabinets,
			claw,
			counter,
			halfDepth: half,
			halfWidth: half,
			you: null,
		};
	}
	// The act layer queues in front of the prize counter; the hall reaches
	// past the queue's last slot and is then centred on what it holds, so
	// the queue adds no empty floor at the back.
	const reachOf = arcadeYouSpot(counter, SLAB, portrait);
	for (const [x, , z] of [
		...Object.values(reachOf.points),
		reachOf.layout.offStage,
		reachOf.layout.tally,
	]) {
		extend(x, z, 0.8);
	}
	const shiftX = (box.minX + box.maxX) / 2;
	const shiftZ = (box.minZ + box.maxZ) / 2;
	const moved = (at: [number, number]): [number, number] => [
		at[0] - shiftX,
		at[1] - shiftZ,
	];
	const centredCounter = moved(counter);
	return {
		cabinets: cabinets.map((cabinet) => ({
			...cabinet,
			x: cabinet.x - shiftX,
			z: cabinet.z - shiftZ,
		})),
		claw: moved(claw),
		counter: centredCounter,
		halfDepth: (box.maxZ - box.minZ) / 2,
		halfWidth: (box.maxX - box.minX) / 2,
		you: { ...arcadeYouSpot(centredCounter, SLAB, portrait), portrait },
	};
}

/** The mark a phone's above-the-marquee plate wears for a pose. */
const POSE_MARK: Partial<
	Record<VillagerPose, { className: string; sign: string }>
> = {
	failed: { className: "bg-(--gk-bad) text-white", sign: "×" },
	"needs-you": { className: "bg-(--gk-gold) text-(--gk-edge)", sign: "!" },
	working: { className: "bg-(--gk-info) text-white", sign: "…" },
};

/**
 * A machine's player pose. "waiting" only when you spoke last and nothing
 * runs ("sent, not picked up"); a machine that merely has conversations
 * is idle.
 */
export function playerPose(machine: Machine): VillagerPose {
	if (machine.tilt) {
		return "failed";
	}
	if (machine.running) {
		return "working";
	}
	if (machine.jackpots.length > 0) {
		return "needs-you";
	}
	const sent = machine.threads.some(
		(thread) => thread.lastMessageRole === "user" && !thread.running
	);
	return sent ? "waiting" : "idle";
}

/** Where a cabinet's player stands: beside it, a step toward the camera. */
export function playerSpot(cabinet: PlacedCabinet): [number, number] {
	const [x, z] = onFloor(PLAYER_SIDE, PLAYER_OUT);
	return [cabinet.x + x, cabinet.z + z];
}

const SYMBOL_COLOR: Record<ReelSymbol, string> = ARCADE_3D.symbol;
const DETAIL_COLOR: Record<PixelSymbol, string> = {
	bell: ARCADE_3D.symbolDetail.bellKnob,
	cherry: ARCADE_3D.symbolDetail.stem,
	flame: ARCADE_3D.symbolDetail.flameCore,
	seven: ARCADE_3D.symbolDetail.flameCore,
};
/** A glyph's width on its reel (world units): bold, nearly reel-wide. */
const GLYPH_WIDTH = 0.24;
/** The BAR plate on a reel (world units), lettered from a canvas. */
const BAR_PLATE: [number, number] = [0.26, 0.15];

type GlyphKey = `${PixelSymbol}:${"#" | "+"}`;
const glyphs = new Map<GlyphKey, GlyphMeshData>();

/** The cached mesh data for one colour of a symbol's pixel art. */
function glyphData(symbol: PixelSymbol, mark: "#" | "+"): GlyphMeshData {
	const key: GlyphKey = `${symbol}:${mark}`;
	let data = glyphs.get(key);
	if (!data) {
		data = glyphMesh(GLYPH_BITMAPS[symbol], mark, GLYPH_WIDTH);
		glyphs.set(key, data);
	}
	return data;
}

/** One colour of a glyph: a flat mesh lit like the screen. */
function GlyphLayer({
	color,
	data,
	lift,
	night,
}: {
	color: string;
	data: GlyphMeshData;
	lift: number;
	night: boolean;
}) {
	if (data.positions.length === 0) {
		return null;
	}
	return (
		<mesh position={[0, 0, lift]}>
			<bufferGeometry>
				<bufferAttribute
					args={[data.positions, 3]}
					attach="attributes-position"
				/>
				<bufferAttribute args={[data.normals, 3]} attach="attributes-normal" />
			</bufferGeometry>
			<ToonMaterial {...emissive(color, true, night)} />
		</mesh>
	);
}

let barCanvas: HTMLCanvasElement | null | undefined;

/**
 * The BAR plate's art, drawn once: real bold lettering on a dark plate, so
 * it reads as BAR at the hall's default zoom (a pixel font cannot).
 */
function barArt(): HTMLCanvasElement | null {
	if (barCanvas !== undefined) {
		return barCanvas;
	}
	barCanvas = null;
	if (typeof document === "undefined") {
		return barCanvas;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 192;
	canvas.height = 100;
	const context = canvas.getContext("2d");
	if (!context) {
		return barCanvas;
	}
	context.fillStyle = ARCADE_3D.symbol.bar;
	context.beginPath();
	context.roundRect(4, 4, 184, 92, 18);
	context.fill();
	context.fillStyle = ARCADE_3D.symbolDetail.barText;
	context.font = `900 74px "${GAME_DISPLAY_FAMILY}", system-ui, sans-serif`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText("BAR", 96, 54);
	barCanvas = canvas;
	return barCanvas;
}

/** The BAR symbol: a lettered plate, lit like the screen. */
function BarPlate({ night }: { night: boolean }) {
	const art = barArt();
	if (!art) {
		return null;
	}
	return (
		<mesh>
			<planeGeometry args={BAR_PLATE} />
			<meshBasicMaterial toneMapped={!night} transparent>
				<canvasTexture args={[art]} attach="map" />
			</meshBasicMaterial>
		</mesh>
	);
}

/** The act sign's centre above the floor, over the marquee. */
const MARQUEE_SIGN_Y = 3.2;
/** Lettering canvases kept (least recently drawn go first). */
const LETTERING_CACHE = 96;
const lettering = new Map<string, HTMLCanvasElement | null>();

function fitFont(
	context: CanvasRenderingContext2D,
	text: string,
	width: number,
	start: number
): number {
	let size = start;
	context.font = `900 ${size}px "${GAME_DISPLAY_FAMILY}", system-ui, sans-serif`;
	while (size > 14 && context.measureText(text).width > width) {
		size -= 2;
		context.font = `900 ${size}px "${GAME_DISPLAY_FAMILY}", system-ui, sans-serif`;
	}
	return size;
}

/**
 * A strip of lit lettering (the act layer's marquee, attract line and reel
 * words), drawn once per text and colour on a canvas: bold display type on
 * a dark strip, so it reads like the cabinet's LED signs.
 */
function letteringArt(
	text: string,
	color: string,
	aspect: number
): HTMLCanvasElement | null {
	// A canvas drawn before the display font loads is drawn again once it has.
	const fontReady =
		typeof document !== "undefined" &&
		(document.fonts?.check(`900 20px "${GAME_DISPLAY_FAMILY}"`) ?? true);
	const key = `${color}:${aspect}:${fontReady}:${text}`;
	if (lettering.has(key)) {
		const kept = lettering.get(key) ?? null;
		// Most recently used last, so the oldest go first.
		lettering.delete(key);
		lettering.set(key, kept);
		return kept;
	}
	for (const old of lettering.keys()) {
		if (lettering.size < LETTERING_CACHE) {
			break;
		}
		lettering.delete(old);
	}
	lettering.set(key, null);
	if (typeof document === "undefined") {
		return null;
	}
	// A tall plate (the act sign) takes two lines: the head word big, the
	// rest ("Tests failed", "15:10") under it.
	const twoLines = aspect < 3 && text.includes(" · ");
	const canvas = document.createElement("canvas");
	canvas.height = twoLines ? 128 : 64;
	canvas.width = Math.round(canvas.height * aspect);
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	context.fillStyle = ARCADE_3D.screen;
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "middle";
	const room = canvas.width - 20;
	if (twoLines) {
		const [head = "", ...rest] = text.split(" · ");
		fitFont(context, head, room, 54);
		context.fillText(head, canvas.width / 2, 40);
		fitFont(context, rest.join(" · "), room, 40);
		context.fillText(rest.join(" · "), canvas.width / 2, 96);
	} else {
		fitFont(context, text, room, Math.min(44, canvas.width / 3));
		context.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
	}
	lettering.set(key, canvas);
	return canvas;
}

/** A plane of lit lettering at `position`, `width` × `height`. */
function Lettering({
	color,
	height,
	night,
	position,
	text,
	width,
}: {
	color: string;
	height: number;
	night: boolean;
	position: Vec3;
	text: string;
	width: number;
}) {
	const art = letteringArt(text, color, width / height);
	if (!art) {
		return null;
	}
	return (
		<mesh position={position}>
			<planeGeometry args={[width, height]} />
			<meshBasicMaterial toneMapped={!night}>
				<canvasTexture args={[art]} attach="map" colorSpace="srgb" key={text} />
			</meshBasicMaterial>
		</mesh>
	);
}

/** A reel's icon for an activity kind (the act layer's reels). */
const KIND_ICON: Record<InterfaceActivityKind, string> = {
	answer: "\u2713",
	ask: "?",
	delegate: "\u21c4",
	edit: "\u270e",
	plan: "\u2630",
	read: "\u25a4",
	run: "\u25b6",
	search: "\u2315",
	think: "\u2026",
	tool: "\u2692",
	web: "\u25cd",
	write: "\u270d",
};

/** A reel's icon; a kind the arcade does not know shows a plain dot. */
export function reelIcon(kind: string): string {
	return Object.hasOwn(KIND_ICON, kind)
		? KIND_ICON[kind as InterfaceActivityKind]
		: "\u2022";
}

/**
 * A reel's symbol as bold pixel art (`arcade-glyphs.ts`), the same set as
 * the paytable: cherries, a seven, a bell, a BAR plate, or a flame (a
 * blank reel stays empty). Two flat meshes at most, lit like the screen.
 */
function ReelSymbol3d({
	night,
	symbol,
}: {
	night: boolean;
	symbol: ReelSymbol;
}) {
	if (symbol === "blank") {
		return null;
	}
	if (symbol === "bar") {
		return <BarPlate night={night} />;
	}
	return (
		<group>
			<GlyphLayer
				color={SYMBOL_COLOR[symbol]}
				data={glyphData(symbol, "#")}
				lift={0}
				night={night}
			/>
			<GlyphLayer
				color={DETAIL_COLOR[symbol]}
				data={glyphData(symbol, "+")}
				lift={0.002}
				night={night}
			/>
		</group>
	);
}

function emissive(color: string, on: boolean, night: boolean) {
	return {
		color,
		emissive: color,
		emissiveIntensity: on ? (night ? 2.2 : 0.6) : 0,
		toneMapped: !(on && night),
	};
}

/** The screen's attract colour: what the machine is doing. */
function attractColor(machine: Machine): string {
	if (machine.tilt) {
		return ARCADE_3D.tilt;
	}
	if (machine.jackpots.length > 0) {
		return ARCADE_3D.topper;
	}
	if (machine.running) {
		return ARCADE_3D.neon[1];
	}
	return ARCADE_3D.screenIdle;
}

const BULBS = [-0.36, -0.22, -0.08, 0.08, 0.22, 0.36] as const;

/**
 * One arcade cabinet, facing +z: a base and upper body in its player's
 * colour with a diagonal accent stripe as side art, a slanted control deck
 * with a joystick and three buttons, a big glowing screen in its attract
 * colour with the three reels on it (tipped back toward the camera so the
 * symbols read), a lit marquee with a row of bulbs, a jackpot light on top
 * and a red lamp when it tilts.
 */
/** The act layer's screen colour for a cabinet's words. */
function wordsAttract(words: CabinetWords): string {
	if (words.tone === "tilt") {
		return ARCADE_3D.tilt;
	}
	if (words.tone === "limit") {
		return ARCADE_3D.marqueeLimit;
	}
	if (words.tone === "paused") {
		return ARCADE_3D.screenIdle;
	}
	return words.reels.length > 0 ? ARCADE_3D.neon[1] : ARCADE_3D.screenIdle;
}

const WORD_COLOR: Record<CabinetWords["tone"], string> = {
	ink: ARCADE_3D.marqueeInk,
	limit: ARCADE_3D.marqueeLimit,
	paused: ARCADE_3D.marqueePaused,
	tilt: ARCADE_3D.marqueeTilt,
};

function Cabinet({
	accent,
	body,
	machine,
	night,
	skin,
	words = null,
}: {
	accent: string;
	body: string;
	machine: Machine;
	night: boolean;
	skin: CabinetSkin;
	/**
	 * The act layer's lettering: the marquee (TILT and why, INSERT COIN,
	 * the step), the reels (the step's kind and the two before it) and the
	 * screen's attract line (what is next). Without it, today's cabinet.
	 */
	words?: CabinetWords | null;
}) {
	const won = words ? false : machine.jackpots.length > 0;
	const attract = words ? wordsAttract(words) : attractColor(machine);
	const tilted = words ? words.tone === "tilt" : machine.tilt !== null;
	return (
		<group>
			<RoundedBox
				args={[1.0, 1.1, 0.72]}
				castShadow
				position={[0, 0.55, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={body} />
			</RoundedBox>
			<ToonMesh color={skin.shade} position={[0, 0.52, 0.362]}>
				<boxGeometry args={[0.8, 0.84, 0.02]} />
			</ToonMesh>
			<mesh position={[0, 0.7, 0.375]}>
				<boxGeometry args={[0.3, 0.08, 0.01]} />
				<ToonMaterial {...emissive(skin.bulb, true, night)} />
			</mesh>
			{/* Side art: a diagonal stripe in the accent colour on both sides. */}
			{[-1, 1].map((side) => (
				<group key={side}>
					<mesh position={[side * 0.502, 0.95, 0]} rotation={[0.7, 0, 0]}>
						<boxGeometry args={[0.012, 0.14, 1.1]} />
						<ToonMaterial color={accent} />
					</mesh>
					<mesh position={[side * 0.502, 1.85, -0.12]} rotation={[0.7, 0, 0]}>
						<boxGeometry args={[0.012, 0.08, 0.6]} />
						<ToonMaterial color={accent} />
					</mesh>
				</group>
			))}
			{/* The slanted control deck: joystick and three buttons. */}
			<group position={[0, 1.14, 0.24]} rotation={[0.32, 0, 0]}>
				<ToonMesh castShadow color={skin.body} ink={PROP_INK * 0.7}>
					<boxGeometry args={[1.0, 0.1, 0.42]} />
				</ToonMesh>
				<ToonMesh color={ARCADE_3D.lever} position={[-0.24, 0.11, 0.02]}>
					<cylinderGeometry args={[0.016, 0.016, 0.16, 8]} />
				</ToonMesh>
				<ToonMesh
					color={ARCADE_3D.knob}
					ink={PROP_INK * 0.5}
					position={[-0.24, 0.2, 0.02]}
				>
					<sphereGeometry args={[0.05, 14, 10]} />
				</ToonMesh>
				{[0, 1, 2].map((index) => (
					<mesh key={index} position={[0.04 + index * 0.13, 0.06, 0.04]}>
						<cylinderGeometry args={[0.035, 0.035, 0.03, 14]} />
						<ToonMaterial
							{...emissive(
								ARCADE_3D.neon[index] ?? ARCADE_3D.topper,
								true,
								night
							)}
						/>
					</mesh>
				))}
			</group>
			{/* Upper body with the screen. */}
			<RoundedBox
				args={[1.0, 1.24, 0.5]}
				castShadow
				position={[0, 1.8, -0.11]}
				radius={0.05}
			>
				<ToonMaterial color={body} />
			</RoundedBox>
			<group position={[0, 1.9, 0.16]} rotation={[-0.24, 0, 0]}>
				<ToonMesh color={skin.trim} ink={PROP_INK * 0.6}>
					<boxGeometry args={[0.94, 0.84, 0.03]} />
				</ToonMesh>
				<mesh position={[0, 0, 0.018]}>
					<boxGeometry args={[0.86, 0.76, 0.01]} />
					<ToonMaterial {...emissive(attract, true, night)} />
				</mesh>
				{machine.reels.map((reel, index) => (
					<group
						key={`${index}:${reel.symbol}`}
						position={[(index - 1) * 0.28, 0, 0.026]}
					>
						<mesh>
							<boxGeometry args={[0.26, 0.6, 0.01]} />
							<ToonMaterial {...emissive(ARCADE_3D.reel, true, false)} />
						</mesh>
						<group position={[0, 0, 0.008]}>
							{words ? (
								// The act layer's reels show only step kinds;
								// never the legacy thread-status symbols.
								words.reels[index] ? (
									<Lettering
										color={ARCADE_3D.marqueeInk}
										height={0.25}
										night={night}
										position={[0, 0, 0]}
										text={reelIcon(words.reels[index])}
										width={0.25}
									/>
								) : null
							) : (
								<ReelSymbol3d night={night} symbol={reel.symbol} />
							)}
						</group>
					</group>
				))}
				{words?.next ? (
					<Lettering
						color={ARCADE_3D.marqueeInk}
						height={0.09}
						night={night}
						position={[0, -0.33, 0.026]}
						text={words.next}
						width={0.8}
					/>
				) : null}
			</group>
			{/* The lit marquee with its bulbs. */}
			<RoundedBox
				args={[1.04, 0.3, 0.56]}
				castShadow
				position={[0, 2.58, -0.09]}
				radius={0.06}
			>
				<ToonMaterial {...emissive(skin.sign, true, night)} />
			</RoundedBox>
			<mesh position={[0, 2.6, 0.196]}>
				<boxGeometry args={[0.78, 0.13, 0.01]} />
				<ToonMaterial {...emissive(skin.signText, true, night)} />
			</mesh>
			{words?.marquee ? (
				// The act's sign over the marquee, big enough to read across
				// the hall: TILT / PAUSED / INSERT COIN or the step on top,
				// why or when underneath.
				<group position={[0, MARQUEE_SIGN_Y, -0.02]}>
					<RoundedBox args={[1.5, 0.62, 0.08]} radius={0.04}>
						<ToonMaterial {...emissive(skin.sign, true, night)} />
					</RoundedBox>
					<Lettering
						color={WORD_COLOR[words.tone]}
						height={0.54}
						night={night}
						position={[0, 0, 0.045]}
						text={words.marquee}
						width={1.42}
					/>
				</group>
			) : null}
			{BULBS.map((x) => (
				<mesh key={x} position={[x * 1.1, 2.46, 0.2]}>
					<sphereGeometry args={[0.025, 8, 6]} />
					<ToonMaterial {...emissive(skin.bulb, true, night)} />
				</mesh>
			))}
			<RoundedBox
				args={[0.46, 0.12, 0.2]}
				position={[0, 2.8, -0.09]}
				radius={0.04}
			>
				<ToonMaterial
					{...emissive(
						won ? ARCADE_3D.topper : ARCADE_3D.topperOff,
						won,
						night
					)}
				/>
			</RoundedBox>
			{tilted ? (
				<mesh position={[0.34, 2.84, -0.09]}>
					<sphereGeometry args={[0.07, 14, 10]} />
					<ToonMaterial {...emissive(ARCADE_3D.tilt, true, true)} />
				</mesh>
			) : null}
		</group>
	);
}

/**
 * The prize counter at the front of the hall: a counter with a glass top,
 * shelves of plush prizes behind it, and a ticket booth sign (its plate is
 * the Collect control).
 */
function PrizeCounter({ at, night }: { at: [number, number]; night: boolean }) {
	const prizes = useMemo(() => {
		const items: InstanceSpec[] = [];
		for (const [row, y] of [1.05, 1.45].entries()) {
			for (let index = 0; index < 7; index++) {
				items.push({
					color: ARCADE_3D.prizes[(index + row * 3) % ARCADE_3D.prizes.length],
					position: [at[0] - 0.9 + index * 0.3, SLAB + y, at[1] - 0.42],
					scale: 0.12 + ((index + row) % 3) * 0.02,
				});
			}
		}
		return items;
	}, [at]);
	return (
		<group>
			<RoundedBox
				args={[2.3, 0.9, 0.55]}
				castShadow
				position={[at[0], SLAB + 0.45, at[1]]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={ARCADE_3D.counter} />
			</RoundedBox>
			<mesh position={[at[0], SLAB + 0.92, at[1]]}>
				<boxGeometry args={[2.34, 0.05, 0.6]} />
				<ToonMaterial color={ARCADE_3D.counterTop} />
			</mesh>
			{/* Shelves behind with the prizes on them. */}
			{[0.92, 1.32].map((y) => (
				<ToonMesh
					color={ARCADE_3D.counter}
					ink={PROP_INK * 0.6}
					key={y}
					position={[at[0], SLAB + y, at[1] - 0.42]}
				>
					<boxGeometry args={[2.2, 0.05, 0.28]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow ink={PROP_INK * 0.6} items={prizes}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<RoundedBox
				args={[1.3, 0.3, 0.06]}
				position={[at[0], SLAB + 1.95, at[1] - 0.42]}
				radius={0.04}
			>
				<ToonMaterial {...emissive(ARCADE_3D.topper, true, night)} />
			</RoundedBox>
		</group>
	);
}

/** A claw machine: a cabinet with a glass case full of plush and a claw. */
function ClawMachine({ at, night }: { at: [number, number]; night: boolean }) {
	const plush = useMemo(
		() =>
			Array.from({ length: 9 }, (_, index) => ({
				color: ARCADE_3D.prizes[index % ARCADE_3D.prizes.length],
				position: [
					at[0] - 0.22 + (index % 3) * 0.22,
					SLAB + 1.02 + Math.floor(index / 3) * 0.05,
					at[1] - 0.2 + Math.floor(index / 3) * 0.2,
				] as Vec3,
				scale: 0.1,
			})),
		[at]
	);
	return (
		<group>
			<RoundedBox
				args={[0.85, 0.95, 0.85]}
				castShadow
				position={[at[0], SLAB + 0.475, at[1]]}
				radius={0.05}
				receiveShadow
			>
				<ToonMaterial color={ARCADE_3D.claw} />
			</RoundedBox>
			<InstancedParts ink={PROP_INK * 0.5} items={plush}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<mesh position={[at[0], SLAB + 1.35, at[1]]}>
				<boxGeometry args={[0.82, 0.8, 0.82]} />
				<ToonMaterial
					color={ARCADE_3D.glass}
					depthWrite={false}
					opacity={0.28}
					transparent
				/>
			</mesh>
			<ToonMesh
				color={ARCADE_3D.lever}
				position={[at[0] + 0.1, SLAB + 1.55, at[1]]}
			>
				<cylinderGeometry args={[0.012, 0.012, 0.4, 6]} />
			</ToonMesh>
			<ToonMesh
				color={ARCADE_3D.lever}
				position={[at[0] + 0.1, SLAB + 1.33, at[1]]}
			>
				<coneGeometry args={[0.07, 0.08, 6]} />
			</ToonMesh>
			<RoundedBox
				args={[0.9, 0.2, 0.9]}
				position={[at[0], SLAB + 1.85, at[1]]}
				radius={0.05}
			>
				<ToonMaterial {...emissive(ARCADE_3D.neon[0], true, night)} />
			</RoundedBox>
		</group>
	);
}

/** Carpet squares with gold star dots. */
function carpetParts(halfWidth: number, halfDepth: number, night: boolean) {
	const tones = night ? ARCADE_3D.carpetNight : ARCADE_3D.carpet;
	const tiles: InstanceSpec[] = [];
	const stars: InstanceSpec[] = [];
	const columns = Math.floor(halfWidth * 2);
	const rows = Math.floor(halfDepth * 2);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const x = -columns / 2 + column + 0.5;
			const z = -rows / 2 + row + 0.5;
			tiles.push({
				color: tones[(row + column) % 2],
				position: [x, SLAB + 0.005, z],
				scale: [1, 0.02, 1],
			});
			stars.push({
				color: ARCADE_3D.carpetStar,
				position: [x, SLAB + 0.017, z],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.12, 0.005, 0.12],
			});
		}
	}
	return { stars, tiles };
}

/** The hall: slab, carpet, back and left walls with neon tubes. */
function Hall({
	halfDepth,
	halfWidth,
	night,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
}) {
	const carpet = useMemo(
		() => carpetParts(halfWidth, halfDepth, night),
		[halfDepth, halfWidth, night]
	);
	const wall = night ? ARCADE_3D.wallNight : ARCADE_3D.wall;
	const base = night ? ARCADE_3D.wallBaseNight : ARCADE_3D.wallBase;
	const back = -halfDepth;
	const left = -halfWidth;
	const neon = (index: number) => {
		const color =
			ARCADE_3D.neon[index % ARCADE_3D.neon.length] ?? ARCADE_3D.topper;
		return emissive(color, true, night);
	};
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={base} />
			</RoundedBox>
			<InstancedParts items={carpet.tiles} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={carpet.stars}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<ToonMesh
				castShadow
				color={wall}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, back]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={wall}
				ink={PROP_INK}
				position={[left, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={base}
				position={[0, SLAB + 0.3, back + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.6, 0.02]} />
			</ToonMesh>
			<ToonMesh
				color={base}
				position={[left + WALL_THICK / 2 + 0.01, SLAB + 0.3, 0]}
			>
				<boxGeometry args={[0.02, 0.6, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			{/* Neon tubes along both walls, and a star and rings on the back. */}
			{[2.38, 2.6].map((y, index) => (
				<group key={y}>
					<mesh position={[0, SLAB + y, back + WALL_THICK / 2 + 0.04]}>
						<boxGeometry args={[halfWidth * 2 - 0.4, 0.05, 0.05]} />
						<ToonMaterial {...neon(index)} />
					</mesh>
					<mesh position={[left + WALL_THICK / 2 + 0.04, SLAB + y, 0]}>
						<boxGeometry args={[0.05, 0.05, halfDepth * 2 - 0.4]} />
						<ToonMaterial {...neon(index + 1)} />
					</mesh>
				</group>
			))}
			{night ? (
				<pointLight
					color={ARCADE_3D.neon[0]}
					decay={2}
					distance={8}
					intensity={2.4}
					position={[0, SLAB + 1.6, back + 1]}
				/>
			) : null}
		</group>
	);
}

/** Trees, shrubs and flowers around the hall. */
function garden(shape: IslandShape, halfWidth: number, halfDepth: number) {
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
				Math.abs(fx) < halfWidth + 0.9 && Math.abs(fz) < halfDepth + 0.9;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (fz < halfDepth && hash < 0.55) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.25) {
					kind = "cedar";
				} else if (hash > 0.47) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, 0, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.72) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 13 + y });
			} else if (hash > 0.82) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** The act layer for the scene: who is on stage and how to draw them. */
export interface ArcadeSceneActs {
	onStage: readonly InterfaceAgentAct[];
	view: ArcadeActView;
}

export interface ArcadeDioramaProps {
	/** The act layer (a snapshot with `asks`); without it, today's floor. */
	acts?: ArcadeSceneActs | null;
	/** Replies waiting on you across the hall (the Collect booth's count). */
	collectable: number;
	hall: HallLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onCollect: () => void;
	onSelect: (machineId: string) => void;
	/**
	 * Phones: each player's name plate rides above their cabinet's marquee
	 * instead of over their head, so it never covers the reels.
	 */
	platesAbove?: boolean;
	quality: RenderQuality;
	reduced: boolean;
	selectedId: string | null;
	shape: IslandShape;
	skinOf: (machine: Machine) => CabinetSkin;
	theme: Scene3dTheme;
}

/** The arcade diorama: island, garden, hall, cabinets, players and prizes. */
export function ArcadeDioramaScene({
	acts = null,
	collectable,
	platesAbove = false,
	hall,
	looks,
	night,
	onCollect,
	onSelect,
	quality,
	reduced,
	selectedId,
	shape,
	skinOf,
	theme,
}: ArcadeDioramaProps) {
	const { halfDepth, halfWidth } = hall;
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < halfWidth + 0.35 && Math.abs(z) < halfDepth + 0.35,
		[halfDepth, halfWidth]
	);
	const green = useMemo(
		() => garden(shape, halfWidth, halfDepth),
		[halfDepth, halfWidth, shape]
	);
	const lamps = useMemo<Vec3[]>(
		() => [
			[halfWidth + 0.5, 0, halfDepth + 0.4],
			[-halfWidth - 0.5, 0, halfDepth + 0.4],
		],
		[halfDepth, halfWidth]
	);
	const stations = useMemo(() => {
		const map = new Map<string, Vec3>();
		for (const cabinet of hall.cabinets) {
			const [x, z] = playerSpot(cabinet);
			map.set(cabinet.machine.agent.id, [x, SLAB, z]);
		}
		return map;
	}, [hall.cabinets]);
	const paths = useMemo(
		() => (hall.you ? arcadePaths(stations, hall.you.points, SLAB) : undefined),
		[hall.you, stations]
	);
	const onStage = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const actView = acts?.view ?? null;
	const { workBubbles } = useGameKitSettings();
	const wordsOf = (agentId: string): CabinetWords | null => {
		const act = actView?.acts.get(agentId);
		return act && actView
			? cabinetWords(
					act,
					actView.snapshot,
					actView.nowMs,
					actView.clock,
					workBubbles
				)
			: null;
	};
	const players = useMemo<VillagerSpec[]>(
		() =>
			hall.cabinets.flatMap((cabinet) => {
				const { machine } = cabinet;
				const base = looks.get(machine.agent.id);
				if (!base) {
					return [];
				}
				const act = onStage.get(machine.agent.id);
				const [px, pz] = playerSpot(cabinet);
				if (act && actView && paths) {
					return arcadePlayer({
						act,
						base: {
							facing: cabinet.yaw - 1.15,
							id: machine.id,
							position: [px, SLAB, pz],
						},
						label: "Open the machine.",
						looks: base,
						paths,
						reduced,
						view: actView,
					});
				}
				const pose = playerPose(machine);
				// Beside the cabinet, turned three-quarters toward its screen
				// (still showing their face); turned out to wave or slump.
				const toScreen = cabinet.yaw - 1.15;
				const facing =
					pose === "needs-you" || pose === "failed" ? FACE_CAMERA : toScreen;
				return [
					{
						facing,
						id: machine.id,
						label: `${machineSummary(machine)}. Open the machine`,
						looks: base,
						name: machine.name,
						pose,
						position: [px, SLAB, pz],
					},
				];
			}),
		[actView, hall.cabinets, looks, onStage, paths, reduced]
	);
	// With acts, every player keeps its own plate (players walk to the
	// you-spot, so a plate above the cabinet would point at nobody).
	const above = platesAbove && !acts;
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reduced}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<LampPosts lamps={lamps} night={night} />
			<Hall halfDepth={halfDepth} halfWidth={halfWidth} night={night} />
			{hall.cabinets.map((cabinet) => {
				const looksOf = looks.get(cabinet.machine.agent.id);
				const skin = skinOf(cabinet.machine);
				return (
					<group
						key={cabinet.machine.id}
						onClick={(event) => {
							event.stopPropagation();
							onSelect(cabinet.machine.id);
						}}
						position={[cabinet.x, SLAB, cabinet.z]}
						rotation={[0, cabinet.yaw, 0]}
					>
						<Cabinet
							accent={looksOf?.accent ?? skin.trim}
							body={looksOf?.body ?? skin.body}
							machine={cabinet.machine}
							night={night}
							skin={skin}
							words={wordsOf(cabinet.machine.agent.id)}
						/>
					</group>
				);
			})}
			<PrizeCounter at={hall.counter} night={night} />
			<ClawMachine at={hall.claw} night={night} />
			{acts ? null : (
				// With acts, answers are tickets on the counter's tray instead.
				<IsoMarker
					at={[hall.counter[0], SLAB + 2.45, hall.counter[1] - 0.4]}
					label={
						collectable > 0
							? `Prize counter: collect the reply that has waited longest, ${collectable} waiting`
							: "Prize counter: nothing to collect"
					}
					onSelect={onCollect}
				>
					Collect {collectable}
				</IsoMarker>
			)}
			{acts && hall.you ? (
				<ArcadeActProps
					onStage={acts.onStage}
					reduced={reduced}
					stations={stations}
					view={acts.view}
					youLayout={hall.you.layout}
				/>
			) : null}
			{above
				? players.map((player) => {
						const cabinet = hall.cabinets.find(
							(item) => item.machine.id === player.id
						);
						if (!cabinet) {
							return null;
						}
						const mark = POSE_MARK[player.pose];
						return (
							<IsoMarker
								at={[cabinet.x, SLAB + 3.15, cabinet.z]}
								focusId={player.id}
								key={player.id}
								label={player.label}
								onSelect={() => onSelect(player.id)}
								pressed={selectedId === player.id}
							>
								{mark ? (
									<span
										aria-hidden="true"
										className={cn(
											"grid size-4 place-items-center rounded-full font-bold text-[11px] leading-none",
											mark.className
										)}
									>
										{mark.sign}
									</span>
								) : null}
								<span className="max-w-24 truncate">{player.name}</span>
							</IsoMarker>
						);
					})
				: null}
			<Villagers
				iconOnly={acts?.view.iconOnly ?? false}
				onSelect={above ? undefined : onSelect}
				paths={paths}
				plates={!above}
				reducedMotion={reduced}
				selectedId={selectedId}
				villagers={players}
			/>
		</group>
	);
}
