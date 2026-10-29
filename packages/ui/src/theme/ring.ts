// Accessible focus-ring colour for user-built themes. Custom themes default the
// ring to `primary`, which fails WCAG 1.4.11 (non-text contrast, 3:1) when the
// user picks a pale primary on a light surface or a dark primary on a dark one.
// `accessibleRingColor` keeps the primary's hue and moves only its OKLCH
// lightness, the minimum amount, until the ring clears 3:1 against every
// surface it is drawn on. Pure: no DOM, no dependencies.

type LinearRgb = [number, number, number];

/** WCAG 1.4.11 minimum contrast for focus indicators and other UI parts. */
export const MIN_RING_CONTRAST = 3;

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE =
	/^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;
const HSL_RE =
	/^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;
const OKLCH_RE =
	/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+(-?[\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/i;

const LIGHTNESS_STEP = 0.002;
const CHROMA_SEARCH_STEPS = 24;
const GAMUT_EPSILON = 1e-4;
/** CSS Color 4: 100% chroma in `oklch()` is 0.4. */
const OKLCH_CHROMA_PERCENT_SCALE = 0.4;

function srgbToLinear(x: number): number {
	return x <= 0.040_45 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(x: number): number {
	return x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

function clamp01(x: number): number {
	return Math.min(1, Math.max(0, x));
}

function oklabToLinear(l: number, a: number, b: number): LinearRgb {
	const lp = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
	const mp = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
	const sp = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
	return [
		4.076_741_662_1 * lp - 3.307_711_591_3 * mp + 0.230_969_929_2 * sp,
		-1.268_438_004_6 * lp + 2.609_757_401_1 * mp - 0.341_319_396_5 * sp,
		-0.004_196_086_3 * lp - 0.703_418_614_7 * mp + 1.707_614_701 * sp,
	];
}

function linearToOklab([r, g, b]: LinearRgb): [number, number, number] {
	const l = Math.cbrt(
		0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b
	);
	const m = Math.cbrt(
		0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b
	);
	const s = Math.cbrt(
		0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b
	);
	return [
		0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
		1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
		0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
	];
}

function parseHex(hex: string): LinearRgb {
	let digits = hex.slice(1);
	if (digits.length <= 4) {
		digits = [...digits].map((d) => d + d).join("");
	}
	return [0, 2, 4].map((i) =>
		srgbToLinear(Number.parseInt(digits.slice(i, i + 2), 16) / 255)
	) as LinearRgb;
}

function hslToLinear(h: number, s: number, l: number): LinearRgb {
	const hue = ((h % 360) + 360) % 360;
	const k = (n: number) => (n + hue / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) =>
		l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
	return [srgbToLinear(f(0)), srgbToLinear(f(8)), srgbToLinear(f(4))];
}

/**
 * Parse a CSS colour as the theme editor and presets emit it (`#rgb[a]`,
 * `#rrggbb[aa]`, `rgb()/rgba()`, `hsl()/hsla()`, `oklch()`) into linear sRGB,
 * clamped to gamut. Alpha is ignored. Returns null for anything else
 * (`var()`, named colours, `color-mix()`).
 */
export function parseColorToLinear(color: string): LinearRgb | null {
	const c = color.trim();
	if (HEX_RE.test(c)) {
		return parseHex(c);
	}
	const rgb = c.match(RGB_RE);
	if (rgb) {
		const channel = (value = "0", percent = "") =>
			srgbToLinear(clamp01(Number(value) / (percent === "%" ? 100 : 255)));
		return [
			channel(rgb[1], rgb[2]),
			channel(rgb[3], rgb[4]),
			channel(rgb[5], rgb[6]),
		];
	}
	const hsl = c.match(HSL_RE);
	if (hsl) {
		return hslToLinear(
			Number(hsl[1]),
			clamp01(Number(hsl[2]) / 100),
			clamp01(Number(hsl[3]) / 100)
		);
	}
	const oklch = c.match(OKLCH_RE);
	if (oklch) {
		const l = Number(oklch[1]) / (oklch[2] === "%" ? 100 : 1);
		const chroma =
			Number(oklch[3]) *
			(oklch[4] === "%" ? OKLCH_CHROMA_PERCENT_SCALE / 100 : 1);
		const hRad = (Number(oklch[5]) * Math.PI) / 180;
		return oklabToLinear(
			l,
			chroma * Math.cos(hRad),
			chroma * Math.sin(hRad)
		).map(clamp01) as LinearRgb;
	}
	return null;
}

function luminance([r, g, b]: LinearRgb): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: LinearRgb, b: LinearRgb): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** WCAG 2.x contrast ratio of two CSS colours, or null if either won't parse. */
export function colorContrastRatio(a: string, b: string): number | null {
	const la = parseColorToLinear(a);
	const lb = parseColorToLinear(b);
	return la && lb ? contrastRatio(la, lb) : null;
}

function toHex(lin: LinearRgb): string {
	return `#${lin
		.map((v) =>
			Math.round(clamp01(linearToSrgb(clamp01(v))) * 255)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

function inGamut(lin: LinearRgb): boolean {
	return lin.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

/** Largest chroma ≤ `chroma` that keeps (l, chroma, hue) inside sRGB. */
function gamutMapped(l: number, chroma: number, hue: number): LinearRgb {
	const at = (c: number) =>
		oklabToLinear(l, c * Math.cos(hue), c * Math.sin(hue));
	const full = at(chroma);
	if (inGamut(full)) {
		return full;
	}
	let lo = 0;
	let hi = chroma;
	for (let i = 0; i < CHROMA_SEARCH_STEPS; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(at(mid))) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return at(lo);
}

function minContrast(color: LinearRgb, surfaces: LinearRgb[]): number {
	let min = Number.POSITIVE_INFINITY;
	for (const surface of surfaces) {
		min = Math.min(min, contrastRatio(color, surface));
	}
	return min;
}

/** Walk lightness in one direction; first sRGB hex that clears every surface. */
function searchLightness(
	start: [number, number, number],
	surfaces: LinearRgb[],
	direction: 1 | -1
): string | null {
	const [l0, a, b] = start;
	const chroma = Math.hypot(a, b);
	const hue = Math.atan2(b, a);
	for (
		let l = l0 + direction * LIGHTNESS_STEP;
		l >= 0 && l <= 1;
		l += direction * LIGHTNESS_STEP
	) {
		const hex = toHex(gamutMapped(l, chroma, hue));
		const rounded = parseColorToLinear(hex);
		if (rounded && minContrast(rounded, surfaces) >= MIN_RING_CONTRAST) {
			return hex;
		}
	}
	return null;
}

/**
 * Focus-ring colour derived from `primary` that reaches 3:1 against every
 * colour in `surfaces` (background, card, popover, sidebar). Returns `primary`
 * unchanged when it already passes or when any colour can't be parsed.
 * Otherwise returns a hex with the same OKLCH hue and the smallest lightness
 * shift (darker in light mode, lighter in dark mode; the other way if that
 * cannot reach 3:1), with chroma reduced only as far as sRGB requires.
 */
export function accessibleRingColor(
	primary: string,
	surfaces: readonly string[],
	mode: "light" | "dark"
): string {
	const primaryLinear = parseColorToLinear(primary);
	const surfaceLinear: LinearRgb[] = [];
	for (const surface of surfaces) {
		const parsed = parseColorToLinear(surface);
		if (!parsed) {
			return primary;
		}
		surfaceLinear.push(parsed);
	}
	if (
		!primaryLinear ||
		surfaceLinear.length === 0 ||
		minContrast(primaryLinear, surfaceLinear) >= MIN_RING_CONTRAST
	) {
		return primary;
	}
	const oklab = linearToOklab(primaryLinear);
	const preferred = mode === "light" ? -1 : 1;
	return (
		searchLightness(oklab, surfaceLinear, preferred) ??
		searchLightness(oklab, surfaceLinear, preferred === -1 ? 1 : -1) ??
		primary
	);
}
