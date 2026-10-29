import { agentHue } from "./interface-renderer.ts";
import { characterLook } from "./world-2d-sprites.tsx";

/**
 * The 3D game kit's scene palette: the one place the cosy cel-shaded
 * diorama look keeps its literal colours. Every game3d-* module, World 3D
 * and the games built on the kit (Farm, Kitchen, Town, ...) draw from here:
 *
 * - `GAME3D_DAY` / `GAME3D_NIGHT`: the shared scene themes (sky, sea, lawn,
 *   cliffs, trees, cottages, lamps, toon lighting). Light themes are day,
 *   dark themes are night.
 * - `FLORA_ART`, `HOUSE_ART`, `SHORE_ART`, `PROP_ART`: fixed prop colours.
 * - `VILLAGER_FEATURES`, `agentSwatches`, `villagerLooks`: the chibi
 *   villagers' faces and the per-agent outfit colours.
 * - `TOON_LIGHT`: ink, rim and shade tints for the toon shader.
 */

export type Vec3 = [number, number, number];

/**
 * Scene colors and lighting for one world theme. Scene colors are fixed per
 * theme (they are a place, not UI chrome), mirroring `WORLD_PALETTES`.
 */
export interface Scene3dTheme {
	ambient: number;
	/** Bloom strength: how much the sun, lamps and sparkles glow. */
	bloom: number;
	/** Background behind the island; also the fog color at the horizon. */
	blossom: string;
	chimney: string;
	cliff: string;
	cliffDeep: string;
	clouds: boolean;
	door: string;
	/** Night fill from the camera side, kept near neutral so colors survive. */
	fillLight: string | null;
	flowers: readonly string[];
	foundation: string;
	/** Fireflies at night, pollen by day (HDR, so they bloom). */
	glimmer: readonly [number, number, number];
	grass: readonly [string, string, string];
	/** Wind-swept grass blades, root to tip; `null` for none (the office). */
	grassBlades: readonly [string, string] | null;
	grout: string;
	hemiGround: string;
	hemiIntensity: number;
	hemiSky: string;
	/** Ink outline base: dark and hue-tinted, never black. */
	ink: string;
	lantern: string;
	/**
	 * Lawn ground: a light and a deep green blended in soft patches (the
	 * grass blades' roots use the same color); `null` indoors.
	 */
	lawn: readonly [string, string] | null;
	night: boolean;
	path: readonly [string, string, string];
	pineLeaves: readonly string[];
	/** What the place is called in the HUD ("6 in the village"). */
	place: string;
	/** Plaza pattern tiles: base, every-other tint, and the stamped motif. */
	plaza: readonly [string, string, string];
	/** What closes the island edge: a forest outdoors, walls in the office. */
	rim: "forest" | "walls";
	/** One-sided rim light on characters: warm by day, lilac at night. */
	rimLight: string;
	sand: string;
	/** Darker sand where the waves reach. */
	sandWet: string;
	/** Multiplies the shaded side (sky fill): cool blue or purple, never black. */
	shadeTint: string;
	sky: string;
	/** Sky dome: deep zenith, pale horizon, and the warm band along it. */
	skyGlow: string;
	skyHorizon: string;
	skyZenith: string;
	smoke: string;
	sunColor: string;
	/** The sun or moon disk in the sky (HDR, so it blooms). */
	sunDisk: readonly [number, number, number];
	sunIntensity: number;
	treeLeaves: readonly string[];
	trunk: string;
	wall: string;
	/** Soft pastel walls the cottages pick from. */
	walls: readonly string[];
	wallTrim: string;
	water: string | null;
	windowIdle: string;
	windowWorking: string;
}

