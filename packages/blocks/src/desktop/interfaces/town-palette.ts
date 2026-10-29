/**
 * Town art: grass, roads, facades, roofs, trees, cars and the data-view
 * ramps. This is the one Town file where literal colours live; the HUD, the
 * petitions desk and the panels take the theme's semantic tokens instead.
 * Status lights in the scene (the failure beacon, the reply bubble dots)
 * come from the theme itself, so the diorama always agrees with the DOM.
 * Two moods: a sunny day for light themes and a town at night, with warm
 * window lights, for dark ones.
 */

export type Rgb = readonly [number, number, number];

export interface ThemeColors {
	background: Rgb | null;
	/** `.dark` on the document, used when the background cannot be read. */
	darkClass: boolean;
	destructive: Rgb | null;
	primary: Rgb | null;
	success: Rgb | null;
}

export const EMPTY_THEME: ThemeColors = {
	background: null,
	darkClass: false,
	destructive: null,
	primary: null,
	success: null,
};

/** A data view: none, recent activity, or how much waits on you. */
export type TownDataView = "activity" | "needs" | "none";

export interface TownPalette {
	ambient: number;
	asphalt: string;
	/** Canvas clear colour: the sea the island sits in, to every edge. */
	background: string;
	bubble: string;
	cars: readonly string[];
	column: string;
	crane: string;
	craneDark: string;
	/** Ground tint per district, chosen by district id. */
	districtTints: readonly string[];
	dome: string;
	earth: string;
	earthDark: string;
	facades: readonly string[];
	grass: string;
	grassDark: string;
	hallRoof: string;
	hallWall: string;
	hemiGround: string;
	hemiIntensity: number;
	hemiSky: string;
	ink: string;
	lamp: string;
	/** Strength of the window glow (bloom); higher at night. */
	lampGlow: number;
	leaves: readonly string[];
	lotPad: string;
	mode: "dark" | "light";
	/** Data-view ramps, low to high. */
	ramps: Record<
		Exclude<TownDataView, "none">,
		readonly [string, string, string]
	>;
	rimLight: string;
	roadLine: string;
	roofs: readonly string[];
	/** The sea around the island (and the canvas clear colour). */
	sea: string;
	shadeTint: string;
	sidewalk: string;
	smoke: string;
	status: Record<"alert" | "reply" | "working", string>;
	sun: number;
	sunColor: string;
	sunDirection: readonly [number, number, number];
	trunk: string;
	water: string;
	/** Unlit window glass by day; lit windows at night. */
	windowLit: string;
	windowOff: string;
	zoneLine: string;
}

const STATUS_FALLBACK: Record<"alert" | "reply" | "working", Rgb> = {
	alert: [226, 72, 72],
	reply: [0, 136, 255],
	working: [52, 184, 112],
};

