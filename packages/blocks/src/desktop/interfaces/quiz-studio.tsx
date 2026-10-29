/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { Check, CircleHelp } from "lucide-react";
import { useMemo } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, DOUBLE_SIDE, jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import { type PlantedTree, PROP_INK, TreeGrove } from "./game3d-props.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	podiumWords,
	QuizActProps,
	type QuizActView,
	quizContestant,
	quizPaths,
	quizYouSpot,
} from "./quiz-acts.tsx";
import { TILE_ATTRIBUTE, type TileHandlers, tileLabel } from "./quiz-board.tsx";
import {
	type Contestant,
	plural,
	QUIZ_ROWS,
	type QuizBoard,
	type QuizTile,
} from "./quiz-model.ts";
import { QUIZ_3D } from "./quiz-palette.ts";
import {
	audienceSeats,
	categoryCentre,
	cellCentre,
	FLOOR_RADIUS,
	hostSpot,
	podiumSpots,
	TOWARD,
	TRUSS_HEIGHT,
	WALL,
	wallPoint,
} from "./quiz-world.ts";

/**
 * The Quiz Show studio (see quiz-world.ts for the layout): the board as a
 * wall of bevelled, glowing tiles facing the camera, each painted with its
 * value (played ones dimmed, the ones that need you brightest) under lit
 * category headers, all inside a curved backdrop lined with marquee bulbs.
 * Clicking a tile picks it; a small status chip on each tile is its
 * keyboard control. The contestants stand as villagers behind chunky
 * podiums whose fronts carry lit score screens, the host at a lectern,
 * under lamps hung on the backdrop whose beams pool on a glossy floor, with the
 * audience in theatre rows along the front edge.
 */

/** The host's and the audience's looks, keyed like agents for the kit. */
export const HOST_ID = "quiz-host";
export const AUDIENCE_IDS = Array.from(
	{ length: 13 },
	(_, index) => `quiz-audience-${index}`
);
/** Height of the stage platform the podiums stand on. */
const STAGE_HEIGHT = 0.2;
const STAGE_RADIUS = 3.4;
const STAGE_STRETCH = 1.7;
/** Contestants and the host stand a head taller than the audience. */
const STAR_SCALE = 1.3;
/** Faces toward the stage (away from the camera). */
const FACE_STAGE = FACE_CAMERA + Math.PI;

type CellState = "blank" | "inPlay" | "lit" | "off" | "open" | "played";

/** A painted panel's colours: the face's top and foot, its bevel and its ink. */
interface Face {
	bevel: string;
	foot: string;
	ink: string;
	top: string;
}

const FACE: Record<CellState, Face> = {
	blank: QUIZ_3D.tilePlayed,
	inPlay: QUIZ_3D.tileInPlay,
	lit: QUIZ_3D.tileLit,
	off: QUIZ_3D.tileOff,
	open: QUIZ_3D.tile,
	played: QUIZ_3D.tilePlayed,
};

