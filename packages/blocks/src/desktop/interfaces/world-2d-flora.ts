import type { PixelLeafTones, PixelScene } from "./world-2d-palette.ts";
import { SWATCH } from "./world-2d-palette.ts";
import {
	light,
	noise,
	PixelBuffer,
	type Sprite,
	shade,
	spriteCache,
	toSprite,
} from "./world-2d-pixel.ts";

/**
 * Trees, bushes and potted plants for the 2D village, plus the small ground
 * decals (grass tufts, wildflowers, pebbles, mushrooms) baked into the
 * ground layer. Canopies are built from overlapping leaf clusters, each lit
 * from the top-left, with a dark band where a front cluster overlaps the one
 * behind it, highlight flecks, and a deep green outline.
 */

export type TreeKind =
	| "bush"
	| "fruit"
	| "log"
	| "maple"
	| "oak"
	| "pine"
	| "rock"
	| "sapling"
	| "stump";

interface Cluster {
	r: number;
	x: number;
	y: number;
}

/** Bayer 4x4 ordered-dither threshold in 0..1. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function bayer(x: number, y: number): number {
	return ((BAYER[(y & 3) * 4 + (x & 3)] ?? 0) + 0.5) / 16;
}

function paintCanopy(
	buffer: PixelBuffer,
	clusters: readonly Cluster[],
	tones: PixelLeafTones,
	seed: number,
	top: number,
	bottom: number
): void {
	const owner = new Int16Array(buffer.width * buffer.height).fill(-1);
	clusters.forEach((cluster, index) => {
		for (
			let y = Math.floor(cluster.y - cluster.r);
			y <= cluster.y + cluster.r;
			y++
		) {
			for (
				let x = Math.floor(cluster.x - cluster.r);
				x <= cluster.x + cluster.r;
				x++
			) {
				if (!buffer.inside(x, y)) {
					continue;
				}
				const dx = x + 0.5 - cluster.x;
				const dy = y + 0.5 - cluster.y;
				// Slightly lumpy edge so clusters never read as clean circles.
				const wobble = (noise(x, y, seed) - 0.5) * 1.6;
				if (dx * dx + dy * dy <= (cluster.r + wobble) ** 2) {
					owner[y * buffer.width + x] = index;
				}
			}
		}
	});
	const span = Math.max(1, bottom - top);
	for (let y = 0; y < buffer.height; y++) {
		for (let x = 0; x < buffer.width; x++) {
			const index = owner[y * buffer.width + x] ?? -1;
			const cluster = clusters[index];
			if (!cluster) {
				continue;
			}
			const below = owner[(y + 1) * buffer.width + x] ?? -1;
			const below2 = owner[(y + 2) * buffer.width + x] ?? -1;
			const dx = (x + 0.5 - cluster.x) / cluster.r;
			const dy = (y + 0.5 - cluster.y) / cluster.r;
			let lit = -(dx * 0.55 + dy * 0.85) - ((y - top) / span) * 0.45 + 0.2;
			// Clustered shading: 2x2 leaf clumps and 3x1 sprigs shift a band
			// up or down, never an ordered checker.
			lit += (noise(x >> 1, y >> 1, seed + 3) - 0.5) * 0.34;
			lit += (noise(Math.floor(x / 3), y, seed + 5) - 0.5) * 0.14;
			let color: string;
			if (
				(below > index || below2 > index) &&
				below !== -1 &&
				below !== index
			) {
				// Shadow cast by the cluster in front.
				color = tones.dark;
			} else if (lit > 0.62) {
				color = tones.glint;
			} else if (lit > 0.18) {
				color = tones.light;
			} else if (lit > -0.38) {
				color = tones.mid;
			} else {
				color = tones.dark;
			}
			buffer.set(x, y, color);
		}
	}
	// Leaf flecks: tiny lit "v" marks on the sunny side, dark ones in shade.
	for (let y = 1; y < buffer.height - 1; y++) {
		for (let x = 1; x < buffer.width - 1; x++) {
			const index = owner[y * buffer.width + x] ?? -1;
			if (index < 0) {
				continue;
			}
			const n = noise(x, y, seed + 7);
			const current = buffer.get(x, y);
			if (n < 0.05 && current === tones.light) {
				buffer.set(x, y, tones.glint);
				buffer.set(x - 1, y - 1, tones.glint);
			} else if (n < 0.05 && current === tones.mid) {
				buffer.set(x, y, tones.dark);
				buffer.set(x + 1, y - 1, tones.dark);
			}
		}
	}
}

function paintTrunk(
	buffer: PixelBuffer,
	cx: number,
	top: number,
	base: number,
	width: number,
	trunk: string
): void {
	const left = cx - Math.floor(width / 2);
	for (let y = top; y <= base; y++) {
		for (let x = left; x < left + width; x++) {
			const edge = x - left;
			let color = trunk;
			if (edge === 0) {
				color = light(trunk, 0.22);
			} else if (edge >= width - 2) {
				color = shade(trunk, edge === width - 1 ? 0.35 : 0.18);
			}
			if (noise(x, y, 31) < 0.12) {
				color = shade(trunk, 0.25);
			}
			buffer.set(x, y, color);
		}
	}
	// Roots flaring at the base.
	buffer.rect(left - 2, base - 1, 2, 2, shade(trunk, 0.1));
	buffer.set(left - 3, base, shade(trunk, 0.2));
	buffer.rect(left + width, base - 1, 2, 2, shade(trunk, 0.3));
	buffer.set(left + width + 2, base, shade(trunk, 0.35));
}

function jitter(clusters: Cluster[], seed: number): Cluster[] {
	return clusters.map((cluster, index) => ({
		r: cluster.r + Math.round((noise(index, seed, 3) - 0.5) * 2),
		x: cluster.x + Math.round((noise(index, seed, 5) - 0.5) * 2),
		y: cluster.y + Math.round((noise(index, seed, 9) - 0.5) * 2),
	}));
}

/** Trunk and roots on their own layer, outlined in a deep bark brown. */
function trunkLayer(
	width: number,
	height: number,
	cx: number,
	top: number,
	base: number,
	trunkWidth: number,
	trunk: string
): PixelBuffer {
	const layer = new PixelBuffer(width, height);
	paintTrunk(layer, cx, top, base, trunkWidth, trunk);
	layer.outline(0.5);
	return layer;
}

