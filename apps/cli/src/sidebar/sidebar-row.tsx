// A focusable, clickable sidebar row and the keyboard focus context it reads.
// Sidebar.tsx provides SidebarFocusContext; every row (nav, section items,
// footer) renders through RowBox so focus and hover paint the same way.

import { createContext, type ReactNode, useContext, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSelectionSafeActivate } from "../ui/clipboard.ts";
import { sidebarRowId } from "./rows.ts";

/** Keyboard focus mode as rows see it: the focused row key (null outside focus
 * mode) and the hand-back a clicked row runs, like Enter does. */
export const SidebarFocusContext = createContext<{
	focusKey: string | null;
	release: () => void;
}>({ focusKey: null, release: () => undefined });

/** Shared highlight for one focusable row: keyboard focus paints the selection
 * colors, a hovering pointer paints the muted background. */
function useSidebarRow(rowKey: string) {
	const theme = useTheme();
	const { focusKey } = useContext(SidebarFocusContext);
	const [hovered, setHovered] = useState(false);
	const focused = focusKey === rowKey;
	let backgroundColor: string | undefined;
	if (focused) {
		backgroundColor = theme.colors.selection;
	} else if (hovered) {
		backgroundColor = theme.colors.muted;
	}
	return {
		focused,
		/** The text color for a row element, readable on the row's background. */
		tone: (base?: string) => {
			if (focused) {
				return theme.colors.selectionForeground;
			}
			return base;
		},
		rowProps: {
			backgroundColor,
			id: sidebarRowId(rowKey),
			onMouseOut: () => setHovered(false),
			onMouseOver: () => setHovered(true),
		},
	};
}

/** A focusable, clickable sidebar row. */
export function RowBox({
	children,
	gap = 1,
	header = false,
	onSelect,
	paddingLeft,
	rowKey,
}: {
	children: (
		tone: (base?: string) => string | undefined,
		focused: boolean
	) => ReactNode;
	gap?: number;
	/** A section header folds in place, so clicking it keeps focus mode. */
	header?: boolean;
	onSelect: () => void;
	paddingLeft?: number;
	rowKey: string;
}) {
	const activate = useSelectionSafeActivate();
	const { release } = useContext(SidebarFocusContext);
	const { focused, rowProps, tone } = useSidebarRow(rowKey);
	return (
		<box
			flexDirection="row"
			flexShrink={0}
			gap={gap}
			paddingLeft={paddingLeft}
			{...rowProps}
			{...activate(() => {
				onSelect();
				if (!header) {
					release();
				}
			})}
		>
			{children(tone, focused)}
		</box>
	);
}
