// Shared theme presets: the single source of truth for theme variants across
// every Ryu surface (desktop, island, ...). Keep this module pure — no
// `localStorage`, no `document`, no `window` — so it is safe to import from any
// renderer or process. DOM application lives in `./apply`, persistence shape in
// `./prefs`.

import { accessibleRingColor } from "./ring.ts";

type Tokens = Record<string, string>;

export type ThemeDensity = "compact" | "comfortable" | "spacious";

export interface ThemeAppearance {
	cardRadius?: number;
	codeFont?: string;
	contentScale?: number;
	contentWidth?: string;
	density?: ThemeDensity;
	fontSizes?: Partial<
		Record<"xs" | "sm" | "base" | "lg" | "xl" | "2xl", string>
	>;
	fontWeights?: Partial<
		Record<"normal" | "medium" | "semibold" | "bold", number>
	>;
	headingFont?: string;
	layout?: {
		navigation?: "sidebar" | "topbar" | "minimal";
		contentAlign?: "start" | "center" | "wide";
		panelStyle?: "flat" | "card" | "outline";
	};
	panelRadius?: number;
	radius?: number;
	spacingScale?: number;
	uiFont?: string;
}

export interface ThemeVariant {
	appearance?: ThemeAppearance;
	id: string;
	label: string;
	mode: "light" | "dark";
	preview: { bg: string; surface: string; primary: string; text: string };
	tokens: Tokens;
}

interface Swatch {
	bg: string;
	primary: string;
	surface: string;
	text: string;
}

interface Palette {
	bg: string;
	border: string;
	card: string;
	fg: string;
	muted: string;
	mutedFg: string;
	primary: string;
	primaryFg: string;
	/** Focus-ring colour when `primary` is under 3:1 against this palette's
	 * bg/card/sidebar (WCAG 1.4.11). Same hue as `primary`, minimum lightness
	 * shift; omitted when `primary` already passes. */
	ring?: string;
	sidebar: string;
}

function makeVariant(
	id: string,
	label: string,
	mode: "light" | "dark",
	preview: Swatch,
	p: Palette,
	destructive: string
): ThemeVariant {
	return {
		id,
		label,
		mode,
		preview,
		tokens: {
			"--background": p.bg,
			"--foreground": p.fg,
			"--card": p.card,
			"--card-foreground": p.fg,
			"--popover": p.card,
			"--popover-foreground": p.fg,
			"--primary": p.primary,
			"--primary-foreground": p.primaryFg,
			"--secondary": p.muted,
			"--secondary-foreground": p.fg,
			"--muted": p.muted,
			"--muted-foreground": p.mutedFg,
			"--accent": p.muted,
			"--accent-foreground": p.fg,
			"--destructive": destructive,
			"--border": p.border,
			"--input": p.border,
			"--ring": p.ring ?? p.primary,
			"--sidebar": p.sidebar,
			"--sidebar-foreground": p.fg,
			"--sidebar-primary": p.primary,
			"--sidebar-primary-foreground": p.primaryFg,
			"--sidebar-accent": p.muted,
			"--sidebar-accent-foreground": p.fg,
			"--sidebar-border": p.border,
			"--sidebar-ring": p.ring ?? p.primary,
		},
	};
}

function makeLight(
	id: string,
	label: string,
	preview: Swatch,
	p: Palette
): ThemeVariant {
	return makeVariant(id, label, "light", preview, p, "#ef4444");
}

function makeDark(
	id: string,
	label: string,
	preview: Swatch,
	p: Palette
): ThemeVariant {
	return makeVariant(id, label, "dark", preview, p, "#f87171");
}