/** The shared daytime diorama: bright sky, turquoise sea, lush lawn. */
export const GAME3D_DAY: Scene3dTheme = {
	ambient: 0.18,
	bloom: 0.55,
	blossom: "#f7a8c4",
	chimney: "#a65f48",
	cliff: "#a8714a",
	cliffDeep: "#80563b",
	clouds: true,
	door: "#7a4a2c",
	flowers: ["#ff7aa2", "#ffd84d", "#ffffff", "#b58cff", "#ff9a4d"],
	foundation: "#c9bfae",
	glimmer: [2.4, 2.3, 1.6],
	grass: ["#7cc957", "#83cd5d", "#77c453"],
	grassBlades: ["#24614a", "#d9f07a"],
	grout: "#d9cdb2",
	hemiGround: "#8f86b9",
	hemiIntensity: 1.35,
	hemiSky: "#c4d6ff",
	ink: "#2a2046",
	lantern: "#4b4a52",
	lawn: ["#74c254", "#3f9446"],
	night: false,
	path: ["#efe2c4", "#e7d8b6", "#f4eacf"],
	pineLeaves: ["#2f8a4e", "#3a9a56", "#2a7c47"],
	place: "village",
	plaza: ["#f1d9b3", "#e3a882", "#fff3dc"],
	rim: "forest",
	rimLight: "#ffd9a6",
	sand: "#f4e2ad",
	sandWet: "#e3c98f",
	fillLight: null,
	shadeTint: "#c3ccff",
	sky: "#9fd8f2",
	skyGlow: "#ffe6bd",
	skyHorizon: "#d6ecff",
	skyZenith: "#2a68dc",
	smoke: "#f4f4f4",
	sunColor: "#fff0d4",
	sunDisk: [2.7, 2.5, 2.1],
	sunIntensity: 2.35,
	treeLeaves: ["#58b44a", "#6cc053", "#4aa443"],
	trunk: "#8a5a3a",
	wall: "#fdecc8",
	wallTrim: "#9a6a45",
	walls: ["#fff4df", "#fde6d6", "#e9f3e2", "#e6eefb", "#fbeed0"],
	water: "#3fc4d8",
	windowIdle: "#a9d3e3",
	windowWorking: "#ffd36e",
};

/** The shared night diorama: indigo sky, warm lamps and windows. */
export const GAME3D_NIGHT: Scene3dTheme = {
	ambient: 0.16,
	bloom: 0.95,
	blossom: "#c58aa6",
	chimney: "#8c6461",
	cliff: "#4a3a48",
	cliffDeep: "#342a38",
	clouds: false,
	door: "#4a3328",
	flowers: ["#ff8ab0", "#ffe27a", "#e6e8ff", "#b9a0ff"],
	foundation: "#5d5a70",
	glimmer: [3.2, 2.8, 0.9],
	grass: ["#2d5f52", "#306354", "#2b5a4e"],
	grassBlades: ["#0f3340", "#5f8f80"],
	grout: "#6c6873",
	hemiGround: "#4a4566",
	hemiIntensity: 1.45,
	hemiSky: "#8d95c2",
	ink: "#0f0c26",
	lantern: "#ffcf7a",
	lawn: ["#2c5c50", "#1c4140"],
	night: true,
	path: ["#a29a95", "#978f8c", "#aaa29c"],
	pineLeaves: ["#1d4a3c", "#22533f", "#1a4236"],
	place: "village",
	plaza: ["#a89a8c", "#9a7c70", "#c2b5a2"],
	rim: "forest",
	rimLight: "#c9b8ff",
	sand: "#8a8296",
	sandWet: "#726c84",
	fillLight: "#c4c9e4",
	shadeTint: "#c6c9ea",
	sky: "#0e1533",
	skyGlow: "#7a62c2",
	skyHorizon: "#3c3f93",
	skyZenith: "#070b2a",
	smoke: "#7a80b6",
	sunColor: "#b6bfe2",
	sunDisk: [1.45, 1.48, 1.62],
	sunIntensity: 1.4,
	treeLeaves: ["#2c6448", "#32704f", "#285c43"],
	trunk: "#4a3628",
	wall: "#d9d2c4",
	wallTrim: "#5a4232",
	walls: ["#d9d2c4", "#d6c6c0", "#c6d1c4", "#c4cad8", "#d8ccb4"],
	water: "#1b2d63",
	windowIdle: "#ffcf7a",
	windowWorking: "#ffd27a",
};

