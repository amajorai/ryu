import type {
	WorldDirection,
	WorldEntity,
	WorldLayout,
	WorldPoint,
} from "@ryuhq/protocol/interfaces";
import {
	alarmLampSprite,
	carrySprite,
	chestSprite,
	flagSprite,
	followerSprite,
	hourglassSprite,
	markSprite,
	nextSignSprite,
	pipBarSprite,
	postSprite,
	toolSprite,
	type WaitTint,
	type World2dTool,
	zzzSprite,
} from "./world-2d-act-sprites.ts";
import {
	barrelSprite,
	benchSprite,
	boardSprite,
	bookshelfSprite,
	CHIMNEY_TOP,
	DOOR_PANE,
	deskSprite,
	FOUNTAIN_POOL,
	FOUNTAIN_SPOUT,
	fenceSprite,
	fountainSprite,
	houseSprite,
	LAMP_LIGHT,
	lampSprite,
	mailboxSprite,
	type OfficePiece,
	officeSprite,
	planterSprite,
	signSprite,
	WINDOW_PANES,
	wellSprite,
} from "./world-2d-buildings.ts";
import {
	agentLook,
	bubbleSprite,
	characterShadow,
	characterSprite,
	PLAYER_LOOK,
	type QuestTone,
	questMarkerSprite,
} from "./world-2d-characters.ts";
import {
	lowGrowth,
	pottedPlantSprite,
	type TreeKind,
	treeKind,
	treeSprite,
} from "./world-2d-flora.ts";
import { buildGround, type GroundShadow } from "./world-2d-ground.ts";
import {
	insidePond,
	insideWorld,
	marginTrees,
	type SceneFrame,
	type VillageProps,
} from "./world-2d-layout.ts";
import type { PixelScene } from "./world-2d-palette.ts";
import { SWATCH } from "./world-2d-palette.ts";
import {
	drawSprite,
	mix,
	noise,
	PixelBuffer,
	PX,
	parseHex,
	type Sprite,
	spriteCache,
	toSprite,
} from "./world-2d-pixel.ts";
import { roofTones, type WorldScenePalette } from "./world-themes.ts";
import { tileHash, type VillageLayout } from "./world-village.ts";

/**
 * Composes the 2D village each frame at native resolution: the baked ground,
 * then every standing thing (trees, cottages, furniture, villagers and the
 * player) in y-order so canopies and roofs overlap whoever walks behind
 * them (a roof or canopy that hides part of the player turns see-through),
 * then the fountain's water. At night the scene is multiplied by a blue
 * lightmap with pools of light cut out of it in stepped concentric rings
 * (flat two-step pools at lamp posts, on the wall around lit windows, and in half-oval pools on
 * the ground below them), a low warm ring is screened over lamp and window
 * pools so the ground keeps its own colors, and lit glass and the
 * characters (with a lifted ambient and a moonlit rim, so faces and dark
 * clothes stay readable) are laid back on top through an occlusion pass,
 * so a window's glow never paints over someone standing in front of it. Chimney smoke (night-tinted)
 * and the working emotes go on last, never dimmed.
 */

interface Drawable {
	/** The character this is (per-frame actors only). */
	actor?: boolean;
	/**
	 * A roof or canopy: it turns see-through while it covers the player, the
	 * way Stardew fades a building or tree the farmer walks behind.
	 */
	fade?: boolean;
	/** The player (per-frame only). */
	player?: boolean;
	sortY: number;
	sprite: Sprite;
	/** Anchor in frame pixels. */
	x: number;
	y: number;
}

interface LightSource {
	/** Only the half below the center (a pool of light on the ground). */
	half: boolean;
	/** Stepped rings from rim to core: windows three, lamps two. */
	rings: number;
	rx: number;
	ry: number;
	/** Also screened warm (lamps and the ground pools under windows). */
	warm: boolean;
	x: number;
	y: number;
}

/**
 * Characters' feet sit this many art pixels above their tile's bottom edge.
 * A character is exactly one world tile tall, so two characters on
 * neighboring rows never overlap.
 */
export const CHARACTER_RAISE = 2;
/** An indoor villager sits behind their desk: feet this far into the tile. */
const SEATED_FEET = 10;

export interface StaticScene {
	chimneys: Map<string, WorldPoint>;
	drawables: Drawable[];
	fireflies: WorldPoint[];
	/** The fountain's spout and pool in frame pixels (outdoors). */
	fountain: { pool: WorldPoint; spout: WorldPoint } | null;
	frame: SceneFrame;
	ground: HTMLCanvasElement;
	indoor: boolean;
	lights: LightSource[];
	/** Water glint spots in frame pixels (the pond's ripples). */
	ripples: WorldPoint[];
}

export interface SceneInput {
	agentsWorking: ReadonlyMap<string, boolean>;
	frame: SceneFrame;
	layout: WorldLayout;
	props: VillageProps;
	roofs: ReadonlyMap<string, string>;
	scene: PixelScene;
	/** The legacy scene palette, for tuning roofs per theme. */
	sceneTones: WorldScenePalette;
	title: string;
	village: VillageLayout;
}

/** A round glow on a wall around lit glass. */
function disc(x: number, y: number, r: number, rings: number): LightSource {
	return { half: false, rings, rx: r, ry: r, warm: false, x, y };
}

/** A half-oval pool of warm light on the ground below lit glass. */
function groundPool(x: number, y: number, rx: number, ry: number): LightSource {
	return { half: true, rings: 3, rx, ry, warm: true, x, y };
}

/** Frame-pixel position of a world tile's top-left corner. */
function at(frame: SceneFrame, x: number, y: number): WorldPoint {
	return { x: (x + frame.margin.x) * PX, y: (y + frame.margin.y) * PX };
}

const HALF = PX / 2;

/** Bakes the ground; depends only on layout, theme and frame. */
export function buildGroundLayer(input: SceneInput): HTMLCanvasElement {
	const { frame, layout, props, scene, village } = input;
	const shadows: GroundShadow[] = [];
	const hidden = landmarkTiles(input);
	const treeShadow = (x: number, y: number, size: number) => {
		const p = at(frame, x, y);
		shadows.push({
			cx: p.x + HALF,
			cy: p.y + PX - 4,
			rx: size,
			ry: Math.max(3, size * 0.32),
		});
	};
	for (const tree of village.trees) {
		if (!insidePond(props.pond, tree.x, tree.y)) {
			const edge = tree.x === 0 || tree.y === 0 || tree.x === layout.width - 1;
			const kind = sceneTreeKind(hidden, tree, edge);
			treeShadow(tree.x, tree.y, scene.indoor || lowGrowth(kind) ? 11 : 17);
		}
	}
	if (!scene.indoor) {
		for (const tree of marginTrees(layout, village, frame, props.pond)) {
			const kind = sceneTreeKind(hidden, tree, true);
			treeShadow(tree.x, tree.y, lowGrowth(kind) ? 11 : 17);
		}
	}
	for (const house of village.houses) {
		const p = at(frame, house.x, house.y);
		shadows.push({
			cx: p.x + (house.w * PX) / 2,
			cy: p.y + house.h * PX,
			rx: (house.w * PX) / 2 + 4,
			ry: 4,
		});
	}
	for (const item of [...props.decor.map((d) => d.point), ...props.lamps]) {
		const p = at(frame, item.x, item.y);
		shadows.push({ cx: p.x + HALF, cy: p.y + PX - 3, rx: 9, ry: 3 });
	}
	if (props.sign) {
		const p = at(frame, props.sign.x, props.sign.y);
		shadows.push({ cx: p.x + HALF, cy: p.y + PX - 3, rx: 16, ry: 3 });
	}
	if (props.fountain) {
		const p = at(frame, props.fountain.x, props.fountain.y);
		shadows.push({ cx: p.x + HALF, cy: p.y + PX - 4, rx: 36, ry: 6 });
	}
	return buildGround({ frame, layout, props, scene, shadows, village });
}

