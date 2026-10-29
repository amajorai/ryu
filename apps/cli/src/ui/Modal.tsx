/* @jsxImportSource @opentui/react */
// Modal - the shared floating-panel primitive for every TUI overlay (shell
// overlays, node picker, command palette, chat pickers/help/keymap). It lays an
// absolute, full-size dim backdrop over its positioning parent and centres a
// bordered panel on it, so an overlay never competes with the transcript or the
// composer for height. The panel is clamped to the area it covers (width
// min(N, w-4), height at most h-4) and its body scrolls when content is taller.
//
// Escape stays with the callers (each already owns it), so Modal adds no close
// key: a second handler would double-close. Clicking the backdrop closes; clicks
// inside the panel are swallowed so they reach neither the backdrop nor the
// shell underneath. Keyboard scrolling of the body is opt-in (`keyboardScroll`)
// for read-only content whose ↑/↓ are not already a selection.

import {
	type BoxRenderable,
	type MouseEvent,
	RGBA,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";

/** The backdrop dims what is underneath (opencode's dialog scrim). */
const BACKDROP = RGBA.fromInts(0, 0, 0, 150);
/** Columns and rows kept free around the panel. */
const VIEWPORT_MARGIN = 4;
/** The smallest panel height that still shows border, header and one row. */
const MIN_PANEL_HEIGHT = 6;
const PAGE_ROWS = 5;
/** Panel rows outside the body: border (2) + header row and its gap (2). */
const PANEL_CHROME_ROWS = 4;
/** Rows a footer adds: its gap and one line. */
const FOOTER_ROWS = 2;

export interface ModalSize {
	/** Rows the scrollable body may take before it scrolls. */
	maxBodyRows: number;
	maxHeight: number;
	width: number;
}

/** The panel geometry Modal produces inside a `width` x `height` area: the
 * preferred width clamped to the area less a 2-cell margin on each side, the
 * height capped the same way, and the rows left for the body. Modal itself gets
 * this from layout (backdrop padding + 100% max size, so a pane-local modal fits
 * its pane); callers that window their own rows (the palette) use it to size
 * them. Pure, so the rules are unit-testable. */
export function modalSize(
	terminalWidth: number,
	terminalHeight: number,
	preferredWidth: number,
	hasFooter = false
): ModalSize {
	const maxHeight = Math.max(
		MIN_PANEL_HEIGHT,
		terminalHeight - VIEWPORT_MARGIN
	);
	const chrome = PANEL_CHROME_ROWS + (hasFooter ? FOOTER_ROWS : 0);
	return {
		maxBodyRows: Math.max(1, maxHeight - chrome),
		maxHeight,
		width: Math.max(
			1,
			Math.min(preferredWidth, terminalWidth - VIEWPORT_MARGIN)
		),
	};
}

/** The DOM-style id a Modal body row carries so `activeRowId` can scroll it
 * into view. */
export function modalRowId(key: string | number): string {
	return `modal-row-${key}`;
}

/** Lets a body rendered inside a Modal it does not own (an OverlayHost body)
 * keep its own selected row scrolled into view. */
const ModalScrollContext = createContext<(rowId: string) => void>(() => {
	// Outside a Modal there is nothing to scroll.
});

/** Keep the row carrying `rowId` (see modalRowId) scrolled into view inside
 * the enclosing Modal body whenever it changes. */
export function useModalActiveRow(rowId: string | undefined): void {
	const scrollIntoView = useContext(ModalScrollContext);
	useEffect(() => {
		if (rowId) {
			scrollIntoView(rowId);
		}
	}, [rowId, scrollIntoView]);
}

export interface ModalProps {
	/** Id (see modalRowId) of the selected body row, kept scrolled into view. */
	activeRowId?: string;
	children?: ReactNode;
	/** Optional fixed muted row under the body (key hints, status). */
	footer?: ReactNode;
	/** Custom header content; replaces the title (e.g. a palette query row). */
	header?: ReactNode;
	/** Muted key hint at the right of the header ("Esc close" by default);
	 * pass "" when the footer already names Esc. */
	hint?: string;
	/** Let ↑/↓/PgUp/PgDn/j/k scroll the body (read-only content only). */
	keyboardScroll?: boolean;
	onClose: () => void;
	/** Wrap the body in a scrollbox (default) or render a plain column. */
	scroll?: boolean;
	title?: string;
	/** Preferred panel width in columns; clamped to the terminal. */
	width?: number;
	/** Stacking order against sibling modals (palette > shell > chat). */
	zIndex?: number;
}

export function Modal({
	activeRowId,
	children,
	footer,
	header,
	hint = "Esc close",
	keyboardScroll = false,
	onClose,
	scroll = true,
	title,
	width = 60,
	zIndex = 30,
}: ModalProps) {
	const theme = useTheme();
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	// The area height in whole rows. A percentage max height lets Yoga give the
	// shrinking body a fractional height, which pushes the footer onto the
	// bottom border; an integer cap keeps every row on the cell grid.
	const [areaHeight, setAreaHeight] = useState<number | null>(null);
	// The row to keep in view: the caller's activeRowId, or the last row a
	// body asked for through useModalActiveRow. Re-applied once layout settles
	// (the first effect runs before the rows have positions).
	const pendingRowRef = useRef<string | undefined>(activeRowId);
	const scrollIntoView = useCallback((rowId: string) => {
		pendingRowRef.current = rowId;
		scrollRef.current?.scrollChildIntoView(rowId);
	}, []);

	useEffect(() => {
		if (activeRowId) {
			scrollIntoView(activeRowId);
		}
	}, [activeRowId, scrollIntoView]);

	useKeyboard((key) => {
		const box = scrollRef.current;
		if (!(keyboardScroll && box)) {
			return;
		}
		if (key.name === "down" || key.name === "j") {
			box.scrollBy(1);
		} else if (key.name === "up" || key.name === "k") {
			box.scrollBy(-1);
		} else if (key.name === "pagedown") {
			box.scrollBy(PAGE_ROWS);
		} else if (key.name === "pageup") {
			box.scrollBy(-PAGE_ROWS);
		}
	});

	const pressedBackdropRef = useRef(false);
	// Swallow clicks inside the panel: they must reach neither the backdrop
	// (which closes) nor the shell underneath (the Sidebar listens for mouse-down).
	const swallow = (event: MouseEvent) => {
		event.stopPropagation();
		pressedBackdropRef.current = false;
	};

	return (
		<box
			alignItems="center"
			backgroundColor={BACKDROP}
			height="100%"
			justifyContent="center"
			left={0}
			onMouseDown={(event: MouseEvent) => {
				event.stopPropagation();
				pressedBackdropRef.current = true;
			}}
			onMouseUp={(event: MouseEvent) => {
				event.stopPropagation();
				// Close only for a click that started on the backdrop: the release
				// of the click that opened this modal (a sidebar or status bar
				// mouse-down) lands here too and must not close it again.
				if (pressedBackdropRef.current) {
					pressedBackdropRef.current = false;
					onClose();
				}
			}}
			onSizeChange={function (this: BoxRenderable) {
				setAreaHeight(Math.floor(this.height));
			}}
			padding={VIEWPORT_MARGIN / 2}
			position="absolute"
			top={0}
			width="100%"
			zIndex={zIndex}
		>
			<box
				backgroundColor={theme.colors.background}
				border={true}
				borderColor={theme.colors.focusRing}
				borderStyle="rounded"
				flexDirection="column"
				flexShrink={0}
				maxHeight={
					areaHeight === null
						? "100%"
						: Math.max(MIN_PANEL_HEIGHT, areaHeight - VIEWPORT_MARGIN)
				}
				maxWidth="100%"
				onMouseDown={swallow}
				onMouseUp={swallow}
				paddingLeft={1}
				paddingRight={1}
				width={width}
			>
				<box
					flexDirection="row"
					flexShrink={0}
					gap={1}
					justifyContent="space-between"
					paddingBottom={1}
				>
					{header ?? (
						<text fg={theme.colors.primary} truncate wrapMode="none">
							<b>{title ?? ""}</b>
						</text>
					)}
					{hint ? (
						<text fg={theme.colors.mutedForeground} flexShrink={0}>
							{hint}
						</text>
					) : null}
				</box>
				{scroll ? (
					<scrollbox
						// Size to the content (not 100% of an auto-height parent) so
						// short bodies stay short; the panel's max height then shrinks a
						// tall body and it scrolls.
						contentOptions={{ minHeight: 0 }}
						flexShrink={1}
						// The auto scrollbars toggle on overflow and steal a column
						// after text has wrapped, which leaves rows clipped; keep the body
						// width stable instead (wheel and ↑/↓ still scroll).
						horizontalScrollbarOptions={{ visible: false }}
						onSizeChange={() => {
							// The body resizes before its rows get their new positions;
							// scroll once this layout pass has finished.
							queueMicrotask(() => {
								const rowId = pendingRowRef.current;
								if (rowId) {
									scrollRef.current?.scrollChildIntoView(rowId);
								}
							});
						}}
						ref={scrollRef}
						verticalScrollbarOptions={{ visible: false }}
					>
						<ModalScrollContext.Provider value={scrollIntoView}>
							{children}
						</ModalScrollContext.Provider>
					</scrollbox>
				) : (
					<box flexDirection="column" flexShrink={1}>
						{children}
					</box>
				)}
				{footer ? (
					<box flexShrink={0} paddingTop={1}>
						{typeof footer === "string" ? (
							<text fg={theme.colors.mutedForeground} truncate wrapMode="none">
								{footer}
							</text>
						) : (
							footer
						)}
					</box>
				) : null}
			</box>
		</box>
	);
}
