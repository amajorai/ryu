import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { agentSwatches, swatchOf } from "./game3d-palette.ts";
import type { PlanetKind } from "./planets-model.ts";

/**
 * Planets art: the sky, the star, planet surfaces, team tints and the
 * fallbacks for moon glows. This is the one Planets file where literal colors
 * live; the HUD and the panel never use them and take the theme's semantic
 * tokens instead. Moon glows come from the theme itself (destructive, primary,
 * success); when the accent is the same color as "working" (a green theme),
 * "your turn" takes a clear hue instead, and the HUD follows it through
 * `--planets-turn`, so a moon always matches the legend's status dot. Two
 * moods: deep space for dark themes and a pale, airy day-side sky for light
 * ones.
 */

export type Rgb = readonly [number, number, number];

export interface PlanetLook {
	/** Primary surface tone (ocean water, gas band, bare rock). */
	a: Rgb;
	/** Atmosphere rim. */
	atmosphere: Rgb;
	/** Secondary tone (land, second band, highlands). */
	b: Rgb;
	/** Detail tone (clouds, storms, cracks, craters). */
	c: Rgb;
	/** Ring tone, for ringed planets. */
	ring: Rgb;
}

const look = (a: Rgb, b: Rgb, c: Rgb, atmosphere: Rgb, ring?: Rgb) => ({
	a,
	atmosphere,
	b,
	c,
	ring: ring ?? b,
});

export const PLANET_LOOKS: Record<PlanetKind, readonly PlanetLook[]> = {
	gas: [
		look([226, 184, 132], [176, 112, 72], [250, 232, 204], [255, 214, 168]),
		look([156, 128, 220], [100, 78, 172], [222, 206, 252], [196, 170, 255]),
		look([104, 186, 178], [52, 124, 140], [204, 240, 230], [160, 244, 226]),
	],
	ice: [
		look([214, 236, 250], [152, 198, 232], [88, 138, 196], [196, 232, 255]),
		look([214, 246, 238], [150, 214, 204], [86, 156, 168], [180, 255, 236]),
		look([230, 224, 250], [180, 170, 232], [116, 104, 182], [214, 204, 255]),
	],
	ocean: [
		look([38, 104, 190], [96, 168, 98], [246, 250, 255], [130, 196, 255]),
		look([28, 128, 158], [204, 178, 114], [244, 250, 252], [140, 232, 244]),
		look([58, 76, 170], [132, 182, 96], [240, 244, 255], [160, 170, 255]),
	],
	ringed: [
		look(
			[232, 206, 156],
			[198, 160, 108],
			[248, 236, 210],
			[255, 226, 176],
			[226, 202, 156]
		),
		look(
			[230, 166, 166],
			[188, 118, 132],
			[252, 224, 218],
			[255, 196, 200],
			[240, 196, 188]
		),
		look(
			[166, 210, 190],
			[112, 168, 150],
			[230, 248, 240],
			[190, 255, 230],
			[200, 230, 218]
		),
	],
	rocky: [
		look([184, 98, 66], [222, 148, 102], [116, 60, 44], [255, 176, 128]),
		look([136, 126, 150], [184, 176, 196], [84, 76, 104], [206, 196, 255]),
		look([158, 136, 80], [204, 180, 116], [102, 84, 52], [244, 224, 156]),
	],
};

const FALLBACK_LOOK = look(
	[150, 140, 160],
	[190, 180, 200],
	[90, 84, 110],
	[210, 200, 255]
);
const FALLBACK_TEAM: Rgb = [255, 184, 84];

/** Orbit tints for teams, in order of the team groups. */
const TEAM_COLORS: readonly Rgb[] = [
	[255, 184, 84],
	[96, 214, 196],
	[240, 128, 200],
	[150, 166, 255],
];
/** The same tints, deeper, so they hold up on a pale sky and white glass. */
const TEAM_COLORS_LIGHT: readonly Rgb[] = [
	[214, 120, 12],
	[14, 150, 128],
	[204, 60, 150],
	[80, 96, 226],
];

/** Hues tried for "your turn" when the theme's accent is too close to "working". */
const TURN_HUES = [212, 262, 192, 296, 40] as const;
/** Below this hue gap (degrees), two status glows read as one color. */
const MIN_STATUS_HUE_GAP = 40;