/** World 3D's office floor theme (indoors, no sea). */
export const OFFICE_THEME: Scene3dTheme = {
	ambient: 0.3,
	bloom: 0.35,
	blossom: "#f2a7b8",
	chimney: "#8c8279",
	cliff: "#9b7a58",
	cliffDeep: "#7f6247",
	clouds: false,
	door: "#6b4b33",
	flowers: ["#ff8a8a", "#ffd06b", "#ffffff", "#a8b8ff"],
	foundation: "#b9b2a6",
	glimmer: [2.2, 2.1, 1.8],
	grass: ["#d9b48a", "#d2ab80", "#dfbd95"],
	grassBlades: null,
	grout: "#a8a090",
	hemiGround: "#b59a7a",
	hemiIntensity: 1.2,
	hemiSky: "#fff4e4",
	ink: "#3a2a24",
	lantern: "#56524c",
	lawn: null,
	night: false,
	path: ["#5f7f8f", "#58788a", "#668796"],
	pineLeaves: ["#3f8a55", "#4a975f", "#377c4b"],
	place: "office",
	plaza: ["#ece6da", "#d9cbb5", "#fbf8f2"],
	rim: "walls",
	rimLight: "#ffe9c8",
	sand: "#e8dfcf",
	sandWet: "#ddd2bf",
	fillLight: null,
	shadeTint: "#e2d9ff",
	sky: "#efe6d6",
	skyGlow: "#fff2de",
	skyHorizon: "#f3eadb",
	skyZenith: "#d8c8ae",
	smoke: "#f4f4f4",
	sunColor: "#fff3e0",
	sunDisk: [0, 0, 0],
	sunIntensity: 2.1,
	treeLeaves: ["#4fa35a", "#5db166", "#46954f"],
	trunk: "#c2683f",
	wall: "#fbf6ec",
	wallTrim: "#8a6a4d",
	walls: ["#fbf6ec"],
	water: null,
	windowIdle: "#b9d6e2",
	windowWorking: "#ffd36e",
};

/** One cozy, muted color an agent wears: body, roof, label dot, map pin. */
export interface AgentSwatch {
	/** Shirt and arms. */
	body: string;
	/** Label dot and minimap house. */
	dot: string;
	hue: number;
	/** The swatch's own lightness and saturation (percent), before dimming. */
	lightness: number;
	/** Darker ridge cap and barge boards. */
	ridge: string;
	/** Roof shingles (two alternating courses). */
	roof: readonly [string, string];
	saturation: number;
	/** Light tint for the name plate border and the villager's collar. */
	tint: string;
}

/**
 * Curated roof colors (hue, saturation, lightness). Saturation stays at or
 * under 50% so roofs read as painted wood and clay, never neon, and there is
 * no green: a green roof disappears into the grass. Bright blue is left out
 * because it is the player's hoodie.
 */
const SWATCHES: readonly (readonly [number, number, number])[] = [
	[12, 50, 56], // terracotta
	[40, 52, 54], // mustard
	[172, 34, 42], // teal
	[198, 40, 58], // sky
	[222, 34, 38], // navy
	[262, 32, 62], // lavender
	[338, 42, 62], // rose
	[6, 40, 42], // brick
	[24, 28, 38], // cocoa
	[210, 12, 50], // slate
];

function hueDistance(a: number, b: number): number {
	const turn = Math.abs(a - b) % 360;
	return Math.min(turn, 360 - turn);
}

