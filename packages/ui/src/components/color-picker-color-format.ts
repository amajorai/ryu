import {
	clamp,
	hexToRgb,
	oklchToRgb,
	parseAlpha,
	rgbToHex,
	rgbToOklch,
} from "./color-picker-color-math.ts";
import {
	type ColorFormat,
	type ColorValue,
	type ParsedColor,
	swatchStringSchema,
} from "./color-picker-shared.ts";

function colorToString(color: ColorValue, format: ColorFormat = "hex"): string {
	switch (format) {
		case "hex":
			return rgbToHex(color).toUpperCase();
		case "rgb":
			return color.a < 1
				? `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${roundAlpha(color.a)})`
				: `rgb(${color.r}, ${color.g}, ${color.b})`;
		case "hsl": {
			const hsl = rgbToHsl(color);
			return color.a < 1
				? `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${roundAlpha(color.a)})`
				: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`;
		}
		case "oklch": {
			const oklch = rgbToOklch(color);
			return color.a < 1
				? `oklch(${roundPercent(oklch.l)}% ${roundNumber(oklch.c)} ${roundNumber(oklch.h)} / ${roundAlpha(color.a)})`
				: `oklch(${roundPercent(oklch.l)}% ${roundNumber(oklch.c)} ${roundNumber(oklch.h)})`;
		}
		default:
			return rgbToHex(color);
	}
}

function roundAlpha(value: number): string {
	return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function roundNumber(value: number): string {
	return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function roundPercent(value: number): string {
	return (value * 100).toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
}

function rgbToHsl(color: ColorValue) {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const diff = max - min;
	const sum = max + min;

	const l = sum / 2;

	let h = 0;
	let s = 0;

	if (diff !== 0) {
		s = l > 0.5 ? diff / (2 - sum) : diff / sum;

		if (max === r) {
			h = (g - b) / diff + (g < b ? 6 : 0);
		} else if (max === g) {
			h = (b - r) / diff + 2;
		} else if (max === b) {
			h = (r - g) / diff + 4;
		}
		h /= 6;
	}

	return {
		h: Math.round(h * 360),
		s: Math.round(s * 100),
		l: Math.round(l * 100),
	};
}

function hslToRgb(
	hsl: { h: number; s: number; l: number },
	alpha = 1
): ColorValue {
	const h = (((hsl.h % 360) + 360) % 360) / 360;
	const s = hsl.s / 100;
	const l = hsl.l / 100;

	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
	const m = l - c / 2;

	let r = 0;
	let g = 0;
	let b = 0;

	if (h >= 0 && h < 1 / 6) {
		r = c;
		g = x;
		b = 0;
	} else if (h >= 1 / 6 && h < 2 / 6) {
		r = x;
		g = c;
		b = 0;
	} else if (h >= 2 / 6 && h < 3 / 6) {
		r = 0;
		g = c;
		b = x;
	} else if (h >= 3 / 6 && h < 4 / 6) {
		r = 0;
		g = x;
		b = c;
	} else if (h >= 4 / 6 && h < 5 / 6) {
		r = x;
		g = 0;
		b = c;
	} else if (h >= 5 / 6 && h < 1) {
		r = c;
		g = 0;
		b = x;
	}

	return {
		r: Math.round((r + m) * 255),
		g: Math.round((g + m) * 255),
		b: Math.round((b + m) * 255),
		a: alpha,
	};
}

function functionalColorChannels(
	value: string,
	names: string[]
): string[] | null {
	const opening = value.indexOf("(");
	if (
		!(
			names.includes(value.slice(0, opening).toLowerCase()) &&
			value.endsWith(")")
		)
	) {
		return null;
	}
	const body = value.slice(opening + 1, -1).trim();
	const sections = body.split("/");
	if (sections.length > 2) {
		return null;
	}
	const channels = body.includes(",")
		? body.split(",").map((channel) => channel.trim())
		: (sections[0] ?? "").trim().split(/\s+/);
	if (body.includes(",") && sections.length > 1) {
		return null;
	}
	if (!body.includes(",") && sections.length === 2) {
		channels.push((sections[1] ?? "").trim());
	}
	if (channels.length !== 3 && channels.length !== 4) {
		return null;
	}
	return channels;
}

function validColorNumber(value: string, unit: "" | "%" | "deg" = ""): boolean {
	const numeric =
		unit && value.toLowerCase().endsWith(unit)
			? value.slice(0, -unit.length)
			: value;
	return (
		/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric) &&
		Number.isFinite(Number(numeric))
	);
}

function parseColorString(value: string): ColorValue | null {
	// Collaborative document marks are untrusted. Bound work before trimming or parsing.
	if (value.length > 128) {
		return null;
	}
	const trimmed = value.trim();

	// Parse hex colors
	if (trimmed.startsWith("#")) {
		if (/^#[a-fA-F0-9]{3,4}$/.test(trimmed)) {
			return hexToRgb(trimmed);
		}
		if (/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/.test(trimmed)) {
			return hexToRgb(trimmed);
		}
	}

	// Parse legacy comma-separated and modern space-separated rgb/rgba colors.
	const rgbMatch = functionalColorChannels(trimmed, ["rgb", "rgba"]);
	if (rgbMatch?.every((channel) => validColorNumber(channel, "%"))) {
		return {
			r: channelValue(rgbMatch[0]),
			g: channelValue(rgbMatch[1]),
			b: channelValue(rgbMatch[2]),
			a: parseAlpha(rgbMatch[3]),
		};
	}

	// Parse legacy comma-separated and modern space-separated hsl/hsla colors.
	const hslMatch = functionalColorChannels(trimmed, ["hsl", "hsla"]);
	if (
		hslMatch &&
		validColorNumber(hslMatch[0] ?? "", "deg") &&
		hslMatch
			.slice(1, 3)
			.every(
				(channel) => channel.endsWith("%") && validColorNumber(channel, "%")
			) &&
		(hslMatch[3] === undefined || validColorNumber(hslMatch[3], "%"))
	) {
		return hslToRgb(
			{
				h: Number.parseFloat(hslMatch[0] ?? "0"),
				l: Number.parseFloat(hslMatch[2] ?? "0"),
				s: Number.parseFloat(hslMatch[1] ?? "0"),
			},
			parseAlpha(hslMatch[3])
		);
	}

	// Parse OKLCH colors. Lightness accepts either a percentage or a 0–1 value;
	// alpha accepts either a percentage or a 0–1 value.
	const oklchMatch = functionalColorChannels(trimmed, ["oklch"]);
	if (
		oklchMatch &&
		validColorNumber(oklchMatch[0] ?? "", "%") &&
		validColorNumber(oklchMatch[1] ?? "") &&
		validColorNumber(oklchMatch[2] ?? "", "deg") &&
		(oklchMatch[3] === undefined || validColorNumber(oklchMatch[3], "%"))
	) {
		const lightness = Number.parseFloat(oklchMatch[0] ?? "0");
		return oklchToRgb({
			a: parseAlpha(oklchMatch[3]),
			c: Math.max(0, Number.parseFloat(oklchMatch[1] ?? "0")),
			h: ((Number.parseFloat(oklchMatch[2] ?? "0") % 360) + 360) % 360,
			l: clamp(
				oklchMatch[0]?.endsWith("%") ? lightness / 100 : lightness,
				0,
				1
			),
		});
	}

	return null;
}

function channelValue(value: string | undefined): number {
	const parsed = Number.parseFloat(value ?? "0");
	return clamp(value?.endsWith("%") ? parsed * 2.55 : parsed, 0, 255);
}

function serializeColor(color: ColorValue): string {
	return color.a < 1
		? colorToString(color, "rgb")
		: rgbToHex(color).toUpperCase();
}

function collectColorSwatches(
	values: readonly string[],
	limit: number
): Array<{ color: ColorValue; value: string }> {
	const entries: Array<{ color: ColorValue; value: string }> = [];
	const seen = new Set<string>();
	for (const value of values) {
		const input = swatchStringSchema.safeParse(value);
		if (!input.success) {
			continue;
		}
		const color = parseColorString(input.data);
		if (!color) {
			continue;
		}
		const serialized = serializeColor(color);
		if (seen.has(serialized)) {
			continue;
		}
		seen.add(serialized);
		entries.push({ color, value: serialized });
		if (entries.length === limit) {
			break;
		}
	}
	return entries;
}

function toParsedColor(color: ColorValue): ParsedColor {
	return {
		alpha: color.a,
		hex: rgbToHex(color).toUpperCase(),
		hsl: rgbToHsl(color),
		oklch: rgbToOklch(color),
		rgb: color,
	};
}

export {
	collectColorSwatches,
	colorToString,
	hslToRgb,
	parseColorString,
	rgbToHsl,
	roundAlpha,
	serializeColor,
	toParsedColor,
};
