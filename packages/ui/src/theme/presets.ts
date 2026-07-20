// Shared theme presets: the single source of truth for theme variants across
// every Ryu surface (desktop, island, ...). Keep this module pure — no
// `localStorage`, no `document`, no `window` — so it is safe to import from any
// renderer or process. DOM application lives in `./apply`, persistence shape in
// `./prefs`.

type Tokens = Record<string, string>;

export interface ThemeVariant {
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
			"--ring": p.primary,
			"--sidebar": p.sidebar,
			"--sidebar-foreground": p.fg,
			"--sidebar-primary": p.primary,
			"--sidebar-primary-foreground": p.primaryFg,
			"--sidebar-accent": p.muted,
			"--sidebar-accent-foreground": p.fg,
			"--sidebar-border": p.border,
			"--sidebar-ring": p.primary,
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
			primary: "#0088ff",
			text: "#18181b",
		},
		tokens: {
			"--background": "oklch(1 0 0)",
			"--foreground": "oklch(0.141 0.005 285.823)",
			"--card": "oklch(1 0 0)",
			"--card-foreground": "oklch(0.141 0.005 285.823)",
			"--popover": "oklch(1 0 0)",
			"--popover-foreground": "oklch(0.141 0.005 285.823)",
			"--primary": "oklch(0.6321 0.2018 254.09)",
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
			"--ring": "oklch(0.708 0 0)",
			"--sidebar": "oklch(0.985 0 0)",
			"--sidebar-foreground": "oklch(0.141 0.005 285.823)",
			"--sidebar-primary": "oklch(0.546 0.245 262.881)",
			"--sidebar-primary-foreground": "oklch(0.97 0.014 254.604)",
			"--sidebar-accent": "oklch(0.967 0.001 286.375)",
			"--sidebar-accent-foreground": "oklch(0.21 0.006 285.885)",
			"--sidebar-border": "oklch(0.92 0.004 286.32)",
			"--sidebar-ring": "oklch(0.708 0 0)",
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
			"--muted-foreground": "oklch(0.556 0 0)",
			"--accent": "oklch(0.97 0 0)",
			"--accent-foreground": "oklch(0.205 0 0)",
			"--destructive": "oklch(0.577 0.245 27.325)",
			"--border": "oklch(0.922 0 0)",
			"--input": "oklch(0.922 0 0)",
			"--ring": "oklch(0.708 0 0)",
			"--sidebar": "oklch(0.985 0 0)",
			"--sidebar-foreground": "oklch(0.145 0 0)",
			"--sidebar-primary": "oklch(0.205 0 0)",
			"--sidebar-primary-foreground": "oklch(0.985 0 0)",
			"--sidebar-accent": "oklch(0.97 0 0)",
			"--sidebar-accent-foreground": "oklch(0.205 0 0)",
			"--sidebar-border": "oklch(0.922 0 0)",
			"--sidebar-ring": "oklch(0.708 0 0)",
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
			primary: "#0088ff",
			text: "#fafafa",
		},
		tokens: {
			"--background": "oklch(19.212% 0.00401 285.944)",
			"--foreground": "oklch(0.985 0 0)",
			"--card": "oklch(0.21 0.006 285.885)",
			"--card-foreground": "oklch(0.985 0 0)",
			"--popover": "oklch(0.21 0.006 285.885)",
			"--popover-foreground": "oklch(0.985 0 0)",
			"--primary": "oklch(0.6321 0.2018 254.09)",
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
			"--sidebar-primary": "oklch(0.623 0.214 259.815)",
			"--sidebar-primary-foreground": "oklch(0.97 0.014 254.604)",
			"--sidebar-accent": "oklch(0.274 0.006 286.033)",
			"--sidebar-accent-foreground": "oklch(0.985 0 0)",
			"--sidebar-border": "oklch(1 0 0 / 10%)",
			"--sidebar-ring": "oklch(0.439 0 0)",
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
			"--sidebar-primary": "oklch(0.488 0.243 264.376)",
			"--sidebar-primary-foreground": "oklch(0.985 0 0)",
			"--sidebar-accent": "oklch(0.269 0 0)",
			"--sidebar-accent-foreground": "oklch(0.985 0 0)",
			"--sidebar-border": "oklch(1 0 0 / 10%)",
			"--sidebar-ring": "oklch(0.556 0 0)",
		},
	},

	makeLight(
		"codex-light",
		"Codex",
		{ bg: "#ffffff", surface: "#f5f5f5", primary: "#10a37f", text: "#1a1a1a" },
		{
			bg: "#ffffff",
			fg: "#1a1a1a",
			card: "#f5f5f5",
			primary: "#10a37f",
			primaryFg: "#ffffff",
			muted: "#ebebeb",
			mutedFg: "#737373",
			border: "#d9d9d9",
			sidebar: "#f5f5f5",
		}
	),
	makeDark(
		"codex-dark",
		"Codex",
		{ bg: "#202123", surface: "#2a2b32", primary: "#10a37f", text: "#ececec" },
		{
			bg: "#202123",
			fg: "#ececec",
			card: "#2a2b32",
			primary: "#10a37f",
			primaryFg: "#ffffff",
			muted: "#343541",
			mutedFg: "#acacbe",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#2a2b32",
		}
	),

	makeLight(
		"claude-light",
		"Claude",
		{ bg: "#fdf9f6", surface: "#f5ede3", primary: "#cc5c38", text: "#1a1612" },
		{
			bg: "#fdf9f6",
			fg: "#1a1612",
			card: "#f5ede3",
			primary: "#cc5c38",
			primaryFg: "#fdf9f6",
			muted: "#f0e8de",
			mutedFg: "#8c7b6b",
			border: "#e8ddd4",
			sidebar: "#f5ede3",
		}
	),
	makeDark(
		"claude-dark",
		"Claude",
		{ bg: "#1c1917", surface: "#292421", primary: "#e06b46", text: "#f5f0e8" },
		{
			bg: "#1c1917",
			fg: "#f5f0e8",
			card: "#292421",
			primary: "#e06b46",
			primaryFg: "#fdf9f6",
			muted: "#332d28",
			mutedFg: "#9c8c7a",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#292421",
		}
	),

	makeLight(
		"ayu-light",
		"Ayu",
		{ bg: "#fafafa", surface: "#f0f0f0", primary: "#ff9940", text: "#5c6166" },
		{
			bg: "#fafafa",
			fg: "#5c6166",
			card: "#f0f0f0",
			primary: "#ff9940",
			primaryFg: "#fafafa",
			muted: "#e8e8e8",
			mutedFg: "#8a9099",
			border: "#d8d8d8",
			sidebar: "#f0f0f0",
		}
	),
	makeDark(
		"ayu-dark",
		"Ayu",
		{ bg: "#1f2430", surface: "#242b38", primary: "#ffd173", text: "#cbccc6" },
		{
			bg: "#1f2430",
			fg: "#cbccc6",
			card: "#242b38",
			primary: "#ffd173",
			primaryFg: "#1f2430",
			muted: "#2a3241",
			mutedFg: "#707a8c",
			border: "rgba(255,255,255,0.08)",
			sidebar: "#242b38",
		}
	),

	makeLight(
		"catppuccin-light",
		"Catppuccin",
		{ bg: "#eff1f5", surface: "#e6e9ef", primary: "#1e66f5", text: "#4c4f69" },
		{
			bg: "#eff1f5",
			fg: "#4c4f69",
			card: "#e6e9ef",
			primary: "#1e66f5",
			primaryFg: "#eff1f5",
			muted: "#ccd0da",
			mutedFg: "#6c6f85",
			border: "#bcc0cc",
			sidebar: "#e6e9ef",
		}
	),
	makeDark(
		"catppuccin-dark",
		"Catppuccin",
		{ bg: "#1e1e2e", surface: "#181825", primary: "#cba6f7", text: "#cdd6f4" },
		{
			bg: "#1e1e2e",
			fg: "#cdd6f4",
			card: "#181825",
			primary: "#cba6f7",
			primaryFg: "#1e1e2e",
			muted: "#313244",
			mutedFg: "#7f849c",
			border: "rgba(255,255,255,0.08)",
			sidebar: "#181825",
		}
	),

	makeLight(
		"dracula-light",
		"Dracula",
		{ bg: "#f8f8f2", surface: "#eeeeee", primary: "#bd93f9", text: "#282a36" },
		{
			bg: "#f8f8f2",
			fg: "#282a36",
			card: "#eeeeee",
			primary: "#bd93f9",
			primaryFg: "#282a36",
			muted: "#e4e4e4",
			mutedFg: "#6272a4",
			border: "#d8d8d8",
			sidebar: "#eeeeee",
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
			border: "rgba(255,255,255,0.1)",
			sidebar: "#21222c",
		}
	),

	makeLight(
		"github-light",
		"GitHub",
		{ bg: "#ffffff", surface: "#f6f8fa", primary: "#0969da", text: "#24292f" },
		{
			bg: "#ffffff",
			fg: "#24292f",
			card: "#f6f8fa",
			primary: "#0969da",
			primaryFg: "#ffffff",
			muted: "#eaecef",
			mutedFg: "#6e7781",
			border: "#d0d7de",
			sidebar: "#f6f8fa",
		}
	),
	makeDark(
		"github-dark",
		"GitHub",
		{ bg: "#0d1117", surface: "#161b22", primary: "#1f6feb", text: "#e6edf3" },
		{
			bg: "#0d1117",
			fg: "#e6edf3",
			card: "#161b22",
			primary: "#1f6feb",
			primaryFg: "#ffffff",
			muted: "#21262d",
			mutedFg: "#8b949e",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#161b22",
		}
	),

	makeLight(
		"linear-light",
		"Linear",
		{ bg: "#ffffff", surface: "#f7f7f8", primary: "#5e6ad2", text: "#1c1c21" },
		{
			bg: "#ffffff",
			fg: "#1c1c21",
			card: "#f7f7f8",
			primary: "#5e6ad2",
			primaryFg: "#ffffff",
			muted: "#ebebef",
			mutedFg: "#717175",
			border: "#dfe1ea",
			sidebar: "#f7f7f8",
		}
	),
	makeDark(
		"linear-dark",
		"Linear",
		{ bg: "#101012", surface: "#1a1a27", primary: "#5e6ad2", text: "#e8e8f0" },
		{
			bg: "#101012",
			fg: "#e8e8f0",
			card: "#1a1a27",
			primary: "#5e6ad2",
			primaryFg: "#ffffff",
			muted: "#1d1d2e",
			mutedFg: "#7b7b93",
			border: "rgba(255,255,255,0.08)",
			sidebar: "#1a1a27",
		}
	),

	makeLight(
		"nord-light",
		"Nord",
		{ bg: "#eceff4", surface: "#e5e9f0", primary: "#5e81ac", text: "#2e3440" },
		{
			bg: "#eceff4",
			fg: "#2e3440",
			card: "#e5e9f0",
			primary: "#5e81ac",
			primaryFg: "#eceff4",
			muted: "#d8dee9",
			mutedFg: "#4c566a",
			border: "#d0d6e0",
			sidebar: "#e5e9f0",
		}
	),
	makeDark(
		"nord-dark",
		"Nord",
		{ bg: "#2e3440", surface: "#3b4252", primary: "#81a1c1", text: "#eceff4" },
		{
			bg: "#2e3440",
			fg: "#eceff4",
			card: "#3b4252",
			primary: "#81a1c1",
			primaryFg: "#2e3440",
			muted: "#434c5e",
			mutedFg: "#8a9bb0",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#3b4252",
		}
	),

	makeLight(
		"notion-light",
		"Notion",
		{ bg: "#ffffff", surface: "#f7f6f3", primary: "#2383e2", text: "#37352f" },
		{
			bg: "#ffffff",
			fg: "#37352f",
			card: "#f7f6f3",
			primary: "#2383e2",
			primaryFg: "#ffffff",
			muted: "#f1f0ee",
			mutedFg: "#9b9a97",
			border: "#e9e9e7",
			sidebar: "#f7f6f3",
		}
	),
	makeDark(
		"notion-dark",
		"Notion",
		{ bg: "#191919", surface: "#202020", primary: "#529cca", text: "#e6e6e5" },
		{
			bg: "#191919",
			fg: "#e6e6e5",
			card: "#202020",
			primary: "#529cca",
			primaryFg: "#191919",
			muted: "#2a2a2a",
			mutedFg: "#9b9a97",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#202020",
		}
	),

	makeLight(
		"one-light",
		"One",
		{ bg: "#fafafa", surface: "#f0f0f0", primary: "#4078f2", text: "#383a42" },
		{
			bg: "#fafafa",
			fg: "#383a42",
			card: "#f0f0f0",
			primary: "#4078f2",
			primaryFg: "#ffffff",
			muted: "#e5e5e5",
			mutedFg: "#696c77",
			border: "#d9d9d9",
			sidebar: "#f0f0f0",
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
			muted: "#2c313a",
			mutedFg: "#5c6370",
			border: "rgba(255,255,255,0.08)",
			sidebar: "#21252b",
		}
	),

	makeLight(
		"raycast-light",
		"Raycast",
		{ bg: "#ffffff", surface: "#f5f5f5", primary: "#ff6363", text: "#1c1c1e" },
		{
			bg: "#ffffff",
			fg: "#1c1c1e",
			card: "#f5f5f5",
			primary: "#ff6363",
			primaryFg: "#ffffff",
			muted: "#ebebeb",
			mutedFg: "#8e8e93",
			border: "#d9d9d9",
			sidebar: "#f5f5f5",
		}
	),
	makeDark(
		"raycast-dark",
		"Raycast",
		{ bg: "#1c1c1e", surface: "#2c2c2e", primary: "#ff6363", text: "#ebebeb" },
		{
			bg: "#1c1c1e",
			fg: "#ebebeb",
			card: "#2c2c2e",
			primary: "#ff6363",
			primaryFg: "#1c1c1e",
			muted: "#3a3a3c",
			mutedFg: "#8e8e93",
			border: "rgba(255,255,255,0.1)",
			sidebar: "#2c2c2e",
		}
	),

	makeLight(
		"tokyo-light",
		"Tokyo Night",
		{ bg: "#d5d6db", surface: "#c8ccd8", primary: "#2ac3de", text: "#343b58" },
		{
			bg: "#d5d6db",
			fg: "#343b58",
			card: "#c8ccd8",
			primary: "#2ac3de",
			primaryFg: "#d5d6db",
			muted: "#b8bdd0",
			mutedFg: "#5a607e",
			border: "#a8b0c8",
			sidebar: "#c8ccd8",
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
			border: "rgba(255,255,255,0.08)",
			sidebar: "#16161e",
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
	sidebar: string;
}

export function customTokensToVariant(
	id: string,
	label: string,
	mode: "light" | "dark",
	t: CustomTokens
): ThemeVariant {
	const card = t.sidebar;
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
			"--primary-foreground": mode === "light" ? "#ffffff" : "#000000",
			"--secondary": t.muted,
			"--secondary-foreground": t.foreground,
			"--muted": t.muted,
			"--muted-foreground": t.mutedForeground,
			"--accent": t.muted,
			"--accent-foreground": t.foreground,
			"--destructive": mode === "light" ? "#ef4444" : "#f87171",
			"--border": t.border,
			"--input": t.border,
			"--ring": t.primary,
			"--sidebar": t.sidebar,
			"--sidebar-foreground": t.foreground,
			"--sidebar-primary": t.primary,
			"--sidebar-primary-foreground": mode === "light" ? "#ffffff" : "#000000",
			"--sidebar-accent": t.muted,
			"--sidebar-accent-foreground": t.foreground,
			"--sidebar-border": t.border,
			"--sidebar-ring": t.primary,
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
