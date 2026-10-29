import type { TicketState } from "./kitchen-model.ts";

/**
 * Kitchen art: tiles, counters, steel, flames, food, chefs. This is the one
 * Kitchen file where literal colours live; the HUD and the panel take the
 * theme's semantic tokens instead. Status glows (ready dishes, the cooking
 * ring, burnt smoke embers) come from the theme's success, warning and
 * destructive tokens, the same ones the order rail uses, and never from
 * `primary` (a green primary would collide with ready). Two lighting moods:
 * daytime prep for light themes and evening service for dark ones.
 */

export type Rgb = readonly [number, number, number];

export interface ThemeColors {
	background: Rgb | null;
	/** `.dark` on the document, used when the background cannot be read. */
	darkClass: boolean;
	destructive: Rgb | null;
	success: Rgb | null;
	warning: Rgb | null;
}

export const EMPTY_THEME: ThemeColors = {
	background: null,
	darkClass: false,
	destructive: null,
	success: null,
	warning: null,
};

export interface KitchenPalette {
	ambient: number;
	/** Canvas clear colour: the upper wall, so no gap shows at the edges. */
	background: string;
	counterBody: string;
	counterTop: string;
	flame: string;
	floorA: string;
	floorB: string;
	floorEdge: string;
	food: readonly string[];
	grillTop: string;
	hat: string;
	hemiGround: string;
	hemiIntensity: number;
	hemiSky: string;
	/** Outline ink, rim light and shade tint for the shared cel look. */
	ink: string;
	/** Heat lamps and the evening station lights. */
	lamp: string;
	/** Station light strength (evening only; 0 in daylight). */
	lampIntensity: number;
	lampLight: string;
	mode: "dark" | "light";
	pan: string;
	plate: string;
	rimLight: string;
	shadeTint: string;
	shelf: string;
	skin: readonly string[];
	sky: string;
	smoke: string;
	status: Record<"burnt" | "cooking" | "ready", string>;
	steam: string;
	steel: string;
	sun: number;
	sunColor: string;
	wallA: string;
	wallB: string;
	wood: string;
	woodDark: string;
}

const STATUS_FALLBACK: Record<"burnt" | "cooking" | "ready", Rgb> = {
	burnt: [226, 72, 72],
	cooking: [236, 168, 40],
	ready: [52, 184, 112],
};

/** Below this RGB distance two status colours read as the same colour. */
const DISTINCT = 90;

function distance(a: Rgb, b: Rgb): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The three scene status colours from the theme, each replaced by its
 * fallback when the theme leaves it out or it lands too close to one
 * already taken (ready is placed first, then burnt, then cooking).
 */
export function statusColors(
	theme: ThemeColors
): Record<"burnt" | "cooking" | "ready", Rgb> {
	const taken: Rgb[] = [];
	const pick = (value: Rgb | null, fallback: Rgb): Rgb => {
		const chosen =
			value && taken.every((other) => distance(other, value) >= DISTINCT)
				? value
				: fallback;
		taken.push(chosen);
		return chosen;
	};
	const ready = pick(theme.success, STATUS_FALLBACK.ready);
	const burnt = pick(theme.destructive, STATUS_FALLBACK.burnt);
	const cooking = pick(theme.warning, STATUS_FALLBACK.cooking);
	return { burnt, cooking, ready };
}

