import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";

export const UI_FONT = "font-bold font-sans";

/** A small wooden plank button that presses down. */
export const PLANK_BUTTON = cn(
	"inline-flex items-center gap-1.5 text-[13px] leading-none outline-none transition-transform hover:brightness-110 focus-visible:outline-3 focus-visible:outline-[#ffd25e] focus-visible:outline-offset-1 active:translate-y-[2px]",
	UI_FONT
);

/** Wooden backing behind the frames: horizontal planks on the pixel grid. */
export const PANEL_BACKING = {
	backgroundColor: "#6b3a1c",
	backgroundImage:
		"repeating-linear-gradient(180deg, #7a4421 0 21px, #5b2f15 21px 24px), repeating-linear-gradient(90deg, transparent 0 117px, #4e2711 117px 120px)",
} as const;

/**
 * The host's design tokens, re-pointed at the dialogue box's parchment and
 * wood, so the real chat inside the panel (still the host's component)
 * reads as part of the dialogue box: parchment page, brown ink, wood-orange
 * accents, tan rules.
 */
export const PARCHMENT_TOKENS: CSSProperties & Record<`--${string}`, string> = {
	"--accent": "#f7d798",
	"--accent-foreground": "#3d1f0d",
	"--background": "#fbe9c4",
	"--border": "#d9a25a",
	"--card": "#fff3d6",
	"--card-foreground": "#3d1f0d",
	"--foreground": "#3d1f0d",
	"--input": "#d9a25a",
	"--muted": "#f3d49a",
	"--muted-foreground": "#7a4a24",
	"--popover": "#fff3d6",
	"--popover-foreground": "#3d1f0d",
	"--primary": "#b5651d",
	"--primary-foreground": "#fff4d6",
	"--ring": "#5b2a0b",
	"--secondary": "#f3d49a",
	"--secondary-foreground": "#3d1f0d",
	colorScheme: "light",
};