function swatchFor(
	[hue, saturation, lightness]: readonly [number, number, number],
	night: boolean
): AgentSwatch {
	// Night dims roofs a little but keeps their color: the indigo comes from
	// the sky and fog, not from the paint.
	const s = night ? saturation * 0.9 : saturation;
	const l = night ? lightness - 6 : lightness;
	return {
		body: `hsl(${hue}, ${Math.min(60, s + 10)}%, ${l + 6}%)`,
		dot: `hsl(${hue}, ${Math.min(70, s + 16)}%, ${Math.max(lightness, 50)}%)`,
		hue,
		lightness,
		ridge: `hsl(${hue}, ${s}%, ${Math.round(l * 0.62)}%)`,
		roof: [`hsl(${hue}, ${s}%, ${l}%)`, `hsl(${hue}, ${s}%, ${l - 6}%)`],
		saturation,
		tint: `hsl(${hue}, ${saturation}%, ${Math.min(86, lightness + 22)}%)`,
	};
}

/**
 * Gives every agent its own swatch: the free swatch nearest its stable hue
 * (so it stays close to its color in the other interfaces), in snapshot
 * order, never reusing one until all ten are taken.
 */
export function agentSwatches(
	agentIds: readonly string[],
	night = false
): ReadonlyMap<string, AgentSwatch> {
	const swatches = new Map<string, AgentSwatch>();
	let taken = new Set<number>();
	for (const agentId of agentIds) {
		if (taken.size === SWATCHES.length) {
			taken = new Set();
		}
		const hue = agentHue(agentId);
		let best = -1;
		for (const [index, swatch] of SWATCHES.entries()) {
			const better =
				best === -1 ||
				hueDistance(swatch[0], hue) <
					hueDistance((SWATCHES[best] ?? swatch)[0], hue);
			if (!taken.has(index) && better) {
				best = index;
			}
		}
		taken.add(best);
		const swatch = SWATCHES[best] ?? SWATCHES[0];
		if (swatch) {
			swatches.set(agentId, swatchFor(swatch, night));
		}
	}
	return swatches;
}

const FALLBACK_SWATCH = swatchFor([12, 50, 56], false);

export function swatchOf(
	swatches: ReadonlyMap<string, AgentSwatch>,
	agentId: string
): AgentSwatch {
	return swatches.get(agentId) ?? FALLBACK_SWATCH;
}

/** Hair and skin match the agent's portrait in the conversation panel. */
export interface CharacterLooks {
	hair: string;
	/** 0 short, 1 long, 2 spiky, 3 bun (same styles as the 2D sprite). */
	hairStyle: number;
	skin: string;
}

/**
 * The palest portrait skin is nearly the cream of the cottage walls behind
 * the villagers; in 3D it is drawn a shade warmer so faces never vanish.
 */
const SKIN_3D: Readonly<Record<string, string>> = { "#f7d7b8": "#f1c9a5" };

export function characterLooks(agentId: string): CharacterLooks {
	const look = characterLook(agentId);
	return {
		hair: look.hair,
		hairStyle: look.hairStyle,
		skin: SKIN_3D[look.skin.fill] ?? look.skin.fill,
	};
}

/**
 * How a villager looks in 3D, driven by the same swatch as its roof, name
 * plate dot and minimap pin, so the cottage and the character living in it
 * read as one identity: a shirt in the swatch's main color, a collar in its
 * light tint, anime hair in a deep shade of the swatch hue (nudged warm so
 * it reads as hair, not paint) and bright eyes of the same family. Skin and
 * hair style come from the agent's portrait.
 */
export function villagerLooks(
	agentId: string,
	swatch: AgentSwatch
): {
	body: string;
	collar: string;
	hair: string;
	hairStyle: number;
	iris: string;
	skin: string;
} {
	const looks = characterLooks(agentId);
	const { hue, lightness, saturation } = swatch;
	const hairHue = (hue + 352) % 360;
	// Greys (slate) keep a hint of blue; vivid swatches keep their color.
	const hairSaturation = Math.max(18, Math.min(52, saturation + 6));
	const hairLightness = Math.max(22, Math.min(34, lightness * 0.55));
	return {
		body: swatch.body,
		collar: swatch.tint,
		hair: `hsl(${hairHue}, ${hairSaturation}%, ${Math.round(hairLightness)}%)`,
		hairStyle: looks.hairStyle,
		iris: `hsl(${hue}, ${Math.min(82, saturation + 34)}%, 54%)`,
		skin: looks.skin,
	};
}