/** Berries or fruit dotted over a canopy (only where leaves are). */
function dotFruit(
	buffer: PixelBuffer,
	color: string,
	count: number,
	seed: number,
	area: { h: number; w: number; x: number; y: number }
): void {
	for (let i = 0; i < count; i++) {
		const x = area.x + Math.floor(noise(i, seed, 51) * area.w);
		const y = area.y + Math.floor(noise(i, seed, 53) * area.h);
		if (buffer.alpha(x, y) > 0 && buffer.alpha(x + 1, y + 1) > 0) {
			buffer.rect(x, y, 2, 2, color);
			buffer.set(x, y, light(color, 0.5));
			buffer.set(x + 1, y + 1, shade(color, 0.3));
		}
	}
}

/**
 * A tall pine of five drooping bough tiers. Each tier hangs a little left
 * or right of the one above, its tips droop lower than its middle, its top
 * edge catches the light and its underside falls into a blue shadow where
 * it overhangs the tier below.
 */
function buildPine(variant: number, scene: PixelScene): Sprite {
	const tones = scene.tree;
	const width = 46;
	const height = 96;
	const cx = 23;
	const buffer = new PixelBuffer(width, height);
	buffer.blit(
		trunkLayer(width, height, cx, 74, height - 6, 6, shade(tones.trunk, 0.1)),
		0,
		0
	);
	const leaf = tones.pine;
	const crown = new PixelBuffer(width, height);
	const tiers = variant % 3 === 2 ? 4 : 5;
	const tierH = 18;
	const start = 3 + (5 - tiers) * 12;
	const shifts = [0, -2, 2, -1, 2, -2];
	// Bottom tier first: each higher tier's droop overlaps the one below.
	for (let t = tiers - 1; t >= 0; t--) {
		const y0 = start + t * 13;
		const shift = shifts[(t + variant) % shifts.length] ?? 0;
		const reach = 4 + t * 3.6 + (variant % 2);
		for (let k = 0; k < tierH; k++) {
			const y = y0 + k;
			const half = Math.min(width / 2 - 1, reach * (0.35 + (k / tierH) * 0.75));
			for (let x = 0; x < width; x++) {
				const dx = x + 0.5 - (cx + shift);
				const ax = Math.abs(dx);
				if (ax > half) {
					continue;
				}
				// Tips droop: the tier's lower edge hangs lowest at the ends.
				const across = ax / Math.max(1, half);
				const bottom = tierH - 1 - Math.round(4 * (1 - across) ** 2);
				if (k > bottom) {
					continue;
				}
				// Saw-tooth needle tips along the outer edge.
				if (ax > half - 2.2 && (y + Math.floor(ax)) % 3 === 0) {
					continue;
				}
				const underside = bottom - k < 3;
				const rel = dx / Math.max(1, half);
				let lit = -rel * 0.75 - (k / tierH) * 0.55 + 0.25;
				lit += (noise(x >> 1, y >> 1, variant + 17) - 0.5) * 0.3;
				let color = leaf.mid;
				if (underside) {
					color = k === bottom ? leaf.line : leaf.dark;
				} else if (lit > 0.62 && k < 7) {
					color = leaf.glint;
				} else if (lit > 0.2) {
					color = leaf.light;
				} else if (lit < -0.42) {
					color = leaf.dark;
				}
				crown.set(x, y, color);
			}
		}
		// A lit edge along the tier's top, broken into short sprigs.
		for (let x = 0; x < width; x++) {
			const dx = x + 0.5 - (cx + shift);
			const half = reach * 0.4;
			if (Math.abs(dx) < half && dx < 1 && noise(x, t, variant + 23) < 0.7) {
				crown.set(x, y0 + 1, leaf.glint);
			}
		}
	}
	crown.outline(0.5, false, leaf.line);
	buffer.blit(crown, 0, 0);
	return toSprite(buffer, cx, height - 4);
}

