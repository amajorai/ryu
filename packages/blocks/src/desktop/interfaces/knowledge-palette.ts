import { ditherAvatarHue } from "@ryu/ui/components/dither-kit/avatar.tsx";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { resolveCssColor } from "./planets-palette.ts";

/**
 * Knowledge art: the graph's background, node and link colours. This is the
 * one Knowledge file where literal colours live (as fallbacks when the theme
 * cannot be read); everything else is derived from the user's theme tokens.
 * Dark themes get Obsidian's deep graph background, light themes a clean
 * near-white sheet. Agents take the hue of their dither avatar, so a node
 * matches the face shown in the side panel.
 */

export type Rgb = readonly [number, number, number];

export interface KnowledgeTheme {
	background: Rgb | null;
	darkClass: boolean;
	destructive: Rgb | null;
	foreground: Rgb | null;
	mutedForeground: Rgb | null;
	primary: Rgb | null;
	success: Rgb | null;
	warning: Rgb | null;
}

export const EMPTY_KNOWLEDGE_THEME: KnowledgeTheme = {
	background: null,
	darkClass: false,
	destructive: null,
	foreground: null,
	mutedForeground: null,
	primary: null,
	success: null,
	warning: null,
};

export interface KnowledgePalette {
	/** Agent name to node hue (degrees): the avatar's, nudged clear of the reserved hues. */
	agentHues: ReadonlyMap<string, number>;
	/** Canvas clear colour (also painted behind the canvas). */
	background: Rgb;
	/** Opacity of dimmed nodes and links. */
	dimAlpha: number;
	dimLinkAlpha: number;
	/**
	 * Neutral emphasis for rings and lit links (hover, focus, selection). It is
	 * never a status hue, so emphasis cannot read as a conversation state.
	 */
	highlight: Rgb;
	hub: Rgb;
	/** Link colour at rest, and its opacity. */
	link: Rgb;
	linkAlpha: number;
	mode: "dark" | "light";
	/** Neutral node tone (topics, unknown agents). */
	neutral: Rgb;
	/**
	 * Hues (degrees) the agent tints keep clear of: the coloured statuses and
	 * the topic tint, so an agent never reads as a conversation state.
	 */
	reserved: readonly number[];
	status: Record<ThreadStatus, Rgb>;
	topic: Rgb;
}

const FALLBACK = {
	dark: {
		background: [24, 24, 27],
		destructive: [239, 68, 68],
		foreground: [236, 236, 240],
		mutedForeground: [150, 150, 160],
		primary: [0, 153, 255],
		success: [52, 199, 120],
		warning: [234, 179, 8],
	},
	light: {
		background: [255, 255, 255],
		destructive: [220, 38, 38],
		foreground: [24, 24, 27],
		mutedForeground: [113, 113, 122],
		primary: [0, 122, 255],
		success: [22, 163, 74],
		warning: [202, 138, 4],
	},
} as const satisfies Record<"dark" | "light", Record<string, Rgb>>;

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

export function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
	return [
		Math.round(a[0] + (b[0] - a[0]) * amount),
		Math.round(a[1] + (b[1] - a[1]) * amount),
		Math.round(a[2] + (b[2] - a[2]) * amount),
	];
}

function luminance(color: Rgb): number {
	return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
}

export function isDarkTheme(theme: KnowledgeTheme): boolean {
	if (theme.background) {
		return luminance(theme.background) < 0.5;
	}
	return theme.darkClass;
}

/** Hue (degrees) and chroma of a colour, for keeping status hues apart. */
function hueOf(color: Rgb): { chroma: number; hue: number } {
	const [r, g, b] = [color[0] / 255, color[1] / 255, color[2] / 255];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const chroma = max - min;
	if (chroma === 0) {
		return { chroma, hue: 0 };
	}
	let hue = 0;
	if (max === r) {
		hue = ((g - b) / chroma) % 6;
	} else if (max === g) {
		hue = (b - r) / chroma + 2;
	} else {
		hue = (r - g) / chroma + 4;
	}
	return { chroma, hue: (hue * 60 + 360) % 360 };
}

