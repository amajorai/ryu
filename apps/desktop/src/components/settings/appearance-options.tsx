import { FileTree, useFileTree } from "@pierre/trees/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import {
	type FileTreePrefs,
	fileTreePrefsToOptions,
} from "@/src/hooks/useFileTreePrefs.ts";

// Where the chat model & agent picker sits. Passed to the Select as `items` so
// the closed trigger names the stored choice instead of printing its raw value.
export const CHAT_PICKER_PLACEMENT_OPTIONS = [
	{ value: "composer", label: "In composer" },
	{ value: "tab-bar", label: "In tab bar actions tray" },
] as const;

// Diff viewer (`@pierre/diffs`) option lists for the Appearance selects.
export const DIFF_STYLE_OPTIONS = [
	{ value: "split", label: "Split (side-by-side)" },
	{ value: "unified", label: "Stacked (inline)" },
] as const;
export const DIFF_INDICATOR_OPTIONS = [
	{ value: "bars", label: "Bars" },
	{ value: "classic", label: "Classic (+/−)" },
	{ value: "none", label: "None" },
] as const;
export const DIFF_LINE_DIFF_OPTIONS = [
	{ value: "word", label: "Word" },
	{ value: "word-alt", label: "Word (alternate)" },
	{ value: "char", label: "Character" },
	{ value: "none", label: "Off" },
] as const;
export const DIFF_HUNK_SEPARATOR_OPTIONS = [
	{ value: "simple", label: "Simple" },
	{ value: "metadata", label: "Metadata" },
	{ value: "line-info", label: "Line info" },
	{ value: "line-info-basic", label: "Line info (basic)" },
] as const;
export const DIFF_THEME_OPTIONS = [
	{ value: "system", label: "Auto (match app)" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
] as const;

// A tiny single-file patch rendered live in the Diff viewer settings section so
// changes (layout, markers, wrap, …) are visible instantly. Covers context,
// additions and deletions so every indicator has something to show.
export const DIFF_PREVIEW_PATCH = `diff --git a/greeting.ts b/greeting.ts
index 1a2b3c4..5d6e7f8 100644
--- a/greeting.ts
+++ b/greeting.ts
@@ -1,4 +1,4 @@
 export function greeting(name: string) {
-  const message = "Hello, " + name;
-  return message;
+  const message = \`Hello, \${name}!\`;
+  return message.trim();
 }
`;

// File tree (`@pierre/trees`) option lists for the Appearance selects.
export const FILE_TREE_DENSITY_OPTIONS = [
	{ value: "compact", label: "Compact" },
	{ value: "default", label: "Default" },
	{ value: "relaxed", label: "Relaxed" },
] as const;
export const FILE_TREE_ICON_OPTIONS = [
	{ value: "standard", label: "Standard" },
	{ value: "minimal", label: "Minimal" },
	{ value: "complete", label: "Complete" },
	{ value: "none", label: "No icons" },
] as const;
export const FILE_TREE_SEARCH_MODE_OPTIONS = [
	{ value: "expand-matches", label: "Expand matches" },
	{ value: "collapse-non-matches", label: "Collapse non-matches" },
	{ value: "hide-non-matches", label: "Hide non-matches" },
] as const;
export const FILE_TREE_EXPANSION_OPTIONS = [
	{ value: "closed", label: "Collapsed" },
	{ value: "open", label: "Expanded" },
] as const;

// A small sample tree rendered live in the File tree settings section.
export const FILE_TREE_PREVIEW_PATHS = [
	"src/components/Button.tsx",
	"src/components/Card.tsx",
	"src/hooks/useTheme.ts",
	"src/index.ts",
	"package.json",
	"README.md",
] as const;

// The preview builds its model from static paths, so no `resetPaths` is needed;
// remounting it (via a `key` on the prefs) applies the constructor-time options.
export function FileTreePreview({
	prefs,
	style,
	className,
}: {
	prefs: FileTreePrefs;
	style?: CSSProperties;
	className?: string;
}) {
	const { model } = useFileTree({
		...fileTreePrefsToOptions(prefs),
		paths: [...FILE_TREE_PREVIEW_PATHS],
	});
	return (
		<FileTree
			className={cn("h-full w-full", className)}
			model={model}
			style={style}
		/>
	);
}
