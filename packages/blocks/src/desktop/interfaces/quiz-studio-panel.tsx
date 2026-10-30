/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { cn } from "@ryu/ui/lib/utils";
import { Check, CircleHelp } from "lucide-react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { FACE_CAMERA } from "./game3d-villager.tsx";
import { TILE_ATTRIBUTE, type TileHandlers, tileLabel } from "./quiz-board.tsx";
import { QUIZ_ROWS, type QuizBoard, type QuizTile } from "./quiz-model.ts";
import { QUIZ_3D } from "./quiz-palette.ts";
import { cellCentre } from "./quiz-world.ts";

export type CellState = "blank" | "inPlay" | "lit" | "off" | "open" | "played";

/** A painted panel's colours: the face's top and foot, its bevel and its ink. */
export interface Face {
	bevel: string;
	foot: string;
	ink: string;
	top: string;
}

export const FACE: Record<CellState, Face> = {
	blank: QUIZ_3D.tilePlayed,
	inPlay: QUIZ_3D.tileInPlay,
	lit: QUIZ_3D.tileLit,
	off: QUIZ_3D.tileOff,
	open: QUIZ_3D.tile,
	played: QUIZ_3D.tilePlayed,
};

/** A panel's face drawn once on a canvas: bevelled, lit, with its words. */
export function panelCanvas(
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
export function headerLines(name: string): string[] {
	const words = name.toUpperCase().split(/\s+/);
	if (words.join(" ").length <= 12 || words.length === 1) {
		return [words.join(" ")];
	}
	const half = Math.ceil(words.length / 2);
	return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
}

export interface CellView {
	at: Vec3;
	column: number;
	row: number;
	state: CellState;
	tile: QuizTile | null;
}

/** Every cell on the wall, by column and row, with what it shows. */
export function boardCells(
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
export function cellWords(
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
export function cellSize(cell: CellView, words: readonly string[]): number {
	if (cell.state === "inPlay") {
		return 40;
	}
	return words.length > 1 || (words[0]?.length ?? 0) > 5 ? 30 : 76;
}

/** One painted panel on the wall, facing the camera. */
export function Panel({
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
export function TileChip({
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