function hueDistance(a: number, b: number): number {
	const difference = Math.abs(a - b) % 360;
	return difference > 180 ? 360 - difference : difference;
}

/** Candidate hues for "your turn", most familiar (blue) first. */
const YOUR_TURN_HUES = [214, 232, 196, 258, 280] as const;
/** Minimum hue separation from the other status and topic colours. */
const MIN_HUE_GAP = 42;

/**
 * "Your turn" gets its own blue, never the theme's primary: a green or red
 * primary would collide with Working or Needs attention. The first candidate
 * hue far enough from every other coloured status (and the topic tint) wins.
 */
export function yourTurnColor(avoid: readonly Rgb[], dark: boolean): Rgb {
	const hues = avoid
		.map(hueOf)
		.filter((entry) => entry.chroma > 0.12)
		.map((entry) => entry.hue);
	const hue =
		YOUR_TURN_HUES.find((candidate) =>
			hues.every((other) => hueDistance(candidate, other) >= MIN_HUE_GAP)
		) ?? YOUR_TURN_HUES[0];
	return dark ? hslToRgb(hue, 0.82, 0.64) : hslToRgb(hue, 0.78, 0.5);
}

/** The graph's colours for a theme (and the workspace's agents). */
export function knowledgePalette(
	theme: KnowledgeTheme,
	agentNames: readonly string[] = []
): KnowledgePalette {
	const dark = isDarkTheme(theme);
	const fallback = dark ? FALLBACK.dark : FALLBACK.light;
	const background = theme.background ?? fallback.background;
	const foreground = theme.foreground ?? fallback.foreground;
	const muted = theme.mutedForeground ?? fallback.mutedForeground;
	const canvas = dark
		? mixRgb(background, BLACK, 0.34)
		: mixRgb(background, WHITE, 0.7);
	const neutral = mixRgb(muted, canvas, dark ? 0.08 : 0.04);
	const attention = theme.destructive ?? fallback.destructive;
	const working = theme.success ?? fallback.success;
	const topic = mixRgb(theme.warning ?? fallback.warning, neutral, 0.35);
	const yourTurn = yourTurnColor([attention, working, topic], dark);
	const reserved = [attention, working, yourTurn, topic]
		.map(hueOf)
		.filter((entry) => entry.chroma > 0.12)
		.map((entry) => entry.hue);
	return {
		agentHues: spreadAgentHues(agentNames, reserved),
		background: canvas,
		dimAlpha: dark ? 0.16 : 0.2,
		dimLinkAlpha: dark ? 0.05 : 0.07,
		highlight: mixRgb(foreground, canvas, dark ? 0.12 : 0.18),
		// Hubs are a strong neutral near the text colour, like Obsidian's
		// plain nodes: they carry weight through size and tone, so agents
		// keep the colour emphasis. Waiting and quiet conversations sit well
		// lighter (dark: dimmer), so a hub never reads as a status.
		hub: mixRgb(foreground, canvas, dark ? 0.16 : 0.22),
		link: mixRgb(foreground, canvas, dark ? 0.55 : 0.6),
		linkAlpha: dark ? 0.5 : 0.6,
		mode: dark ? "dark" : "light",
		neutral,
		reserved,
		status: {
			attention,
			quiet: mixRgb(muted, canvas, dark ? 0.4 : 0.45),
			waiting: mixRgb(muted, canvas, dark ? 0.12 : 0.18),
			working,
			"your-turn": yourTurn,
		},
		topic,
	};
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
	const h = ((hue % 360) + 360) % 360;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = lightness - chroma / 2;
	let triple: [number, number, number] = [chroma, 0, x];
	if (h < 60) {
		triple = [chroma, x, 0];
	} else if (h < 120) {
		triple = [x, chroma, 0];
	} else if (h < 180) {
		triple = [0, chroma, x];
	} else if (h < 240) {
		triple = [0, x, chroma];
	} else if (h < 300) {
		triple = [x, 0, chroma];
	}
	return [
		Math.round((triple[0] + m) * 255),
		Math.round((triple[1] + m) * 255),
		Math.round((triple[2] + m) * 255),
	];
}