/** Everything standing in the village, sorted back to front. */
export function buildStaticScene(
	input: SceneInput,
	ground: HTMLCanvasElement
): StaticScene {
	const { agentsWorking, frame, layout, props, roofs, scene, village } = input;
	const night = scene.night !== null;
	const drawables: Drawable[] = [];
	const lights: LightSource[] = [];
	const chimneys = new Map<string, WorldPoint>();
	const add = (
		sprite: Sprite,
		x: number,
		y: number,
		sortY = y,
		fade = false
	) => {
		drawables.push(
			fade ? { fade, sortY, sprite, x, y } : { sortY, sprite, x, y }
		);
	};
	const hidden = landmarkTiles(input);
	const treeAt = (x: number, y: number, variant: number, edge: boolean) => {
		const p = at(frame, x, y);
		const hash = tileHash(x, y);
		const foot = p.y + PX - 3;
		if (scene.indoor) {
			add(indoorPiece(layout, x, y, hash + variant, scene), p.x + HALF, foot);
			return;
		}
		if (y === village.plaza.bottom + 1 && insideWorld(layout, x, y)) {
			// The square is paved: its corner "trees" are flower planters.
			add(planterSprite(hash), p.x + HALF, foot);
			return;
		}
		const kind = sceneTreeKind(hidden, { variant, x, y }, edge);
		// Trees stand a little off-center so a wood never reads as a grid.
		const nudge = lowGrowth(kind) ? 0 : (hash % 7) - 3;
		add(
			treeSprite(kind, hash % 3, scene),
			p.x + HALF + nudge,
			foot,
			foot,
			!lowGrowth(kind)
		);
	};
	for (const tree of village.trees) {
		if (insidePond(props.pond, tree.x, tree.y)) {
			continue;
		}
		const edge = tree.x === 0 || tree.y === 0 || tree.x === layout.width - 1;
		treeAt(tree.x, tree.y, tree.variant, edge);
	}
	if (!scene.indoor) {
		for (const tree of marginTrees(layout, village, frame, props.pond)) {
			treeAt(tree.x, tree.y, tree.variant, true);
		}
	}
	village.houses.forEach((house, index) => {
		const p = at(frame, house.x, house.y);
		const working = agentsWorking.get(house.agentId) ?? false;
		const roofBase = roofs.get(house.agentId) ?? SWATCH.red530;
		const roof = roofTones(roofBase, input.sceneTones).fill;
		const sprite = houseSprite(
			{ lit: working || night, roof: hexOf(roof), variant: index },
			scene.indoor
		);
		const base = p.y + house.h * PX;
		add(sprite, p.x, p.y, base, true);
		if (scene.indoor) {
			// The desk stands on the villager's own tile, in front of them.
			add(deskSprite(working, index), p.x, base, base + PX - 1);
			return;
		}
		chimneys.set(house.agentId, {
			x: p.x + CHIMNEY_TOP.x,
			y: p.y + CHIMNEY_TOP.y,
		});
		if (night) {
			// Lit glass glows on the wall around it and spills a half-oval
			// pool onto the ground in front of the cottage.
			const ground = p.y + house.h * PX;
			for (const pane of WINDOW_PANES) {
				const x = p.x + pane.x + pane.w / 2;
				lights.push(disc(x, p.y + pane.y + pane.h / 2 + 3, 15, 3));
				lights.push(groundPool(x, ground, 15, 7));
			}
			const doorX = p.x + DOOR_PANE.x + DOOR_PANE.w / 2;
			lights.push(disc(doorX, p.y + DOOR_PANE.y + 10, 13, 3));
			lights.push(groundPool(doorX, ground + 1, 13, 8));
		}
	});
	for (const lamp of props.lamps) {
		const p = at(frame, lamp.x, lamp.y);
		const foot = { x: p.x + HALF, y: p.y + PX - 3 };
		add(lampSprite(night), foot.x, foot.y);
		const head = { x: foot.x + LAMP_LIGHT.x, y: foot.y + LAMP_LIGHT.y };
		// A small glow around the lantern, and a flat two-step pool on the
		// ground around the post's foot: it stays on the ground row the lamp
		// stands on, so it never washes over a cottage's facade.
		lights.push({ ...disc(head.x, head.y, 9, 2), warm: true });
		lights.push({
			half: false,
			rings: 2,
			rx: 30,
			ry: 12,
			warm: true,
			x: foot.x,
			y: foot.y - 1,
		});
	}
	for (const mailbox of props.mailboxes) {
		const p = at(frame, mailbox.point.x, mailbox.point.y);
		add(
			mailboxSprite(hexOf(roofs.get(mailbox.agentId) ?? SWATCH.red490)),
			p.x + 20,
			p.y + PX - 4
		);
	}
	for (const item of props.decor) {
		const p = at(frame, item.point.x, item.point.y);
		const hash = tileHash(item.point.x, item.point.y);
		const sprite = decorSprite(item.kind, hash, scene.indoor);
		// Yard barrels sit toward the yard's outer corner.
		const yard = item.kind === "barrel" || item.kind === "crate";
		add(sprite, p.x + (yard && !scene.indoor ? 11 : HALF), p.y + PX - 3);
	}
	let fountain: StaticScene["fountain"] = null;
	if (props.fountain) {
		const p = at(frame, props.fountain.x, props.fountain.y);
		// Its basin reaches the square's south curb, so the spout stays
		// clear of whoever stands on the spawn tile above it.
		const foot = { x: p.x + HALF, y: p.y + PX + 2 };
		add(fountainSprite(), foot.x, foot.y);
		fountain = {
			pool: { x: foot.x + FOUNTAIN_POOL.x, y: foot.y + FOUNTAIN_POOL.y },
			spout: { x: foot.x + FOUNTAIN_SPOUT.x, y: foot.y + FOUNTAIN_SPOUT.y },
		};
	}
	if (props.sign) {
		const p = at(frame, props.sign.x, props.sign.y);
		const words = input.title.toUpperCase().split(/\s+/);
		add(signSprite(words), p.x + HALF, p.y + PX - 3);
	}
	drawables.sort((a, b) => a.sortY - b.sortY);
	const fireflies: WorldPoint[] = [];
	if (night) {
		for (let y = 0; y < layout.height; y++) {
			for (let x = 0; x < layout.width; x++) {
				const key = `${x},${y}`;
				if (
					!(village.paths.has(key) || village.blocked.has(key)) &&
					tileHash(x * 7 + 3, y * 13 + 1) % 100 < 10
				) {
					const p = at(frame, x, y);
					fireflies.push({ x: p.x + (tileHash(x, y) % 24) + 4, y: p.y + 10 });
				}
			}
		}
	}
	const ripples: WorldPoint[] = [];
	if (props.pond) {
		const p = at(frame, props.pond.x, props.pond.y);
		const w = props.pond.w * PX;
		const h = props.pond.h * PX;
		for (const [fx, fy] of [
			[0.3, 0.55],
			[0.62, 0.68],
			[0.48, 0.4],
			[0.72, 0.45],
			[0.38, 0.74],
		] as const) {
			ripples.push({
				x: p.x + Math.round(w * fx),
				y: p.y + Math.round(h * fy),
			});
		}
	}
	return {
		chimneys,
		drawables,
		fireflies,
		fountain,
		frame,
		ground,
		indoor: scene.indoor,
		lights,
		ripples,
	};
}

