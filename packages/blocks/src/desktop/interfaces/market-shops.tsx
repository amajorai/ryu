/* eslint-disable react/no-unknown-property */
import { RoundedBoxGeometry } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasTexture } from "three";
import { GAME_DISPLAY_FAMILY } from "./game-font.ts";
import { MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import type { MeshData } from "./game3d-island.ts";
import { ToonMaterial } from "./game3d-materials.tsx";
import { PROP_INK } from "./game3d-props.tsx";
import {
	FACING_YAW,
	type MarketFacing,
	type MarketLot,
	type Vec3,
} from "./market-model.ts";
import { type MarketArt, swatch } from "./market-palette.ts";

/**
 * The market's buildings in the kit's look, every part instanced across
 * all lots (one draw call per part kind, plus its ink outline):
 *
 * - a project's shop: rounded walls, a flat, stepped or gabled roof, a big
 *   shop window, a door, a striped awning with a scalloped valance, a
 *   painted signboard, and a display table out front;
 * - the general store: the same, wider, with a double door between two
 *   windows;
 * - a team's stall: an open wooden stall under a striped canopy, its
 *   counter heaped with goods.
 *
 * Windows glow while the shop is busy, and every window is warm at night.
 */

/** A unit triangular prism: base -0.5..0.5 on x at y 0, apex at y 1. */
function prismData(): MeshData {
	const position: number[] = [];
	const normal: number[] = [];
	const index: number[] = [];
	const face = (points: Vec3[], n: Vec3) => {
		const base = position.length / 3;
		for (const point of points) {
			position.push(...point);
			normal.push(...n);
		}
		for (let corner = 1; corner < points.length - 1; corner++) {
			index.push(base, base + corner, base + corner + 1);
		}
	};
	const slope = Math.hypot(1, 0.5);
	face(
		[
			[-0.5, 0, 0.5],
			[0.5, 0, 0.5],
			[0, 1, 0.5],
		],
		[0, 0, 1]
	);
	face(
		[
			[0.5, 0, -0.5],
			[-0.5, 0, -0.5],
			[0, 1, -0.5],
		],
		[0, 0, -1]
	);
	face(
		[
			[0.5, 0, 0.5],
			[0.5, 0, -0.5],
			[0, 1, -0.5],
			[0, 1, 0.5],
		],
		[1 / slope, 0.5 / slope, 0]
	);
	face(
		[
			[-0.5, 0, -0.5],
			[-0.5, 0, 0.5],
			[0, 1, 0.5],
			[0, 1, -0.5],
		],
		[-1 / slope, 0.5 / slope, 0]
	);
	return {
		index: new Uint32Array(index),
		normal: new Float32Array(normal),
		position: new Float32Array(position),
	};
}

const PRISM = prismData();

interface ShopParts {
	boards: InstanceSpec[];
	glass: InstanceSpec[];
	goods: InstanceSpec[];
	knobs: InstanceSpec[];
	litGlass: InstanceSpec[];
	prisms: InstanceSpec[];
	scallops: InstanceSpec[];
	stripes: InstanceSpec[];
	trim: InstanceSpec[];
	walls: InstanceSpec[];
	wood: InstanceSpec[];
}

function box(position: Vec3, scale: Vec3, color: string): InstanceSpec {
	return { color, position, scale };
}

/** A pane of glass: lit panes take the warm glow's own colour. */
function pane(
	parts: ShopParts,
	art: MarketArt,
	lit: boolean,
	position: Vec3,
	scale: Vec3
) {
	if (lit) {
		parts.litGlass.push({ position, scale });
	} else {
		parts.glass.push(box(position, scale, art.glass));
	}
}

/** A striped awning from the facade at `top` sloping out `reach` to `low`. */
function addAwning(
	parts: ShopParts,
	art: MarketArt,
	colour: string,
	{
		front,
		low,
		reach,
		top,
		width,
		x,
	}: {
		front: number;
		low: number;
		reach: number;
		top: number;
		width: number;
		x: number;
	}
) {
	const drop = top - low;
	const tilt = Math.atan2(drop, reach);
	const length = Math.hypot(drop, reach);
	const count = Math.max(4, Math.round(width / 0.36));
	const stripe = width / count;
	for (let index = 0; index < count; index++) {
		const sx = x - width / 2 + stripe * (index + 0.5);
		const color = index % 2 === 0 ? colour : art.awningLight;
		parts.stripes.push({
			color,
			position: [sx, (top + low) / 2, front + reach / 2],
			rotation: [tilt, 0, 0],
			scale: [stripe + 0.002, 0.05, length],
		});
		parts.scallops.push({
			color,
			position: [sx, low - 0.02, front + reach + 0.01],
			scale: [stripe * 0.5, 0.1, 0.035],
		});
	}
}

/** Goods heaped on a counter or table top: soft round fruit and parcels. */
function addGoods(
	parts: ShopParts,
	art: MarketArt,
	{
		seed,
		width,
		x,
		y,
		z,
	}: { seed: number; width: number; x: number; y: number; z: number }
) {
	const count = Math.max(3, Math.round(width / 0.26));
	for (let index = 0; index < count; index++) {
		const gx = x - width / 2 + (width / count) * (index + 0.5);
		const color = swatch(art.goods, seed + index);
		if ((seed + index) % 3 === 2) {
			parts.wood.push(box([gx, y + 0.07, z], [0.18, 0.14, 0.2], color));
			continue;
		}
		parts.goods.push({
			color,
			position: [gx, y + 0.08, z + ((index % 2) - 0.5) * 0.08],
			scale: 0.085,
		});
	}
}

/** A window: a trim frame and its glass (lit or not), facing +z. */
function addWindow(
	parts: ShopParts,
	art: MarketArt,
	lit: boolean,
	at: Vec3,
	size: [number, number]
) {
	parts.trim.push(
		box([at[0], at[1], at[2]], [size[0] + 0.12, size[1] + 0.12, 0.06], art.trim)
	);
	pane(
		parts,
		art,
		lit,
		[at[0], at[1], at[2] + 0.035],
		[size[0], size[1], 0.03]
	);
	parts.trim.push(
		box([at[0], at[1], at[2] + 0.055], [0.04, size[1], 0.02], art.trim)
	);
}

/** A door with its frame, a little window and a brass knob. */
function addDoor(
	parts: ShopParts,
	art: MarketArt,
	lit: boolean,
	{ colour, front, x }: { colour: string; front: number; x: number }
) {
	parts.trim.push(box([x, 0.62, front + 0.01], [0.74, 1.24, 0.05], art.trim));
	parts.wood.push(box([x, 0.58, front + 0.035], [0.6, 1.12, 0.04], colour));
	pane(parts, art, lit, [x, 0.88, front + 0.06], [0.32, 0.26, 0.02]);
	parts.knobs.push({ position: [x + 0.2, 0.55, front + 0.08], scale: 0.045 });
}

/** Shingle courses per roof slope; alternating tones read as tiled rows. */
const COURSES = 3;

/**
 * One roof slope from its eave up to the ridge, laid as overlapping
 * shingle courses in two tones. `across` is the run along the ridge; the
 * slope climbs from `eave` to `ridge` (points in the lot's frame) along x
 * (`axis` "x") or z.
 */
function addSlope(
	parts: ShopParts,
	tones: [string, string],
	{
		across,
		axis,
		eave,
		ridge,
	}: { across: number; axis: "x" | "z"; eave: Vec3; ridge: Vec3 }
) {
	const run = axis === "x" ? ridge[0] - eave[0] : ridge[2] - eave[2];
	const rise = ridge[1] - eave[1];
	const length = Math.hypot(run, rise);
	const tilt = Math.atan2(rise, Math.abs(run));
	for (let course = 0; course < COURSES; course++) {
		const t = (course + 0.5) / COURSES;
		const position: Vec3 = [
			eave[0] + (ridge[0] - eave[0]) * t,
			eave[1] + rise * t + 0.03 * (COURSES - course),
			eave[2] + (ridge[2] - eave[2]) * t,
		];
		const scale: Vec3 =
			axis === "x"
				? [length / COURSES + 0.06, 0.1, across]
				: [across, 0.1, length / COURSES + 0.06];
		// A slope climbing toward -x or +z tips the other way.
		const sign = run > 0 ? 1 : -1;
		const rotation: Vec3 =
			axis === "x" ? [0, 0, sign * tilt] : [-sign * tilt, 0, 0];
		parts.walls.push({
			color: tones[course % 2],
			position,
			rotation,
			scale,
		});
	}
}

/**
 * The roof: a gable end to the street (styles 0 and 2, the gable carrying
 * the sign), or a pitched roof behind a stepped false front (style 1).
 */
function addRoof(parts: ShopParts, art: MarketArt, lot: MarketLot) {
	const { front, x: cx } = lot.frame;
	const { depth, height, width } = lot.size;
	const cz = front - depth / 2;
	const { roof: style, wall } = lot.shop.style;
	const tone = lot.shop.style.awning + 1;
	const tones: [string, string] = [
		swatch(art.roof, tone),
		swatch(art.roofDark, tone),
	];
	const wallColour = swatch(art.wall, wall);
	const overhang = 0.22;
	if (style === 1) {
		const rise = 0.75;
		for (const side of [-1, 1]) {
			const eaveZ = side > 0 ? front + overhang : front - depth - overhang;
			addSlope(parts, tones, {
				across: width + 0.3,
				axis: "z",
				eave: [cx, height, eaveZ],
				ridge: [cx, height + rise, cz],
			});
		}
		parts.trim.push(
			box([cx, height + rise + 0.06, cz], [width + 0.32, 0.1, 0.14], tones[1])
		);
		for (const side of [-1, 1]) {
			parts.prisms.push({
				color: wallColour,
				position: [cx + side * (width / 2 - 0.01), height, cz],
				rotation: [0, Math.PI / 2, 0],
				scale: [depth, rise, 0.02],
			});
		}
		// The stepped false front carries the sign.
		parts.walls.push(
			box(
				[cx, height + 0.42, front + 0.02],
				[width * 0.72, 0.84, 0.14],
				wallColour
			)
		);
		parts.trim.push(
			box(
				[cx, height + 0.87, front + 0.02],
				[width * 0.76, 0.08, 0.2],
				art.trim
			)
		);
		return;
	}
	const rise = style === 2 ? 1.05 : 0.85;
	parts.prisms.push({
		color: wallColour,
		position: [cx, height, cz],
		scale: [width, rise, depth],
	});
	for (const side of [-1, 1]) {
		addSlope(parts, tones, {
			across: depth + 2 * overhang,
			axis: "x",
			eave: [cx + side * (width / 2 + overhang), height - 0.06, cz],
			ridge: [cx, height + rise, cz],
		});
	}
	parts.trim.push(
		box(
			[cx, height + rise + 0.05, cz],
			[0.16, 0.1, depth + 2 * overhang + 0.04],
			tones[1]
		)
	);
	parts.trim.push(
		box([cx, height + 0.02, front + 0.03], [width + 0.06, 0.08, 0.08], art.trim)
	);
	if (style === 2) {
		// A brick chimney on the back slope.
		parts.wood.push(
			box(
				[cx + width * 0.24, height + rise * 0.7, cz - depth * 0.2],
				[0.3, 0.8, 0.3],
				tones[1]
			)
		);
	}
}

/** A shop or the general store: walls, roof, windows, door, awning, sign. */
function addShop(
	parts: ShopParts,
	art: MarketArt,
	lot: MarketLot,
	lit: boolean
) {
	const { shop } = lot;
	const { front, x: cx } = lot.frame;
	const { depth, height, width } = lot.size;
	const cz = front - depth / 2;
	const general = shop.kind === "general";
	const wall = swatch(art.wall, shop.style.wall);
	const awning = swatch(art.awning, shop.style.awning);
	const door = swatch(art.door, shop.style.door);
	parts.walls.push(box([cx, height / 2, cz], [width, height, depth], wall));
	parts.trim.push(
		box([cx, 0.09, cz], [width + 0.08, 0.18, depth + 0.08], art.trim)
	);
	addRoof(parts, art, lot);
	// The shop window(s) and door under the awning.
	if (general) {
		addDoor(parts, art, lit, { colour: door, front, x: cx - 0.31 });
		addDoor(parts, art, lit, { colour: door, front, x: cx + 0.31 });
		for (const side of [-1, 1]) {
			addWindow(
				parts,
				art,
				lit,
				[cx + side * 1.42, 0.86, front + 0.01],
				[1.05, 0.78]
			);
		}
	} else {
		addWindow(parts, art, lit, [cx - 0.55, 0.86, front + 0.01], [1.7, 0.78]);
		addDoor(parts, art, lit, { colour: door, front, x: cx + width / 2 - 0.62 });
	}
	addAwning(parts, art, awning, {
		front: front + 0.04,
		low: 1.36,
		reach: 0.78,
		top: 1.72,
		width: width - 0.1,
		x: cx,
	});
	// The painted fascia board over the awning, the shop's name on it.
	const [, signY, signZ] = lot.frame.sign;
	parts.boards.push(
		box(
			[cx, signY, signZ - 0.05],
			[width * 0.66 + 0.1, 0.5, 0.06],
			art.signEdge
		)
	);
	parts.boards.push(
		box([cx, signY, signZ - 0.01], [width * 0.66, 0.4, 0.04], art.sign)
	);
	// The display table out front, heaped with goods.
	if (lot.frame.table) {
		const [tx, , tz] = lot.frame.table;
		const length = Math.min(width - 1.3, 2.2);
		parts.wood.push(box([tx, 0.44, tz], [length, 0.07, 0.5], art.table));
		for (const side of [-1, 1]) {
			for (const deep of [-1, 1]) {
				parts.wood.push(
					box(
						[tx + side * (length / 2 - 0.08), 0.21, tz + deep * 0.19],
						[0.06, 0.42, 0.06],
						art.woodDark
					)
				);
			}
		}
		addGoods(parts, art, {
			seed: shop.style.goods,
			width: length - 0.2,
			x: tx,
			y: 0.48,
			z: tz,
		});
	}
}

/** A team's stall: posts, a low back, a heaped counter, a striped canopy. */
function addStall(parts: ShopParts, art: MarketArt, lot: MarketLot) {
	const { shop } = lot;
	const { front, x: cx } = lot.frame;
	const { depth, height, width } = lot.size;
	const cz = front - depth / 2;
	const back = cz - depth / 2;
	const awning = swatch(art.awning, shop.style.awning);
	for (const x of [cx - width / 2 + 0.1, cx + width / 2 - 0.1]) {
		for (const z of [front - 0.1, back + 0.1]) {
			parts.wood.push(box([x, height / 2, z], [0.11, height, 0.11], art.wood));
		}
	}
	parts.wood.push(
		box([cx, 0.5, back + 0.08], [width - 0.1, 1, 0.08], art.woodDark)
	);
	// The counter along the front, its top a step lighter.
	parts.wood.push(
		box([cx, 0.3, front - 0.32], [width - 0.3, 0.6, 0.44], art.wood)
	);
	parts.trim.push(
		box([cx, 0.62, front - 0.32], [width - 0.22, 0.06, 0.52], art.table)
	);
	addGoods(parts, art, {
		seed: shop.style.goods,
		width: width - 0.6,
		x: cx,
		y: 0.65,
		z: front - 0.32,
	});
	// The canopy: two striped slopes from the ridge.
	const ridge = height + 0.5;
	for (const side of [-1, 1]) {
		const edge = side > 0 ? front + 0.2 : back - 0.2;
		const reach = Math.abs(edge - cz);
		const count = Math.max(4, Math.round(width / 0.36));
		const stripe = (width + 0.3) / count;
		const tilt = Math.atan2(ridge - height, reach);
		const length = Math.hypot(ridge - height, reach);
		for (let index = 0; index < count; index++) {
			const sx = cx - (width + 0.3) / 2 + stripe * (index + 0.5);
			const color = index % 2 === 0 ? awning : art.awningLight;
			parts.stripes.push({
				color,
				position: [sx, (ridge + height) / 2, cz + (side * reach) / 2],
				rotation: [side * tilt, 0, 0],
				scale: [stripe + 0.002, 0.05, length],
			});
			if (side > 0) {
				parts.scallops.push({
					color,
					position: [sx, height - 0.03, edge + 0.01],
					scale: [stripe * 0.5, 0.11, 0.035],
				});
			}
		}
	}
	const [, signY] = lot.frame.sign;
	parts.wood.push(
		box([cx - 0.5, ridge + 0.33, cz], [0.06, 0.66, 0.06], art.woodDark)
	);
	parts.wood.push(
		box([cx + 0.5, ridge + 0.33, cz], [0.06, 0.66, 0.06], art.woodDark)
	);
	parts.boards.push(
		box([cx, signY, cz + 0.02], [width * 0.6 + 0.1, 0.48, 0.06], art.signEdge)
	);
	parts.boards.push(
		box([cx, signY, cz + 0.06], [width * 0.6, 0.38, 0.04], art.sign)
	);
}

export function buildShops(
	lots: readonly MarketLot[],
	art: MarketArt,
	night: boolean,
	/** With acts: the shops whose keepers are at work (lit windows). */
	busy?: ReadonlySet<string>
): ShopParts {
	const parts: ShopParts = {
		boards: [],
		glass: [],
		goods: [],
		knobs: [],
		litGlass: [],
		prisms: [],
		scallops: [],
		stripes: [],
		trim: [],
		walls: [],
		wood: [],
	};
	for (const lot of lots) {
		if (lot.shop.kind === "stall") {
			addStall(parts, art, lot);
		} else {
			addShop(
				parts,
				art,
				lot,
				night || (busy ? busy.has(lot.shop.id) : lot.shop.busy)
			);
		}
	}
	return parts;
}

const SIGN_PX = { height: 128, width: 640 };

/** Paints a shop's name onto a canvas, sized down to fit the board. */
function paintSign(canvas: HTMLCanvasElement, name: string, ink: string) {
	const context = canvas.getContext("2d");
	if (!context) {
		return;
	}
	context.clearRect(0, 0, SIGN_PX.width, SIGN_PX.height);
	let size = 76;
	const font = (px: number) =>
		`700 ${px}px "${GAME_DISPLAY_FAMILY}", ui-rounded, system-ui, sans-serif`;
	context.font = font(size);
	while (size > 30 && context.measureText(name).width > SIGN_PX.width - 48) {
		size -= 4;
		context.font = font(size);
	}
	context.fillStyle = ink;
	context.lineJoin = "round";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(name, SIGN_PX.width / 2, SIGN_PX.height / 2 + 4);
}

/**
 * A shop's name painted on its signboard: a canvas texture on a plane just
 * in front of the board, repainted once the display font has loaded.
 */
function SignText({
	ink,
	name,
	position,
	width,
}: {
	ink: string;
	name: string;
	position: Vec3;
	width: number;
}) {
	const canvas = useMemo(() => {
		const element = document.createElement("canvas");
		element.width = SIGN_PX.width;
		element.height = SIGN_PX.height;
		return element;
	}, []);
	const texture = useRef<CanvasTexture>(null);
	const [fontReady, setFontReady] = useState(false);
	useEffect(() => {
		let live = true;
		document.fonts
			?.load(`600 64px "${GAME_DISPLAY_FAMILY}"`)
			.then(() => {
				if (live) {
					setFontReady(true);
				}
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);
	useEffect(() => {
		paintSign(canvas, name, ink);
		if (texture.current) {
			texture.current.needsUpdate = true;
		}
	}, [canvas, fontReady, ink, name]);
	const height = width * (SIGN_PX.height / SIGN_PX.width);
	return (
		<mesh position={position}>
			<planeGeometry args={[width, height]} />
			<meshBasicMaterial toneMapped={false} transparent>
				<canvasTexture
					args={[canvas]}
					attach="map"
					colorSpace="srgb"
					ref={texture}
				/>
			</meshBasicMaterial>
		</mesh>
	);
}

/** Where each lot's painted name goes, in the lot's frame. */
function signTexts(lots: readonly MarketLot[]) {
	return lots.map((lot) => {
		const stall = lot.shop.kind === "stall";
		const [x, y, z] = lot.frame.sign;
		const front = stall
			? lot.frame.front - lot.size.depth / 2 + 0.085
			: z + 0.016;
		return {
			id: lot.shop.id,
			name: lot.shop.name,
			position: [x, y, front] as Vec3,
			width: lot.size.width * (stall ? 0.58 : 0.64),
		};
	});
}

/**
 * Every shop and stall facing one way, instanced, drawn in their own frame
 * (fronts toward +z) and turned into the world.
 */
export function MarketShops({
	art,
	busy,
	facing,
	lots,
	night,
}: {
	art: MarketArt;
	/** With acts, each shop's busy flag from its keepers' acts. */
	busy?: ReadonlyMap<string, boolean>;
	facing: MarketFacing;
	lots: readonly MarketLot[];
	night: boolean;
}) {
	// Keyed by the lit shops, so a new map each tick rebuilds nothing.
	const litKey = busy
		? [...busy]
				.filter(([, lit]) => lit)
				.map(([id]) => id)
				.sort()
				.join("\n")
		: null;
	const parts = useMemo(
		() =>
			buildShops(
				lots.filter((lot) => lot.facing === facing),
				art,
				night,
				litKey === null ? undefined : new Set(litKey.split("\n"))
			),
		[art, facing, litKey, lots, night]
	);
	const texts = useMemo(
		() => signTexts(lots.filter((lot) => lot.facing === facing)),
		[facing, lots]
	);
	return (
		<group rotation={[0, FACING_YAW[facing], 0]}>
			{texts.map((text) => (
				<SignText
					ink={art.signInk}
					key={text.id}
					name={text.name}
					position={text.position}
					width={text.width}
				/>
			))}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={art.woodDark}
				items={parts.walls}
				receiveShadow
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.05} smoothness={3} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={art.woodDark}
				items={parts.prisms}
				receiveShadow
			>
				<MeshGeometry data={PRISM} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.trim} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.woodDark}
				items={parts.wood}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.woodDark}
				items={parts.stripes}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.scallops}>
				<sphereGeometry
					args={[1, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]}
				/>
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.signEdge}
				items={parts.boards}
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.04} smoothness={3} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={PROP_INK * 0.6} items={parts.goods}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.knobs}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial color={art.knob} />
			</InstancedParts>
			<InstancedParts items={parts.glass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial emissive={art.glass} emissiveIntensity={0.25} />
			</InstancedParts>
			<InstancedParts items={parts.litGlass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial
					color={art.litGlass}
					emissive={art.litGlass}
					emissiveIntensity={night ? 1.5 : 0.6}
					toneMapped={false}
				/>
			</InstancedParts>
		</group>
	);
}
