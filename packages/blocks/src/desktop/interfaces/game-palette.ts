import { GAME_DISPLAY_FAMILY } from "./game-font.ts";

/**
 * The game kit's HUD palette: the one file where the kit's literal colours
 * live. Game HUDs (title plates, counters, the primary action, legend chips
 * and the side sheet's frame) are painted from these custom properties so
 * every game shares one chunky, high-contrast look. Each game's own art keeps
 * its own palette file; the sheet's body (the host's conversation, composers
 * and lists) stays on the user's theme tokens.
 *
 * Two moods follow the theme without reading it in JavaScript: light themes
 * are day (cream plates with a dark outline), dark themes (`.dark`) are night
 * (deep slate plates with a black outline). A game picks one accent for its
 * primary action with `data-game-accent` on the shell. Paper (tickets,
 * signs, cards in the world) keeps dark ink in both moods.
 */

/** The accents a game can choose for its primary action. */
export type GameAccent = "grape" | "leaf" | "sky" | "sun" | "tomato";

type Mood = Record<string, string>;

const SCOPE = "[data-game-shell]";

const DAY: Mood = {
	backdrop: "#efe4cf",
	bad: "#d9412f",
	edge: "#3b2a1e",
	focus: "#1f6feb",
	gold: "#e9a821",
	good: "#2f9a4c",
	info: "#2f78d0",
	ink: "#2b1f16",
	"ink-muted": "#6a5444",
	"ink-soft": "#8a7462",
	paper: "#fffdf6",
	"paper-edge": "#d8c7a6",
	"paper-ink": "#2b1f16",
	"paper-ink-muted": "#6a5444",
	plate: "#fff8ea",
	"plate-sunk": "#f1e5cd",
	shadow: "rgb(59 42 30 / 0.3)",
	warn: "#e08a12",
};

const NIGHT: Mood = {
	backdrop: "#141a28",
	bad: "#ff6a55",
	edge: "#05070d",
	focus: "#ffd84d",
	gold: "#ffc94a",
	good: "#4fd07a",
	info: "#62a8ff",
	ink: "#f7f0e3",
	"ink-muted": "#bcb2a2",
	"ink-soft": "#958b7d",
	paper: "#f1e9d8",
	"paper-edge": "#a89a80",
	"paper-ink": "#2b1f16",
	"paper-ink-muted": "#66503f",
	plate: "#222a3d",
	"plate-sunk": "#171d2c",
	shadow: "rgb(0 0 0 / 0.55)",
	warn: "#ffb03b",
};

/** Fill, the darker lip under it, and the text on it. */
const ACCENTS: Record<GameAccent, { edge: string; fill: string; ink: string }> =
	{
		grape: { edge: "#5b2f9e", fill: "#7d48d6", ink: "#ffffff" },
		leaf: { edge: "#2b6e31", fill: "#3b9444", ink: "#ffffff" },
		sky: { edge: "#1d5aa6", fill: "#2d74cc", ink: "#ffffff" },
		sun: { edge: "#b77f0b", fill: "#ffc53d", ink: "#2b1f16" },
		tomato: { edge: "#a93516", fill: "#dc4f26", ink: "#ffffff" },
	};

function declarations(mood: Mood): string {
	return Object.entries(mood)
		.map(([name, value]) => `--gk-${name}: ${value};`)
		.join("\n");
}

function accentRules(): string {
	return Object.entries(ACCENTS)
		.map(
			([name, accent]) =>
				`${SCOPE}[data-game-accent="${name}"] { --gk-accent: ${accent.fill}; --gk-accent-edge: ${accent.edge}; --gk-accent-ink: ${accent.ink}; }`
		)
		.join("\n");
}

/**
 * The kit stylesheet: both moods, the accents, the display face and the few
 * rules Tailwind cannot express (the plate's lip). Rendered once per shell.
 */
export const GAME_KIT_CSS = `
${SCOPE} {
${declarations(DAY)}
--gk-font: "${GAME_DISPLAY_FAMILY}", ui-rounded, var(--font-heading, var(--font-sans)), system-ui, sans-serif;
--gk-lip: 0 3px 0 var(--gk-edge), 0 10px 24px -8px var(--gk-shadow);
--gk-lip-pressed: 0 1px 0 var(--gk-edge), 0 4px 10px -6px var(--gk-shadow);
}
.dark ${SCOPE}, ${SCOPE}.dark {
${declarations(NIGHT)}
}
${accentRules()}
${SCOPE} .gk-display { font-family: var(--gk-font); font-weight: 600; letter-spacing: 0.005em; font-synthesis: none; }
${SCOPE} .gk-action { box-shadow: 0 4px 0 var(--gk-accent-edge), 0 0 0 2px var(--gk-edge), 0 12px 22px -10px var(--gk-shadow); }
${SCOPE} .gk-action:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 1px 0 var(--gk-accent-edge), 0 0 0 2px var(--gk-edge); }
@media (prefers-reduced-motion: reduce) {
${SCOPE} .gk-action:active:not(:disabled) { transform: none; }
}
`;