export const THEME_VARIANTS: ThemeVariant[] = [
	// Default "Ryu" light: the original ryu-desktop brand palette (blue primary)
	// restored from ../ryuold/ryu-desktop/src/global.css `:root`.
	{
		id: "ryu-light",
		label: "Ryu",
		mode: "light",
		preview: {
			bg: "#ffffff",
			surface: "#fafafa",
			primary: "#0099ff",
			text: "#18181b",
		},
		tokens: {
			"--background": "oklch(1 0 0)",
			"--foreground": "oklch(0.141 0.005 285.823)",
			"--card": "oklch(1 0 0)",
			"--card-foreground": "oklch(0.141 0.005 285.823)",
			"--popover": "oklch(1 0 0)",
			"--popover-foreground": "oklch(0.141 0.005 285.823)",
			"--primary": "#0099ff",
			"--primary-foreground": "oklch(0.97 0.014 254.604)",
			"--secondary": "oklch(0.9249 0 0)",
			"--secondary-foreground": "oklch(0.21 0.006 285.885)",
			"--muted": "oklch(0.967 0.001 286.375)",
			"--muted-foreground": "oklch(0.552 0.016 285.938)",
			"--accent": "oklch(0.967 0.001 286.375)",
			"--accent-foreground": "oklch(0.21 0.006 285.885)",
			"--destructive": "oklch(0.645 0.246 16.439)",
			"--border": "oklch(0.92 0.004 286.32)",
			"--input": "oklch(0.92 0.004 286.32)",
			"--ring": "oklch(0.64 0 0)",
			"--sidebar": "oklch(0.985 0 0)",
			"--sidebar-foreground": "oklch(0.141 0.005 285.823)",
			"--sidebar-primary": "#0099ff",
			"--sidebar-primary-foreground": "oklch(0.97 0.014 254.604)",
			"--sidebar-accent": "oklch(0.967 0.001 286.375)",
			"--sidebar-accent-foreground": "oklch(0.21 0.006 285.885)",
			"--sidebar-border": "oklch(0.92 0.004 286.32)",
			"--sidebar-ring": "oklch(0.64 0 0)",
		},
	},
	// "Ryu Light": the previous neutral grayscale default, kept as a preset.
	{
		id: "ryu-light-mono",
		label: "Ryu Light",
		mode: "light",
		preview: {
			bg: "#ffffff",
			surface: "#fafafa",
			primary: "#27272a",
			text: "#18181b",
		},
		tokens: {
			"--background": "oklch(1 0 0)",
			"--foreground": "oklch(0.145 0 0)",
			"--card": "oklch(1 0 0)",
			"--card-foreground": "oklch(0.145 0 0)",
			"--popover": "oklch(1 0 0)",
			"--popover-foreground": "oklch(0.145 0 0)",
			"--primary": "oklch(0.205 0 0)",
			"--primary-foreground": "oklch(0.985 0 0)",
			"--secondary": "oklch(0.97 0 0)",
			"--secondary-foreground": "oklch(0.205 0 0)",
			"--muted": "oklch(0.97 0 0)",
			"--muted-foreground": "oklch(0.545 0 0)",
			"--accent": "oklch(0.97 0 0)",
			"--accent-foreground": "oklch(0.205 0 0)",
			"--destructive": "oklch(0.577 0.245 27.325)",
			"--border": "oklch(0.922 0 0)",
			"--input": "oklch(0.922 0 0)",
			"--ring": "oklch(0.64 0 0)",
			"--sidebar": "oklch(0.985 0 0)",
			"--sidebar-foreground": "oklch(0.145 0 0)",
			"--sidebar-primary": "oklch(0.205 0 0)",
			"--sidebar-primary-foreground": "oklch(0.985 0 0)",
			"--sidebar-accent": "oklch(0.97 0 0)",
			"--sidebar-accent-foreground": "oklch(0.205 0 0)",
			"--sidebar-border": "oklch(0.922 0 0)",
			"--sidebar-ring": "oklch(0.64 0 0)",
		},
	},
	// Default "Ryu" dark: the original ryu-desktop brand palette (blue primary)
	// restored from ../ryuold/ryu-desktop/src/global.css `.dark`.
	{
		id: "ryu-dark",
		label: "Ryu",
		mode: "dark",
		preview: {
			bg: "#1c1c1f",
			surface: "#27272b",
			primary: "#0099ff",
			text: "#fafafa",
		},
		tokens: {
			"--background": "oklch(19.212% 0.00401 285.944)",
			"--foreground": "oklch(0.985 0 0)",
			"--card": "oklch(0.21 0.006 285.885)",
			"--card-foreground": "oklch(0.985 0 0)",
			"--popover": "oklch(0.21 0.006 285.885)",
			"--popover-foreground": "oklch(0.985 0 0)",
			"--primary": "#0099ff",
			"--primary-foreground": "oklch(0.97 0.014 254.604)",
			"--secondary": "oklch(0.274 0.006 286.033)",
			"--secondary-foreground": "oklch(0.985 0 0)",
			"--muted": "oklch(0.274 0.006 286.033)",
			"--muted-foreground": "oklch(0.705 0.015 286.067)",
			"--accent": "oklch(0.274 0.006 286.033)",
			"--accent-foreground": "oklch(0.985 0 0)",
			"--destructive": "oklch(0.704 0.191 22.216)",
			"--border": "oklch(1 0 0 / 10%)",
			"--input": "oklch(1 0 0 / 15%)",
			"--ring": "oklch(0.556 0 0)",
			"--sidebar": "oklch(0.21 0.006 285.885)",
			"--sidebar-foreground": "oklch(0.985 0 0)",
			"--sidebar-primary": "#0099ff",
			"--sidebar-primary-foreground": "oklch(0.97 0.014 254.604)",
			"--sidebar-accent": "oklch(0.274 0.006 286.033)",
			"--sidebar-accent-foreground": "oklch(0.985 0 0)",
			"--sidebar-border": "oklch(1 0 0 / 10%)",
			"--sidebar-ring": "oklch(0.556 0 0)",
		},
	},
	// "Ryu Dark": the previous neutral grayscale default, kept as a preset.
	{
		id: "ryu-dark-mono",
		label: "Ryu Dark",
		mode: "dark",
		preview: {
			bg: "#18181b",
			surface: "#27272a",
			primary: "#e4e4e7",
			text: "#fafafa",
		},
		tokens: {
			"--background": "oklch(0.145 0 0)",
			"--foreground": "oklch(0.985 0 0)",
			"--card": "oklch(0.205 0 0)",
			"--card-foreground": "oklch(0.985 0 0)",
			"--popover": "oklch(0.205 0 0)",
			"--popover-foreground": "oklch(0.985 0 0)",
			"--primary": "oklch(0.922 0 0)",
			"--primary-foreground": "oklch(0.205 0 0)",
			"--secondary": "oklch(0.269 0 0)",
			"--secondary-foreground": "oklch(0.985 0 0)",
			"--muted": "oklch(0.269 0 0)",
			"--muted-foreground": "oklch(0.708 0 0)",
			"--accent": "oklch(0.269 0 0)",
			"--accent-foreground": "oklch(0.985 0 0)",
			"--destructive": "oklch(0.704 0.191 22.216)",
			"--border": "oklch(1 0 0 / 10%)",
			"--input": "oklch(1 0 0 / 15%)",
			"--ring": "oklch(0.556 0 0)",
			"--sidebar": "oklch(0.205 0 0)",
			"--sidebar-foreground": "oklch(0.985 0 0)",
			// Neutral, like this preset's --primary. Was Tailwind indigo
			// (oklch(0.488 0.243 264.376) = #1447e6) — the same stray-blue leftover
			// the default presets carried, in the one preset that is meant to have
			// no accent colour at all.
			"--sidebar-primary": "oklch(0.922 0 0)",
			"--sidebar-primary-foreground": "oklch(0.205 0 0)",
			"--sidebar-accent": "oklch(0.269 0 0)",
			"--sidebar-accent-foreground": "oklch(0.985 0 0)",
			"--sidebar-border": "oklch(1 0 0 / 10%)",
			"--sidebar-ring": "oklch(0.556 0 0)",
		},
	},

	// Codex (OpenAI). The accent is BLUE — `--theme-blue-*` from the ChatGPT
	// design system (blue-400 #3A83F7 icons/buttons, blue-500 #2C67C5 on light) —
	// NOT the old `#10A37F` OpenAI green. Dark bg is the near-black `gray-950
	// #0D0D0D`; light bg is white with gray-50 #F9F9F9 surfaces.
	makeLight(
		"codex-light",
		"Codex",
		{ bg: "#ffffff", surface: "#f9f9f9", primary: "#2c67c5", text: "#0d0d0d" },
		{
			bg: "#ffffff",
			fg: "#0d0d0d",
			card: "#f9f9f9",
			primary: "#2c67c5",
			primaryFg: "#ffffff",
			muted: "#f0f0f0",
			mutedFg: "#5d5d5d",
			border: "#e6e6e6",
			sidebar: "#f9f9f9",
		}
	),
	makeDark(
		"codex-dark",
		"Codex",
		{ bg: "#0d0d0d", surface: "#212121", primary: "#3a83f7", text: "#ffffff" },
		{
			bg: "#0d0d0d",
			fg: "#ffffff",
			card: "#212121",
			primary: "#3a83f7",
			primaryFg: "#ffffff",
			muted: "#303030",
			mutedFg: "#b3b3b3",
			border: "#313131",
			sidebar: "#212121",
		}
	),

	// Claude (Anthropic). Accent is the confirmed `--cds-clay:#d97757` "book
	// cloth" terracotta. Light page bg is the warm off-white `--df-bg-page
	// #FCFCFB`; dark bg is the warm charcoal `gray-800 #20201F` with gray-750
	// #2C2C2A surfaces. (The old #cc5c38/#e06b46 accent was wrong.)
	makeLight(
		"claude-light",
		"Claude",
		{ bg: "#fcfcfb", surface: "#ffffff", primary: "#d97757", text: "#141413" },
		{
			bg: "#fcfcfb",
			fg: "#141413",
			card: "#ffffff",
			primary: "#d97757",
			primaryFg: "#ffffff",
			muted: "#f6f5f2",
			mutedFg: "#98978f",
			border: "#e4e4e3",
			sidebar: "#ffffff",
		}
	),
	makeDark(
		"claude-dark",
		"Claude",
		{ bg: "#20201f", surface: "#2c2c2a", primary: "#d97757", text: "#e0e1d9" },
		{
			bg: "#20201f",
			fg: "#e0e1d9",
			card: "#2c2c2a",
			primary: "#d97757",
			primaryFg: "#ffffff",
			muted: "#383835",
			mutedFg: "#a5a49a",
			border: "#323231",
			sidebar: "#2c2c2a",
		}
	),

	// Ayu. Light bg #FCFCFC / dark bg #10141C from the ayu-vscode bundle. (The
	// older `#1F2430` dark was actually Ayu Mirage — a separate flavour.)
	makeLight(
		"ayu-light",
		"Ayu",
		{ bg: "#fcfcfc", surface: "#f8f9fa", primary: "#ff9940", text: "#5c6166" },
		{
			bg: "#fcfcfc",
			fg: "#5c6166",
			card: "#fafafa",
			primary: "#ff9940",
			primaryFg: "#ffffff",
			ring: "#db780d",
			muted: "#edeff1",
			mutedFg: "#adaeb1",
			border: "#d9dde1",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"ayu-dark",
		"Ayu",
		{ bg: "#10141c", surface: "#0d1017", primary: "#ffd173", text: "#bfbdb6" },
		{
			bg: "#10141c",
			fg: "#bfbdb6",
			card: "#0d1017",
			primary: "#ffd173",
			primaryFg: "#10141c",
			muted: "#161a24",
			mutedFg: "#5a6673",
			border: "#1b1f29",
			sidebar: "#0d1017",
		}
	),

	// Catppuccin. Latte (light) and Mocha (dark), the official default accent
	// mauve. Surfaces are surface0; muted is surface1; mutedFg is overlay0.
	makeLight(
		"catppuccin-light",
		"Catppuccin",
		{ bg: "#eff1f5", surface: "#ccd0da", primary: "#8839ef", text: "#4c4f69" },
		{
			bg: "#eff1f5",
			fg: "#4c4f69",
			card: "#ccd0da",
			primary: "#8839ef",
			primaryFg: "#ffffff",
			muted: "#bcc0cc",
			mutedFg: "#6c7086",
			border: "#bcc0cc",
			sidebar: "#ccd0da",
		}
	),
	makeDark(
		"catppuccin-dark",
		"Catppuccin",
		{ bg: "#1e1e2e", surface: "#313244", primary: "#cba6f7", text: "#cdd6f4" },
		{
			bg: "#1e1e2e",
			fg: "#cdd6f4",
			card: "#313244",
			primary: "#cba6f7",
			primaryFg: "#1e1e2e",
			muted: "#45475a",
			mutedFg: "#6c7086",
			border: "#45475a",
			sidebar: "#313244",
		}
	),

	// Dracula. Light = the official "Alucard" variant (bg #FFFBEB, purple
	// #644AC9, comment #6C664B); dark = the classic #282A36 / purple #BD93F9.
	makeLight(
		"dracula-light",
		"Dracula",
		{ bg: "#fffbeb", surface: "#cfcfde", primary: "#644ac9", text: "#1f1f1f" },
		{
			bg: "#fffbeb",
			fg: "#1f1f1f",
			card: "#cfcfde",
			primary: "#644ac9",
			primaryFg: "#ffffff",
			muted: "#e6e6ee",
			mutedFg: "#6c664b",
			border: "#cfcfde",
			sidebar: "#cfcfde",
		}
	),
	makeDark(
		"dracula-dark",
		"Dracula",
		{ bg: "#282a36", surface: "#21222c", primary: "#bd93f9", text: "#f8f8f2" },
		{
			bg: "#282a36",
			fg: "#f8f8f2",
			card: "#21222c",
			primary: "#bd93f9",
			primaryFg: "#282a36",
			muted: "#44475a",
			mutedFg: "#6272a4",
			border: "#44475a",
			sidebar: "#21222c",
		}
	),

	// GitHub. Current @primer/primitives v11 values (fg-default #1F2328 light /
	// #F0F6FC dark, accent #0969DA / #4493F8, border-default #D1D9E0 / #3D444D).
	makeLight(
		"github-light",
		"GitHub",
		{ bg: "#ffffff", surface: "#f6f8fa", primary: "#0969da", text: "#1f2328" },
		{
			bg: "#ffffff",
			fg: "#1f2328",
			card: "#f6f8fa",
			primary: "#0969da",
			primaryFg: "#ffffff",
			muted: "#eaeef2",
			mutedFg: "#59636e",
			border: "#d1d9e0",
			sidebar: "#f6f8fa",
		}
	),
	makeDark(
		"github-dark",
		"GitHub",
		{ bg: "#0d1117", surface: "#151b23", primary: "#4493f8", text: "#f0f6fc" },
		{
			bg: "#0d1117",
			fg: "#f0f6fc",
			card: "#151b23",
			primary: "#4493f8",
			primaryFg: "#ffffff",
			muted: "#21262d",
			mutedFg: "#9198a1",
			border: "#3d444d",
			sidebar: "#151b23",
		}
	),

	// Linear. Brand Mercury White #F4F5F8 / Nordic Gray #222326, indigo accent
	// #5E6AD2. Dark surface #191D20 (not the purple-tinted old value).
	makeLight(
		"linear-light",
		"Linear",
		{ bg: "#ffffff", surface: "#f4f5f8", primary: "#5e6ad2", text: "#222326" },
		{
			bg: "#ffffff",
			fg: "#222326",
			card: "#f4f5f8",
			primary: "#5e6ad2",
			primaryFg: "#ffffff",
			muted: "#e2e4e7",
			mutedFg: "#8a8f98",
			border: "#e2e4e7",
			sidebar: "#f4f5f8",
		}
	),
	makeDark(
		"linear-dark",
		"Linear",
		{ bg: "#101012", surface: "#191d20", primary: "#5e6ad2", text: "#f4f5f8" },
		{
			bg: "#101012",
			fg: "#f4f5f8",
			card: "#191d20",
			primary: "#5e6ad2",
			primaryFg: "#ffffff",
			muted: "#24262b",
			mutedFg: "#8a8f98",
			border: "#2e2e32",
			sidebar: "#191d20",
		}
	),

	// Nord. Polar Night (dark) nord0-3, Snow Storm (light) nord4-6, frost
	// accent: nord8 #88C0D0 is "the accent colour for primary UI elements".
	makeLight(
		"nord-light",
		"Nord",
		{ bg: "#eceff4", surface: "#e5e9f0", primary: "#5e81ac", text: "#2e3440" },
		{
			bg: "#eceff4",
			fg: "#2e3440",
			card: "#e5e9f0",
			primary: "#5e81ac",
			primaryFg: "#ffffff",
			muted: "#d8dee9",
			mutedFg: "#4c566a",
			border: "#d8dee9",
			sidebar: "#e5e9f0",
		}
	),
	makeDark(
		"nord-dark",
		"Nord",
		{ bg: "#2e3440", surface: "#3b4252", primary: "#88c0d0", text: "#eceff4" },
		{
			bg: "#2e3440",
			fg: "#eceff4",
			card: "#3b4252",
			primary: "#88c0d0",
			primaryFg: "#2e3440",
			muted: "#434c5e",
			mutedFg: "#4c566a",
			border: "#4c566a",
			sidebar: "#3b4252",
		}
	),

	makeLight(
		"notion-light",
		"Notion",
		{ bg: "#ffffff", surface: "#f7f7f5", primary: "#2383e2", text: "#37352f" },
		{
			bg: "#ffffff",
			fg: "#37352f",
			card: "#f7f7f5",
			primary: "#2383e2",
			primaryFg: "#ffffff",
			muted: "#ededeb",
			mutedFg: "#9b9a97",
			border: "#e9e9e7",
			sidebar: "#f7f7f5",
		}
	),
	makeDark(
		"notion-dark",
		"Notion",
		{ bg: "#191919", surface: "#1f1f1f", primary: "#529cca", text: "#e6e6e5" },
		{
			bg: "#191919",
			fg: "#e6e6e5",
			card: "#1f1f1f",
			primary: "#529cca",
			primaryFg: "#191919",
			muted: "#2b2b2b",
			mutedFg: "#9b9a97",
			border: "#2e2e2e",
			sidebar: "#1f1f1f",
		}
	),

	makeLight(
		"one-light",
		"One",
		{ bg: "#fafafa", surface: "#f0f0f1", primary: "#4078f2", text: "#383a42" },
		{
			bg: "#fafafa",
			fg: "#383a42",
			card: "#f0f0f1",
			primary: "#4078f2",
			primaryFg: "#ffffff",
			muted: "#e5e5e6",
			mutedFg: "#a0a1a7",
			border: "#e1e1e1",
			sidebar: "#f0f0f1",
		}
	),
	makeDark(
		"one-dark",
		"One",
		{ bg: "#282c34", surface: "#21252b", primary: "#61afef", text: "#abb2bf" },
		{
			bg: "#282c34",
			fg: "#abb2bf",
			card: "#21252b",
			primary: "#61afef",
			primaryFg: "#282c34",
			muted: "#2c313c",
			mutedFg: "#5c6370",
			border: "#181a1f",
			sidebar: "#21252b",
		}
	),

	makeLight(
		"raycast-light",
		"Raycast",
		{ bg: "#ffffff", surface: "#f4f4f5", primary: "#ff6363", text: "#1c1c1e" },
		{
			bg: "#ffffff",
			fg: "#1c1c1e",
			card: "#f4f4f5",
			primary: "#ff6363",
			primaryFg: "#ffffff",
			ring: "#f3585a",
			muted: "#e9e9eb",
			mutedFg: "#8a8a8e",
			border: "#d9d9dc",
			sidebar: "#f4f4f5",
		}
	),
	makeDark(
		"raycast-dark",
		"Raycast",
		{ bg: "#1c1c1e", surface: "#2c2c2e", primary: "#ff6363", text: "#ffffff" },
		{
			bg: "#1c1c1e",
			fg: "#ffffff",
			card: "#2c2c2e",
			primary: "#ff6363",
			primaryFg: "#1c1c1e",
			muted: "#3a3a3c",
			mutedFg: "#98989e",
			border: "#38383a",
			sidebar: "#2c2c2e",
		}
	),

	// Tokyo Night. Dark = folke/tokyonight "night" (bg #1A1B26, blue #7AA2F7,
	// cyan #7DCFFF). Light = the "day" style (bg #E1E2E7, fg #3760BF, blue
	// #2E7DE9) — the previous #D5D6DB bg was not the real day palette.
	makeLight(
		"tokyo-light",
		"Tokyo Night",
		{ bg: "#e1e2e7", surface: "#d0d5e3", primary: "#2e7de9", text: "#3760bf" },
		{
			bg: "#e1e2e7",
			fg: "#3760bf",
			card: "#d0d5e3",
			primary: "#2e7de9",
			primaryFg: "#ffffff",
			ring: "#2676e1",
			muted: "#c4c8da",
			mutedFg: "#848cb5",
			border: "#b4b5b9",
			sidebar: "#d0d5e3",
		}
	),
	makeDark(
		"tokyo-dark",
		"Tokyo Night",
		{ bg: "#1a1b26", surface: "#16161e", primary: "#7aa2f7", text: "#c0caf5" },
		{
			bg: "#1a1b26",
			fg: "#c0caf5",
			card: "#16161e",
			primary: "#7aa2f7",
			primaryFg: "#1a1b26",
			muted: "#292e42",
			mutedFg: "#565f89",
			border: "#15161e",
			sidebar: "#16161e",
		}
	),

	// ── More well-known themes (light) ───────────────────────────────────────
	// Values pulled from the canonical theme sources (morhetz/gruvbox,
	// ethanschoonover/solarized, rose-pine/rose-pine, sainnhe/everforest,
	// rebelot/kanagawa.nvim, sdras/night-owl-vscode-theme,
	// equinusocio/material-theme, miguelsolorio/min-theme, antfu/vitesse-theme,
	// jolaleye/horizon-theme-vscode) and cross-checked against the bundled
	// `@shikijs/themes` JSON used by the diff/file-tree pickers.

	makeLight(
		"gruvbox-light",
		"Gruvbox Light",
		{ bg: "#fbf1c7", surface: "#ebdbb2", primary: "#d65d0e", text: "#3c3836" },
		{
			bg: "#fbf1c7",
			fg: "#3c3836",
			card: "#ebdbb2",
			primary: "#d65d0e",
			primaryFg: "#fbf1c7",
			ring: "#d05800",
			muted: "#d5c4a1",
			mutedFg: "#928374",
			border: "#d5c4a1",
			sidebar: "#ebdbb2",
		}
	),
	makeLight(
		"solarized-light",
		"Solarized Light",
		{ bg: "#fdf6e3", surface: "#eee8d5", primary: "#268bd2", text: "#657b83" },
		{
			bg: "#fdf6e3",
			fg: "#657b83",
			card: "#eee8d5",
			primary: "#268bd2",
			primaryFg: "#fdf6e3",
			muted: "#eee8d5",
			mutedFg: "#93a1a1",
			border: "#93a1a1",
			sidebar: "#eee8d5",
		}
	),
	makeLight(
		"rose-pine-dawn",
		"Rosé Pine Dawn",
		{ bg: "#faf4ed", surface: "#fff8f2", primary: "#907aa9", text: "#575279" },
		{
			bg: "#faf4ed",
			fg: "#575279",
			card: "#fff8f2",
			primary: "#907aa9",
			primaryFg: "#faf4ed",
			muted: "#f2e9de",
			mutedFg: "#9893a5",
			border: "#dfdad9",
			sidebar: "#fff8f2",
		}
	),
	makeLight(
		"everforest-light",
		"Everforest Light",
		{ bg: "#fdf6e3", surface: "#f6efdd", primary: "#83a26d", text: "#5c6a72" },
		{
			bg: "#fdf6e3",
			fg: "#5c6a72",
			card: "#f6efdd",
			primary: "#83a26d",
			primaryFg: "#fdf6e3",
			ring: "#75935f",
			muted: "#efe8d4",
			mutedFg: "#939f91",
			border: "#dfd8c5",
			sidebar: "#f6efdd",
		}
	),
	makeLight(
		"kanagawa-lotus",
		"Kanagawa Lotus",
		{ bg: "#f2ecbc", surface: "#e5ddb0", primary: "#d27e99", text: "#545464" },
		{
			bg: "#f2ecbc",
			fg: "#545464",
			card: "#e5ddb0",
			primary: "#d27e99",
			primaryFg: "#ffffff",
			ring: "#b5647f",
			muted: "#e4d794",
			mutedFg: "#716e61",
			border: "#dad2a1",
			sidebar: "#e5ddb0",
		}
	),
	makeLight(
		"night-owl-light",
		"Night Owl Light",
		{ bg: "#fbfbfb", surface: "#f0f0f0", primary: "#4876d6", text: "#403f53" },
		{
			bg: "#fbfbfb",
			fg: "#403f53",
			card: "#f0f0f0",
			primary: "#4876d6",
			primaryFg: "#ffffff",
			muted: "#e0e0e0",
			mutedFg: "#989fb1",
			border: "#e8e8ee",
			sidebar: "#f0f0f0",
		}
	),
	makeLight(
		"material-theme-lighter",
		"Material Lighter",
		{ bg: "#fafafa", surface: "#f2f2f2", primary: "#80cbc4", text: "#90a4ae" },
		{
			bg: "#fafafa",
			fg: "#90a4ae",
			card: "#f2f2f2",
			primary: "#80cbc4",
			primaryFg: "#253238",
			ring: "#4d9892",
			muted: "#e5e9ea",
			mutedFg: "#c0cbcb",
			border: "#dce3e3",
			sidebar: "#f2f2f2",
		}
	),
	makeLight(
		"min-light",
		"Min Light",
		{ bg: "#ffffff", surface: "#f6f6f6", primary: "#1976d2", text: "#212121" },
		{
			bg: "#ffffff",
			fg: "#212121",
			card: "#f6f6f6",
			primary: "#1976d2",
			primaryFg: "#ffffff",
			muted: "#efefef",
			mutedFg: "#c2c3c5",
			border: "#e4e4e4",
			sidebar: "#f6f6f6",
		}
	),
	makeLight(
		"slack-ochin",
		"Slack",
		{ bg: "#ffffff", surface: "#f8f8f8", primary: "#611f69", text: "#000000" },
		{
			bg: "#ffffff",
			fg: "#000000",
			card: "#f8f8f8",
			primary: "#611f69",
			primaryFg: "#ffffff",
			muted: "#eeeeee",
			mutedFg: "#616161",
			border: "#dbdbdb",
			sidebar: "#f8f8f8",
		}
	),
	makeLight(
		"snazzy-light",
		"Snazzy Light",
		{ bg: "#fafbfc", surface: "#f3f4f5", primary: "#2dae58", text: "#565869" },
		{
			bg: "#fafbfc",
			fg: "#565869",
			card: "#f3f4f5",
			primary: "#2dae58",
			primaryFg: "#ffffff",
			ring: "#18a24d",
			muted: "#e9f0ec",
			mutedFg: "#adb1c2",
			border: "#e1e6e8",
			sidebar: "#f3f4f5",
		}
	),
	makeLight(
		"vitesse-light",
		"Vitesse Light",
		{ bg: "#ffffff", surface: "#f7f7f7", primary: "#59873a", text: "#393a34" },
		{
			bg: "#ffffff",
			fg: "#393a34",
			card: "#f7f7f7",
			primary: "#59873a",
			primaryFg: "#ffffff",
			muted: "#ededed",
			mutedFg: "#a0ada0",
			border: "#e0e0e0",
			sidebar: "#f7f7f7",
		}
	),
	makeLight(
		"light-plus",
		"Light Plus",
		{ bg: "#ffffff", surface: "#f5f5f5", primary: "#007acc", text: "#000000" },
		{
			bg: "#ffffff",
			fg: "#000000",
			card: "#f5f5f5",
			primary: "#007acc",
			primaryFg: "#ffffff",
			muted: "#efefef",
			mutedFg: "#808080",
			border: "#e0e0e0",
			sidebar: "#f5f5f5",
		}
	),
	makeLight(
		"horizon-bright",
		"Horizon Bright",
		{ bg: "#fdf0ed", surface: "#f7e6e2", primary: "#da103f", text: "#06060c" },
		{
			bg: "#fdf0ed",
			fg: "#06060c",
			card: "#f7e6e2",
			primary: "#da103f",
			primaryFg: "#fdf0ed",
			muted: "#f9cbbf",
			mutedFg: "#7a7c87",
			border: "#e8d5cf",
			sidebar: "#f7e6e2",
		}
	),
	makeLight(
		"vercel-light",
		"Vercel",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#0070f3", text: "#000000" },
		{
			bg: "#ffffff",
			fg: "#000000",
			card: "#fafafa",
			primary: "#0070f3",
			primaryFg: "#ffffff",
			muted: "#f1f1f1",
			mutedFg: "#666666",
			border: "#e5e5e5",
			sidebar: "#fafafa",
		}
	),

	// ── More well-known themes (dark) ────────────────────────────────────────

	makeDark(
		"gruvbox-dark",
		"Gruvbox Dark",
		{ bg: "#282828", surface: "#3c3836", primary: "#fe8019", text: "#ebdbb2" },
		{
			bg: "#282828",
			fg: "#ebdbb2",
			card: "#3c3836",
			primary: "#fe8019",
			primaryFg: "#282828",
			muted: "#504945",
			mutedFg: "#928374",
			border: "#504945",
			sidebar: "#3c3836",
		}
	),
	makeDark(
		"solarized-dark",
		"Solarized Dark",
		{ bg: "#002b36", surface: "#073642", primary: "#268bd2", text: "#839496" },
		{
			bg: "#002b36",
			fg: "#839496",
			card: "#073642",
			primary: "#268bd2",
			primaryFg: "#002b36",
			muted: "#073642",
			mutedFg: "#586e75",
			border: "#586e75",
			sidebar: "#073642",
		}
	),
	makeDark(
		"rose-pine",
		"Rosé Pine",
		{ bg: "#191724", surface: "#1f1d2e", primary: "#c4a7e7", text: "#e0def4" },
		{
			bg: "#191724",
			fg: "#e0def4",
			card: "#1f1d2e",
			primary: "#c4a7e7",
			primaryFg: "#191724",
			muted: "#26233a",
			mutedFg: "#6e6a86",
			border: "#2a283e",
			sidebar: "#1f1d2e",
		}
	),
	makeDark(
		"rose-pine-moon",
		"Rosé Pine Moon",
		{ bg: "#232136", surface: "#2a273f", primary: "#c4a7e7", text: "#e0def4" },
		{
			bg: "#232136",
			fg: "#e0def4",
			card: "#2a273f",
			primary: "#c4a7e7",
			primaryFg: "#232136",
			muted: "#393552",
			mutedFg: "#6e6a86",
			border: "#44415a",
			sidebar: "#2a273f",
		}
	),
	makeDark(
		"everforest-dark",
		"Everforest Dark",
		{ bg: "#2d353b", surface: "#343f44", primary: "#a7c080", text: "#d3c6aa" },
		{
			bg: "#2d353b",
			fg: "#d3c6aa",
			card: "#343f44",
			primary: "#a7c080",
			primaryFg: "#2d353b",
			muted: "#475258",
			mutedFg: "#859289",
			border: "#475258",
			sidebar: "#343f44",
		}
	),
	makeDark(
		"kanagawa-wave",
		"Kanagawa Wave",
		{ bg: "#1f1f28", surface: "#16161d", primary: "#7e9cd8", text: "#dcd7ba" },
		{
			bg: "#1f1f28",
			fg: "#dcd7ba",
			card: "#16161d",
			primary: "#7e9cd8",
			primaryFg: "#1f1f28",
			muted: "#363646",
			mutedFg: "#727169",
			border: "#363646",
			sidebar: "#16161d",
		}
	),
	makeDark(
		"kanagawa-dragon",
		"Kanagawa Dragon",
		{ bg: "#181616", surface: "#1f1e1e", primary: "#8ba4b0", text: "#c5c9c5" },
		{
			bg: "#181616",
			fg: "#c5c9c5",
			card: "#1f1e1e",
			primary: "#8ba4b0",
			primaryFg: "#181616",
			muted: "#223249",
			mutedFg: "#737c73",
			border: "#393836",
			sidebar: "#1f1e1e",
		}
	),
	makeDark(
		"night-owl",
		"Night Owl",
		{ bg: "#011627", surface: "#0b2942", primary: "#82aaff", text: "#d6deeb" },
		{
			bg: "#011627",
			fg: "#d6deeb",
			card: "#0b2942",
			primary: "#82aaff",
			primaryFg: "#011627",
			muted: "#1d3b53",
			mutedFg: "#637777",
			border: "#1d3b53",
			sidebar: "#0b2942",
		}
	),
	makeDark(
		"material-theme",
		"Material",
		{ bg: "#263238", surface: "#2e3c43", primary: "#80cbc4", text: "#eeffff" },
		{
			bg: "#263238",
			fg: "#eeffff",
			card: "#2e3c43",
			primary: "#80cbc4",
			primaryFg: "#263238",
			muted: "#37474f",
			mutedFg: "#546e7a",
			border: "#37474f",
			sidebar: "#2e3c43",
		}
	),
	makeDark(
		"material-theme-darker",
		"Material Darker",
		{ bg: "#212121", surface: "#2a2a2a", primary: "#80cbc4", text: "#eeffff" },
		{
			bg: "#212121",
			fg: "#eeffff",
			card: "#2a2a2a",
			primary: "#80cbc4",
			primaryFg: "#263238",
			muted: "#333333",
			mutedFg: "#545454",
			border: "#353535",
			sidebar: "#2a2a2a",
		}
	),
	makeDark(
		"material-theme-ocean",
		"Material Ocean",
		{ bg: "#0f111a", surface: "#171a26", primary: "#82aaff", text: "#babed8" },
		{
			bg: "#0f111a",
			fg: "#babed8",
			card: "#171a26",
			primary: "#82aaff",
			primaryFg: "#0f111a",
			muted: "#20242f",
			mutedFg: "#464b5d",
			border: "#20242f",
			sidebar: "#171a26",
		}
	),
	makeDark(
		"material-theme-palenight",
		"Material Palenight",
		{ bg: "#292d3e", surface: "#31354a", primary: "#82aaff", text: "#babed8" },
		{
			bg: "#292d3e",
			fg: "#babed8",
			card: "#31354a",
			primary: "#82aaff",
			primaryFg: "#292d3e",
			muted: "#3a3f54",
			mutedFg: "#676e95",
			border: "#3a3f54",
			sidebar: "#31354a",
		}
	),
	makeDark(
		"min-dark",
		"Min Dark",
		{ bg: "#1f1f1f", surface: "#282828", primary: "#1976d2", text: "#888888" },
		{
			bg: "#1f1f1f",
			fg: "#888888",
			card: "#282828",
			primary: "#1976d2",
			primaryFg: "#1f1f1f",
			muted: "#333333",
			mutedFg: "#6b737c",
			border: "#333333",
			sidebar: "#282828",
		}
	),
	makeDark(
		"slack-dark",
		"Slack Dark",
		{ bg: "#222222", surface: "#2a2a2a", primary: "#36c5f0", text: "#e6e6e6" },
		{
			bg: "#222222",
			fg: "#e6e6e6",
			card: "#2a2a2a",
			primary: "#36c5f0",
			primaryFg: "#222222",
			muted: "#141414",
			mutedFg: "#9c9c9c",
			border: "#333333",
			sidebar: "#2a2a2a",
		}
	),
	makeDark(
		"vitesse-dark",
		"Vitesse Dark",
		{ bg: "#121212", surface: "#181818", primary: "#4d9375", text: "#dbd7ca" },
		{
			bg: "#121212",
			fg: "#dbd7ca",
			card: "#181818",
			primary: "#4d9375",
			primaryFg: "#121212",
			muted: "#222222",
			mutedFg: "#758575",
			border: "#222222",
			sidebar: "#181818",
		}
	),
	makeDark(
		"vitesse-black",
		"Vitesse Black",
		{ bg: "#000000", surface: "#121212", primary: "#4d9375", text: "#dbd7ca" },
		{
			bg: "#000000",
			fg: "#dbd7ca",
			card: "#121212",
			primary: "#4d9375",
			primaryFg: "#000000",
			muted: "#161616",
			mutedFg: "#758575",
			border: "#1e1e1e",
			sidebar: "#121212",
		}
	),
	makeDark(
		"dark-plus",
		"Dark Plus",
		{ bg: "#1e1e1e", surface: "#252526", primary: "#007acc", text: "#d4d4d4" },
		{
			bg: "#1e1e1e",
			fg: "#d4d4d4",
			card: "#252526",
			primary: "#007acc",
			primaryFg: "#1e1e1e",
			muted: "#2d2d30",
			mutedFg: "#8a8a8a",
			border: "#333333",
			sidebar: "#252526",
		}
	),
	makeDark(
		"monokai",
		"Monokai",
		{ bg: "#272822", surface: "#383830", primary: "#f92672", text: "#f8f8f2" },
		{
			bg: "#272822",
			fg: "#f8f8f2",
			card: "#383830",
			primary: "#f92672",
			primaryFg: "#272822",
			muted: "#3e3d32",
			mutedFg: "#75715e",
			border: "#49483e",
			sidebar: "#383830",
		}
	),
	makeDark(
		"synthwave-84",
		"Synthwave '84",
		{ bg: "#262335", surface: "#241b2f", primary: "#36f9f6", text: "#ffffff" },
		{
			bg: "#262335",
			fg: "#ffffff",
			card: "#241b2f",
			primary: "#36f9f6",
			primaryFg: "#262335",
			muted: "#3a334f",
			mutedFg: "#848bbd",
			border: "#3a334f",
			sidebar: "#241b2f",
		}
	),
	makeDark(
		"horizon",
		"Horizon",
		{ bg: "#1c1e26", surface: "#232530", primary: "#e95678", text: "#d5d8da" },
		{
			bg: "#1c1e26",
			fg: "#d5d8da",
			card: "#232530",
			primary: "#e95678",
			primaryFg: "#1c1e26",
			muted: "#2e303e",
			mutedFg: "#b7b9c1",
			border: "#2e303e",
			sidebar: "#232530",
		}
	),
	makeDark(
		"poimandres",
		"Poimandres",
		{ bg: "#1b1e28", surface: "#21232e", primary: "#5de4c7", text: "#a6accd" },
		{
			bg: "#1b1e28",
			fg: "#a6accd",
			card: "#21232e",
			primary: "#5de4c7",
			primaryFg: "#1b1e28",
			muted: "#232530",
			mutedFg: "#767c9d",
			border: "#2a2f3a",
			sidebar: "#21232e",
		}
	),
	makeDark(
		"one-dark-pro",
		"One Dark Pro",
		{ bg: "#282c34", surface: "#21252b", primary: "#61afef", text: "#abb2bf" },
		{
			bg: "#282c34",
			fg: "#abb2bf",
			card: "#21252b",
			primary: "#61afef",
			primaryFg: "#282c34",
			muted: "#2c313c",
			mutedFg: "#5c6370",
			border: "#181a1f",
			sidebar: "#21252b",
		}
	),
	makeDark(
		"laserwave",
		"LaserWave",
		{ bg: "#27212e", surface: "#2f283a", primary: "#eb64b9", text: "#ffffff" },
		{
			bg: "#27212e",
			fg: "#ffffff",
			card: "#2f283a",
			primary: "#eb64b9",
			primaryFg: "#27212e",
			muted: "#3a3242",
			mutedFg: "#91889b",
			border: "#3a3048",
			sidebar: "#2f283a",
		}
	),
	makeDark(
		"houston",
		"Houston",
		{ bg: "#17191e", surface: "#23262d", primary: "#f78166", text: "#eef0f9" },
		{
			bg: "#17191e",
			fg: "#eef0f9",
			card: "#23262d",
			primary: "#f78166",
			primaryFg: "#17191e",
			muted: "#2b2f37",
			mutedFg: "#545864",
			border: "#2b2f37",
			sidebar: "#23262d",
		}
	),
	makeDark(
		"plastic",
		"Plastic",
		{ bg: "#21252b", surface: "#181a1f", primary: "#b57edc", text: "#a9b2c3" },
		{
			bg: "#21252b",
			fg: "#a9b2c3",
			card: "#181a1f",
			primary: "#b57edc",
			primaryFg: "#21252b",
			muted: "#2c3036",
			mutedFg: "#5f6672",
			border: "#3a3f47",
			sidebar: "#181a1f",
		}
	),
	makeDark(
		"red",
		"Red",
		{ bg: "#390000", surface: "#490000", primary: "#ec0d1e", text: "#f8f8f8" },
		{
			bg: "#390000",
			fg: "#f8f8f8",
			card: "#490000",
			primary: "#ec0d1e",
			primaryFg: "#390000",
			muted: "#580000",
			mutedFg: "#e7c0c0",
			border: "#750000",
			sidebar: "#490000",
		}
	),
	makeDark(
		"andromeeda",
		"Andromeeda",
		{ bg: "#23262e", surface: "#2a2e38", primary: "#00e8c6", text: "#d5ced9" },
		{
			bg: "#23262e",
			fg: "#d5ced9",
			card: "#2a2e38",
			primary: "#00e8c6",
			primaryFg: "#23262e",
			muted: "#2e323d",
			mutedFg: "#a0a1a7",
			border: "#3d4352",
			sidebar: "#2a2e38",
		}
	),

	makeDark(
		"amoled-dark",
		"AMOLED",
		{ bg: "#000000", surface: "#0a0a0a", primary: "#ffffff", text: "#ffffff" },
		{
			bg: "#000000",
			fg: "#ffffff",
			card: "#0a0a0a",
			primary: "#ffffff",
			primaryFg: "#000000",
			muted: "#111111",
			mutedFg: "#a0a0a0",
			border: "rgba(255,255,255,0.08)",
			sidebar: "#000000",
		}
	),

	// shadcn base color families
	makeLight(
		"slate-light",
		"Slate",
		{ bg: "#ffffff", surface: "#f8fafc", primary: "#0f172a", text: "#0f172a" },
		{
			bg: "#ffffff",
			fg: "#0f172a",
			card: "#f8fafc",
			primary: "#0f172a",
			primaryFg: "#f8fafc",
			muted: "#f1f5f9",
			mutedFg: "#64748b",
			border: "#e2e8f0",
			sidebar: "#f8fafc",
		}
	),
	makeDark(
		"slate-dark",
		"Slate",
		{ bg: "#0f172a", surface: "#1e293b", primary: "#f8fafc", text: "#f8fafc" },
		{
			bg: "#0f172a",
			fg: "#f8fafc",
			card: "#1e293b",
			primary: "#f8fafc",
			primaryFg: "#0f172a",
			muted: "#1e293b",
			mutedFg: "#94a3b8",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#1e293b",
		}
	),

	makeLight(
		"stone-light",
		"Stone",
		{ bg: "#ffffff", surface: "#fafaf9", primary: "#1c1917", text: "#1c1917" },
		{
			bg: "#ffffff",
			fg: "#1c1917",
			card: "#fafaf9",
			primary: "#1c1917",
			primaryFg: "#fafaf9",
			muted: "#f5f5f4",
			mutedFg: "#78716c",
			border: "#e7e5e4",
			sidebar: "#fafaf9",
		}
	),
	makeDark(
		"stone-dark",
		"Stone",
		{ bg: "#1c1917", surface: "#292524", primary: "#e7e5e4", text: "#fafaf9" },
		{
			bg: "#1c1917",
			fg: "#fafaf9",
			card: "#292524",
			primary: "#e7e5e4",
			primaryFg: "#292524",
			muted: "#292524",
			mutedFg: "#a8a29e",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#292524",
		}
	),

	makeLight(
		"gray-light",
		"Gray",
		{ bg: "#ffffff", surface: "#f9fafb", primary: "#111827", text: "#111827" },
		{
			bg: "#ffffff",
			fg: "#111827",
			card: "#f9fafb",
			primary: "#111827",
			primaryFg: "#f9fafb",
			muted: "#f3f4f6",
			mutedFg: "#6b7280",
			border: "#e5e7eb",
			sidebar: "#f9fafb",
		}
	),
	makeDark(
		"gray-dark",
		"Gray",
		{ bg: "#111827", surface: "#1f2937", primary: "#f9fafb", text: "#f9fafb" },
		{
			bg: "#111827",
			fg: "#f9fafb",
			card: "#1f2937",
			primary: "#f9fafb",
			primaryFg: "#1f2937",
			muted: "#1f2937",
			mutedFg: "#9ca3af",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#1f2937",
		}
	),

	makeLight(
		"red-light",
		"Red",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#dc2626", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#dc2626",
			primaryFg: "#fef2f2",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"red-dark",
		"Red",
		{ bg: "#18181b", surface: "#27272a", primary: "#ef4444", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#ef4444",
			primaryFg: "#fef2f2",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),

	makeLight(
		"rose-light",
		"Rose",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#e11d48", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#e11d48",
			primaryFg: "#fff1f2",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"rose-dark",
		"Rose",
		{ bg: "#18181b", surface: "#27272a", primary: "#fb7185", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#fb7185",
			primaryFg: "#fff1f2",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),

	makeLight(
		"orange-light",
		"Orange",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#ea580c", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#ea580c",
			primaryFg: "#fff7ed",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"orange-dark",
		"Orange",
		{ bg: "#18181b", surface: "#27272a", primary: "#fb923c", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#fb923c",
			primaryFg: "#fff7ed",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),

	makeLight(
		"green-light",
		"Green",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#16a34a", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#16a34a",
			primaryFg: "#f0fdf4",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"green-dark",
		"Green",
		{ bg: "#18181b", surface: "#27272a", primary: "#4ade80", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#4ade80",
			primaryFg: "#052e16",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),

	makeLight(
		"blue-light",
		"Blue",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#2563eb", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#2563eb",
			primaryFg: "#eff6ff",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"blue-dark",
		"Blue",
		{ bg: "#18181b", surface: "#27272a", primary: "#60a5fa", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#60a5fa",
			primaryFg: "#eff6ff",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),

	makeLight(
		"violet-light",
		"Violet",
		{ bg: "#ffffff", surface: "#fafafa", primary: "#7c3aed", text: "#18181b" },
		{
			bg: "#ffffff",
			fg: "#18181b",
			card: "#fafafa",
			primary: "#7c3aed",
			primaryFg: "#f5f3ff",
			muted: "#f4f4f5",
			mutedFg: "#71717a",
			border: "#e4e4e7",
			sidebar: "#fafafa",
		}
	),
	makeDark(
		"violet-dark",
		"Violet",
		{ bg: "#18181b", surface: "#27272a", primary: "#a78bfa", text: "#fafafa" },
		{
			bg: "#18181b",
			fg: "#fafafa",
			card: "#27272a",
			primary: "#a78bfa",
			primaryFg: "#f5f3ff",
			muted: "#3f3f46",
			mutedFg: "#a1a1aa",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#27272a",
		}
	),
];

export const LIGHT_VARIANTS = THEME_VARIANTS.filter((v) => v.mode === "light");
export const DARK_VARIANTS = THEME_VARIANTS.filter((v) => v.mode === "dark");

export const DEFAULT_LIGHT_ID = "ryu-light";
export const DEFAULT_DARK_ID = "ryu-dark";

/**
 * Resolve a variant by id against the built-ins plus any custom variants the
 * caller supplies. Pure: the caller owns where custom themes come from
 * (localStorage on desktop, the synced prefs blob on island).
 */
export function findVariantIn(
	id: string,
	customThemes: ThemeVariant[] = []
): ThemeVariant | undefined {
	return (
		THEME_VARIANTS.find((v) => v.id === id) ??
		customThemes.find((v) => v.id === id)
	);
}

export function builtinVariants(mode: "light" | "dark"): ThemeVariant[] {
	return THEME_VARIANTS.filter((v) => v.mode === mode);
}

export interface CustomTokens {
	background: string;
	border: string;
	foreground: string;
	muted: string;
	mutedForeground: string;
	primary: string;
	/** Explicit focus-ring colour. Omitted → derived from `primary`, adjusted to
	 * reach 3:1 against the theme's surfaces (see `accessibleRingColor`). */
	ring?: string;
	sidebar: string;
}

const HEX_6_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_3_RE = /^#[0-9a-fA-F]{3}$/;
const OKLCH_RE = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/;
const RGBA_CHANNEL_RE = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;

function channelToHex(v: number): string {
	return Math.round(Math.min(1, Math.max(0, v)) * 255)
		.toString(16)
		.padStart(2, "0");
}

function linearToSrgb(x: number): number {
	return x <= 0.003_130_8 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** OKLCH → sRGB hex (Björn Ottosson OKLab matrices). Lightness may be 0–1 or %. */
function oklchToHex(lRaw: string, cRaw: string, hRaw: string): string {
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

export function colorToHex(color: string): string | null {
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
		const [, r, g, b] = rgba;
		if (r === undefined || g === undefined || b === undefined) {
			return null;
		}
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}
	const oklchMatch = color.match(OKLCH_RE);
	if (oklchMatch) {
		const [, lightness, chroma, hue] = oklchMatch;
		if (lightness === undefined || chroma === undefined || hue === undefined) {
			return null;
		}
		return oklchToHex(lightness, chroma, hue);
	}
	return null;
}

export function relativeLuminance(hex: string): number {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Pick black or white ink for text/icons on `color`. Uses relative luminance
 * of the resolved sRGB hex — not theme mode — so a dark-mode blue primary
 * still gets light ink (Switch thumbs read `--primary-foreground`).
 * Falls back to mode when the colour string cannot be parsed.
 */
export function contrastForeground(
	color: string,
	mode: "light" | "dark"
): string {
	const hex = colorToHex(color);
	if (!hex) {
		return mode === "light" ? "#ffffff" : "#000000";
	}
	return relativeLuminance(hex) > 0.5 ? "#000000" : "#ffffff";
}

export function customTokensToVariant(
	id: string,
	label: string,
	mode: "light" | "dark",
	t: CustomTokens
): ThemeVariant {
	const card = t.sidebar;
	const primaryFg = contrastForeground(t.primary, mode);
	const ring =
		t.ring ??
		accessibleRingColor(t.primary, [t.background, card, t.sidebar], mode);
	return {
		id,
		label,
		mode,
		preview: {
			bg: t.background,
			surface: t.sidebar,
			primary: t.primary,
			text: t.foreground,
		},
		tokens: {
			"--background": t.background,
			"--foreground": t.foreground,
			"--card": card,
			"--card-foreground": t.foreground,
			"--popover": card,
			"--popover-foreground": t.foreground,
			"--primary": t.primary,
			"--primary-foreground": primaryFg,
			"--secondary": t.muted,
			"--secondary-foreground": t.foreground,
			"--muted": t.muted,
			"--muted-foreground": t.mutedForeground,
			"--accent": t.muted,
			"--accent-foreground": t.foreground,
			"--destructive": mode === "light" ? "#ef4444" : "#f87171",
			"--border": t.border,
			"--input": t.border,
			"--ring": ring,
			"--sidebar": t.sidebar,
			"--sidebar-foreground": t.foreground,
			"--sidebar-primary": t.primary,
			"--sidebar-primary-foreground": primaryFg,
			"--sidebar-accent": t.muted,
			"--sidebar-accent-foreground": t.foreground,
			"--sidebar-border": t.border,
			"--sidebar-ring": ring,
		},
	};
}

export function variantToCustomTokens(variant: ThemeVariant): CustomTokens {
	return {
		background: variant.tokens["--background"] ?? "#ffffff",
		foreground: variant.tokens["--foreground"] ?? "#000000",
		primary: variant.tokens["--primary"] ?? "#000000",
		muted: variant.tokens["--muted"] ?? "#f4f4f5",
		mutedForeground: variant.tokens["--muted-foreground"] ?? "#71717a",
		border: variant.tokens["--border"] ?? "#e4e4e7",
		sidebar: variant.tokens["--sidebar"] ?? "#f9f9f9",
	};
}
