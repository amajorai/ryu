/* eslint-disable react/no-unknown-property */
import type { InterfaceActivityKind } from "@ryuhq/protocol/interfaces";
import {
	GLYPH_BITMAPS,
	type GlyphMeshData,
	glyphMesh,
	type PixelSymbol,
} from "./arcade-glyphs.ts";
import type { ReelSymbol } from "./arcade-model.ts";
import { ARCADE_3D } from "./arcade-palette.ts";
import { GAME_DISPLAY_FAMILY } from "./game-font.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";

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
export const MARQUEE_SIGN_Y = 3.2;
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
export function Lettering({
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
export function ReelSymbol3d({
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

export function emissive(color: string, on: boolean, night: boolean) {
	return {
		color,
		emissive: color,
		emissiveIntensity: on ? (night ? 2.2 : 0.6) : 0,
		toneMapped: !(on && night),
	};
}