/**
 * Toward the sun (or moon) from the ground: high over the left shoulder of
 * the follow camera by day, so cottage fronts and faces are lit, and lower
 * from the west at night. Lights, cast shadows and the grass's
 * baked shade all use it.
 */
export function sunDirection(theme: Scene3dTheme): Vec3 {
	return theme.night ? [-0.5, 1, 0.35] : [-0.6, 1.05, 0.85];
}

/** Office furniture colors: the cubicle pods' desks, chairs and screens. */
export const OFFICE_PALETTE = {
	aluminum: "#d9dce1",
	bezel: "#26292f",
	chair: "#3a3f4a",
	deskLeg: "#9aa0a8",
	deskTop: "#e6cb9e",
	keyboard: "#eef0f3",
	leaves: "#4f9e4a",
	mug: "#fffaf0",
	pot: "#c2683f",
	screenOff: "#3d4a5c",
	screenOn: "#9ad8ff",
} as const;

/** Fixed art color shared by many props: pure white for glints and glows. */
export const ART_WHITE = "#ffffff";
/** Painted-wood cream used by window frames, rounds and boat stripes. */
export const ART_CREAM = "#fffaf0";

/** Grass and wildflower art colors (`world-3d-grass.tsx`). */
export const FLORA_ART = {
	/** Pinwheel aster petals: lilac, white and sky blue. */
	asterPetals: ["#c9b6ff", ART_WHITE, "#a9cbff", "#f3d4ff"],
	/** Drooping bells: blue, violet and pink. */
	bells: ["#7d8dff", "#b18cff", "#ff9ec4", "#6fb6ff"],
	centerGlow: "#ffb000",
	gold: "#ffd84d",
	glint: "#fff6c8",
	stem: "#4f9a46",
	tipFallback: "#c4ec72",
} as const;

/** House, yard and lamp art colors (`world-3d-houses.tsx`). */
export const HOUSE_ART = {
	/** Door woods: oak, walnut, honey pine. */
	doorWoods: ["#7a4a2c", "#5b3a28", "#a46b3c"],
	flag: "#ffd84d",
	lampBulb: "#fff3cf",
	lampBulbGlow: "#ffe7a8",
	/** Painted iron: dark green-grey reads as a lamp post, not a black stick. */
	lampIron: "#3f4a3c",
	lampLight: "#ffc985",
	mailbox: "#e25a4a",
	mailPost: "#8a5a3a",
	picket: "#fff6e6",
	planterFlower: "#f2c14e",
	shrub: "#4f9e4a",
	/** Warm window glow pooled on the ground at night. */
	windowPool: "#ffd38a",
} as const;

/** Shore, rock, boat and orchard art colors (`world-3d-terrain.tsx`). */
export const SHORE_ART = {
	foamInner: "#f4fdff",
	foamOuter: "#d6f6fa",
	fruit: ["#e8453c", "#ff9a2e", "#ffb3a7", "#d6e05a"],
	lifebuoy: "#4fa3c9",
	pot: "#c2683f",
	potLeaves: ["#4f9e4a", "#5aae52", "#468f44"],
	rockInk: "#b5b0c2",
	rocks: ["#c9c3cf", "#b5b0c2"],
	rocksLawn: ["#c9c3cf", "#b9b3c6"],
	shadow: "#7b74a8",
	shells: ["#fff4ec", "#ffc9c2", "#f6e3c6"],
	starfish: ["#ff8f6b", "#ffb15c", "#f77d8e"],
	towelStripe: "#e8553d",
	umbrellaPole: "#f4efe1",
} as const;

/** Faces, shoes and the player's outfit (`world-3d-villagers.tsx`). */
export const VILLAGER_FEATURES = {
	cheek: "#ff9fb0",
	eye: "#2b1e3d",
	lash: "#241a33",
	mouth: "#7a3340",
	shoe: "#5b3b2b",
	thoughtBubble: "#fff8ea",
} as const;

