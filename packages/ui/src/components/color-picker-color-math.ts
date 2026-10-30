import type {
	ColorValue,
	HSVColorValue,
	OklchColorValue,
} from "./color-picker-shared.ts";

const EMPTY_COLOR: ColorValue = { a: 1, b: 0, g: 0, r: 0 };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseAlpha(value: string | undefined): number {
	if (!value) {
		return 1;
	}
	const parsed = value.trim().endsWith("%")
		? Number.parseFloat(value) / 100
		: Number.parseFloat(value);
	return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : 1;
}

function hexToRgb(hex: string, alpha?: number): ColorValue {
	const normalized = hex.trim().replace(/^#/, "");
	const expanded =
		normalized.length === 3 || normalized.length === 4
			? normalized
					.split("")
					.map((channel) => `${channel}${channel}`)
					.join("")
			: normalized;
	const result = /^([a-f\d]{6})([a-f\d]{2})?$/i.exec(expanded);
	return result
		? {
				r: Number.parseInt(result[1]?.slice(0, 2) ?? "0", 16),
				g: Number.parseInt(result[1]?.slice(2, 4) ?? "0", 16),
				b: Number.parseInt(result[1]?.slice(4, 6) ?? "0", 16),
				a: alpha ?? (result[2] ? Number.parseInt(result[2], 16) / 255 : 1),
			}
		: { ...EMPTY_COLOR, a: alpha ?? 1 };
}

function rgbToHex(color: ColorValue): string {
	const toHex = (n: number) => {
		const hex = Math.round(clamp(n, 0, 255)).toString(16);
		return hex.length === 1 ? `0${hex}` : hex;
	};
	return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`.toUpperCase();
}

function srgbToLinear(value: number): number {
	return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
	const sign = value < 0 ? -1 : 1;
	const magnitude = Math.abs(value);
	return (
		sign *
		(magnitude <= 0.003_130_8
			? magnitude * 12.92
			: 1.055 * magnitude ** (1 / 2.4) - 0.055)
	);
}

function rgbToOklch(color: ColorValue): OklchColorValue {
	const r = srgbToLinear(color.r / 255);
	const g = srgbToLinear(color.g / 255);
	const b = srgbToLinear(color.b / 255);

	const l = 0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b;
	const m = 0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b;
	const s = 0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b;
	const lRoot = Math.cbrt(l);
	const mRoot = Math.cbrt(m);
	const sRoot = Math.cbrt(s);
	const lightness =
		0.210_454_255_3 * lRoot + 0.793_617_785 * mRoot - 0.004_072_046_8 * sRoot;
	const a =
		1.977_998_495_1 * lRoot - 2.428_592_205 * mRoot + 0.450_593_709_9 * sRoot;
	const bComponent =
		0.025_904_037_1 * lRoot + 0.782_771_766_2 * mRoot - 0.808_675_766 * sRoot;
	const chroma = Math.hypot(a, bComponent);
	const hue =
		chroma < 0.000_001
			? 0
			: ((Math.atan2(bComponent, a) * 180) / Math.PI + 360) % 360;

	return {
		a: color.a,
		c: chroma,
		h: hue,
		l: clamp(lightness, 0, 1),
	};
}

function oklchToRgb(oklch: OklchColorValue): ColorValue {
	const hue = (oklch.h * Math.PI) / 180;
	const a = oklch.c * Math.cos(hue);
	const b = oklch.c * Math.sin(hue);
	const l = oklch.l + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
	const m = oklch.l - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
	const s = oklch.l - 0.089_484_177_5 * a - 1.291_485_548 * b;
	const lCubed = l ** 3;
	const mCubed = m ** 3;
	const sCubed = s ** 3;

	return {
		a: clamp(oklch.a, 0, 1),
		b:
			clamp(
				linearToSrgb(
					-0.004_196_086_3 * lCubed -
						0.703_418_614_7 * mCubed +
						1.707_614_701 * sCubed
				),
				0,
				1
			) * 255,
		g:
			clamp(
				linearToSrgb(
					-1.268_438_004_6 * lCubed +
						2.609_757_401_1 * mCubed -
						0.341_319_396_5 * sCubed
				),
				0,
				1
			) * 255,
		r:
			clamp(
				linearToSrgb(
					4.076_741_662_1 * lCubed -
						3.307_711_591_3 * mCubed +
						0.230_969_929_2 * sCubed
				),
				0,
				1
			) * 255,
	};
}

function rgbToHsv(color: ColorValue): HSVColorValue {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const diff = max - min;

	let h = 0;
	if (diff !== 0) {
		switch (max) {
			case r:
				h = ((g - b) / diff) % 6;
				break;
			case g:
				h = (b - r) / diff + 2;
				break;
			case b:
				h = (r - g) / diff + 4;
				break;
		}
	}
	h = Math.round(h * 60);
	if (h < 0) {
		h += 360;
	}

	const s = max === 0 ? 0 : diff / max;
	const v = max;

	return {
		h,
		s: Math.round(s * 100),
		v: Math.round(v * 100),
		a: color.a,
	};
}

function hsvToRgb(hsv: HSVColorValue): ColorValue {
	const h = hsv.h / 360;
	const s = hsv.s / 100;
	const v = hsv.v / 100;

	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);

	let r: number;
	let g: number;
	let b: number;

	switch (i % 6) {
		case 0: {
			r = v;
			g = t;
			b = p;
			break;
		}
		case 1: {
			r = q;
			g = v;
			b = p;
			break;
		}
		case 2: {
			r = p;
			g = v;
			b = t;
			break;
		}
		case 3: {
			r = p;
			g = q;
			b = v;
			break;
		}
		case 4: {
			r = t;
			g = p;
			b = v;
			break;
		}
		case 5: {
			r = v;
			g = p;
			b = q;
			break;
		}
		default: {
			r = 0;
			g = 0;
			b = 0;
		}
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
		a: hsv.a,
	};
}

export {
	clamp,
	EMPTY_COLOR,
	hexToRgb,
	hsvToRgb,
	oklchToRgb,
	parseAlpha,
	rgbToHex,
	rgbToHsv,
	rgbToOklch,
};
