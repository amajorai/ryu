/* @jsxImportSource @opentui/react */
// One row of a keyboard-driven TUI list, shared by ListTab, DeclarativeView and
// the store tabs. It pairs with useListWindow, which decides which rows to draw.
//
// The row always occupies exactly `linesPerRow` terminal lines and never
// flex-shrinks. On a short terminal, a shrinkable row could collapse to less than
// its content, and OpenTUI would then draw the next row's text over it. The title
// and the optional subtitle are each a single line truncated with an ellipsis, so
// long descriptions cannot wrap into the next row either. A selected row gets the
// theme's full-width selection background, plus the `›` caret and a bold title.

import type { ReactNode } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";

export interface SelectableRowProps {
	/** Right-aligned muted text on the title line (e.g. a shortcut or count). */
	accessory?: string;
	/** Custom title-line content, drawn after the caret in place of `title`. */
	children?: ReactNode;
	/** Lines the row occupies; defaults to 2 with a subtitle and 1 without. */
	linesPerRow?: number;
	selected: boolean;
	/** Muted single-line text under the title. */
	subtitle?: string;
	/** Single-line title (ignored when `children` is given). */
	title?: string;
	/** Extra title-line content after the title, such as a badge. */
	titleSuffix?: ReactNode;
}

export function SelectableRow({
	accessory,
	children,
	linesPerRow,
	selected,
	subtitle,
	title,
	titleSuffix,
}: SelectableRowProps) {
	const theme = useTheme();
	const lines = linesPerRow ?? (subtitle ? 2 : 1);
	const foreground = selected
		? theme.colors.selectionForeground
		: theme.colors.foreground;
	const muted = selected
		? theme.colors.selectionForeground
		: theme.colors.mutedForeground;
	return (
		<box
			backgroundColor={selected ? theme.colors.selection : undefined}
			flexDirection="row"
			flexShrink={0}
			gap={1}
			height={lines}
		>
			<text fg={muted} flexShrink={0}>
				{selected ? "›" : " "}
			</text>
			<box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
				<box flexDirection="row" flexShrink={0} gap={1} height={1}>
					{children ?? (
						<text
							fg={foreground}
							flexShrink={1}
							minWidth={0}
							truncate
							wrapMode="none"
						>
							{selected ? <b>{title ?? ""}</b> : (title ?? "")}
						</text>
					)}
					{titleSuffix ? <box flexShrink={0}>{titleSuffix}</box> : null}
				</box>
				{subtitle && lines > 1 ? (
					<text fg={muted} flexShrink={0} height={1} truncate wrapMode="none">
						{subtitle}
					</text>
				) : null}
			</box>
			{accessory ? (
				<text fg={muted} flexShrink={0}>
					{accessory}
				</text>
			) : null}
		</box>
	);
}

/** Muted `N/M` position line shown under a list whose rows do not all fit. */
export function ListPosition({
	count,
	index,
	visible,
}: {
	count: number;
	index: number;
	visible: number;
}) {
	const theme = useTheme();
	if (count <= visible) {
		return null;
	}
	return (
		<box flexShrink={0} height={1}>
			<text fg={theme.colors.mutedForeground}>{`${index + 1}/${count}`}</text>
		</box>
	);
}