/** A salmonberry bush: low leaf clusters dotted with pink berries. */
function buildBush(variant: number, scene: PixelScene): Sprite {
	const buffer = new PixelBuffer(36, 28);
	const clusters = jitter(
		[
			{ r: 8, x: 10, y: 16 },
			{ r: 8, x: 26, y: 16 },
			{ r: 9, x: 18, y: 11 },
			{ r: 8, x: 18, y: 18 },
		],
		variant
	);
	paintCanopy(buffer, clusters, scene.tree.oak, variant + 11, 2, 26);
	if (variant % 3 !== 2) {
		dotFruit(buffer, SWATCH.pink355, 10, variant + 40, {
			h: 14,
			w: 24,
			x: 6,
			y: 6,
		});
	}
	buffer.outline(0.5, false, scene.tree.oak.line);
	return toSprite(buffer, 18, 27);
}

/** A cut stump with rings, or a mossy fallen log. */
function buildStump(log: boolean, scene: PixelScene): Sprite {
	const wood = scene.tree.trunk;
	if (log) {
		const buffer = new PixelBuffer(28, 14);
		buffer.rect(3, 4, 21, 7, wood);
		buffer.hline(3, 4, 21, light(wood, 0.25));
		buffer.hline(3, 10, 21, shade(wood, 0.35));
		for (let x = 5; x < 22; x += 4) {
			buffer.hline(x, 7, 2, shade(wood, 0.2));
		}
		buffer.ellipse(23.5, 7.5, 3, 3.6, SWATCH.amber335);
		buffer.ellipse(23.5, 7.5, 1.6, 2, SWATCH.amber495Muted);
		buffer.set(23, 7, SWATCH.orange630);
		// Moss along the top.
		buffer.hline(6, 4, 6, SWATCH.green525);
		buffer.hline(8, 3, 3, SWATCH.green485);
		buffer.outline(0.55);
		return toSprite(buffer, 14, 12);
	}
	const buffer = new PixelBuffer(18, 14);
	buffer.rect(4, 5, 10, 6, wood);
	buffer.vline(4, 5, 6, light(wood, 0.2));
	buffer.rect(11, 5, 3, 6, shade(wood, 0.3));
	buffer.rect(2, 9, 3, 2, shade(wood, 0.15));
	buffer.rect(13, 9, 3, 2, shade(wood, 0.35));
	buffer.ellipse(9, 5, 5.2, 2.4, SWATCH.amber335);
	buffer.ellipse(9, 5, 3, 1.4, SWATCH.amber425);
	buffer.set(9, 5, SWATCH.amber550);
	buffer.outline(0.55);
	return toSprite(buffer, 9, 12);
}