/** The tree a scenery tile grows; a bush where a canopy would hide things. */
function sceneTreeKind(
	hidden: ReadonlySet<string>,
	tree: { variant: number; x: number; y: number },
	edge: boolean
): TreeKind {
	const kind = treeKind(tree.variant, tileHash(tree.x, tree.y), edge);
	// A canopy would hide a villager, a door or the plaza furniture just
	// above: grow a berry bush there instead (it blocks the same tile).
	return !lowGrowth(kind) && canopyWouldHide(hidden, tree.x, tree.y)
		? "bush"
		: kind;
}

/**
 * Office "trees": bookshelves along the back wall; plants, filing cabinets,
 * a coffee bar and couches taking turns down the side walls; plants and
 * floor lamps on the open floor.
 */
function indoorPiece(
	layout: WorldLayout,
	x: number,
	y: number,
	seed: number,
	scene: PixelScene
): Sprite {
	if (!insideWorld(layout, x, y)) {
		return pottedPlantSprite(seed, scene);
	}
	if (y === 0) {
		return bookshelfSprite(seed);
	}
	const side = x === 0 || x === layout.width - 1;
	if (side) {
		const cycle: (OfficePiece | "plant")[] = [
			"plant",
			"cabinet",
			"couch",
			"plant",
			"coffee",
			"cabinet",
		];
		const piece = cycle[(y + (x === 0 ? 0 : 3)) % cycle.length] ?? "plant";
		return piece === "plant"
			? pottedPlantSprite(seed, scene)
			: officeSprite(piece, seed);
	}
	return seed % 3 === 0 ? officeSprite("lamp") : pottedPlantSprite(seed, scene);
}

/** Tiles a tree canopy must never cover: villagers, cottages, furniture. */
function landmarkTiles(input: SceneInput): Set<string> {
	const { layout, props, village } = input;
	const tiles = new Set<string>();
	for (const entity of layout.entities) {
		tiles.add(`${entity.x},${entity.y}`);
	}
	for (const house of village.houses) {
		for (let dx = 0; dx < house.w; dx++) {
			tiles.add(`${house.x + dx},${house.y + house.h - 1}`);
		}
	}
	for (const point of [
		...props.lamps,
		...props.decor.map((item) => item.point),
		...props.mailboxes.map((item) => item.point),
	]) {
		tiles.add(`${point.x},${point.y}`);
	}
	for (const point of [props.sign, props.fountain]) {
		if (point) {
			for (let dx = -1; dx <= 1; dx++) {
				tiles.add(`${point.x + dx},${point.y}`);
			}
		}
	}
	return tiles;
}

function canopyWouldHide(
	tiles: ReadonlySet<string>,
	x: number,
	y: number
): boolean {
	for (let dx = -1; dx <= 1; dx++) {
		if (tiles.has(`${x + dx},${y - 1}`)) {
			return true;
		}
	}
	return tiles.has(`${x},${y - 2}`);
}

function decorSprite(kind: string, hash: number, indoor: boolean): Sprite {
	switch (kind) {
		case "bench":
			return benchSprite(indoor);
		case "well":
			return wellSprite(indoor);
		case "board":
			return boardSprite(indoor);
		case "barrel":
			return barrelSprite(false);
		case "crate":
			return barrelSprite(true);
		case "fence":
			return fenceSprite();
		case "cabinet":
			return officeSprite("cabinet", hash);
		case "shelf":
			return bookshelfSprite(hash);
		default:
			// Indoors the plaza's planters are floor lamps and side couches.
			if (indoor) {
				return hash % 2 === 0
					? officeSprite("lamp")
					: officeSprite("couch", hash);
			}
			return planterSprite(hash);
	}
}