/**
 * Agent tints keep at least this far (degrees) from every reserved hue. Agents
 * also differ from conversations by size and their inner cut, so the gap only
 * has to stop a tint passing for a status at a glance.
 */
const AGENT_HUE_GAP = 16;
/** Two agents closer than this (degrees) are nudged apart. */
const AGENT_SEPARATION = 20;

/** Every whole hue at least AGENT_HUE_GAP from each reserved hue. */
function clearHues(reserved: readonly number[]): number[] {
	const hues: number[] = [];
	for (let hue = 0; hue < 360; hue += 1) {
		if (reserved.every((other) => hueDistance(hue, other) >= AGENT_HUE_GAP)) {
			hues.push(hue);
		}
	}
	return hues;
}

/** The clear hue nearest `hue` that also passes `accept`. */
function nearestHue(
	hue: number,
	clear: readonly number[],
	accept: (candidate: number) => boolean = () => true
): number | undefined {
	let best: number | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const candidate of clear) {
		const gap = hueDistance(candidate, hue);
		if (gap < distance && accept(candidate)) {
			distance = gap;
			best = candidate;
		}
	}
	return best;
}

/**
 * Hues for the workspace's agents. Each starts at its dither avatar's hue, so
 * the node matches the face in the side panel, and moves only as far as it
 * must: clear of the status and topic hues, then clear of an agent already
 * placed within AGENT_SEPARATION degrees.
 */
export function spreadAgentHues(
	names: readonly string[],
	reserved: readonly number[]
): Map<string, number> {
	const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
	const clear = clearHues(reserved);
	const result = new Map<string, number>();
	const placed: number[] = [];
	for (const name of unique) {
		const avatar = ditherAvatarHue(name);
		const hue =
			nearestHue(avatar, clear, (candidate) =>
				placed.every(
					(other) => hueDistance(candidate, other) >= AGENT_SEPARATION
				)
			) ??
			nearestHue(avatar, clear) ??
			avatar;
		placed.push(hue);
		result.set(name, hue);
	}
	return result;
}

/** The free hue nearest `hue` (for an agent the palette was not built with). */
function nearestClearHue(hue: number, reserved: readonly number[]): number {
	return nearestHue(hue, clearHues(reserved)) ?? hue;
}

/**
 * An agent's node colour: its avatar's hue (nudged clear of the statuses),
 * close to the avatar's own saturation so the two read as one. Renderers also draw agents with an inner
 * cut, so the shape says "agent" whatever the hue.
 */
export function agentColor(name: string, palette: KnowledgePalette): Rgb {
	const hue =
		palette.agentHues.get(name) ??
		nearestClearHue(ditherAvatarHue(name), palette.reserved);
	return palette.mode === "dark"
		? hslToRgb(hue, 0.68, 0.66)
		: hslToRgb(hue, 0.66, 0.54);
}

/** CSS colour for a palette entry (legend swatches, list dots). */
export function cssColor(color: Rgb, alpha = 1): string {
	return alpha >= 1
		? `rgb(${color[0]} ${color[1]} ${color[2]})`
		: `rgb(${color[0]} ${color[1]} ${color[2]} / ${alpha})`;
}

/** 0..1 channels for shaders. */
export function unitRgb(color: Rgb): [number, number, number] {
	return [color[0] / 255, color[1] / 255, color[2] / 255];
}

/**
 * The theme tokens the graph follows, read at `element`. Tokens can hold any
 * colour syntax (oklch, color-mix...), so each is painted to resolve it.
 */
export function readKnowledgeTheme(element: HTMLElement): KnowledgeTheme {
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
		return { ...EMPTY_KNOWLEDGE_THEME, darkClass };
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
		foreground: read("--foreground"),
		mutedForeground: read("--muted-foreground"),
		primary: read("--primary"),
		success: read("--success"),
		warning: read("--warning"),
	};
}
