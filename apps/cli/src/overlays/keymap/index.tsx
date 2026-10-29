/* @jsxImportSource @opentui/react */
// Keyboard shortcuts overlay (F1, "?" outside text fields, Ctrl+?, /help). Lists
// the live keymap registry (src/core/keymap.ts) grouped by area, filtered as you
// type, in a scrollable body. The shell toggles it; Esc closes it via the host.

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	filterKeymap,
	keymapForMode,
	keymapGroups,
} from "../../core/keymap.ts";
import { useCliProductMode } from "../../core/ProductModeContext.tsx";
import { tf } from "../../i18n/translate.ts";
import type { OverlayModule } from "../registry.ts";

/** Rows around the list: the host panel (border, padding, title: 6), the
 * filter field and gaps (5), the one-line footer (1), plus the tab strip and
 * status bar left visible above and below the centered panel (2). */
const CHROME_ROWS = 14;
const MIN_LIST_ROWS = 3;
const KEYS_COLUMN_WIDTH = 26;
const PAGE_ROWS = 10;
/** Matches OverlayHost's panel: at most 120 columns, 2 short of each edge. */
const MAX_PANEL_WIDTH = 120;
const PANEL_MARGIN_COLUMNS = 4;
/** The panel's border and padding columns around the body. */
const PANEL_INSET_COLUMNS = 4;
const FOOTER_HINT =
	"Type to filter · ↑↓ PgUp PgDn scroll · F1 close · /help <command> usage";
const SHORT_FOOTER_HINT = "Type to filter · ↑↓ scroll · F1 close";

function KeymapBody() {
	const theme = useTheme();
	const { height, width } = useTerminalDimensions();
	const { effectiveMode } = useCliProductMode();
	const [query, setQuery] = useState("");
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);

	const entries = useMemo(
		() => filterKeymap(keymapForMode(effectiveMode), query),
		[effectiveMode, query]
	);
	const groups = keymapGroups(entries);
	const listRows = Math.max(MIN_LIST_ROWS, height - CHROME_ROWS);
	// One footer line: a wrapped footer would push the panel over the status bar.
	const bodyWidth =
		Math.min(MAX_PANEL_WIDTH, width - PANEL_MARGIN_COLUMNS) -
		PANEL_INSET_COLUMNS;
	const footer =
		FOOTER_HINT.length <= bodyWidth ? FOOTER_HINT : SHORT_FOOTER_HINT;

	useKeyboard((key: KeyEvent) => {
		const scroll = scrollRef.current;
		if (!scroll) {
			return;
		}
		if (key.name === "up") {
			scroll.scrollBy(-1);
		} else if (key.name === "down") {
			scroll.scrollBy(1);
		} else if (key.name === "pageup") {
			scroll.scrollBy(-PAGE_ROWS);
		} else if (key.name === "pagedown") {
			scroll.scrollBy(PAGE_ROWS);
		}
	});

	const onInput = (value: string) => {
		setQuery(value);
		scrollRef.current?.scrollTo(0);
	};

	return (
		<box flexDirection="column" gap={1}>
			<box
				borderColor={theme.colors.focusRing}
				borderStyle="rounded"
				flexDirection="row"
				gap={1}
				paddingLeft={1}
				paddingRight={1}
			>
				<text fg={theme.colors.mutedForeground}>{"⌕"}</text>
				<input
					cursorColor={theme.colors.primary}
					flexGrow={1}
					focused={true}
					focusedTextColor={theme.colors.foreground}
					onInput={onInput}
					placeholder="Filter shortcuts and commands…"
					placeholderColor={theme.colors.mutedForeground}
					textColor={theme.colors.foreground}
					value={query}
				/>
			</box>
			<scrollbox height={listRows} ref={scrollRef}>
				{groups.length === 0 ? (
					<text fg={theme.colors.mutedForeground}>
						{tf("No shortcuts match “{query}”", { query: query.trim() })}
					</text>
				) : (
					groups.map((group) => (
						<box flexDirection="column" key={group.group} marginBottom={1}>
							<text fg={theme.colors.primary}>
								<b>{group.group}</b>
							</text>
							{group.entries.map((entry) => (
								<box flexDirection="row" gap={2} key={entry.id}>
									<box flexShrink={0} width={KEYS_COLUMN_WIDTH}>
										<text fg={theme.colors.foreground}>{entry.keys}</text>
									</box>
									<text fg={theme.colors.mutedForeground}>{entry.label}</text>
								</box>
							))}
						</box>
					))
				)}
			</scrollbox>
			<text fg={theme.colors.mutedForeground}>{footer}</text>
		</box>
	);
}

export const keymapOverlay: OverlayModule = {
	id: "keymap",
	title: "Keyboard shortcuts",
	Body: KeymapBody,
};
