// Single source of truth for the TUI's visual themes.
//
// termcn components read their colors from the vendored ThemeProvider via
// useTheme() (theme.colors.primary, theme.colors.border, ...). The catalog below
// keeps terminal-safe semantic color definitions in one place; consumers should
// read the resulting Theme through useTheme() rather than carrying their own
// palette. The existing ryuTheme export remains the default dark theme used by
// the current App integration.

import { createTheme, type Theme } from "@/components/ui/theme-provider.tsx";

type ThemeColors = Theme["colors"];
type ThemeBorder = Theme["border"];

// The color maps are deliberately semantic. Hex values belong here, at the
// theme-definition boundary, so components and preference resolution never
// need to know which color represents a surface, status, or focus state.
const RYU_DARK_COLORS = {
	primary: "#0099FF",
	primaryForeground: "#0B0B12",
	accent: "#0099FF",
	accentForeground: "#FFFFFF",
	secondary: "#7C7F93",
	secondaryForeground: "#FFFFFF",
	success: "#34D399",
	successForeground: "#0B0B12",
	warning: "#FBBF24",
	warningForeground: "#0B0B12",
	error: "#F87171",
	errorForeground: "#0B0B12",
	info: "#60A5FA",
	infoForeground: "#0B0B12",
	background: "#0B0B12",
	foreground: "#E5E7EB",
	muted: "#1F2230",
	mutedForeground: "#9CA3AF",
	border: "#2A2D39",
	focusRing: "#0099FF",
	selection: "#006EB8",
	selectionForeground: "#FFFFFF",
} satisfies ThemeColors;

const RYU_LIGHT_COLORS = {
	primary: "#006EB8",
	primaryForeground: "#FFFFFF",
	accent: "#006EB8",
	accentForeground: "#FFFFFF",
	secondary: "#6B7280",
	secondaryForeground: "#FFFFFF",
	success: "#047857",
	successForeground: "#FFFFFF",
	warning: "#B45309",
	warningForeground: "#FFFFFF",
	error: "#B91C1C",
	errorForeground: "#FFFFFF",
	info: "#1D4ED8",
	infoForeground: "#FFFFFF",
	background: "#FAFAFF",
	foreground: "#1F2030",
	muted: "#EEF0F6",
	mutedForeground: "#5F6472",
	border: "#E1E3EB",
	focusRing: "#006EB8",
	selection: "#D9F0FF",
	selectionForeground: "#003C66",
} satisfies ThemeColors;

const RYU_MONO_DARK_COLORS = {
	primary: "#F4F4F5",
	primaryForeground: "#18181B",
	accent: "#D4D4D8",
	accentForeground: "#18181B",
	secondary: "#A1A1AA",
	secondaryForeground: "#18181B",
	success: "#86EFAC",
	successForeground: "#14532D",
	warning: "#FDE68A",
	warningForeground: "#713F12",
	error: "#FDA4AF",
	errorForeground: "#881337",
	info: "#93C5FD",
	infoForeground: "#1E3A8A",
	background: "#18181B",
	foreground: "#FAFAFA",
	muted: "#27272A",
	mutedForeground: "#A1A1AA",
	border: "#3F3F46",
	focusRing: "#F4F4F5",
	selection: "#52525B",
	selectionForeground: "#FFFFFF",
} satisfies ThemeColors;

const RYU_MONO_LIGHT_COLORS = {
	primary: "#27272A",
	primaryForeground: "#FFFFFF",
	accent: "#3F3F46",
	accentForeground: "#FFFFFF",
	secondary: "#71717A",
	secondaryForeground: "#FFFFFF",
	success: "#166534",
	successForeground: "#FFFFFF",
	warning: "#A16207",
	warningForeground: "#FFFFFF",
	error: "#B91C1C",
	errorForeground: "#FFFFFF",
	info: "#1D4ED8",
	infoForeground: "#FFFFFF",
	background: "#FFFFFF",
	foreground: "#18181B",
	muted: "#F4F4F5",
	mutedForeground: "#52525B",
	border: "#E4E4E7",
	focusRing: "#27272A",
	selection: "#E4E4E7",
	selectionForeground: "#18181B",
} satisfies ThemeColors;

const RYU_DARK_BORDER = {
	style: "round",
	color: RYU_DARK_COLORS.border,
	focusColor: RYU_DARK_COLORS.focusRing,
} satisfies ThemeBorder;

const RYU_LIGHT_BORDER = {
	style: "round",
	color: RYU_LIGHT_COLORS.border,
	focusColor: RYU_LIGHT_COLORS.focusRing,
} satisfies ThemeBorder;