/** Moon glows when the theme's tokens cannot be read (tests, headless). */
const STATUS_FALLBACK: Record<ThreadStatus, Rgb> = {
	attention: [232, 72, 72],
	quiet: [126, 132, 146],
	waiting: [170, 180, 200],
	working: [64, 196, 120],
	"your-turn": [0, 153, 255],
};

export interface SkyPalette {
	/** CSS background for the layer behind the canvas. */
	background: string;
	/** Faint colour of the plane's dust disc around the star. */
	disc: Rgb;
	/** Orbit line colour and opacity. */
	orbit: Rgb;
	orbitOpacity: number;
	starOpacity: number;
	stars: readonly [Rgb, Rgb];
}

export interface SunPalette {
	core: Rgb;
	/** Corona and halo size: wider by day, where a glow reads less. */
	coronaScale: number;
	edge: Rgb;
	glow: Rgb;
	/** Corona strength. */
	glowStrength: number;
	/** Strength of the wide outer halo (the bloom). */
	haloStrength: number;
	mid: Rgb;
}

export interface PlanetsPalette {
	/** Additive glows read in deep space; a pale sky needs normal blending. */
	additive: boolean;
	/** Atmosphere halos: full in deep space, softer against a pale sky. */
	glowScale: number;
	mode: "dark" | "light";
	/**
	 * Moon status glows: a pale sky washes a soft halo out, so moons that
	 * need you keep a stronger one by day than planets' atmospheres do.
	 */
	moonGlowScale: number;
	/** Brightness of a planet's night side (a day-side look in light themes). */
	night: number;
	/** Selection and focus ring, from the theme's `--ring`. */
	ring: Rgb;
	sky: SkyPalette;
	status: Record<ThreadStatus, Rgb>;
	sun: SunPalette;
	teams: readonly Rgb[];
}

export interface ThemeColors {
	background: Rgb | null;
	/** `.dark` on the document, used when the background cannot be read. */
	darkClass: boolean;
	destructive: Rgb | null;
	primary: Rgb | null;
	ring: Rgb | null;
	success: Rgb | null;
}

export const EMPTY_THEME: ThemeColors = {
	background: null,
	darkClass: false,
	destructive: null,
	primary: null,
	ring: null,
	success: null,
};

export function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
	const keep = 1 - amount;
	return [
		Math.round(from[0] * keep + to[0] * amount),
		Math.round(from[1] * keep + to[1] * amount),
		Math.round(from[2] * keep + to[2] * amount),
	];
}