/** `roofTones` returns HSL color strings; sprites want hex. */
function hexOf(color: string): string {
	if (color.startsWith("#")) {
		return color;
	}
	const match = /hsl\((\d+(?:\.\d+)?) ([\d.]+)% ([\d.]+)%\)/.exec(color);
	if (!match) {
		return SWATCH.red530;
	}
	const h = Number(match[1]);
	const s = Number(match[2]) / 100;
	const l = Number(match[3]) / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) =>
		l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	const hex = (v: number) =>
		Math.round(v * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

// ---------------------------------------------------------------------------
// Per-frame composition
// ---------------------------------------------------------------------------

/** What a villager's act shows over the sprite (the act layer only). */
export interface ActorAct {
	/** One alarm lamp per counted failure. */
	alarms?: number;
	/** When a limit clears ("15:10"), beside its zzz clock. */
	back?: string | null;
	/** The letter or scroll an asker carries. */
	carry?: "letter" | "scroll" | null;
	/** A routine's run against its usual length: a "~" plaque, never guessed pips. */
	estimate?: boolean;
	/** A stopped run: smoke at its chimney (the "!" is `alert`). */
	failed?: boolean;
	/** Running helpers, following the villager. */
	followers?: number;
	/** An interrupted run (and no failure): a grey flag by the villager. */
	interrupted?: boolean;
	/** A limit: zzz and a clock over the head. */
	limited?: boolean;
	/** There is a next step (its words are in the talk panel): a signpost. */
	next?: boolean;
	/** Failures too old to count: one dim lamp each. */
	oldAlarms?: number;
	/** Progress pips over the roof while it works. */
	pips?: { done: number; total: number } | null;
	/** A suggestion waits: a note by the villager. */
	suggestion?: boolean;
	/** The tool a working villager holds for its step. */
	tool?: World2dTool | null;
	/** An older answer waits unread: a letter by the villager. */
	unread?: boolean;
	/** An asker's wait, on an hourglass plaque ("14m"). */
	wait?: string | null;
	/** How long the carried ask has waited: the plaque's tint. */
	waitTint?: WaitTint;
}

export interface ActorState {
	/** The act layer's sprites over this villager. */
	act?: ActorAct;
	/** The "!" quest marker: the villager is waiting on the user. */
	alert?: QuestTone | null;
	/** False hides the working "..." emote (the "Work bubbles" setting). */
	emote?: boolean;
	entity: WorldEntity;
	facing: WorldDirection;
	/** Index into the curated outfits (the agent's place in the village). */
	lookIndex: number;
	/** The player stands close (the villager faces them, no idle glances). */
	near: boolean;
	talking: boolean;
	working: boolean;
}

export interface FrameState {
	actors: readonly ActorState[];
	/** Camera offset in art pixels (frame origin on the canvas). */
	camX: number;
	camY: number;
	/** The act layer's chest of answers, on its tile. */
	chest?: WorldPoint | null;
	/** Animate idle loops (false under reduced motion). */
	motion: boolean;
	/** The act layer's notice posts, on their queue tiles. */
	notices?: readonly WorldPoint[];
	player: { facing: WorldDirection; walkFrame: number; x: number; y: number };
	/** Milliseconds since mount, for the idle animations. */
	time: number;
}

/** Offscreen canvases the night pass draws into (viewport sized). */
export interface NightLayers {
	/** Glass glow and characters, with whatever stands in front cut out. */
	fx: CanvasRenderingContext2D;
	/** The multiply lightmap. */
	light: CanvasRenderingContext2D;
}

/** Where a villager's feet are drawn, in frame pixels. */
export function actorFeet(
	entity: WorldPoint,
	margin: { x: number; y: number },
	indoor: boolean
): WorldPoint {
	return {
		x: (entity.x + margin.x) * PX + HALF,
		y:
			(entity.y + margin.y) * PX +
			(indoor ? SEATED_FEET : PX - CHARACTER_RAISE),
	};
}

/** A smoke puff: a light disc with a shaded lower-right rim. */
function buildPuff(size: number): Sprite {
	const buffer = new PixelBuffer(size + 2, size + 2);
	const r = size / 2;
	buffer.ellipse(r + 1, r + 1, r, r, SWATCH.indigo255);
	buffer.ellipse(r + 0.6, r + 0.6, r - 0.6, r - 0.6, SWATCH.violet80);
	if (size >= 4) {
		buffer.set(Math.floor(r), Math.floor(r), SWATCH.violet25);
	}
	return toSprite(buffer, Math.floor(r) + 1, Math.floor(r) + 1);
}

const puffSprites = spriteCache(buildPuff);

/** Pools lift the night toward this warm white. */
const POOL_LIGHT = SWATCH.amber145;
/** Warm color screened over lamp and window pools. */
const POOL_WARM = SWATCH.amber380;

/**
 * A pool of light: concentric stepped rings (no dither) on the pixel
 * grid, an ellipse `rx` by `ry`, or only its lower half for a pool on the
 * ground. `ring` maps a level (1 rim .. `rings` core) to its color.
 */
function lightRings(
	rx: number,
	ry: number,
	rings: number,
	half: boolean,
	ring: (level: number) => string
): Sprite {
	const buffer = new PixelBuffer(rx * 2, ry * 2);
	for (let y = half ? ry : 0; y < ry * 2; y++) {
		for (let x = 0; x < rx * 2; x++) {
			const d = Math.hypot((x + 0.5 - rx) / rx, (y + 0.5 - ry) / ry);
			if (d >= 1) {
				continue;
			}
			const level = Math.min(rings, Math.ceil((1 - d) * rings));
			buffer.set(x, y, ring(level));
		}
	}
	return toSprite(buffer, rx, ry);
}

/**
 * The lightmap's pool: each ring lifts the night color about 0.16 further
 * toward warm white, so a pool keeps the local colors under it.
 */
function buildLight(
	rx: number,
	ry: number,
	rings: number,
	half: boolean,
	night: string
): Sprite {
	// Two-step pools (lamps) take bigger steps so their core still lifts.
	const step = rings <= 2 ? 0.16 : 0.14;
	return lightRings(rx, ry, rings, half, (level) =>
		mix(night, POOL_LIGHT, Math.min(0.72, 0.06 + level * step))
	);
}

/** The warm ring screened over a pool: low alpha, a step per ring. */
function buildGlow(
	rx: number,
	ry: number,
	rings: number,
	half: boolean
): Sprite {
	return lightRings(rx, ry, rings, half, (level) => {
		const alpha = Math.round(Math.min(0.12, level * 0.04) * 255);
		return `${POOL_WARM}${alpha.toString(16).padStart(2, "0")}`;
	});
}

const glowSprites = spriteCache(buildGlow);
const lightSprites = spriteCache(buildLight);

/** 8 fps cadence for idle loops (water, fireflies, glances). */
const TICK_MS = 125;
/** Smoke drifts at about 7 fps, the emote's dots at about 5.5 fps. */
const SMOKE_MS = 140;
const DOTS_MS = 180;

function visible(
	width: number,
	height: number,
	d: Drawable,
	camX: number,
	camY: number
): boolean {
	const left = d.x - d.sprite.ax + camX;
	const top = d.y - d.sprite.ay + camY;
	return (
		left < width &&
		top < height &&
		left + d.sprite.canvas.width > 0 &&
		top + d.sprite.canvas.height > 0
	);
}

/**
 * Idle villagers glance left or right now and then; close to the player
 * they face the player.
 */
function idleFacing(actor: ActorState, tick: number, motion: boolean) {
	if (actor.near || actor.talking || !motion || actor.facing !== "down") {
		return actor.facing;
	}
	const phase = tileHash(actor.entity.x, actor.entity.y);
	const cycle = (tick + phase) % 64;
	if (cycle < 10) {
		return phase % 2 === 0 ? "left" : "right";
	}
	return "down";
}

/** The characters this frame, as drawables. */
function actorDrawables(
	scene: StaticScene,
	state: FrameState,
	tick: number
): Drawable[] {
	const margin = scene.frame.margin;
	const items: Drawable[] = [];
	for (const actor of state.actors) {
		const feet = actorFeet(actor.entity, margin, scene.indoor);
		const phase = tileHash(actor.entity.x, actor.entity.y) % 16;
		const breathe = state.motion && Math.floor((tick + phase) / 6) % 2 === 1;
		const sprite = characterSprite(
			agentLook(actor.entity.agentId, actor.lookIndex),
			idleFacing(actor, tick, state.motion),
			0,
			breathe
		);
		items.push({ actor: true, sortY: feet.y, sprite, x: feet.x, y: feet.y });
	}
	const player = state.player;
	const feetY = player.y + PX - CHARACTER_RAISE;
	items.push({
		actor: true,
		player: true,
		sortY: feetY,
		sprite: characterSprite(PLAYER_LOOK, player.facing, player.walkFrame),
		x: player.x + HALF,
		y: feetY,
	});
	// The chest stands in the village like the people do (its tile has open
	// ground south, so no roof covers it).
	if (state.chest) {
		const feet = actorFeet(state.chest, margin, scene.indoor);
		items.push({ sortY: feet.y, sprite: chestSprite(), x: feet.x, y: feet.y });
	}
	return items.sort((a, b) => a.sortY - b.sortY);
}

/** Merges the pre-sorted statics with the actors, keeping what's on screen. */
function visibleItems(
	scene: StaticScene,
	actors: readonly Drawable[],
	width: number,
	height: number,
	camX: number,
	camY: number
): Drawable[] {
	const items: Drawable[] = [];
	let next = 0;
	const push = (item: Drawable) => {
		if (visible(width, height, item, camX, camY)) {
			items.push(item);
		}
	};
	for (const item of scene.drawables) {
		while (next < actors.length && (actors[next]?.sortY ?? 0) <= item.sortY) {
			const actor = actors[next];
			if (actor) {
				push(actor);
			}
			next++;
		}
		push(item);
	}
	for (; next < actors.length; next++) {
		const actor = actors[next];
		if (actor) {
			push(actor);
		}
	}
	return items;
}

/** How see-through a roof or canopy gets while the player is behind it. */
const FADE_ALPHA = 0.5;
/** Hidden player pixels it takes before a roof or canopy fades. */
const FADE_MIN_PIXELS = 12;

const alphaMasks = new WeakMap<HTMLCanvasElement, Uint8Array>();

/** Which pixels of a sprite canvas are opaque (cached per canvas). */
function alphaMask(canvas: HTMLCanvasElement): Uint8Array {
	const hit = alphaMasks.get(canvas);
	if (hit) {
		return hit;
	}
	const mask = new Uint8Array(canvas.width * canvas.height);
	const data = canvas
		.getContext("2d")
		?.getImageData(0, 0, canvas.width, canvas.height).data;
	if (data) {
		for (let i = 0; i < mask.length; i++) {
			mask[i] = (data[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
		}
	}
	alphaMasks.set(canvas, mask);
	return mask;
}

/** A drawable's sprite rectangle in frame pixels. */
function spriteRect(item: Drawable): {
	h: number;
	left: number;
	top: number;
	w: number;
} {
	return {
		h: item.sprite.canvas.height,
		left: Math.round(item.x - item.sprite.ax),
		top: Math.round(item.y - item.sprite.ay),
		w: item.sprite.canvas.width,
	};
}

/**
 * The top row (frame pixels) of `target` that `cover` hides, or null when
 * it hides nothing.
 */
function firstHiddenRow(cover: Drawable, target: Drawable): number | null {
	const a = spriteRect(cover);
	const b = spriteRect(target);
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.left + a.w, b.left + b.w);
	const bottom = Math.min(a.top + a.h, b.top + b.h);
	const coverMask = alphaMask(cover.sprite.canvas);
	const targetMask = alphaMask(target.sprite.canvas);
	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++) {
			if (
				coverMask[(y - a.top) * a.w + (x - a.left)] &&
				targetMask[(y - b.top) * b.w + (x - b.left)]
			) {
				return y;
			}
		}
	}
	return null;
}

