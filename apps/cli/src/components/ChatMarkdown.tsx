/* @jsxImportSource @opentui/react */

// ChatMarkdown - transcript markdown on OpenTUI's native <markdown> renderable.
//
// The vendored termcn Markdown stacks every inline segment (bold, code, link)
// on its own row, so chat replies render on OpenTUI's MarkdownRenderable
// instead: inline runs stay on one wrapped line, syntax markers are concealed,
// tables draw as a grid, and `streaming` keeps only the trailing block unstable
// while tokens arrive. Colors come from the active theme tokens.

import {
	type MarkdownTableOptions,
	type StyleDefinitionInput,
	SyntaxStyle,
} from "@opentui/core";
import { useMemo } from "react";
import { type ColorTokens, useTheme } from "@/components/ui/theme-provider.tsx";

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** Map theme color tokens onto the markup scopes MarkdownRenderable resolves. */
export function chatMarkdownStyles(
	colors: ColorTokens
): Record<string, StyleDefinitionInput> {
	const heading: StyleDefinitionInput = { fg: colors.primary, bold: true };
	const link: StyleDefinitionInput = { fg: colors.info, underline: true };
	const muted: StyleDefinitionInput = { fg: colors.mutedForeground };
	const styles: Record<string, StyleDefinitionInput> = {
		default: { fg: colors.foreground },
		conceal: { fg: colors.border },
		"markup.heading": heading,
		// Emphasis scopes do not inherit `default`: without an fg they paint
		// OpenTUI's white, which vanishes on a light theme.
		"markup.strong": { fg: colors.foreground, bold: true },
		"markup.italic": { fg: colors.foreground, italic: true },
		"markup.strikethrough": { fg: colors.foreground, dim: true },
		"markup.raw": { fg: colors.accent },
		"markup.raw.block": { fg: colors.accent },
		"markup.link": link,
		"markup.link.label": link,
		"markup.link.url": muted,
		"markup.quote": muted,
		"markup.list": muted,
		// Fenced code blocks are highlighted by tree-sitter with these base
		// capture names (dotted sub-scopes fall back to the base name), so code
		// stays visually distinct from the surrounding prose.
		keyword: { fg: colors.primary },
		string: { fg: colors.success },
		comment: { fg: colors.mutedForeground, italic: true },
		number: { fg: colors.warning },
		boolean: { fg: colors.warning },
		constant: { fg: colors.warning },
		function: { fg: colors.info },
		type: { fg: colors.accent },
		operator: { fg: colors.secondary },
		punctuation: { fg: colors.mutedForeground },
	};
	for (const level of HEADING_LEVELS) {
		styles[`markup.heading.${level}`] = heading;
	}
	return styles;
}

// One SyntaxStyle per theme palette, shared by every transcript part. A
// SyntaxStyle owns native memory and throws once destroyed, so styles live as
// long as their (module-level, bounded) theme palette instead of being torn
// down per message while a tree-sitter highlight may still resolve against it.
const styleCache = new WeakMap<ColorTokens, SyntaxStyle>();

function syntaxStyleFor(colors: ColorTokens): SyntaxStyle {
	const cached = styleCache.get(colors);
	if (cached) {
		return cached;
	}
	const style = SyntaxStyle.fromStyles(chatMarkdownStyles(colors));
	styleCache.set(colors, style);
	return style;
}

export function ChatMarkdown({
	content,
	streaming = false,
}: {
	content: string;
	streaming?: boolean;
}) {
	const { colors } = useTheme();
	const style = syntaxStyleFor(colors);
	// Size tables to their content with padded, word-wrapped cells so a small
	// table does not stretch across the transcript and wide ones still fit.
	const tableOptions = useMemo<MarkdownTableOptions>(
		() => ({
			style: "grid",
			widthMode: "content",
			wrapMode: "word",
			cellPaddingX: 1,
			borderColor: colors.border,
		}),
		[colors.border]
	);
	return (
		<markdown
			conceal
			content={content}
			streaming={streaming}
			syntaxStyle={style}
			tableOptions={tableOptions}
		/>
	);
}