/** A grey boulder with a lit top and a few cracks. */
function buildRock(variant: number): Sprite {
	const buffer = new PixelBuffer(18, 14);
	const stone =
		variant % 2 === 0 ? SWATCH.warmGrey395Muted : SWATCH.coolGrey370;
	buffer.ellipse(9, 8, 7, 5, stone);
	buffer.ellipse(7.5, 6.5, 4.5, 2.6, light(stone, 0.3));
	buffer.ellipse(11.5, 10, 4, 2, shade(stone, 0.22));
	buffer.set(6, 5, light(stone, 0.6));
	buffer.set(10, 8, shade(stone, 0.35));
	buffer.set(11, 9, shade(stone, 0.35));
	if (variant % 3 === 0) {
		buffer.ellipse(4, 11, 2.4, 1.6, shade(stone, 0.05));
	}
	buffer.outline(0.5);
	return toSprite(buffer, 9, 12);
}

/**
 * A broadleaf crown as one irregular leaf mass: the union of a few lobes
 * with a chunky, clumped edge, lit as a whole from the top-left (yellow-
 * green highlight clusters up there, a mid tone, and a darker bottom third
 * where the crown shades itself), with a darker crescent under each lobe
 * that sits in front of the mass so the leaves read as overlapping chunks
 * rather than separate balls.
 */