/** How many of `target`'s opaque pixels `cover`'s opaque pixels hide. */
function hiddenPixels(cover: Drawable, target: Drawable): number {
	const a = spriteRect(cover);
	const b = spriteRect(target);
	const left = Math.max(a.left, b.left);
	const top = Math.max(a.top, b.top);
	const right = Math.min(a.left + a.w, b.left + b.w);
	const bottom = Math.min(a.top + a.h, b.top + b.h);
	if (left >= right || top >= bottom) {
		return 0;
	}
	const coverMask = alphaMask(cover.sprite.canvas);
	const targetMask = alphaMask(target.sprite.canvas);
	let count = 0;
	for (let y = top; y < bottom; y++) {
		for (let x = left; x < right; x++) {
			if (
				coverMask[(y - a.top) * a.w + (x - a.left)] &&
				targetMask[(y - b.top) * b.w + (x - b.left)]
			) {
				count++;
			}
		}
	}
	return count;
}

/**
 * Roofs and canopies drawn in front of the player that actually hide part
 * of them: these turn see-through as a whole (see `liftPlayerOverFaded`), so
 * the player never vanishes behind a cottage or a tree.
 */
function fadedItems(items: readonly Drawable[]): ReadonlySet<Drawable> {
	const faded = new Set<Drawable>();
	const index = items.findIndex((item) => item.player);
	const player = items[index];
	if (!player) {
		return faded;
	}
	for (let i = index + 1; i < items.length; i++) {
		const item = items[i];
		if (item?.fade && hiddenPixels(item, player) >= FADE_MIN_PIXELS) {
			faded.add(item);
		}
	}
	return faded;
}

/**
 * How far down the player's sprite (as a share of its height) a roof's top
 * edge must sit for the player to be drawn over it instead.
 */
const EAVES_SHARE = 0.55;

/**
 * The street in front of a row of cottages runs under the eaves of the
 * next row's roofs, so a player standing there (to talk to a villager, say)
 * has only their feet behind the roof's top edge. Rather than ghost the
 * roof, draw the player over a roof that would hide no more than their
 * feet; a roof or canopy that would hide more still fades.
 */
function liftPlayerOverEaves(items: Drawable[]): Drawable[] {
	const index = items.findIndex((item) => item.player);
	const player = items[index];
	if (!player) {
		return items;
	}
	const body = spriteRect(player);
	const eavesLine = body.top + body.h * EAVES_SHARE;
	let last = -1;
	for (let i = index + 1; i < items.length; i++) {
		const item = items[i];
		if (!item?.fade) {
			continue;
		}
		const hiddenFrom = firstHiddenRow(item, player);
		if (hiddenFrom !== null && hiddenFrom >= eavesLine) {
			last = i;
		}
	}
	if (last < 0) {
		return items;
	}
	const lifted = items.filter((item) => item !== player);
	lifted.splice(last, 0, player);
	return lifted;
}

/**
 * Moves the player in front of every roof or canopy that fades for them,
 * so the whole building or tree turns see-through while the player stays
 * solid on top of it: nothing (a chimney, a branch) ever ghosts over the
 * player's face. The player never moves past something solid that hides
 * them, such as a villager standing in front.
 */
function liftPlayerOverFaded(
	items: Drawable[],
	faded: ReadonlySet<Drawable>
): Drawable[] {
	const index = items.findIndex((item) => item.player);
	const player = items[index];
	if (!player || faded.size === 0) {
		return items;
	}
	let last = -1;
	for (let i = index + 1; i < items.length; i++) {
		const item = items[i];
		if (!item) {
			continue;
		}
		if (faded.has(item)) {
			last = i;
		} else if (hiddenPixels(item, player) > 0) {
			break;
		}
	}
	if (last < 0) {
		return items;
	}
	const lifted = items.filter((item) => item !== player);
	lifted.splice(last, 0, player);
	return lifted;
}

/** Draws an item's image, the whole of it see-through when it is faded. */
function drawItemImage(
	context: CanvasRenderingContext2D,
	image: CanvasImageSource,
	x: number,
	y: number,
	faded: boolean
): void {
	if (!faded) {
		context.drawImage(image, x, y);
		return;
	}
	const base = context.globalAlpha;
	context.globalAlpha = base * FADE_ALPHA;
	context.drawImage(image, x, y);
	context.globalAlpha = base;
}