/** The traveler's outfit: a straw hat, a red scarf and a cream cape. */
export const PLAYER_OUTFIT = {
	hair: "#b17a47",
	hat: "#f2d58a",
	hatBand: "#d9483b",
	hatWeave: "#d8b462",
	iris: "#d99a2b",
	cape: "#fff3dc",
	capeHem: "#d9a93e",
	scarf: "#ee3a2f",
	skin: "#f6d2b0",
	tunic: "#fbf5e8",
	tunicTrim: "#d4a640",
} as const;

/** Cloud shading and toon lighting colors (`game3d-sky.tsx`, `game3d-toon.ts`). */
export const TOON_LIGHT = {
	cloudInk: "#9aa2d6",
	cloudUnder: "#b9c3e8",
	ink: "#1e1838",
	rim: "#ffd9a8",
	shadeTint: "#c9d4ff",
} as const;

/**
 * A palette hex at the given alpha, as a CSS color for canvas gradient stops.
 * Accepts `#rrggbb` only.
 */
export function hexAlpha(hex: string, alpha: number): string {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${red},${green},${blue},${alpha})`;
}

/** What villagers hold and wear (`game3d-villager.tsx`). */
export const VILLAGER_GEAR = {
	bristle: "#e2c06a",
	chef: "#fffdf8",
	flowerHeart: "#ffd84d",
	metal: "#a9b4c0",
	pan: "#3c4250",
	paper: "#fff6e0",
	produce: ["#e8453c", "#ff9a2e", "#8fcf4a"],
	straw: "#f2d58a",
	strawBand: "#d9483b",
	tin: "#6fb3c9",
	wicker: "#d8a65a",
	wood: "#a8743f",
} as const;

/**
 * The behaviour layer's colours (game3d-life.tsx): what villagers carry
 * when a game gives no colours of its own, and the effect bursts.
 */
export const LIFE_ART = {
	bag: "#c99a62",
	bagAccent: "#8a5a32",
	basket: "#d8a65a",
	basketAccent: "#e8453c",
	bowl: "#fffaf0",
	bowlAccent: "#ff9a2e",
	box: "#d9a96a",
	boxAccent: "#f5e3b8",
	laptop: "#9aa6b4",
	laptopAccent: "#3c4a5c",
	letter: "#fff6e0",
	letterAccent: "#d9483b",
	plate: "#ffffff",
	plateAccent: "#8fcf4a",
	puff: "#efe3cf",
	smoke: "#7d7a78",
	sparkle: "#fff2a8",
} as const;

/**
 * The second outfit color an agent's accessory wears (a bow, a bandana, a
 * flower): a soft pastel across the color wheel from its shirt.
 */
export function accentFor(swatch: AgentSwatch): string {
	return `hsl(${(swatch.hue + 150) % 360}, 62%, 72%)`;
}

/** Kit props: fences, crates, benches, signs, lamps, ponds (`game3d-props.tsx`). */
export const PROP_ART = {
	bench: "#b5763f",
	crate: "#d09a5e",
	crateBand: "#8f5f38",
	fence: "#fff6e6",
	fenceWood: "#c48d58",
	lampBulb: HOUSE_ART.lampBulb,
	lampGlow: HOUSE_ART.lampBulbGlow,
	lampIron: HOUSE_ART.lampIron,
	lampLight: HOUSE_ART.lampLight,
	lily: "#5aae52",
	lilyFlower: "#ffb3c7",
	pondDay: "#5cc9da",
	pondNight: "#2a4f86",
	reed: "#4f9a46",
	rocks: ["#d6d0da", "#c3bdcc", "#e2dde6"],
	sign: "#e6be86",
	signPost: "#8a5a3a",
	stones: ["#efe2c4", "#e7d8b6", "#f4eacf"],
	stonesNight: ["#a29a95", "#978f8c", "#aaa29c"],
	wood: "#a8743f",
} as const;