export function cssRgb(color: Rgb): string {
	return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function luminance([r, g, b]: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const DAY = {
	ambient: 1.05,
	asphalt: "#e6d3ad",
	bubble: "#ffffff",
	cars: ["#e8604c", "#3f88c5", "#f2c14e", "#f7f7f2", "#5fa36a", "#8a6fb3"],
	column: "#f7f2e8",
	crane: "#f2b53a",
	craneDark: "#b9822a",
	districtTints: [
		"#8fd06a",
		"#a6d77a",
		"#9fd394",
		"#88cc7e",
		"#b2d978",
		"#97d38a",
	],
	dome: "#6fa8a0",
	earth: "#a8714a",
	earthDark: "#80563b",
	facades: [
		"#fff4df",
		"#fde6d6",
		"#e9f3e2",
		"#e6eefb",
		"#fbeed0",
		"#fbe3ea",
		"#efe6fb",
		"#fff0d0",
	],
	grass: "#74c254",
	grassDark: "#5fb04c",
	hallRoof: "#5a86c4",
	hallWall: "#fff6e6",
	hemiGround: "#8f86b9",
	hemiIntensity: 1.3,
	hemiSky: "#c4d6ff",
	ink: "#2a2046",
	lamp: "#ffd98a",
	lampGlow: 0.25,
	leaves: ["#58b44a", "#6cc053", "#4aa443", "#7ccb5a"],
	lotPad: "#f1e3c4",
	ramps: {
		activity: ["#d9ecc8", "#f4d35e", "#f08a4b"],
		needs: ["#e3e6ea", "#f2b8a0", "#e2574c"],
	},
	rimLight: "#ffd9a6",
	roadLine: "#f7edd6",
	roofs: ["#c9654f", "#5f8fbf", "#3f9a8a", "#d1a043", "#8f74c4", "#cf6f8f"],
	shadeTint: "#c3ccff",
	sidewalk: "#f1e2c2",
	smoke: "#5d5862",
	sun: 2.1,
	sunColor: "#fff5e3",
	sunDirection: [-0.45, 0.85, 0.35] as const,
	trunk: "#8a5f3d",
	sea: "#3fc4d8",
	water: "#5cc9da",
	windowLit: "#ffd98a",
	windowOff: "#6f8fa8",
	zoneLine: "#c9a97a",
} as const;

const NIGHT = {
	ambient: 0.42,
	asphalt: "#8d8394",
	bubble: "#f1eef6",
	cars: ["#c9584a", "#3c6f9e", "#c9a347", "#c8c6c0", "#4f8259", "#6f5a96"],
	column: "#b9b4c4",
	crane: "#c99a3c",
	craneDark: "#7d5f2a",
	districtTints: [
		"#2f6052",
		"#3a6450",
		"#2c5a58",
		"#35624a",
		"#3d6650",
		"#2f5e55",
	],
	dome: "#4d7a74",
	earth: "#4a3a48",
	earthDark: "#342a38",
	facades: [
		"#b7a58e",
		"#b88f82",
		"#8fa3ab",
		"#b3aa79",
		"#9d93ad",
		"#86a08c",
		"#b292a0",
		"#a89b8a",
	],
	grass: "#2c5c50",
	grassDark: "#24504a",
	hallRoof: "#3c546a",
	hallWall: "#b8b2a8",
	hemiGround: "#4a4566",
	hemiIntensity: 0.95,
	hemiSky: "#8d95c2",
	ink: "#0f0c26",
	lamp: "#ffc46b",
	lampGlow: 0.9,
	leaves: ["#2c6448", "#32704f", "#285c43", "#3a7450"],
	lotPad: "#978f8c",
	ramps: {
		activity: ["#3f5a48", "#c9a347", "#e07a3f"],
		needs: ["#4a4d55", "#a8634f", "#ff5a45"],
	},
	rimLight: "#c9b8ff",
	roadLine: "#bdb8a8",
	roofs: ["#9a4038", "#3f5c7c", "#2f6a5b", "#94642c", "#5a4380", "#7c3848"],
	shadeTint: "#c6c9ea",
	sidewalk: "#a29a95",
	smoke: "#3b3740",
	sun: 1.05,
	sunColor: "#b9c4ff",
	sunDirection: [-0.35, 0.8, -0.45] as const,
	trunk: "#5a3f2a",
	sea: "#1b2d63",
	water: "#2a4f86",
	windowLit: "#ffcf7a",
	windowOff: "#ffcf7a",
	zoneLine: "#8d8775",
} as const;

/** The art palette for the current theme. */
export function townPalette(theme: ThemeColors): TownPalette {
	const dark = theme.background
		? luminance(theme.background) < 0.35
		: theme.darkClass;
	const base = dark ? NIGHT : DAY;
	return {
		...base,
		background: base.sea,
		mode: dark ? "dark" : "light",
		status: {
			alert: cssRgb(theme.destructive ?? STATUS_FALLBACK.alert),
			reply: cssRgb(theme.primary ?? STATUS_FALLBACK.reply),
			working: cssRgb(theme.success ?? STATUS_FALLBACK.working),
		},
	};
}

/** Linear blend of two `#rrggbb` colours. */
export function mixHex(a: string, b: string, amount: number): string {
	const parse = (hex: string) => {
		const value = Number.parseInt(hex.slice(1, 7), 16);
		return [(value >> 16) & 255, (value >> 8) & 255, value & 255] as const;
	};
	const from = parse(a);
	const to = parse(b);
	const t = Math.min(1, Math.max(0, amount));
	const channel = (index: 0 | 1 | 2) =>
		Math.round(from[index] + (to[index] - from[index]) * t)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** A point on a three-stop ramp, 0 to 1. */
export function rampColor(
	ramp: readonly [string, string, string],
	value: number
): string {
	const t = Math.min(1, Math.max(0, value));
	if (t <= 0.5) {
		return mixHex(ramp[0], ramp[1], t * 2);
	}
	return mixHex(ramp[1], ramp[2], (t - 0.5) * 2);
}

/** The ground colour a district shows in the current data view. */
export function districtColor(
	palette: TownPalette,
	dataView: TownDataView,
	district: { activity: number; needs: number; tint: number }
): string {
	if (dataView === "activity") {
		return rampColor(palette.ramps.activity, district.activity);
	}
	if (dataView === "needs") {
		return rampColor(palette.ramps.needs, district.needs);
	}
	return palette.districtTints[district.tint] ?? palette.grass;
}

/** CSS gradient for a data-view legend. */
export function rampGradient(ramp: readonly [string, string, string]): string {
	return `linear-gradient(90deg, ${ramp[0]}, ${ramp[1]}, ${ramp[2]})`;
}

/** A stable small hash of an id (FNV-1a). */
export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** One item of `list` chosen by id, the same every time for that id. */
export function pickById<T>(
	list: readonly T[],
	id: string,
	salt = 0
): T | undefined {
	if (list.length === 0) {
		return undefined;
	}
	return list[(hashId(id) + salt) % list.length];
}

const PROBE_SENTINEL = "rgb(1, 2, 3)";

/**
 * Resolve any CSS colour the browser understands (oklch, color-mix, hex) to
 * sRGB by painting one pixel. Null when it does not parse or there is no 2D
 * canvas (tests, some headless contexts).
 */
function resolveCssColor(
	probe: CanvasRenderingContext2D,
	value: string
): Rgb | null {
	const trimmed = value.trim();
	if (!trimmed) {
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

/** The theme colours the scene follows, from the CSS variables at `element`. */
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
	const context = probe;
	const read = (name: string) => {
		if (!getComputedStyle(element).getPropertyValue(name).trim()) {
			return null;
		}
		const swatch = doc.createElement("span");
		swatch.style.color = `var(${name})`;
		swatch.style.display = "none";
		element.append(swatch);
		const computed = getComputedStyle(swatch).color;
		swatch.remove();
		return resolveCssColor(context, computed);
	};
	return {
		background: read("--background"),
		darkClass,
		destructive: read("--destructive"),
		primary: read("--primary"),
		success: read("--success"),
	};
}