/** Draws one frame of the village onto a canvas sized to the viewport. */
export function drawFrame(
	context: CanvasRenderingContext2D,
	layers: NightLayers | null,
	scene: StaticScene,
	pixel: PixelScene,
	state: FrameState
): void {
	const { camX, camY } = state;
	const width = context.canvas.width;
	const height = context.canvas.height;
	const tick = state.motion ? Math.floor(state.time / TICK_MS) : 0;
	context.imageSmoothingEnabled = false;
	context.globalCompositeOperation = "source-over";
	context.globalAlpha = 1;
	context.fillStyle = pixel.backdrop;
	context.fillRect(0, 0, width, height);
	context.drawImage(scene.ground, camX, camY);
	drawRipples(context, scene, pixel, camX, camY, tick, state.motion);

	const actors = actorDrawables(scene, state, tick);
	const shadow = characterShadow();
	for (const actor of actors) {
		// Seated villagers' feet are under their desks.
		if (actor.actor && (!scene.indoor || actor.player)) {
			drawSprite(context, shadow, actor.x + camX, actor.y - 1 + camY);
		}
	}
	const sorted = liftPlayerOverEaves(
		visibleItems(scene, actors, width, height, camX, camY)
	);
	const faded = fadedItems(sorted);
	const items = liftPlayerOverFaded(sorted, faded);
	for (const item of items) {
		drawItemImage(
			context,
			item.sprite.canvas,
			Math.round(item.x - item.sprite.ax + camX),
			Math.round(item.y - item.sprite.ay + camY),
			faded.has(item)
		);
	}
	if (scene.fountain) {
		drawFountain(context, scene.fountain, camX, camY, tick, state.motion);
	}
	const working = state.actors.filter((actor) => actor.working);
	if (pixel.night && layers) {
		drawNight(context, layers, scene, pixel.night, items, faded, state, tick);
	}
	// Smoke and emotes go on last, over the night pass: Stardew never dims an
	// emote, and the smoke is tinted to the night instead of darkened by it.
	for (const actor of working) {
		drawSmoke(context, scene, actor, state, pixel.night);
	}
	// A stopped run smokes too (the act layer's breakdown).
	for (const actor of state.actors) {
		if (actor.act?.failed && !actor.working) {
			drawSmoke(context, scene, actor, state, pixel.night);
		}
	}
	drawActs(context, scene, state);
	for (const actor of state.actors) {
		if (actor.alert) {
			drawQuestMarker(context, scene, actor, actor.alert, state);
		} else if (actor.working && actor.emote !== false) {
			drawEmote(context, scene, actor, state);
		}
	}
}

/** Smoke puffs at night: the moonlit grey of the night's ambient. */
function nightPuff(sprite: Sprite, night: string | null): HTMLCanvasElement {
	return night
		? tinted(sprite, mix(night, SWATCH.white10Muted, 0.62))
		: sprite.canvas;
}

/** Chimney smoke above a working villager's cottage. */
function drawSmoke(
	context: CanvasRenderingContext2D,
	scene: StaticScene,
	actor: ActorState,
	state: FrameState,
	night: string | null
): void {
	const chimney = scene.chimneys.get(actor.entity.agentId);
	if (!chimney) {
		return;
	}
	const { camX, camY } = state;
	const step = state.motion ? Math.floor(state.time / SMOKE_MS) : 6;
	const life = 32;
	for (let i = 0; i < 4; i++) {
		const age = (step + i * (life / 4)) % life;
		const p = age / life;
		// Puffs swell, then shrink away as they rise (no alpha fades).
		const size = Math.max(
			0,
			Math.round(p < 0.4 ? 4 + p * 10 : 8 - (p - 0.4) * 11)
		);
		if (size < 2) {
			continue;
		}
		const drift = Math.round(p * 14 + Math.sin((age + i * 3) * 0.5) * 1.5);
		const puff = puffSprites(String(size), size);
		context.drawImage(
			nightPuff(puff, night),
			Math.round(chimney.x + drift + camX - puff.ax),
			Math.round(chimney.y - 2 - Math.round(p * 28) + camY - puff.ay)
		);
	}
}

/** The "..." emote above a working villager's head. */
function drawEmote(
	context: CanvasRenderingContext2D,
	scene: StaticScene,
	actor: ActorState,
	state: FrameState
): void {
	const { camX, camY } = state;
	const feet = actorFeet(actor.entity, scene.frame.margin, scene.indoor);
	const beat = state.motion ? Math.floor(state.time / DOTS_MS) % 4 : 3;
	const dots = Math.min(3, beat + 1);
	const bob = state.motion && Math.floor(state.time / 500) % 2 === 0 ? 0 : 1;
	// Just above the head, the tail pointing down at the villager.
	drawSprite(
		context,
		bubbleSprite(dots),
		feet.x + camX,
		feet.y - 32 - bob + camY
	);
}

/**
 * The "!" quest marker over a villager who is waiting on the player, bobbing
 * a pixel at the emote's cadence (still under reduced motion).
 */
function drawQuestMarker(
	context: CanvasRenderingContext2D,
	scene: StaticScene,
	actor: ActorState,
	tone: QuestTone,
	state: FrameState
): void {
	const { camX, camY } = state;
	const feet = actorFeet(actor.entity, scene.frame.margin, scene.indoor);
	const bob = state.motion && Math.floor(state.time / 500) % 2 === 0 ? 0 : 1;
	drawSprite(
		context,
		questMarkerSprite(tone),
		feet.x + camX,
		feet.y - 32 - bob + camY
	);
}

/**
 * The act layer's sprites: the chest of answers, an asker's letter and
 * hourglass plaque, a limit's zzz, the pips over a working villager's roof
 * (over its head indoors).
 */
/** Alarm lamps drawn at most per villager (the queue lists every one). */
const MAX_LAMPS = 3;
/** Helpers drawn following a villager at most. */
const MAX_FOLLOWERS = 3;

function drawActs(
	context: CanvasRenderingContext2D,
	scene: StaticScene,
	state: FrameState
): void {
	const { camX, camY } = state;
	// Notice posts are markers, like the emotes: drawn over the eaves. (The
	// chest is depth-sorted with the people.)
	for (const notice of state.notices ?? []) {
		const feet = actorFeet(notice, scene.frame.margin, scene.indoor);
		drawSprite(context, postSprite(), feet.x + camX, feet.y + camY);
	}
	for (const actor of state.actors) {
		const act = actor.act;
		if (!act) {
			continue;
		}
		const feet = actorFeet(actor.entity, scene.frame.margin, scene.indoor);
		if (act.carry) {
			drawSprite(
				context,
				carrySprite(act.carry),
				feet.x + 5 + camX,
				feet.y - 10 + camY
			);
		} else if (act.tool) {
			drawSprite(
				context,
				toolSprite(act.tool),
				feet.x + 6 + camX,
				feet.y - 8 + camY
			);
		}
		if (act.wait) {
			drawSprite(
				context,
				hourglassSprite(act.wait, act.waitTint),
				// On the asker's left, beside its head and under the "!" marks:
				// the next place in the queue is on its right.
				feet.x - 7 + camX,
				feet.y - 19 + camY
			);
		}
		if (act.limited) {
			drawSprite(
				context,
				zzzSprite(act.back),
				feet.x + 4 + camX,
				feet.y - 30 + camY
			);
		}
		// Alarm lamps over the right shoulder: lit ones, then dim old ones.
		const lit = Math.min(MAX_LAMPS, act.alarms ?? 0);
		const dim = Math.min(MAX_LAMPS - lit, act.oldAlarms ?? 0);
		for (let index = 0; index < lit + dim; index++) {
			drawSprite(
				context,
				alarmLampSprite(index >= lit),
				feet.x + 6 + index * 7 + camX,
				feet.y - 22 + camY
			);
		}
		// At the feet, rightwards: the flag, the next sign, the note.
		let right = 7;
		const atRight = (sprite: Sprite, rise = 0) => {
			drawSprite(
				context,
				sprite,
				feet.x + right + sprite.ax + camX,
				feet.y - rise + camY
			);
			right += sprite.canvas.width;
		};
		if (act.interrupted) {
			atRight(flagSprite());
		}
		if (act.next) {
			atRight(nextSignSprite());
		}
		if (act.suggestion) {
			atRight(markSprite("note"), 1);
		}
		// Leftwards: the unread letter, then the helpers following.
		let left = -6;
		const atLeft = (sprite: Sprite) => {
			left -= sprite.canvas.width;
			drawSprite(
				context,
				sprite,
				feet.x + left + sprite.ax + camX,
				feet.y + camY
			);
		};
		if (act.unread) {
			atLeft(markSprite("unread"));
		}
		for (
			let index = 0;
			index < Math.min(MAX_FOLLOWERS, act.followers ?? 0);
			index++
		) {
			atLeft(followerSprite());
		}
		// Beside the head, not over the chimney: a top-row cottage's chimney
		// can sit off the canvas while its villager is in view.
		if (act.pips && act.pips.total > 0) {
			drawSprite(
				context,
				pipBarSprite(act.pips.done, act.pips.total),
				feet.x + 8 + camX,
				feet.y - 40 + camY
			);
		} else if (act.estimate) {
			drawSprite(
				context,
				hourglassSprite("~"),
				feet.x - 7 + camX,
				feet.y - 40 + camY
			);
		}
	}
}