/** A panel's face drawn once on a canvas: bevelled, lit, with its words. */
function panelCanvas(
	face: Face,
	lines: readonly string[],
	size: number,
	glow: boolean
): HTMLCanvasElement | null {
	if (typeof document === "undefined") {
		return null;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 256;
	canvas.height = 128;
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	const gradient = context.createLinearGradient(0, 0, 0, 128);
	gradient.addColorStop(0, face.top);
	gradient.addColorStop(1, face.foot);
	context.fillStyle = gradient;
	context.fillRect(0, 0, 256, 128);
	// The bevel: a lit top-left edge and a shaded lower one.
	context.lineWidth = 8;
	context.strokeStyle = face.bevel;
	context.strokeRect(4, 4, 248, 120);
	context.fillStyle = face.ink;
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.font = `900 ${size}px ui-rounded, system-ui, sans-serif`;
	if (glow) {
		context.shadowColor = face.ink;
		context.shadowBlur = 14;
	}
	const step = size * 1.05;
	const top = 64 - ((lines.length - 1) * step) / 2;
	for (const [index, line] of lines.entries()) {
		context.fillText(line, 128, top + index * step, 236);
	}
	return canvas;
}

/** Splits a category name over at most two lines for its header panel. */
function headerLines(name: string): string[] {
	const words = name.toUpperCase().split(/\s+/);
	if (words.join(" ").length <= 12 || words.length === 1) {
		return [words.join(" ")];
	}
	const half = Math.ceil(words.length / 2);
	return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
}

interface CellView {
	at: Vec3;
	column: number;
	row: number;
	state: CellState;
	tile: QuizTile | null;
}

/** Every cell on the wall, by column and row, with what it shows. */
function boardCells(
	board: QuizBoard,
	isRevealed: (tile: QuizTile) => boolean,
	inPlayId: string | null,
	openId: string | null
): CellView[] {
	const cells: CellView[] = [];
	for (const [column, category] of board.columns.entries()) {
		for (let row = 0; row < QUIZ_ROWS; row++) {
			const at = cellCentre(column, row);
			const tile = category?.tiles.find((item) => item.row === row) ?? null;
			let state: CellState = category ? "blank" : "off";
			if (tile) {
				if (tile.thread.id === inPlayId) {
					state = "inPlay";
				} else if (tile.thread.id === openId) {
					state = "off";
				} else if (isRevealed(tile)) {
					state = "played";
				} else {
					state = tile.needsYou ? "lit" : "open";
				}
			}
			cells.push({ at, column, row, state, tile });
		}
	}
	return cells;
}

/** What a cell's face says: its value, "Answering", the answer, or nothing. */
function cellWords(
	cell: CellView,
	board: QuizBoard,
	headlines: ReadonlyMap<string, string>
): string[] {
	if (cell.state === "inPlay") {
		return ["ANSWERING"];
	}
	// With acts, an answer waiting to be read flips its tile to the answer.
	const headline = cell.tile ? headlines.get(cell.tile.thread.id) : undefined;
	if (headline && cell.state !== "off") {
		return headerLines(headline);
	}
	if (cell.state === "off") {
		return [];
	}
	const value =
		cell.tile?.value ?? (cell.row + 1) * 100 * (board.double ? 2 : 1);
	return [String(value)];
}

/** A cell's lettering size: big values, smaller words. */
function cellSize(cell: CellView, words: readonly string[]): number {
	if (cell.state === "inPlay") {
		return 40;
	}
	return words.length > 1 || (words[0]?.length ?? 0) > 5 ? 30 : 76;
}

/** One painted panel on the wall, facing the camera. */
function Panel({
	at,
	canvas,
	height,
	onSelect,
	width,
}: {
	at: Vec3;
	canvas: HTMLCanvasElement | null;
	height: number;
	onSelect?: () => void;
	width: number;
}) {
	if (!canvas) {
		return null;
	}
	return (
		<mesh
			onClick={
				onSelect
					? (event) => {
							event.stopPropagation();
							onSelect();
						}
					: undefined
			}
			position={at}
			rotation={[0, FACE_CAMERA, 0]}
		>
			<planeGeometry args={[width, height]} />
			<meshBasicMaterial toneMapped={false}>
				<canvasTexture args={[canvas]} attach="map" colorSpace="srgb" />
			</meshBasicMaterial>
		</mesh>
	);
}

/** A live clue's status chip on its tile: its keyboard control. */
function TileChip({
	at,
	handlers,
	state,
	tile,
}: {
	at: Vec3;
	handlers: TileHandlers;
	state: CellState;
	tile: QuizTile;
}) {
	const id = tile.thread.id;
	const inPlay = state === "inPlay";
	const played = state === "played";
	let label = tileLabel(tile, "open", handlers.clueFirst);
	if (inPlay) {
		label = tileLabel(tile, "answering", handlers.clueFirst);
	} else if (played) {
		label = tileLabel(tile, "revealed", handlers.clueFirst);
	}
	let mark = (
		<CircleHelp aria-hidden="true" className="size-3.5" strokeWidth={2.75} />
	);
	if (played) {
		mark = <Check aria-hidden="true" className="size-3" strokeWidth={3} />;
	} else if (state === "lit") {
		mark = (
			<span aria-hidden="true" className="font-black">
				!
			</span>
		);
	} else if (tile.status === "working") {
		mark = (
			<span
				aria-hidden="true"
				className="font-black text-[11px] tracking-tight"
			>
				•••
			</span>
		);
	}
	return (
		<group position={at}>
			<Html center zIndexRange={[30, 0]}>
				<button
					aria-current={inPlay ? "true" : undefined}
					aria-label={label}
					className={cn(
						GAME_PLATE,
						GAME_FOCUS,
						"gk-display grid size-5 cursor-pointer select-none place-items-center rounded-full text-[13px] leading-none",
						state === "lit" && "bg-(--gk-gold) text-(--gk-edge)",
						tile.status === "working" && !played && "text-(--gk-good)",
						inPlay && "bg-(--gk-accent) text-(--gk-accent-ink)",
						played && "text-(--gk-ink-muted) opacity-80"
					)}
					data-iso-target=""
					data-thread-id={id}
					onClick={() => handlers.onPick(id)}
					onFocus={() => handlers.onFocusTile(id)}
					onKeyDown={(event) => handlers.onKeyDown(event, id)}
					title={tile.thread.title}
					type="button"
					{...{ [TILE_ATTRIBUTE]: "" }}
				>
					{mark}
				</button>
			</Html>
		</group>
	);
}

/**
 * With acts a podium's screen fills most of its front, so a six- or
 * seven-letter word ("Buzzed", "Working") still reads at desktop size.
 */
const ACT_SCREEN = { height: 0.64, width: 1.28 };

/** The biggest size (up to 100 px) a podium word fits the screen at. */
function fitWordSize(words: string): number {
	if (typeof document === "undefined") {
		return 100;
	}
	const context = document.createElement("canvas").getContext("2d");
	if (!context) {
		return 100;
	}
	let size = 100;
	while (size > 40) {
		context.font = `900 ${size}px ui-rounded, system-ui, sans-serif`;
		if (context.measureText(words).width <= 236) {
			break;
		}
		size -= 4;
	}
	return size;
}

/**
 * A podium's lit screen: its contestant's messages, or with acts what the
 * contestant is on in one word ("X", "Out", "Editing").
 */
function scoreCanvas(words: string, acted = false): HTMLCanvasElement | null {
	const face = {
		bevel: QUIZ_3D.rim,
		foot: QUIZ_3D.screen,
		ink: QUIZ_3D.screenInk,
		top: QUIZ_3D.screen,
	};
	// An act's word is one short line in the biggest letters that fit.
	if (acted) {
		return panelCanvas(face, [words], fitWordSize(words), true);
	}
	const lines = /^\d+$/.test(words) ? [words] : headerLines(words);
	let size = 84;
	if (lines.length > 1) {
		size = 54;
	} else if (words.length > 4) {
		size = 64;
	}
	return panelCanvas(face, lines, size, true);
}

/** Podiums: chunky bodies, desks and the lamp lit while an agent works. */
function podiumParts(
	contestants: readonly Contestant[],
	/** With acts the lamp is unlit: the progress pips light the podium. */
	acted = false
) {
	const bodies: InstanceSpec[] = [];
	const desks: InstanceSpec[] = [];
	const lamps: InstanceSpec[] = [];
	for (const [index, [x, z]] of podiumSpots().entries()) {
		const contestant = contestants[index];
		const box = (y: number, out: number, size: Vec3, color?: string) => ({
			color,
			position: [
				x + TOWARD[0] * out,
				STAGE_HEIGHT + y,
				z + TOWARD[1] * out,
			] as Vec3,
			rotation: [0, FACE_CAMERA, 0] as Vec3,
			scale: size,
		});
		bodies.push(box(0.42, 0, [1.4, 0.84, 0.78], QUIZ_3D.podium));
		desks.push(box(0.88, -0.04, [1.56, 0.1, 0.94], QUIZ_3D.podiumDesk));
		lamps.push(
			box(
				0.12,
				0.4,
				[1.1, 0.07, 0.02],
				contestant?.working && !acted ? QUIZ_3D.lampOn : QUIZ_3D.lampOff
			)
		);
	}
	return { bodies, desks, lamps };
}

/** The truss over the board, its lamps, their beams and the pools they light. */
function rigParts() {
	const truss: InstanceSpec[] = [];
	const lamps: InstanceSpec[] = [];
	const beams: InstanceSpec[] = [];
	const pools: InstanceSpec[] = [];
	// The lamps hang off the backdrop's top edge, over the board.
	const y = TRUSS_HEIGHT;
	for (const along of [-3, -0.9, 1.4, 3.6]) {
		const at = wallPoint(along + 0.9, 0.45, y + 0.2);
		lamps.push({ color: QUIZ_3D.lamp, position: at, scale: [0.22, 0.4, 0.22] });
		truss.push({
			color: QUIZ_3D.truss,
			position: [at[0], at[1] + 0.32, at[2]],
			scale: [0.05, 0.4, 0.05],
		});
		const target = wallPoint(along + 0.9, 4.4, 0);
		const ux = at[0] - target[0];
		const uz = at[2] - target[2];
		const length = Math.hypot(ux, at[1], uz);
		beams.push({
			color: QUIZ_3D.beam,
			position: [(at[0] + target[0]) / 2, at[1] / 2, (at[2] + target[2]) / 2],
			rotation: [
				Math.atan2(uz / length, at[1] / length),
				0,
				-Math.asin(ux / length),
			],
			scale: [1, length, 1],
		});
		pools.push({
			color: QUIZ_3D.pool,
			position: [target[0], STAGE_HEIGHT + 0.012, target[2]],
			rotation: [-Math.PI / 2, 0, 0],
			scale: 0.95,
		});
	}
	return { beams, lamps, pools, truss };
}

/** Marquee bulbs along the top of the curved backdrop. */
function marqueeBulbs(radius: number, height: number): InstanceSpec[] {
	const bulbs: InstanceSpec[] = [];
	const [cx, , cz] = wallPoint(0, 2, 0);
	for (let index = 0; index <= 28; index++) {
		const angle = FACE_CAMERA + Math.PI - 1.15 + (index / 28) * 2.3;
		bulbs.push({
			color: QUIZ_3D.bulb,
			position: [
				cx + Math.sin(angle) * (radius - 0.08),
				height + 0.1,
				cz + Math.cos(angle) * (radius - 0.08),
			],
			scale: 0.07,
		});
	}
	return bulbs;
}

/** Theatre seats: a velvet seat and back in a dark frame. */
function seatParts() {
	const frames: InstanceSpec[] = [];
	const velvet: InstanceSpec[] = [];
	const away: [number, number] = [-TOWARD[0], -TOWARD[1]];
	for (const seat of audienceSeats()) {
		const [x, z] = seat.at;
		const y = seat.row * 0.25;
		const turn: Vec3 = [0, FACE_CAMERA, 0];
		frames.push({
			position: [x, y + 0.14, z],
			rotation: turn,
			scale: [0.78, 0.28, 0.66],
		});
		velvet.push(
			{ position: [x, y + 0.34, z], rotation: turn, scale: [0.66, 0.12, 0.56] },
			{
				position: [x - away[0] * 0.3, y + 0.62, z - away[1] * 0.3],
				rotation: turn,
				scale: [0.68, 0.6, 0.12],
			}
		);
		if (seat.row > 0) {
			// The back row sits on a riser.
			frames.push({
				position: [x, y / 2, z],
				rotation: turn,
				scale: [1.05, y, 1],
			});
		}
	}
	return { frames, velvet };
}

/** Trees round the island beyond the set. */
function rimTrees(shape: IslandShape): PlantedTree[] {
	const trees: PlantedTree[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const [cx, , cz] = wallPoint(0.9, 3.6, 0);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const out =
				(fx - WALL.centre[0]) * TOWARD[0] + (fz - WALL.centre[1]) * TOWARD[1];
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				Math.hypot(fx - cx, fz - cz) < FLOOR_RADIUS + 0.4 ||
				out > 4 ||
				hash > 0.6
			) {
				continue;
			}
			trees.push({
				at: [fx, 0, fz],
				kind: hash < 0.3 ? "cedar" : "fruit",
				scale: 0.75 + jitter(x, y, 9) * 0.35,
				seed: Math.round(hash * 1000),
			});
		}
	}
	return trees;
}