function paintCrown(
	buffer: PixelBuffer,
	lobes: readonly Cluster[],
	tones: PixelLeafTones,
	seed: number
): void {
	const inLobe = (lobe: Cluster, x: number, y: number) => {
		const dx = x + 0.5 - lobe.x;
		const dy = y + 0.5 - lobe.y;
		// Leaf clumps poke out of the outline in 2x2 lumps.
		const wobble = (noise(x >> 1, y >> 1, seed) - 0.5) * 3;
		return dx * dx + dy * dy <= (lobe.r + wobble) ** 2;
	};
	const owner = new Int16Array(buffer.width * buffer.height).fill(-1);
	let top = buffer.height;
	let bottom = 0;
	let left = buffer.width;
	let right = 0;
	for (let y = 0; y < buffer.height; y++) {
		for (let x = 0; x < buffer.width; x++) {
			let hit = -1;
			lobes.forEach((lobe, index) => {
				if (inLobe(lobe, x, y)) {
					hit = index;
				}
			});
			if (hit >= 0) {
				owner[y * buffer.width + x] = hit;
				top = Math.min(top, y);
				bottom = Math.max(bottom, y);
				left = Math.min(left, x);
				right = Math.max(right, x);
			}
		}
	}
	const height = Math.max(1, bottom - top);
	const half = Math.max(1, (right - left) / 2);
	const center = (left + right) / 2;
	const at = (x: number, y: number) =>
		buffer.inside(x, y) ? (owner[y * buffer.width + x] ?? -1) : -1;
	for (let y = top; y <= bottom; y++) {
		for (let x = left; x <= right; x++) {
			const index = at(x, y);
			if (index < 0) {
				continue;
			}
			const ny = (y - top) / height;
			const nx = (x + 0.5 - center) / half;
			// Leaf clumps: 3x3 cells nudge the light up or down.
			const clump =
				(noise(Math.floor(x / 3), Math.floor(y / 3), seed + 3) - 0.5) * 0.32;
			const lit = 0.62 - nx * 0.42 - ny * 1.15 + clump;
			// The lower edge of a lobe that sits over the mass: a dark crescent.
			const lobe = lobes[index];
			const below = at(x, y + 2);
			const crescent =
				index > 0 &&
				lobe !== undefined &&
				y + 0.5 > lobe.y &&
				below >= 0 &&
				below !== index &&
				!inLobe(lobe, x, y + 2);
			const shadowLine = 0.7 + (noise(x >> 1, 0, seed + 9) - 0.5) * 0.12;
			let color: string;
			if (ny > shadowLine || lit < -0.12) {
				color = tones.dark;
			} else if (crescent) {
				color = lit > 0.4 ? tones.mid : tones.dark;
			} else if (lit > 0.42) {
				color = tones.light;
			} else {
				color = tones.mid;
			}
			buffer.set(x, y, color);
		}
	}
	// Highlight clusters on the sunny upper-left: small leaf-shaped glints.
	const glints = [
		[0.28, 0.12],
		[0.42, 0.2],
		[0.2, 0.3],
		[0.55, 0.1],
		[0.34, 0.4],
		[0.14, 0.18],
		[0.62, 0.28],
	] as const;
	glints.forEach(([fx, fy], i) => {
		const gx = Math.round(
			left + (right - left) * fx + (noise(i, seed, 11) - 0.5) * 4
		);
		const gy = Math.round(top + height * fy + (noise(i, seed, 13) - 0.5) * 3);
		for (const [dx, dy] of [
			[0, 0],
			[1, 0],
			[-1, 1],
			[0, 1],
			[2, -1],
		] as const) {
			if (
				at(gx + dx, gy + dy) >= 0 &&
				buffer.get(gx + dx, gy + dy) === tones.light
			) {
				buffer.set(gx + dx, gy + dy, tones.glint);
			}
		}
	});
	// Leaf flecks: a few dark "v" marks in the mid tone.
	for (let y = top + 1; y < bottom; y++) {
		for (let x = left + 1; x < right; x++) {
			if (
				at(x, y) >= 0 &&
				noise(x, y, seed + 7) < 0.035 &&
				buffer.get(x, y) === tones.mid
			) {
				buffer.set(x, y, tones.dark);
				buffer.set(x + 1, y - 1, tones.dark);
			}
		}
	}
}

/**
 * Broadleaf trees: big and small oaks, maples, and fruit trees (apple or
 * peach). The crown is one leaf mass with a deep green line; under it a
 * short trunk (about a tile of it shows) flares into roots, outlined in
 * bark brown.
 */
function buildBroadleaf(
	kind: "fruit" | "maple" | "oak" | "sapling",
	variant: number,
	scene: PixelScene
): Sprite {
	const tones = scene.tree;
	const small = kind === "sapling" || kind === "fruit";
	const fruit = kind === "fruit";
	const maple = kind === "maple";
	const width = small ? 46 : 64;
	const height = small ? 64 : 88;
	const cx = width / 2;
	const buffer = new PixelBuffer(width, height);
	buffer.blit(
		trunkLayer(
			width,
			height,
			cx,
			small ? 36 : 52,
			height - 5,
			small ? 6 : 10,
			tones.trunk
		),
		0,
		0
	);
	let base: Cluster[];
	if (small) {
		base = [
			{ r: 15, x: 23, y: 25 },
			{ r: 10, x: 22, y: 12 },
			{ r: 9, x: 10, y: 28 },
			{ r: 9, x: 36, y: 26 },
			{ r: 9, x: 24, y: 37 },
		];
	} else if (maple) {
		base = [
			{ r: 22, x: 32, y: 36 },
			{ r: 13, x: 26, y: 15 },
			{ r: 11, x: 42, y: 18 },
			{ r: 12, x: 13, y: 38 },
			{ r: 12, x: 51, y: 40 },
			{ r: 11, x: 22, y: 56 },
			{ r: 11, x: 43, y: 56 },
		];
	} else {
		base = [
			{ r: 23, x: 32, y: 38 },
			{ r: 15, x: 30, y: 17 },
			{ r: 12, x: 14, y: 40 },
			{ r: 13, x: 49, y: 35 },
			{ r: 12, x: 21, y: 56 },
			{ r: 12, x: 43, y: 57 },
		];
	}
	const lobes = jitter(base, variant);
	const leaves = maple ? tones.maple : tones.oak;
	const crown = new PixelBuffer(width, height);
	paintCrown(crown, lobes, leaves, variant * 13 + (maple ? 5 : 1));
	if (fruit) {
		dotFruit(
			crown,
			variant % 2 === 0 ? tones.fruit : SWATCH.amber410,
			12,
			variant,
			{
				h: 28,
				w: 32,
				x: 7,
				y: 8,
			}
		);
	}
	crown.outline(0.5, false, leaves.line);
	buffer.blit(crown, 0, 0);
	return toSprite(buffer, cx, height - 3);
}