/** Ripple widths through one glint's life (8 fps). */
const RIPPLE_WIDTHS = [0, 1, 3, 5, 5, 3, 1, 0, 0, 0, 0, 0];

/** Water glints on the pond that widen and fade at Stardew's cadence. */
function drawRipples(
	context: CanvasRenderingContext2D,
	scene: StaticScene,
	pixel: PixelScene,
	camX: number,
	camY: number,
	tick: number,
	motion: boolean
): void {
	context.fillStyle = pixel.water.light;
	scene.ripples.forEach((spot, index) => {
		const width = motion
			? (RIPPLE_WIDTHS[(tick + index * 3) % RIPPLE_WIDTHS.length] ?? 0)
			: 3;
		if (width === 0) {
			return;
		}
		const x = spot.x - (width >> 1) + camX;
		const y = spot.y + camY;
		context.fillRect(x, y, width, 1);
		if (width >= 5) {
			context.fillRect(x + 1, y - 1, width - 2, 1);
		}
	});
}

/**
 * The fountain's water: a jet arcing out of the spout into the upper bowl,
 * two streams spilling from the bowl into the basin, and rings spreading
 * where they land, stepping at 8 fps.
 */
function drawFountain(
	context: CanvasRenderingContext2D,
	fountain: NonNullable<StaticScene["fountain"]>,
	camX: number,
	camY: number,
	tick: number,
	motion: boolean
): void {
	const sx = fountain.spout.x + camX;
	const sy = fountain.spout.y + camY;
	const px = fountain.pool.x + camX;
	const py = fountain.pool.y + camY;
	const t = motion ? tick : 2;
	context.fillStyle = SWATCH.sky45;
	context.fillRect(sx - 1, sy - 2, 2, 2);
	// The jet: droplets arcing to both sides, one step further each tick.
	for (let i = 0; i < 3; i++) {
		const k = (t + i * 2) % 6;
		const dx = 1 + Math.floor(k * 0.9);
		const dy = -1 + Math.floor((k * k) / 4);
		context.fillStyle = k < 3 ? SWATCH.sky45 : SWATCH.sky225;
		context.fillRect(sx - 1 - dx, sy + dy, 1, 1);
		context.fillRect(sx + dx, sy + dy, 1, 1);
	}
	// Streams from the bowl's lip down to the basin.
	for (const side of [-1, 1]) {
		const x = px + side * 11 + (side > 0 ? -1 : 0);
		for (let y = 0; y < 9; y++) {
			const on = (y + t) % 4 !== 0;
			if (on) {
				context.fillStyle = y % 4 === 1 ? SWATCH.sky45 : SWATCH.sky225;
				context.fillRect(x + (y > 5 ? side : 0), py - 9 + y, 1, 1);
			}
		}
		const ring =
			RIPPLE_WIDTHS[(t + (side > 0 ? 5 : 0)) % RIPPLE_WIDTHS.length] ?? 0;
		if (ring > 0) {
			context.fillStyle = SWATCH.sky225;
			context.fillRect(x + side - (ring >> 1), py - 1, ring, 1);
		}
	}
}

/** Characters at night, tinted by the ambient (or a light they stand in). */
const tintCache = new WeakMap<
	HTMLCanvasElement,
	Map<string, HTMLCanvasElement>
>();

function tinted(sprite: Sprite, tint: string): HTMLCanvasElement {
	let byTint = tintCache.get(sprite.canvas);
	if (!byTint) {
		byTint = new Map();
		tintCache.set(sprite.canvas, byTint);
	}
	const hit = byTint.get(tint);
	if (hit) {
		return hit;
	}
	const canvas = document.createElement("canvas");
	canvas.width = sprite.canvas.width;
	canvas.height = sprite.canvas.height;
	const context = canvas.getContext("2d");
	if (context) {
		context.drawImage(sprite.canvas, 0, 0);
		context.globalCompositeOperation = "multiply";
		context.fillStyle = tint;
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.globalCompositeOperation = "destination-in";
		context.drawImage(sprite.canvas, 0, 0);
	}
	byTint.set(tint, canvas);
	return canvas;
}

const rimCache = new WeakMap<HTMLCanvasElement, Sprite>();
/** Moonlight caught on a figure's edge: its outline lifted toward pale blue. */
const MOON_RIM = SWATCH.blue95;

/**
 * A character with its outermost pixels (the dark outline) lifted toward
 * moonlight, so villagers in dark clothes stay readable away from lamps.
 */
function moonRimmed(sprite: Sprite): Sprite {
	const hit = rimCache.get(sprite.canvas);
	if (hit) {
		return hit;
	}
	const { height, width } = sprite.canvas;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	const source = sprite.canvas
		.getContext("2d")
		?.getImageData(0, 0, width, height);
	const result: Sprite = { ...sprite, canvas };
	rimCache.set(sprite.canvas, result);
	if (!(context && source)) {
		return result;
	}
	const data = source.data;
	const opaque = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < width && y < height
			? (data[(y * width + x) * 4 + 3] ?? 0) > 0
			: false;
	const out = new ImageData(new Uint8ClampedArray(data), width, height);
	const [mr, mg, mb] = parseHex(MOON_RIM);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (
				!opaque(x, y) ||
				(opaque(x - 1, y) &&
					opaque(x + 1, y) &&
					opaque(x, y - 1) &&
					opaque(x, y + 1))
			) {
				continue;
			}
			const i = (y * width + x) * 4;
			out.data[i] = ((data[i] ?? 0) + mr) / 2;
			out.data[i + 1] = ((data[i + 1] ?? 0) + mg) / 2;
			out.data[i + 2] = ((data[i + 2] ?? 0) + mb) / 2;
		}
	}
	context.putImageData(out, 0, 0);
	return result;
}

/** How lit a point is by the scene's warm lights: 0 (ambient) to 3. */
function lightLevel(scene: StaticScene, x: number, y: number): number {
	let best = 0;
	for (const source of scene.lights) {
		if (source.half && y < source.y) {
			continue;
		}
		const d = Math.hypot(
			(x - source.x) / source.rx,
			(y - source.y) / source.ry
		);
		if (d < 1) {
			best = Math.max(best, Math.ceil(((1 - d) * source.rings * 3) / 4));
		}
	}
	return Math.min(3, best);
}

/** How far a lit pane's halo reaches, and its additive steps outward. */
const HALO_PAD = 3;
const HALO_STEPS = [
	[110, 66, 18],
	[64, 36, 10],
	[30, 16, 4],
] as const;
const haloCache = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