const RYU_MONO_DARK_BORDER = {
	style: "round",
	color: RYU_MONO_DARK_COLORS.border,
	focusColor: RYU_MONO_DARK_COLORS.focusRing,
} satisfies ThemeBorder;

const RYU_MONO_LIGHT_BORDER = {
	style: "round",
	color: RYU_MONO_LIGHT_COLORS.border,
	focusColor: RYU_MONO_LIGHT_COLORS.focusRing,
} satisfies ThemeBorder;

// NO_COLOR (https://no-color.org) palettes. OpenTUI always paints explicit
// colors, so honoring the convention means dropping every hue: status, accent,
// and focus collapse onto the neutral foreground ramp, and state is carried by
// the glyphs and labels the components already render (✓ ✗ ⚠ ● ○ ›).
const RYU_NO_COLOR_DARK_COLORS = {
	...RYU_MONO_DARK_COLORS,
	accent: RYU_MONO_DARK_COLORS.foreground,
	error: RYU_MONO_DARK_COLORS.foreground,
	errorForeground: RYU_MONO_DARK_COLORS.background,
	info: RYU_MONO_DARK_COLORS.foreground,
	infoForeground: RYU_MONO_DARK_COLORS.background,
	primary: RYU_MONO_DARK_COLORS.foreground,
	success: RYU_MONO_DARK_COLORS.foreground,
	successForeground: RYU_MONO_DARK_COLORS.background,
	warning: RYU_MONO_DARK_COLORS.foreground,
	warningForeground: RYU_MONO_DARK_COLORS.background,
} satisfies ThemeColors;

const RYU_NO_COLOR_LIGHT_COLORS = {
	...RYU_MONO_LIGHT_COLORS,
	accent: RYU_MONO_LIGHT_COLORS.foreground,
	error: RYU_MONO_LIGHT_COLORS.foreground,
	errorForeground: RYU_MONO_LIGHT_COLORS.background,
	info: RYU_MONO_LIGHT_COLORS.foreground,
	infoForeground: RYU_MONO_LIGHT_COLORS.background,
	primary: RYU_MONO_LIGHT_COLORS.foreground,
	success: RYU_MONO_LIGHT_COLORS.foreground,
	successForeground: RYU_MONO_LIGHT_COLORS.background,
	warning: RYU_MONO_LIGHT_COLORS.foreground,
	warningForeground: RYU_MONO_LIGHT_COLORS.background,
} satisfies ThemeColors;

// Ryu brand palette. Soft boundaries let spacing and text lead while selection
// and focus retain their existing accent contrast.
export const ryuTheme: Theme = createTheme({
	name: "ryu",
	colors: RYU_DARK_COLORS,
	border: RYU_DARK_BORDER,
});

export const ryuDarkTheme: Theme = ryuTheme;

export const ryuLightTheme: Theme = createTheme({
	name: "ryu-light",
	colors: RYU_LIGHT_COLORS,
	border: RYU_LIGHT_BORDER,
});

export const ryuMonoDarkTheme: Theme = createTheme({
	name: "ryu-mono-dark",
	colors: RYU_MONO_DARK_COLORS,
	border: RYU_MONO_DARK_BORDER,
});

export const ryuMonoLightTheme: Theme = createTheme({
	name: "ryu-mono-light",
	colors: RYU_MONO_LIGHT_COLORS,
	border: RYU_MONO_LIGHT_BORDER,
});

export const ryuNoColorDarkTheme: Theme = createTheme({
	name: "ryu-no-color-dark",
	colors: RYU_NO_COLOR_DARK_COLORS,
	border: RYU_MONO_DARK_BORDER,
});

export const ryuNoColorLightTheme: Theme = createTheme({
	name: "ryu-no-color-light",
	colors: RYU_NO_COLOR_LIGHT_COLORS,
	border: RYU_MONO_LIGHT_BORDER,
});

export interface RyuThemePreset {
	readonly dark: Theme;
	readonly label: string;
	readonly light: Theme;
}

export const THEME_CATALOG = {
	ryu: {
		dark: ryuDarkTheme,
		label: "Ryu",
		light: ryuLightTheme,
	},
	"ryu-mono": {
		dark: ryuMonoDarkTheme,
		label: "Ryu Mono",
		light: ryuMonoLightTheme,
	},
} as const satisfies Readonly<Record<string, RyuThemePreset>>;

export type ThemePresetId = keyof typeof THEME_CATALOG;

export const THEME_PRESET_IDS: readonly ThemePresetId[] = Object.freeze(
	Object.keys(THEME_CATALOG).filter((id): id is ThemePresetId =>
		Object.hasOwn(THEME_CATALOG, id)
	)
);

// Descriptive alias for callers that prefer the term "presets" to "catalog".
export const RYU_THEME_PRESETS = THEME_CATALOG;