const NO_HEADLINES: ReadonlyMap<string, string> = new Map();

export interface QuizStudioProps {
	/** The act layer (a snapshot with `asks`); without it, today's studio. */
	acts?: { onStage: readonly InterfaceAgentAct[]; view: QuizActView } | null;
	/** The studio audience in its theatre rows (the "Audience" setting). */
	audience?: boolean;
	board: QuizBoard;
	contestants: readonly Contestant[];
	handlers: TileHandlers;
	/** With acts: each delivered answer's headline, by thread, for its tile. */
	headlines?: ReadonlyMap<string, string>;
	inPlayId: string | null;
	isRevealed: (tile: QuizTile) => boolean;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onAsk: (agentId: string) => void;
	openId: string | null;
	quality: RenderQuality;
	reducedMotion: boolean;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/**
 * The studio's cast besides the contestants: the host beside the lectern,
 * then (with the "Audience" setting on) a seated crowd in the theatre rows.
 */
export function studioExtras(
	looks: ReadonlyMap<string, MemberLooks>,
	[hostX, hostZ]: readonly [number, number],
	audience = true
): VillagerSpec[] {
	const out: VillagerSpec[] = [];
	const host = looks.get(HOST_ID);
	if (host) {
		out.push({
			id: HOST_ID,
			label: "The host",
			looks: host,
			name: "Host",
			pose: "idle",
			position: [
				hostX - TOWARD[0] * 0.65,
				STAGE_HEIGHT,
				hostZ - TOWARD[1] * 0.65,
			],
			scale: STAR_SCALE,
		});
	}
	for (const [index, seat] of (audience ? audienceSeats() : []).entries()) {
		const id = AUDIENCE_IDS[index];
		const base = id ? looks.get(id) : undefined;
		if (!(id && base) || jitter(index, 3, 11) > 0.82) {
			continue;
		}
		out.push({
			facing: FACE_STAGE,
			id,
			label: "Audience",
			looks: base,
			name: "Audience",
			pose: "idle",
			position: [seat.at[0], seat.row * 0.25 + 0.3, seat.at[1]],
			scale: 0.85,
		});
	}
	return out;
}

export function QuizStudio({
	acts = null,
	audience = true,
	board,
	contestants,
	handlers,
	headlines = NO_HEADLINES,
	inPlayId,
	isRevealed,
	looks,
	night,
	onAsk,
	openId,
	quality,
	reducedMotion,
	shape,
	theme,
}: QuizStudioProps) {
	const [floorX, , floorZ] = wallPoint(0.9, 3.6, 0);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.hypot(x - floorX, z - floorZ) < FLOOR_RADIUS + 0.2,
		[floorX, floorZ]
	);
	const cells = useMemo(
		() => boardCells(board, isRevealed, inPlayId, openId),
		[board, inPlayId, isRevealed, openId]
	);
	// Each panel's face is painted once per state; keys keep them current.
	const faces = useMemo(
		() =>
			cells.map((cell) => {
				const words = cellWords(cell, board, headlines);
				const glow = cell.state === "lit" || cell.state === "open";
				return {
					canvas: panelCanvas(
						FACE[cell.state],
						words,
						cellSize(cell, words),
						glow
					),
					key: `${cell.column}:${cell.row}:${cell.state}:${words.join("")}`,
				};
			}),
		[board, cells, headlines]
	);
	const headers = useMemo(
		() =>
			board.columns.map((category, column) => ({
				canvas: panelCanvas(
					category ? QUIZ_3D.header : QUIZ_3D.tileOff,
					category ? headerLines(category.name) : [],
					34,
					false
				),
				key: `${column}:${category?.name ?? ""}`,
			})),
		[board]
	);
	const actWords = useMemo(
		() =>
			new Map(
				(acts?.onStage ?? []).map((act) => [act.agentId, podiumWords(act)])
			),
		[acts?.onStage]
	);
	const scores = useMemo(
		() =>
			contestants.map((contestant) => {
				const words =
					actWords.get(contestant.agent.id) ?? String(contestant.score);
				return {
					canvas: scoreCanvas(words, actWords.has(contestant.agent.id)),
					key: `${contestant.agent.id}:${words}`,
				};
			}),
		[actWords, contestants]
	);
	const podiums = useMemo(
		() => podiumParts(contestants, acts != null),
		[acts, contestants]
	);
	const rig = useMemo(() => rigParts(), []);
	const seats = useMemo(() => seatParts(), []);
	const trees = useMemo(() => rimTrees(shape), [shape]);
	const wallWidth = board.columns.length * WALL.column + 0.5;
	const wallTop = WALL.floor + QUIZ_ROWS * WALL.row + 0.7;
	const backdrop = { height: wallTop + 0.25, radius: 6.4 };
	const bulbs = useMemo(
		() => marqueeBulbs(backdrop.radius, backdrop.height),
		[backdrop.height, backdrop.radius]
	);
	const spots = useMemo(() => podiumSpots(), []);
	const stations = useMemo(() => {
		const map = new Map<string, Vec3>();
		for (const [index, contestant] of contestants.entries()) {
			const spot = spots[index];
			if (spot) {
				map.set(contestant.agent.id, [
					spot[0] - TOWARD[0] * 0.8,
					STAGE_HEIGHT,
					spot[1] - TOWARD[1] * 0.8,
				]);
			}
		}
		return map;
	}, [contestants, spots]);
	const narrow = acts?.view.iconOnly ?? false;
	const you = useMemo(() => quizYouSpot(narrow), [narrow]);
	const paths = useMemo(
		() => (acts ? quizPaths(stations, you.points) : undefined),
		[acts, stations, you]
	);
	const actOf = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const actView = acts?.view ?? null;
	const stars = useMemo<VillagerSpec[]>(() => {
		const out: VillagerSpec[] = [];
		for (const [index, contestant] of contestants.entries()) {
			const spot = spots[index];
			const base = looks.get(contestant.agent.id);
			const station = stations.get(contestant.agent.id);
			if (!(spot && base && station)) {
				continue;
			}
			const act = actOf.get(contestant.agent.id);
			if (act && actView && paths) {
				const [star, ...helpers] = quizContestant({
					act,
					base: { id: contestant.agent.id, position: station },
					label: "Ask the final question.",
					looks: base,
					paths,
					reduced: reducedMotion,
					view: actView,
				});
				if (star) {
					out.push({ ...star, scale: STAR_SCALE }, ...helpers);
				}
				continue;
			}
			const { agent, score, working } = contestant;
			out.push({
				id: agent.id,
				label: `Ask ${agent.name} the final question. ${working ? "Working" : "Idle"}, ${plural(score, "message", "messages")}.`,
				looks: base,
				name: agent.name,
				pose: working ? "working" : "idle",
				position: [
					spot[0] - TOWARD[0] * 0.8,
					STAGE_HEIGHT,
					spot[1] - TOWARD[1] * 0.8,
				],
				scale: STAR_SCALE,
			});
		}
		return out;
	}, [
		actOf,
		actView,
		contestants,
		looks,
		paths,
		reducedMotion,
		spots,
		stations,
	]);
	const [hostX, hostZ] = hostSpot();
	const extras = useMemo(
		() => studioExtras(looks, [hostX, hostZ], audience),
		[audience, hostX, hostZ, looks]
	);
	// With acts the host (you) wears a name plate: the queue's bubbles and
	// plates then keep clear of its head, as they do of any plate.
	const hostPlated = acts != null;
	const host = hostPlated ? extras.filter((extra) => extra.id === HOST_ID) : [];
	const unplated = hostPlated
		? extras.filter((extra) => extra.id !== HOST_ID)
		: extras;
	const stageAt = wallPoint(0.9, 4.1, 0);
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
			<TreeGrove theme={theme} trees={trees} />
			{/* The glossy floor, the stage on it and its gold ring. */}
			<mesh position={[floorX, 0.03, floorZ]} receiveShadow>
				<cylinderGeometry args={[FLOOR_RADIUS, FLOOR_RADIUS, 0.06, 64]} />
				<ToonMaterial
					color={night ? QUIZ_3D.floorNight : QUIZ_3D.floor}
					sheen={0.6}
				/>
			</mesh>
			<group
				position={[stageAt[0], 0, stageAt[2]]}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<mesh
					castShadow
					position={[0, STAGE_HEIGHT / 2, 0]}
					receiveShadow
					scale={[STAGE_STRETCH, 1, 1]}
				>
					<cylinderGeometry
						args={[STAGE_RADIUS, STAGE_RADIUS + 0.1, STAGE_HEIGHT, 64]}
					/>
					<ToonMaterial color={QUIZ_3D.stage} rim={0.15} sheen={0.5} />
				</mesh>
				<mesh
					position={[0, STAGE_HEIGHT + 0.006, 0]}
					rotation={[-Math.PI / 2, 0, 0]}
					scale={[STAGE_STRETCH, 1, 1]}
				>
					<ringGeometry args={[STAGE_RADIUS - 0.45, STAGE_RADIUS - 0.3, 72]} />
					<meshBasicMaterial color={QUIZ_3D.ring} toneMapped={!night} />
				</mesh>
			</group>
			<InstancedParts items={rig.pools}>
				<circleGeometry args={[1, 32]} />
				<CurvedBasicMaterial
					blending={ADDITIVE_BLENDING}
					depthWrite={false}
					opacity={night ? 0.3 : 0.16}
					toneMapped={false}
					transparent
				/>
			</InstancedParts>
			{/* The curved backdrop with its marquee bulbs. */}
			<mesh position={wallPoint(0, 2, backdrop.height / 2)}>
				<cylinderGeometry
					args={[
						backdrop.radius,
						backdrop.radius,
						backdrop.height,
						48,
						1,
						true,
						FACE_CAMERA + Math.PI - 1.15,
						2.3,
					]}
				/>
				<ToonMaterial
					color={night ? QUIZ_3D.backdropNight : QUIZ_3D.backdrop}
					side={DOUBLE_SIDE}
				/>
			</mesh>
			<InstancedParts items={bulbs}>
				<sphereGeometry args={[1, 10, 8]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{/* The board wall: its bezel and rim, and every painted panel. */}
			<mesh
				castShadow
				position={wallPoint(0, -0.06, wallTop / 2 + 0.2)}
				receiveShadow
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[wallWidth, wallTop + 0.2, 0.3]} />
				<ToonMaterial color={QUIZ_3D.bezel} />
			</mesh>
			<mesh
				position={wallPoint(0, 0.1, wallTop + 0.32)}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[wallWidth + 0.1, 0.08, 0.1]} />
				<meshBasicMaterial color={QUIZ_3D.rim} toneMapped={false} />
			</mesh>
			{cells.map((cell, index) => {
				const face = faces[index];
				const tile = cell.tile;
				return face ? (
					<Panel
						at={cell.at}
						canvas={face.canvas}
						height={WALL.cellHeight}
						key={face.key}
						onSelect={
							tile && cell.state !== "off"
								? () => handlers.onPick(tile.thread.id)
								: undefined
						}
						width={WALL.cellWidth}
					/>
				) : null;
			})}
			{headers.map((header, column) => (
				<Panel
					at={categoryCentre(column)}
					canvas={header.canvas}
					height={WALL.cellHeight + 0.1}
					key={header.key}
					width={WALL.cellWidth}
				/>
			))}
			{/* Podiums with their score screens, and the host's lectern. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={QUIZ_3D.podium}
				items={podiums.bodies}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial rim={0.15} />
			</InstancedParts>
			<InstancedParts castShadow items={podiums.desks}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={podiums.lamps}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={false} />
			</InstancedParts>
			{scores.map((score, index) => {
				const spot = spots[index];
				return spot ? (
					<Panel
						at={[
							spot[0] + TOWARD[0] * 0.4,
							STAGE_HEIGHT + 0.5,
							spot[1] + TOWARD[1] * 0.4,
						]}
						canvas={score.canvas}
						height={acts ? ACT_SCREEN.height : 0.46}
						key={score.key}
						width={acts ? ACT_SCREEN.width : 0.92}
					/>
				) : null;
			})}
			<mesh
				castShadow
				position={[hostX, STAGE_HEIGHT + 0.42, hostZ]}
				rotation={[0, FACE_CAMERA, 0]}
			>
				<boxGeometry args={[0.8, 0.84, 0.52]} />
				<ToonMaterial color={QUIZ_3D.lectern} rim={0.2} />
			</mesh>
			{/* The lighting rig. */}
			<InstancedParts castShadow items={rig.truss}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={rig.lamps}>
				<cylinderGeometry args={[0.7, 1, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={rig.beams}>
				<cylinderGeometry args={[0.14, 0.9, 1, 20, 1, true]} />
				<CurvedBasicMaterial
					blending={ADDITIVE_BLENDING}
					depthWrite={false}
					opacity={night ? 0.12 : 0.07}
					toneMapped={false}
					transparent
				/>
			</InstancedParts>
			{/* The audience's theatre rows. */}
			{audience ? (
				<>
					<InstancedParts
						castShadow
						ink={PROP_INK * 0.7}
						inkColor={QUIZ_3D.seatFrame}
						items={seats.frames}
						receiveShadow
					>
						<boxGeometry args={[1, 1, 1]} />
						<ToonMaterial color={QUIZ_3D.seatFrame} />
					</InstancedParts>
					<InstancedParts castShadow items={seats.velvet}>
						<boxGeometry args={[1, 1, 1]} />
						<ToonMaterial color={QUIZ_3D.velvet} />
					</InstancedParts>
				</>
			) : null}
			{acts ? (
				<QuizActProps
					onStage={acts.onStage}
					reduced={reducedMotion}
					stations={stations}
					view={acts.view}
					youLayout={you.layout}
				/>
			) : null}
			<Villagers
				iconOnly={narrow}
				onSelect={onAsk}
				paths={paths}
				reducedMotion={reducedMotion}
				villagers={stars}
			/>
			{host.length > 0 ? (
				<Villagers
					iconOnly={narrow}
					reducedMotion={reducedMotion}
					villagers={host}
				/>
			) : null}
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={unplated}
			/>
			{/* Each live clue's status chip, at its tile's top right corner. */}
			{cells.map((cell) => {
				const tile = cell.tile;
				if (!tile || tile.thread.id === openId) {
					return null;
				}
				const corner = wallPoint(
					(cell.column - (board.columns.length - 1) / 2) * WALL.column +
						WALL.cellWidth / 2 -
						0.1,
					0.14,
					cell.at[1] + WALL.cellHeight / 2 - 0.1
				);
				return (
					<TileChip
						at={corner}
						handlers={handlers}
						key={tile.thread.id}
						state={cell.state}
						tile={tile}
					/>
				);
			})}
		</group>
	);
}