function buildTree(kind: TreeKind, variant: number, scene: PixelScene): Sprite {
	switch (kind) {
		case "pine":
			return buildPine(variant, scene);
		case "bush":
			return buildBush(variant, scene);
		case "stump":
			return buildStump(false, scene);
		case "log":
			return buildStump(true, scene);
		case "rock":
			return buildRock(variant);
		default:
			return buildBroadleaf(kind, variant, scene);
	}
}

const treeSprites = spriteCache(buildTree);

export function treeSprite(
	kind: TreeKind,
	variant: number,
	scene: PixelScene
): Sprite {
	return treeSprites(
		`${kind}|${variant}|${scene.tree.oak.mid}`,
		kind,
		variant,
		scene
	);
}

/** Whether a tree kind is low (it never needs to dodge a canopy check). */
export function lowGrowth(kind: TreeKind): boolean {
	return (
		kind === "bush" || kind === "stump" || kind === "log" || kind === "rock"
	);
}

/** A leafy office plant in a terracotta pot (indoor "tree"). */
function buildPottedPlant(variant: number, scene: PixelScene): Sprite {
	const buffer = new PixelBuffer(24, 34);
	const tall = variant % 2 === 0;
	const clusters = jitter(
		tall
			? [
					{ r: 5, x: 12, y: 6 },
					{ r: 5, x: 7, y: 12 },
					{ r: 5, x: 17, y: 12 },
					{ r: 6, x: 12, y: 16 },
				]
			: [
					{ r: 6, x: 8, y: 14 },
					{ r: 6, x: 16, y: 14 },
					{ r: 6, x: 12, y: 11 },
				],
		variant + 3
	);
	paintCanopy(buffer, clusters, scene.tree.oak, variant + 21, 1, 22);
	buffer.outline(0.5, false, scene.tree.oak.line);
	// Pot.
	const pot = variant % 4 === 1 ? SWATCH.blue455Muted : SWATCH.orange490;
	const potLayer = new PixelBuffer(24, 34);
	potLayer.rect(6, 22, 12, 2, light(pot, 0.2));
	potLayer.rect(7, 24, 10, 8, pot);
	potLayer.vline(7, 24, 8, light(pot, 0.15));
	potLayer.rect(15, 24, 2, 8, shade(pot, 0.25));
	potLayer.hline(7, 25, 10, shade(pot, 0.3));
	potLayer.outline(0.5);
	buffer.blit(potLayer, 0, 0);
	return toSprite(buffer, 12, 33);
}

const plantSprites = spriteCache(buildPottedPlant);

export function pottedPlantSprite(variant: number, scene: PixelScene): Sprite {
	return plantSprites(String(variant % 4), variant % 4, scene);
}

/**
 * Which tree a scenery tile grows, from its variant and a hash: a mixed
 * wood of big and small oaks, maples, pines and fruit trees, with berry
 * bushes, stumps, fallen logs and boulders among them.
 */
