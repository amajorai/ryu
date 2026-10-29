/**
 * Aquarium art: the water, light, reef and creature colors the 3D tank is
 * lit with. Game art is allowed its own palette (this is the one file in the
 * Aquarium where literal colors live); chrome never uses these and takes the
 * theme's semantic tokens instead. Two moods: sunlit turquoise shallows for
 * light themes and a deep-sea night with bioluminescence for dark ones. The
 * water is nudged toward the theme's primary (and, at night, its background)
 * so each theme's tank still feels like it belongs to that theme.
 *
 * Colors here are sRGB bytes. The scene converts them to linear light once
 * (`linear`) and does its lighting and fog in linear space.
 */

export type Rgb = readonly [number, number, number];

export interface CreatureHue {
	/** Markings: bands, spots, shell seams. */
	accent: Rgb;
	belly: Rgb;
	body: Rgb;
	fin: Rgb;
	/** Bioluminescent spots (night) or a soft sheen (day). */
	glow: Rgb;
}

export interface TankPalette {
	/** Ambient light strength (hemisphere light from the water). */
	ambient: number;
	bubble: Rgb;
	/** Caustic light on surfaces facing up. */
	caustic: Rgb;
	causticStrength: number;
	/** Reef coral: four tones (pink, orange, violet, yellow by day). */
	coral: readonly [Rgb, Rgb, Rgb, Rgb];
	/** How much coral tips glow (0 by day). */
	coralGlow: number;
	creatures: readonly CreatureHue[];
	eye: Rgb;
	/** Exponential-squared fog density (higher at night). */
	fogDensity: number;
	/** Glowing plankton and kelp spots at night. */
	glowSpots: readonly [Rgb, Rgb, Rgb];
	grass: readonly [Rgb, Rgb];
	kelp: readonly [Rgb, Rgb];
	/** Kelp tip highlight. */
	kelpTip: Rgb;
	mode: "dark" | "light";
	/** Drifting marine snow. */
	mote: Rgb;
	moteStrength: number;
	pearl: Rgb;
	pearlGlow: Rgb;
	/** God rays from the surface. */
	ray: Rgb;
	rayStrength: number;
	rock: readonly [Rgb, Rgb];
	/** The soft growth tint on the rocks' upper faces. */
	rockGrowth: Rgb;
	sand: readonly [Rgb, Rgb];
	/** Key light (the sun, or the moon at night). */
	sun: Rgb;
	sunStrength: number;
	/** Water from the deep below, to the horizon, to the bright surface. */
	water: { deep: Rgb; mid: Rgb; surface: Rgb };
}

const DAY: TankPalette = {
	ambient: 0.92,
	bubble: [236, 252, 255],
	caustic: [255, 252, 226],
	causticStrength: 1.1,
	coral: [
		[244, 112, 112],
		[252, 160, 76],
		[172, 112, 214],
		[246, 206, 86],
	],
	coralGlow: 0,
	creatures: [
		{
			accent: [255, 255, 255],
			belly: [255, 214, 176],
			body: [255, 116, 60],
			fin: [236, 84, 44],
			glow: [255, 196, 150],
		},
		{
			accent: [40, 48, 90],
			belly: [255, 246, 196],
			body: [255, 206, 48],
			fin: [244, 160, 28],
			glow: [255, 236, 160],
		},
		{
			accent: [255, 214, 72],
			belly: [200, 220, 255],
			body: [58, 102, 230],
			fin: [40, 74, 196],
			glow: [170, 196, 255],
		},
		{
			accent: [255, 255, 255],
			belly: [248, 210, 252],
			body: [188, 92, 214],
			fin: [150, 64, 184],
			glow: [236, 180, 248],
		},
		{
			accent: [34, 92, 60],
			belly: [230, 250, 190],
			body: [130, 200, 64],
			fin: [92, 164, 44],
			glow: [210, 244, 160],
		},
		{
			accent: [255, 255, 255],
			belly: [255, 210, 222],
			body: [240, 84, 132],
			fin: [204, 54, 100],
			glow: [255, 180, 204],
		},
		{
			accent: [255, 230, 120],
			belly: [200, 250, 238],
			body: [28, 178, 164],
			fin: [18, 140, 130],
			glow: [170, 240, 226],
		},
		{
			accent: [70, 52, 40],
			belly: [255, 234, 184],
			body: [226, 164, 92],
			fin: [184, 120, 60],
			glow: [255, 210, 150],
		},
	],
	eye: [16, 22, 34],
	fogDensity: 0.03,
	glowSpots: [
		[180, 255, 240],
		[255, 220, 250],
		[220, 255, 180],
	],
	grass: [
		[62, 138, 82],
		[136, 188, 92],
	],
	kelp: [
		[52, 116, 58],
		[118, 164, 64],
	],
	kelpTip: [196, 214, 112],
	mode: "light",
	mote: [255, 255, 250],
	moteStrength: 0.55,
	pearl: [255, 250, 246],
	pearlGlow: [255, 226, 240],
	ray: [255, 252, 224],
	rayStrength: 0.2,
	rock: [
		[150, 156, 160],
		[88, 104, 120],
	],
	rockGrowth: [120, 168, 120],
	sand: [
		[244, 228, 186],
		[214, 188, 140],
	],
	sun: [255, 250, 232],
	sunStrength: 1.05,
	water: {
		deep: [14, 92, 132],
		mid: [44, 170, 190],
		surface: [196, 248, 240],
	},
};

