// Single source of truth for the TUI's visual theme.
//
// termcn components read their colors from the vendored ThemeProvider via
// useTheme() (theme.colors.primary, theme.colors.border, ...). Rather than run a
// second parallel theme system, we adopt that provider as canonical and feed it a
// Ryu-branded Theme built with termcn's createTheme(). The App wraps the tree in
// <ThemeProvider theme={ryuTheme}> (see App.tsx); tabs then read tokens with
// `useTheme()` imported from "@/components/ui/theme-provider". This module just
// defines ryuTheme so there is exactly one place colors live.

import { createTheme, type Theme } from "@/components/ui/theme-provider.tsx";

// Ryu brand palette. Keeps termcn's well-tuned semantic colors (success/warning/
// error/info) and overrides the brand purple + neutral surfaces to match Ryu.
export const ryuTheme: Theme = createTheme({
	name: "ryu",
	colors: {
		primary: "#A78BFA",
		primaryForeground: "#0B0B12",
		accent: "#8B5CF6",
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
		border: "#3A3D4D",
		focusRing: "#A78BFA",
		selection: "#7C3AED",
		selectionForeground: "#FFFFFF",
	},
	border: {
		style: "round",
		color: "#3A3D4D",
		focusColor: "#A78BFA",
	},
});