export function cssRgb(color: Rgb): string {
	return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function luminance([r, g, b]: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const FOOD = [
	"#f2a03d",
	"#e4573d",
	"#7cbf4f",
	"#f4d35e",
	"#c96d9b",
	"#5aa6d6",
] as const;

const SKIN = ["#f3c9a5", "#e0a77f", "#c58a62", "#9a6646", "#f6d7bd"] as const;

const DAY = {
	ambient: 1.25,
	counterBody: "#f3ebdf",
	counterTop: "#dcae7c",
	floorA: "#f1e8d8",
	floorB: "#d6e6db",
	floorEdge: "#b9a993",
	flame: "#ff8a2a",
	grillTop: "#3b3f46",
	hat: "#ffffff",
	hemiGround: "#b8a58a",
	hemiIntensity: 1.1,
	hemiSky: "#fff8ee",
	ink: "#2b2530",
	lamp: "#ffcf7a",
	lampIntensity: 0,
	lampLight: "#fff4e0",
	pan: "#4a4f58",
	plate: "#fbfaf6",
	rimLight: "#fff1d6",
	shadeTint: "#c8d2f0",
	shelf: "#b98a5a",
	sky: "#bfe3f2",
	smoke: "#4a4448",
	steam: "#ffffff",
	steel: "#b9c1ca",
	sun: 1.6,
	sunColor: "#fff6e8",
	wallA: "#f6efe3",
	wallB: "#9fd3c7",
	wood: "#c98f57",
	woodDark: "#9c6a3f",
} as const;

const EVENING = {
	ambient: 0.65,
	counterBody: "#615868",
	counterTop: "#a5764e",
	floorA: "#7a7067",
	floorB: "#3f5551",
	floorEdge: "#2c2630",
	flame: "#ff7a1f",
	grillTop: "#2a2c31",
	hat: "#f4f1ec",
	hemiGround: "#6b5446",
	hemiIntensity: 1.05,
	hemiSky: "#c3c4e8",
	ink: "#141018",
	lamp: "#ffb85c",
	lampIntensity: 3.2,
	lampLight: "#ffdcb4",
	pan: "#3e424a",
	plate: "#f2efe8",
	rimLight: "#ffc98a",
	shadeTint: "#a9a6d6",
	shelf: "#7a5a3e",
	sky: "#5d7fa8",
	smoke: "#b9b3bd",
	steam: "#e6e2ec",
	steel: "#98a1ad",
	sun: 1.45,
	sunColor: "#e6e2ff",
	wallA: "#4b4352",
	wallB: "#36615c",
	wood: "#a06c44",
	woodDark: "#6a452b",
} as const;

/** The art palette for the current theme. */
export function kitchenPalette(theme: ThemeColors): KitchenPalette {
	const dark = theme.background
		? luminance(theme.background) < 0.35
		: theme.darkClass;
	const base = dark ? EVENING : DAY;
	const status = statusColors(theme);
	return {
		...base,
		// The wall runs past the top of the frame: the clear colour matches it.
		background: base.wallA,
		food: FOOD,
		skin: SKIN,
		mode: dark ? "dark" : "light",
		status: {
			burnt: cssRgb(status.burnt),
			cooking: cssRgb(status.cooking),
			ready: cssRgb(status.ready),
		},
	};
}

/**
 * Chef jackets: eight toon colours far apart in hue and value, each with a
 * darker shade for trousers and the hat band. Picked by id and then
 * de-duplicated across the brigade, so no two chefs on screen match.
 */
export const CHEF_COLORS: readonly { body: string; shade: string }[] = [
	{ body: "#e2524a", shade: "#9c2f2b" },
	{ body: "#3f8fe0", shade: "#25599a" },
	{ body: "#f2b234", shade: "#a8731a" },
	{ body: "#47b26b", shade: "#2b7546" },
	{ body: "#9a6ad8", shade: "#61409a" },
	{ body: "#ef7fae", shade: "#a74c74" },
	{ body: "#2fb5b0", shade: "#1d7672" },
	{ body: "#f07b35", shade: "#a74f1d" },
];

/**
 * A colour slot for every chef: each id's own pick, rotated to the next free
 * slot when an earlier chef already wears it. Stable for a given brigade.
 */
export function brigadeColors(ids: readonly string[]): Map<string, number> {
	const slots = new Map<string, number>();
	const used = new Set<number>();
	for (const id of ids) {
		if (used.size >= CHEF_COLORS.length) {
			used.clear();
		}
		let slot = hashId(id) % CHEF_COLORS.length;
		for (let step = 0; step < CHEF_COLORS.length && used.has(slot); step += 1) {
			slot = (slot + 1) % CHEF_COLORS.length;
		}
		used.add(slot);
		slots.set(id, slot);
	}
	return slots;
}

/** The toque and its outline on the DOM chef avatars. */
export const CHEF_AVATAR_HAT = "#ffffff";
export const CHEF_AVATAR_INK = "#2b2530";

/** A chef's jacket and shade for a colour slot. */
export function chefColors(slot: number): { body: string; shade: string } {
	return (
		CHEF_COLORS[
			((slot % CHEF_COLORS.length) + CHEF_COLORS.length) % CHEF_COLORS.length
		] ?? { body: "#3f8fe0", shade: "#25599a" }
	);
}

/** The status colour a ticket state glows with in the scene. */
export function stateGlow(
	palette: KitchenPalette,
	state: TicketState
): string | null {
	if (state === "ready" || state === "burnt" || state === "cooking") {
		return palette.status[state];
	}
	return null;
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
		success: read("--success"),
		warning: read("--warning"),
	};
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