const NIGHT: TankPalette = {
	ambient: 0.75,
	bubble: [170, 236, 255],
	caustic: [120, 180, 255],
	causticStrength: 0.4,
	coral: [
		[255, 84, 196],
		[60, 236, 222],
		[150, 112, 255],
		[150, 255, 120],
	],
	coralGlow: 1,
	creatures: [
		{
			accent: [220, 255, 255],
			belly: [176, 244, 255],
			body: [56, 196, 244],
			fin: [30, 140, 210],
			glow: [80, 228, 255],
		},
		{
			accent: [255, 220, 250],
			belly: [255, 190, 240],
			body: [228, 80, 210],
			fin: [176, 50, 172],
			glow: [255, 110, 230],
		},
		{
			accent: [240, 255, 210],
			belly: [210, 255, 180],
			body: [124, 230, 100],
			fin: [80, 190, 70],
			glow: [160, 255, 130],
		},
		{
			accent: [236, 226, 255],
			belly: [204, 192, 255],
			body: [138, 112, 248],
			fin: [100, 76, 212],
			glow: [168, 140, 255],
		},
		{
			accent: [255, 246, 214],
			belly: [255, 226, 168],
			body: [255, 176, 64],
			fin: [222, 134, 36],
			glow: [255, 200, 100],
		},
		{
			accent: [255, 230, 236],
			belly: [255, 190, 208],
			body: [255, 100, 142],
			fin: [212, 62, 106],
			glow: [255, 130, 170],
		},
		{
			accent: [220, 255, 244],
			belly: [180, 255, 232],
			body: [48, 228, 184],
			fin: [28, 180, 146],
			glow: [80, 255, 210],
		},
		{
			accent: [236, 244, 255],
			belly: [206, 222, 255],
			body: [136, 176, 255],
			fin: [92, 132, 222],
			glow: [160, 196, 255],
		},
	],
	eye: [6, 10, 22],
	fogDensity: 0.04,
	glowSpots: [
		[90, 255, 220],
		[255, 120, 230],
		[150, 170, 255],
	],
	grass: [
		[22, 74, 78],
		[40, 112, 104],
	],
	kelp: [
		[20, 66, 74],
		[36, 104, 100],
	],
	kelpTip: [56, 140, 128],
	mode: "dark",
	mote: [150, 255, 236],
	moteStrength: 0.9,
	pearl: [250, 248, 255],
	pearlGlow: [190, 220, 255],
	ray: [120, 170, 255],
	rayStrength: 0.12,
	rock: [
		[96, 112, 148],
		[50, 62, 92],
	],
	rockGrowth: [52, 116, 124],
	sand: [
		[84, 98, 128],
		[50, 62, 90],
	],
	sun: [150, 186, 255],
	sunStrength: 0.75,
	water: {
		deep: [3, 10, 30],
		mid: [10, 36, 74],
		surface: [44, 104, 170],
	},
};

const FALLBACK_HUE: CreatureHue = {
	accent: [255, 255, 255],
	belly: [255, 214, 176],
	body: [255, 116, 60],
	fin: [236, 84, 44],
	glow: [255, 196, 150],
};

/** A creature's colors in a palette (palettes always carry eight hues). */
export function creatureHue(palette: TankPalette, index: number): CreatureHue {
	const count = palette.creatures.length;
	return count > 0
		? (palette.creatures[index % count] ?? FALLBACK_HUE)
		: FALLBACK_HUE;
}

export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
	const keep = 1 - amount;
	return [
		Math.round(from[0] * keep + to[0] * amount),
		Math.round(from[1] * keep + to[1] * amount),
		Math.round(from[2] * keep + to[2] * amount),
	];
}

/** A CSS color string for an art color (portraits, glyph fills). */
export function cssColor(color: Rgb, alpha = 1): string {
	const clamped = Math.max(0, Math.min(1, alpha));
	return `rgb(${color[0]} ${color[1]} ${color[2]} / ${clamped})`;
}

function toLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** An art color in linear light, as the scene's shaders take it. */
export function linear(color: Rgb): [number, number, number] {
	return [toLinear(color[0]), toLinear(color[1]), toLinear(color[2])];
}

/** WCAG relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function luminance(color: Rgb): number {
	const [r, g, b] = linear(color);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface ThemeColors {
	background: Rgb | null;
	/** True when the document is in dark mode (`.dark`), used if `background` is unknown. */
	darkClass: boolean;
	primary: Rgb | null;
	ring: Rgb | null;
}

export const EMPTY_THEME: ThemeColors = {
	background: null,
	darkClass: false,
	primary: null,
	ring: null,
};

/**
 * The tank for a theme: night when the theme's background is dark, shallows
 * otherwise. The water picks up a little of the theme's primary (and, at
 * night, its background) so the tank sits inside the theme instead of on it.
 */
export function tankPalette(theme: ThemeColors): TankPalette {
	const dark = theme.background
		? luminance(theme.background) < 0.3
		: theme.darkClass;
	const base = dark ? NIGHT : DAY;
	const { background, primary } = theme;
	const tint = (tone: Rgb, primaryShare: number, backgroundShare: number) => {
		let mixed = tone;
		if (primary) {
			mixed = mixRgb(mixed, primary, primaryShare);
		}
		if (background && dark) {
			mixed = mixRgb(mixed, background, backgroundShare);
		}
		return mixed;
	};
	// Enough of the primary that each theme's water is recognizably its own
	// (a blue theme's shallows run bluer, a green theme's greener), not so
	// much that the sea stops reading as the sea.
	return {
		...base,
		caustic: tint(base.caustic, dark ? 0.18 : 0.1, 0),
		ray: tint(base.ray, dark ? 0.22 : 0.16, 0),
		water: {
			deep: tint(base.water.deep, dark ? 0.12 : 0.2, 0.18),
			mid: tint(base.water.mid, dark ? 0.16 : 0.22, 0.12),
			surface: tint(base.water.surface, dark ? 0.12 : 0.12, 0),
		},
	};
}

const PROBE_SENTINEL = "rgb(1, 2, 3)";

/**
 * Resolve any CSS color the browser understands (oklch, color-mix, hex...) to
 * sRGB by painting one pixel. Returns null when the value does not parse or no
 * 2D canvas is available (tests, headless contexts without one).
 */
export function resolveCssColor(
	probe: CanvasRenderingContext2D | null,
	value: string
): Rgb | null {
	const trimmed = value.trim();
	if (!(probe && trimmed)) {
		return null;
	}
	probe.fillStyle = PROBE_SENTINEL;
	const before = probe.fillStyle;
	probe.fillStyle = trimmed;
	if (probe.fillStyle === before && trimmed !== PROBE_SENTINEL) {
		return null;
	}
	probe.clearRect(0, 0, 1, 1);
	probe.fillRect(0, 0, 1, 1);
	const data = probe.getImageData(0, 0, 1, 1).data;
	const alpha = (data[3] ?? 0) / 255;
	if (alpha === 0) {
		return null;
	}
	return [
		Math.round((data[0] ?? 0) / alpha),
		Math.round((data[1] ?? 0) / alpha),
		Math.round((data[2] ?? 0) / alpha),
	];
}

/**
 * Read the theme colors the tank follows, from the CSS variables in effect at
 * `element`. Theme variables may hold any CSS color syntax, so they go through
 * an element's computed `color` first and then the one-pixel probe.
 */
export function readThemeColors(element: HTMLElement): ThemeColors {
	const doc = element.ownerDocument;
	const darkClass =
		doc.documentElement.classList.contains("dark") ||
		element.closest(".dark") !== null;
	const canvas = doc.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	let probe: CanvasRenderingContext2D | null = null;
	try {
		probe = canvas.getContext("2d", { willReadFrequently: true });
	} catch {
		probe = null;
	}
	if (!probe) {
		return { ...EMPTY_THEME, darkClass };
	}
	const read = (name: string) => {
		const raw = getComputedStyle(element).getPropertyValue(name);
		const direct = resolveCssColor(probe, raw);
		if (direct || !raw.trim()) {
			return direct;
		}
		// Not canvas syntax (color-mix, relative colors): let CSS compute it.
		const swatch = doc.createElement("span");
		swatch.style.color = `var(${name})`;
		swatch.style.display = "none";
		element.append(swatch);
		const computed = getComputedStyle(swatch).color;
		swatch.remove();
		return resolveCssColor(probe, computed);
	};
	return {
		background: read("--background"),
		darkClass,
		primary: read("--primary"),
		ring: read("--ring"),
	};
}