/** A CSS color for an art color at an opacity. */
export function cssColor(color: Rgb, alpha = 1): string {
	const clamped = Math.max(0, Math.min(1, alpha));
	return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${clamped})`;
}

/** 0..1 channels for shader uniforms (sRGB, written straight to the screen). */
export function unitRgb(color: Rgb): [number, number, number] {
	return [color[0] / 255, color[1] / 255, color[2] / 255];
}

export interface Hsl {
	/** 0..360 */
	h: number;
	/** 0..1 */
	l: number;
	/** 0..1 */
	s: number;
}

export function rgbToHsl(color: Rgb): Hsl {
	const r = color[0] / 255;
	const g = color[1] / 255;
	const b = color[2] / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) {
		return { h: 0, l, s: 0 };
	}
	const s = d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return { h: (h * 60 + 360) % 360, l, s };
}

export function hslToRgb({ h, l, s }: Hsl): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const sector = Math.floor((((h % 360) + 360) % 360) / 60);
	const table: readonly (readonly [number, number, number])[] = [
		[c, x, 0],
		[x, c, 0],
		[0, c, x],
		[0, x, c],
		[x, 0, c],
		[c, 0, x],
	];
	const [r, g, b] = table[sector] ?? [c, x, 0];
	return [
		Math.round((r + m) * 255),
		Math.round((g + m) * 255),
		Math.round((b + m) * 255),
	];
}

/** Shortest distance between two hues, degrees (0..180). */
export function hueGap(a: number, b: number): number {
	const gap = Math.abs(a - b) % 360;
	return gap > 180 ? 360 - gap : gap;
}

/**
 * Whether two status colors would read as the same: both colorful with
 * nearly the same hue, or both grey.
 */
export function statusColorsClash(a: Rgb, b: Rgb): boolean {
	const first = rgbToHsl(a);
	const second = rgbToHsl(b);
	const greyA = first.s < 0.22;
	const greyB = second.s < 0.22;
	if (greyA || greyB) {
		return greyA === greyB;
	}
	return hueGap(first.h, second.h) < MIN_STATUS_HUE_GAP;
}

/**
 * "Your turn" glows in the theme's accent, unless that accent is the same
 * color as "working" (a green theme) or is grey: then it takes a hue clear
 * of both "working" and "needs attention", keeping the accent's weight.
 */
export function yourTurnColor(
	primary: Rgb,
	working: Rgb,
	attention: Rgb,
	dark: boolean
): Rgb {
	const accent = rgbToHsl(primary);
	if (accent.s >= 0.22 && !statusColorsClash(primary, working)) {
		return primary;
	}
	const avoid = [rgbToHsl(working).h, rgbToHsl(attention).h];
	let bestHue: number = TURN_HUES[0];
	let bestGap = -1;
	for (const hue of TURN_HUES) {
		const gap = Math.min(...avoid.map((other) => hueGap(hue, other)));
		if (gap > bestGap + 20) {
			bestGap = gap;
			bestHue = hue;
		}
	}
	const lightness = dark
		? Math.min(0.68, Math.max(0.56, accent.l))
		: Math.min(0.48, Math.max(0.4, accent.l));
	return hslToRgb({ h: bestHue, l: lightness, s: Math.max(0.72, accent.s) });
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: Rgb): number {
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return (
		0.2126 * channel(color[0]) +
		0.7152 * channel(color[1]) +
		0.0722 * channel(color[2])
	);
}

export function planetLook(kind: PlanetKind, variant: number): PlanetLook {
	const looks = PLANET_LOOKS[kind];
	return looks[variant % looks.length] ?? FALLBACK_LOOK;
}

export function teamColor(palette: PlanetsPalette, colorIndex: number): Rgb {
	return palette.teams[colorIndex % palette.teams.length] ?? FALLBACK_TEAM;
}

/**
 * CSS variables the HUD and panel read for the palette's "your turn" color
 * (`text-(--planets-turn)`), so chrome and moons always agree.
 */
export function paletteVars(palette: PlanetsPalette): Record<string, string> {
	return { "--planets-turn": cssColor(palette.status["your-turn"]) };
}

/** A small lit sphere for a planet, as a CSS background (HUD and panel). */
export function planetSwatch(lookOf: PlanetLook): string {
	const light = mixRgb(lookOf.c, lookOf.a, 0.35);
	const shade = mixRgb(lookOf.b, [8, 10, 24], 0.55);
	return `radial-gradient(circle at 32% 30%, ${cssColor(light)} 0%, ${cssColor(lookOf.a)} 38%, ${cssColor(lookOf.b)} 66%, ${cssColor(shade)} 100%)`;
}

/** The star as a CSS swatch. */
export function sunSwatch(sun: SunPalette): string {
	return `radial-gradient(circle at 40% 38%, ${cssColor(sun.core)} 0%, ${cssColor(sun.mid)} 45%, ${cssColor(sun.edge)} 100%)`;
}

/** Soft halo shadow for the star swatch. */
export function sunShadow(sun: SunPalette): string {
	return `0 0 14px 2px ${cssColor(sun.glow, 0.55)}`;
}

/** A wider, softer halo for the large star swatch (the loading placeholder). */
export function sunBloom(sun: SunPalette): string {
	return `0 0 24px 6px ${cssColor(sun.glow, 0.6)}, 0 0 72px 24px ${cssColor(sun.glow, 0.28)}`;
}

function darkSky(theme: ThemeColors): SkyPalette {
	const tint = theme.primary ?? [96, 120, 220];
	const base = theme.background ?? [8, 10, 22];
	const top = mixRgb([4, 6, 16], base, 0.25);
	const bottom = mixRgb([12, 12, 30], base, 0.3);
	const nebulaA = mixRgb([94, 58, 168], tint, 0.35);
	const nebulaB = mixRgb([24, 104, 148], tint, 0.2);
	const nebulaC = mixRgb([168, 64, 118], tint, 0.15);
	return {
		background: [
			`radial-gradient(ellipse 55% 45% at 18% 22%, ${cssColor(nebulaA, 0.32)}, transparent 70%)`,
			`radial-gradient(ellipse 50% 40% at 84% 78%, ${cssColor(nebulaB, 0.3)}, transparent 72%)`,
			`radial-gradient(ellipse 35% 30% at 72% 18%, ${cssColor(nebulaC, 0.18)}, transparent 70%)`,
			`radial-gradient(ellipse 70% 60% at 50% 55%, ${cssColor(mixRgb(bottom, nebulaA, 0.2), 0.6)}, transparent 80%)`,
			`linear-gradient(180deg, ${cssColor(top)} 0%, ${cssColor(bottom)} 100%)`,
		].join(", "),
		disc: mixRgb([255, 200, 140], tint, 0.25),
		// Cool and neutral, so warm team tints stand apart from plain orbits.
		orbit: mixRgb([168, 186, 226], tint, 0.06),
		orbitOpacity: 0.17,
		stars: [
			[236, 240, 255],
			[255, 226, 196],
		],
		starOpacity: 0.95,
	};
}

/**
 * Light themes look into space too, at dusk rather than at midnight: a deep
 * blue that lifts toward the horizon, brighter nebulae, and white stars, so
 * the day-lit planets read against it instead of floating on a blank page.
 */
function lightSky(theme: ThemeColors): SkyPalette {
	const tint = theme.primary ?? [0, 153, 255];
	const top = mixRgb([14, 22, 56], tint, 0.12);
	const bottom = mixRgb([40, 56, 112], tint, 0.14);
	const nebulaA = mixRgb([120, 86, 210], tint, 0.3);
	const nebulaB = mixRgb([40, 150, 200], tint, 0.2);
	const nebulaC = mixRgb([220, 96, 150], tint, 0.12);
	return {
		background: [
			`radial-gradient(ellipse 60% 50% at 50% 54%, ${cssColor([255, 196, 140], 0.22)}, transparent 70%)`,
			`radial-gradient(ellipse 55% 45% at 16% 22%, ${cssColor(nebulaA, 0.45)}, transparent 70%)`,
			`radial-gradient(ellipse 50% 42% at 86% 80%, ${cssColor(nebulaB, 0.4)}, transparent 72%)`,
			`radial-gradient(ellipse 36% 30% at 74% 16%, ${cssColor(nebulaC, 0.26)}, transparent 70%)`,
			`linear-gradient(180deg, ${cssColor(top)} 0%, ${cssColor(bottom)} 100%)`,
		].join(", "),
		disc: [255, 196, 132],
		orbit: mixRgb([186, 204, 240], tint, 0.08),
		orbitOpacity: 0.3,
		stars: [
			[255, 255, 255],
			[200, 220, 255],
		],
		starOpacity: 0.9,
	};
}

/** The art palette for the current theme. */
export function planetsPalette(theme: ThemeColors): PlanetsPalette {
	const dark = theme.background
		? luminance(theme.background) < 0.3
		: theme.darkClass;
	const attention = theme.destructive ?? STATUS_FALLBACK.attention;
	const working = theme.success ?? STATUS_FALLBACK.working;
	const status: Record<ThreadStatus, Rgb> = {
		...STATUS_FALLBACK,
		attention,
		working,
		"your-turn": yourTurnColor(
			theme.primary ?? STATUS_FALLBACK["your-turn"],
			working,
			attention,
			dark
		),
	};
	if (!dark) {
		status.quiet = [140, 148, 166];
		status.waiting = [182, 192, 212];
	}
	return {
		additive: dark,
		mode: dark ? "dark" : "light",
		glowScale: dark ? 1 : 0.55,
		moonGlowScale: dark ? 1 : 0.9,
		night: dark ? 0.3 : 0.62,
		ring: theme.ring ?? theme.primary ?? [0, 153, 255],
		sky: dark ? darkSky(theme) : lightSky(theme),
		status,
		sun: {
			core: [255, 252, 238],
			coronaScale: dark ? 1 : 1.55,
			edge: [255, 136, 56],
			glow: dark ? [255, 168, 76] : [255, 160, 64],
			glowStrength: dark ? 1 : 1.05,
			haloStrength: dark ? 1 : 1.6,
			mid: [255, 204, 104],
		},
		teams: dark ? TEAM_COLORS : TEAM_COLORS_LIGHT,
	};
}

const PROBE_SENTINEL = "rgb(1, 2, 3)";

/**
 * Resolve any CSS color the browser understands (oklch, color-mix, hex...)
 * to sRGB by painting one pixel. Null when it does not parse or there is no
 * 2D canvas (tests, some headless contexts).
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
 * The theme colors the scene follows, from the CSS variables in effect at
 * `element`. Variables can hold any color syntax, so each goes through an
 * element's computed `color` when the canvas cannot parse it directly.
 */
export function readThemeColors(element: HTMLElement): ThemeColors {
	const doc = element.ownerDocument;
	const darkClass =
		doc.documentElement.classList.contains("dark") ||
		element.closest(".dark") !== null;
	let probe: CanvasRenderingContext2D | null = null;
	try {
		const canvas = doc.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
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
		destructive: read("--destructive"),
		primary: read("--primary"),
		ring: read("--ring"),
		success: read("--success"),
	};
}

/** The hue, saturation and lightness (percent) of an agent's kit swatch. */
export interface AgentHue {
	hue: number;
	lightness: number;
	saturation: number;
}

/**
 * A planet painted in its agent's colour (the hue its villager wears in
 * every game): the agent colour, a lighter band, a deeper band, and a rim
 * and ring in the same family.
 */
export function agentPlanetLook(agent: AgentHue): PlanetLook {
	const s = Math.min(0.62, (agent.saturation + 10) / 100);
	const l = Math.min(0.62, Math.max(0.42, (agent.lightness + 6) / 100));
	const tone = (lightness: number, saturation = s) =>
		hslToRgb({ h: agent.hue, l: lightness, s: saturation });
	return {
		a: tone(l),
		atmosphere: tone(0.78, 0.7),
		b: tone(Math.min(0.82, l + 0.16)),
		c: tone(Math.max(0.26, l - 0.14), Math.min(0.7, s + 0.06)),
		ring: tone(0.8, 0.4),
	};
}

/** The little world on top of each planet, and the friendly star's face. */
export interface PlanetWorldArt {
	/** The grassy cap a planet's cottage, trees and villager stand on. */
	cap: string;
	capEdge: string;
	/** The star's face: eyes, cheeks and smile. */
	cheek: string;
	eye: string;
	/** The star's petal rays. */
	ray: string;
	rayTip: string;
}

export const PLANET_WORLD_ART: Record<"dark" | "light", PlanetWorldArt> = {
	dark: {
		cap: "#4f9a5c",
		capEdge: "#3c7d4c",
		cheek: "#ff8f6e",
		eye: "#3a2418",
		ray: "#ffcf4a",
		rayTip: "#ffe9a0",
	},
	light: {
		cap: "#78c46a",
		capEdge: "#5aa356",
		cheek: "#ff8a6a",
		eye: "#3a2418",
		ray: "#ffc93c",
		rayTip: "#fff0b0",
	},
};

/**
 * Every planet's look in its agent's colour. Swatches are dealt in roster
 * order (each agent gets its own until all are taken), so pass every
 * planet's id, in the system's order, wherever a planet is drawn.
 */
export function planetLooks(
	planetIds: readonly string[]
): ReadonlyMap<string, PlanetLook> {
	const swatches = agentSwatches(planetIds);
	const looks = new Map<string, PlanetLook>();
	for (const id of planetIds) {
		looks.set(id, agentPlanetLook(swatchOf(swatches, id)));
	}
	return looks;
}

let lastLooks: { key: string; looks: ReadonlyMap<string, PlanetLook> } | null =
	null;

/** One planet's look in its agent's colour, within its system. */
export function planetLookIn(
	system: { planets: readonly { id: string }[] },
	planetId: string
): PlanetLook | undefined {
	const ids = system.planets.map((planet) => planet.id);
	const key = ids.join("\n");
	if (lastLooks?.key !== key) {
		lastLooks = { key, looks: planetLooks(ids) };
	}
	return lastLooks.looks.get(planetId);
}

/**
 * Planets' act-layer colours: the space station in the foreground (hull,
 * berth lights and the ring light that drains while a probe waits), the
 * probes by ask kind, the cargo capsule of a ready answer, the red storm
 * band of a failed run, the dark moon of an interrupted one, the eclipse
 * of a limit, the satellite of a working world and the progress pips
 * round its focus moon. The one Planets file where these colours live.
 */
export const PLANETS_ACT = {
	berth: "#3b4256",
	capsule: "#f2b84b",
	capsuleBand: "#7a4f12",
	darkMoon: "#2a2833",
	eclipse: "#0b0a12",
	hull: "#c9d0de",
	hullDark: "#6c7489",
	pipDone: "#7ce0a3",
	pipTodo: "#59607a",
	probe: {
		approval: "#ffd257",
		input: "#d6c9ff",
		permission: "#ff9f6b",
		question: "#7fe3e0",
		reply: "#7ce0a3",
	},
	ringLight: "#ffd257",
	ringLow: "#ff8a3d",
	satellite: "#e8ecf5",
	satellitePanel: "#4f7cff",
	storm: "#ff3b2f",
} as const;
