import type { CSSProperties } from "react";
import {
	type CustomTokens,
	findVariant,
	variantToCustomTokens,
} from "@/src/lib/themes/presets.ts";

export const MODES = [
	{
		value: "light",
		label: "Light",
		image: "/assets/images/settings/ui-light.png",
	},
	{
		value: "dark",
		label: "Dark",
		image: "/assets/images/settings/ui-dark.png",
	},
	{
		value: "system",
		label: "System",
		image: "/assets/images/settings/ui-system.png",
	},
] as const;

export const COLOR_FIELDS: Array<{
	key: Exclude<keyof CustomTokens, "ring">;
	label: string;
}> = [
	{ key: "background", label: "Background" },
	{ key: "foreground", label: "Foreground" },
	{ key: "primary", label: "Primary" },
	{ key: "muted", label: "Muted" },
	{ key: "mutedForeground", label: "Muted text" },
	{ key: "border", label: "Border" },
	{ key: "sidebar", label: "Sidebar" },
];

// Quick-pick accent colors for the primary token, per mode. Selecting one sets
// `--primary` through the same token-change flow as the custom picker, so it
// participates in the dirty/save logic. The custom picker is the last option.
export const PRIMARY_PRESETS: Array<{
	name: string;
	label: string;
	light: string;
	dark: string;
}> = [
	{ name: "ryu", label: "Ryu Blue", light: "#0099ff", dark: "#0099ff" },
	{ name: "blue", label: "Blue", light: "#2563eb", dark: "#60a5fa" },
	{ name: "violet", label: "Violet", light: "#7c3aed", dark: "#a78bfa" },
	{ name: "green", label: "Green", light: "#16a34a", dark: "#4ade80" },
	{ name: "orange", label: "Orange", light: "#ea580c", dark: "#fb923c" },
	{ name: "red", label: "Red", light: "#dc2626", dark: "#ef4444" },
	{ name: "rose", label: "Rose", light: "#e11d48", dark: "#fb7185" },
	{ name: "neutral", label: "Neutral", light: "#18181b", dark: "#fafafa" },
];

export const OKLCH_RE = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/;
export const HEX_6_RE = /^#[0-9a-fA-F]{6}$/;
export const HEX_3_RE = /^#[0-9a-fA-F]{3}$/;
export const RGBA_CHANNEL_RE = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;

export function getLuminance(hex: string): number {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function getContrastColor(hex: string): string {
	if (!HEX_6_RE.test(hex)) {
		return "#ffffff";
	}
	return getLuminance(hex) > 0.5 ? "#000000" : "#ffffff";
}

export function channelToHex(v: number): string {
	return Math.round(Math.min(1, Math.max(0, v)) * 255)
		.toString(16)
		.padStart(2, "0");
}

export function linearToSrgb(x: number): number {
	return x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

// Full OKLCH -> sRGB hex conversion (Björn Ottosson's OKLab matrices). Handles
// chromatic colors, not just near-grey, so the settings swatch matches the real
// `--primary` the theme applies. Lightness may be given as a 0-1 number or a %.
export function oklchToHex(lRaw: string, cRaw: string, hRaw: string): string {
	const l = lRaw.endsWith("%") ? Number.parseFloat(lRaw) / 100 : Number(lRaw);
	const c = Number(cRaw);
	const h = Number(hRaw);
	const hRad = (h * Math.PI) / 180;
	const a = c * Math.cos(hRad);
	const b = c * Math.sin(hRad);

	const lp = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
	const mp = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
	const sp = (l - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;

	const r = 4.076_741_662_1 * lp - 3.307_711_591_3 * mp + 0.230_969_929_2 * sp;
	const g = -1.268_438_004_6 * lp + 2.609_757_401_1 * mp - 0.341_319_396_5 * sp;
	const bb = -0.004_196_086_3 * lp - 0.703_418_614_7 * mp + 1.707_614_701 * sp;

	return `#${channelToHex(linearToSrgb(r))}${channelToHex(linearToSrgb(g))}${channelToHex(linearToSrgb(bb))}`;
}

export function colorToHex(color: string): string {
	if (HEX_6_RE.test(color)) {
		return color;
	}
	if (HEX_3_RE.test(color)) {
		const r = color[1];
		const g = color[2];
		const b = color[3];
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	const rgba = color.match(RGBA_CHANNEL_RE);
	if (rgba) {
		const toHex = (n: string) => Number(n).toString(16).padStart(2, "0");
		return `#${toHex(rgba[1])}${toHex(rgba[2])}${toHex(rgba[3])}`;
	}
	const oklchMatch = color.match(OKLCH_RE);
	if (oklchMatch) {
		return oklchToHex(oklchMatch[1], oklchMatch[2], oklchMatch[3]);
	}
	return "#888888";
}

export function tokensAreEqual(a: CustomTokens, b: CustomTokens): boolean {
	for (const field of COLOR_FIELDS) {
		if (a[field.key] !== b[field.key]) {
			return false;
		}
	}
	return true;
}

export function initTokens(variantId: string): CustomTokens {
	const variant = findVariant(variantId);
	if (!variant) {
		return {
			background: "#ffffff",
			foreground: "#000000",
			primary: "#000000",
			muted: "#f4f4f5",
			mutedForeground: "#71717a",
			border: "#e4e4e7",
			sidebar: "#f9f9f9",
		};
	}
	// Keep the preset's raw CSS colour strings (e.g. `oklch(1 0 0 / 10%)` for a
	// dark border). These are what get re-applied live and saved, so they MUST
	// stay lossless — converting to 6-digit hex here dropped the alpha channel
	// and collapsed translucent borders/inputs to solid #ffffff (white outlines
	// + blown-out muted surfaces in dark mode). Hex is a display-only concern,
	// handled in the colour fields via `colorToHex`.
	return variantToCustomTokens(variant);
}

export interface AppearanceTreePreviewStyle extends CSSProperties {
	"--appearance-tree-background"?: string;
	"--appearance-tree-border"?: string;
	"--appearance-tree-foreground"?: string;
	"--appearance-tree-scheme"?: string;
	"--trees-theme-focus-ring"?: string;
	"--trees-theme-git-added-fg"?: string;
	"--trees-theme-git-deleted-fg"?: string;
	"--trees-theme-git-modified-fg"?: string;
	"--trees-theme-input-bg"?: string;
	"--trees-theme-input-border"?: string;
	"--trees-theme-list-active-selection-bg"?: string;
	"--trees-theme-list-active-selection-fg"?: string;
	"--trees-theme-list-hover-bg"?: string;
	"--trees-theme-scrollbar-thumb"?: string;
	"--trees-theme-sidebar-bg"?: string;
	"--trees-theme-sidebar-border"?: string;
	"--trees-theme-sidebar-fg"?: string;
	"--trees-theme-sidebar-header-fg"?: string;
}

export interface AppearancePaintStyle extends CSSProperties {
	"--appearance-fill"?: string;
	"--appearance-font"?: string;
}