/** An art color as a hex string, for kit meshes (`ToonMesh` and friends). */
export function hexColor(color: Rgb): string {
	const byte = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}`;
}

/**
 * The glass tank's fittings and the room it stands in: its frame, the
 * cabinet under it, the glints, and the room's floor, rug, walls and
 * window.
 */
export interface TankFittings {
	/** The wooden cabinet the tank stands on, its doors and their knobs. */
	cabinet: string;
	cabinetDoor: string;
	cabinetKnob: string;
	cabinetTop: string;
	/** The room's wooden floor and the seams between its boards. */
	floor: string;
	floorSeam: string;
	/** The frame posts and rims (painted wood by day, brass under lamps). */
	frame: string;
	frameTrim: string;
	/** Lines of light on the glass and the water's surface. */
	glint: string;
	/** A potted plant in the room's corner. */
	leaf: string;
	pot: string;
	/** Light on the waves at the surface. */
	ripple: string;
	/** The rug under the cabinet and its border. */
	rug: string;
	rugEdge: string;
	/** Soft shadows the creatures cast on the sand. */
	shadow: string;
	/** Starfish and shells on the sand. */
	shells: readonly [string, string, string];
	/**
	 * The room's walls and their skirting boards; the side wall, turned from
	 * the light, is drawn flat in its own shade.
	 */
	wall: string;
	wallSide: string;
	wallTrim: string;
	/** The window on the back wall: its frame and the sky through it. */
	window: string;
	windowFrame: string;
}

/** The room's wallpaper choices (the aquarium's `wallpaper` setting). */
export type AquariumWallpaper = "blue" | "cream" | "sage";

/** Each wallpaper's wall, side-wall and skirting colours, by theme. */
export const WALLPAPERS: Record<
	AquariumWallpaper,
	Record<"dark" | "light", Pick<TankFittings, "wall" | "wallSide" | "wallTrim">>
> = {
	blue: {
		dark: { wall: "#1d2a44", wallSide: "#17223a", wallTrim: "#2a3a5c" },
		light: { wall: "#d6e6f2", wallSide: "#c4d7e6", wallTrim: "#aac3d6" },
	},
	cream: {
		dark: { wall: "#232a40", wallSide: "#1c2236", wallTrim: "#2f3752" },
		light: { wall: "#f2e6d4", wallSide: "#e4d3bb", wallTrim: "#dcc8ad" },
	},
	sage: {
		dark: { wall: "#202e2a", wallSide: "#1a2622", wallTrim: "#2c3e38" },
		light: { wall: "#dfe8d4", wallSide: "#cfdcc1", wallTrim: "#b6c8a4" },
	},
};

export const TANK_FITTINGS: Record<"dark" | "light", TankFittings> = {
	dark: {
		cabinet: "#3b2e3a",
		cabinetDoor: "#4a3a48",
		cabinetKnob: "#e2b866",
		cabinetTop: "#56445a",
		floor: "#2c2433",
		floorSeam: "#211a27",
		frame: "#3a4a6a",
		frameTrim: "#e2b866",
		glint: "#9fe8ff",
		leaf: "#2f6a5a",
		pot: "#6a4a5a",
		ripple: "#7fd8ff",
		rug: "#2a3550",
		rugEdge: "#3b4a6e",
		shadow: "#020814",
		shells: ["#ff8fa8", "#ffc86e", "#b7a6ff"],
		wall: "#232a40",
		wallSide: "#1c2236",
		wallTrim: "#2f3752",
		window: "#101a38",
		windowFrame: "#3b4566",
	},
	light: {
		cabinet: "#a8754e",
		cabinetDoor: "#b8865d",
		cabinetKnob: "#f3d88a",
		cabinetTop: "#c6956a",
		floor: "#d9b98f",
		floorSeam: "#c4a27a",
		frame: "#4f86a8",
		frameTrim: "#f3d88a",
		glint: "#ffffff",
		leaf: "#5aa86a",
		pot: "#d47a5a",
		ripple: "#ffffff",
		rug: "#7fb7c9",
		rugEdge: "#5f9db2",
		shadow: "#1d4a5a",
		shells: ["#ff8a7a", "#ffb84d", "#f6e7c8"],
		wall: "#f2e6d4",
		wallSide: "#e4d3bb",
		wallTrim: "#dcc8ad",
		window: "#bfe6f7",
		windowFrame: "#ffffff",
	},
};

/** The tank's fittings in a theme, with the room papered in `wallpaper`. */
export function roomFittings(
	mode: "dark" | "light",
	wallpaper: AquariumWallpaper = "cream"
): TankFittings {
	return { ...TANK_FITTINGS[mode], ...WALLPAPERS[wallpaper][mode] };
}