/**
 * A stepped warm ring around a sprite's glow pixels (diamond distance 1-3,
 * the pixels themselves left empty), drawn additively over the night.
 */
function haloOf(glow: HTMLCanvasElement): HTMLCanvasElement {
	const hit = haloCache.get(glow);
	if (hit) {
		return hit;
	}
	const canvas = document.createElement("canvas");
	canvas.width = glow.width + HALO_PAD * 2;
	canvas.height = glow.height + HALO_PAD * 2;
	haloCache.set(glow, canvas);
	const source = glow
		.getContext("2d")
		?.getImageData(0, 0, glow.width, glow.height);
	const context = canvas.getContext("2d");
	if (!(source && context)) {
		return canvas;
	}
	const { height, width } = canvas;
	const lit = (x: number, y: number) => {
		const gx = x - HALO_PAD;
		const gy = y - HALO_PAD;
		if (gx < 0 || gy < 0 || gx >= glow.width || gy >= glow.height) {
			return false;
		}
		return (source.data[(gy * glow.width + gx) * 4 + 3] ?? 0) > 0;
	};
	const out = context.createImageData(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (lit(x, y)) {
				continue;
			}
			let best = HALO_PAD + 1;
			for (let dy = -HALO_PAD; dy <= HALO_PAD; dy++) {
				const reach = HALO_PAD - Math.abs(dy);
				for (let dx = -reach; dx <= reach; dx++) {
					if (lit(x + dx, y + dy)) {
						best = Math.min(best, Math.abs(dx) + Math.abs(dy));
					}
				}
			}
			const step = HALO_STEPS[best - 1];
			if (step) {
				const index = (y * width + x) * 4;
				out.data[index] = step[0];
				out.data[index + 1] = step[1];
				out.data[index + 2] = step[2];
				out.data[index + 3] = 255;
			}
		}
	}
	context.putImageData(out, 0, 0);
	return canvas;
}

function drawNight(
	context: CanvasRenderingContext2D,
	layers: NightLayers,
	scene: StaticScene,
	night: string,
	items: readonly Drawable[],
	faded: ReadonlySet<Drawable>,
	state: FrameState,
	tick: number
): void {
	const { camX, camY } = state;
	const width = context.canvas.width;
	const height = context.canvas.height;
	const { fx, light } = layers;
	light.imageSmoothingEnabled = false;
	light.globalCompositeOperation = "source-over";
	light.fillStyle = night;
	light.fillRect(0, 0, width, height);
	light.globalCompositeOperation = "lighten";
	const onScreen = (source: LightSource) =>
		source.x + camX + source.rx >= 0 &&
		source.y + camY + source.ry >= 0 &&
		source.x + camX - source.rx <= width &&
		source.y + camY - source.ry <= height;
	for (const source of scene.lights) {
		if (onScreen(source)) {
			drawSprite(
				light,
				lightSprites(
					`${source.rx}|${source.ry}|${source.rings}|${source.half}|${night}`,
					source.rx,
					source.ry,
					source.rings,
					source.half,
					night
				),
				Math.round(source.x) + camX,
				Math.round(source.y) + camY
			);
		}
	}
	const flies = fireflyPositions(scene, state, tick);
	for (const fly of flies) {
		if (fly.on) {
			drawSprite(
				light,
				lightSprites(`6|6|2|false|${night}`, 6, 6, 2, false, night),
				fly.x + camX,
				fly.y + camY
			);
		}
	}
	light.globalCompositeOperation = "source-over";
	context.globalCompositeOperation = "multiply";
	context.drawImage(light.canvas, 0, 0);
	// A low warm ring screened over lamp and window pools: the light reads
	// warm without washing the ground under it one flat color.
	context.globalCompositeOperation = "screen";
	for (const source of scene.lights) {
		if (source.warm && onScreen(source)) {
			drawSprite(
				context,
				glowSprites(
					`${source.rx}|${source.ry}|${source.rings}|${source.half}`,
					source.rx,
					source.ry,
					source.rings,
					source.half
				),
				Math.round(source.x) + camX,
				Math.round(source.y) + camY
			);
		}
	}
	context.globalCompositeOperation = "source-over";
	// A warm 3px halo around every lit pane, added on top.
	context.globalCompositeOperation = "lighter";
	for (const item of items) {
		if (item.sprite.glow) {
			drawItemImage(
				context,
				haloOf(item.sprite.glow),
				Math.round(item.x - item.sprite.ax + camX) - HALO_PAD,
				Math.round(item.y - item.sprite.ay + camY) - HALO_PAD,
				faded.has(item)
			);
		}
	}
	context.globalCompositeOperation = "source-over";

	// Lit glass and the characters go back on top, each cut by whatever
	// stands in front of it, so nothing glows through a villager's face.
	const ambient = mix(night, SWATCH.white10Muted, 0.44);
	const tints = [
		ambient,
		mix(ambient, SWATCH.amber155, 0.35),
		mix(ambient, SWATCH.amber155, 0.6),
		mix(ambient, SWATCH.amber90, 0.85),
	];
	fx.imageSmoothingEnabled = false;
	fx.globalCompositeOperation = "source-over";
	fx.clearRect(0, 0, width, height);
	let painted = false;
	for (const item of items) {
		const x = Math.round(item.x - item.sprite.ax + camX);
		const y = Math.round(item.y - item.sprite.ay + camY);
		if (item.actor) {
			const level = lightLevel(scene, item.x, item.y - 16);
			fx.drawImage(
				tinted(moonRimmed(item.sprite), tints[level] ?? ambient),
				x,
				y
			);
			painted = true;
			continue;
		}
		// A see-through roof only partly hides whoever stands behind it.
		const seeThrough = faded.has(item);
		if (painted) {
			fx.globalCompositeOperation = "destination-out";
			drawItemImage(fx, item.sprite.canvas, x, y, seeThrough);
			fx.globalCompositeOperation = "source-over";
		}
		if (item.sprite.glow) {
			drawItemImage(fx, item.sprite.glow, x, y, seeThrough);
			painted = true;
		}
	}
	if (painted) {
		context.drawImage(fx.canvas, 0, 0);
	}
	for (const fly of flies) {
		context.fillStyle = fly.on ? SWATCH.lime200 : SWATCH.lime480;
		context.fillRect(fly.x + camX, fly.y + camY, 1, 1);
		if (fly.on) {
			context.fillStyle = SWATCH.lime335;
			context.fillRect(fly.x + camX - 1, fly.y + camY, 1, 1);
			context.fillRect(fly.x + camX + 1, fly.y + camY, 1, 1);
			context.fillRect(fly.x + camX, fly.y + camY - 1, 1, 1);
			context.fillRect(fly.x + camX, fly.y + camY + 1, 1, 1);
		}
	}
}

function fireflyPositions(
	scene: StaticScene,
	state: FrameState,
	tick: number
): { on: boolean; x: number; y: number }[] {
	return scene.fireflies.map((base, index) => {
		const phase = noise(index, 0, 5) * 40;
		const t = tick / 8 + phase;
		return {
			on: !state.motion || Math.sin(t * 1.7 + index) > -0.3,
			x: Math.round(base.x + Math.sin(t * 0.9) * 9 + Math.sin(t * 0.37) * 4),
			y: Math.round(base.y + Math.cos(t * 0.7) * 6 - 2),
		};
	});
}