export function treeKind(
	variant: number,
	hash: number,
	edge: boolean
): TreeKind {
	const roll = (hash * 7 + variant * 131) % 100;
	if (edge) {
		if (roll < 30) {
			return "oak";
		}
		if (roll < 52) {
			return "pine";
		}
		if (roll < 64) {
			return "maple";
		}
		if (roll < 74) {
			return "sapling";
		}
		if (roll < 80) {
			return "fruit";
		}
		if (roll < 88) {
			return "bush";
		}
		if (roll < 92) {
			return "stump";
		}
		if (roll < 96) {
			return "rock";
		}
		return "log";
	}
	switch (variant) {
		case 0:
			return roll < 50 ? "oak" : "sapling";
		case 1:
			return "pine";
		case 2:
			return "maple";
		default:
			return hash % 2 === 0 ? "fruit" : "bush";
	}
}

// ---------------------------------------------------------------------------
// Ground decals, drawn straight into the ground buffer
// ---------------------------------------------------------------------------

const TUFTS = [
	["t.t", "btb", "b.b"],
	[".t...t", "tb.t.b", "b.bb.b"],
	["t.t.t", "btbtb"],
] as const;

export function paintTuft(
	buffer: PixelBuffer,
	x: number,
	y: number,
	variant: number,
	scene: PixelScene
): void {
	const rows = TUFTS[variant % TUFTS.length] ?? TUFTS[0];
	buffer.map(rows, { b: scene.grassBlade, t: scene.grassTip }, x, y);
}

/** Tall grass clump (fiber): a fan of blades, dark at the root. */
export function paintTallGrass(
	buffer: PixelBuffer,
	x: number,
	y: number,
	scene: PixelScene
): void {
	const rows = [
		"..t...t..",
		".tb.t.bt.",
		".bb.b.bb.",
		"tbbtbtbbt",
		"bBbbBbbBb",
		".BBBBBBB.",
	];
	buffer.map(
		rows,
		{
			B: shade(scene.grassBlade, 0.25),
			b: scene.grassBlade,
			t: scene.grassTip,
		},
		x,
		y
	);
}

/** A wildflower: daffodil, sweet pea, blue jazz, and friends. */
export function paintFlower(
	buffer: PixelBuffer,
	x: number,
	y: number,
	variant: number,
	scene: PixelScene
): void {
	const [petal, center] = scene.flowers[variant % scene.flowers.length] ?? [
		SWATCH.yellow385,
		SWATCH.amber460,
	];
	buffer.map(
		[".p.", "pcp", ".p.", ".s.", "ls."],
		{ c: center, l: scene.grassTip, p: petal, s: scene.grassBlade },
		x,
		y
	);
}

export function paintPebble(buffer: PixelBuffer, x: number, y: number): void {
	buffer.map(
		[".ll.", "lggd", ".dd."],
		{ d: SWATCH.warmGrey585, g: SWATCH.warmGrey405, l: SWATCH.amber235Muted },
		x,
		y
	);
}

export function paintMushroom(buffer: PixelBuffer, x: number, y: number): void {
	buffer.map(
		[".rr.", "rwrr", "RRRR", ".ss.", ".sS."],
		{
			R: SWATCH.red595,
			r: SWATCH.red460,
			S: SWATCH.amber305Muted,
			s: SWATCH.amber115,
			w: SWATCH.white10Muted,
		},
		x,
		y
	);
}

export function paintTwig(buffer: PixelBuffer, x: number, y: number): void {
	buffer.map(["t...", ".tt.", "...t"], { t: SWATCH.orange665 }, x, y);
}

export function paintLilyPad(
	buffer: PixelBuffer,
	x: number,
	y: number,
	bloom: boolean
): void {
	buffer.map(
		[".gggg.", "gglgGg", "gggGGg", ".gGG.."],
		{ G: SWATCH.green670, g: SWATCH.green555Dusty, l: SWATCH.green440 },
		x,
		y
	);
	if (bloom) {
		buffer.map(
			[".p.", "pwp"],
			{ p: SWATCH.pink195, w: SWATCH.pink20 },
			x + 1,
			y - 1
		);
	}
}
