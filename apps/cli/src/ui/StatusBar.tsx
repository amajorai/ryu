/* @jsxImportSource @opentui/react */
// Bottom key-hint bar, mirroring apps/cli's footer. The shell renders one bar with
// the global hints merged with whatever the focused surface publishes through
// StatusContext. Each hint is a {keys, label} pair shown as a "keys label" segment.
//
// The bar fits greedily to the terminal width (see fitStatusBar): hints are kept in
// priority order and dropped whole - never clipped mid-word - and the left status
// text is middle-truncated with an ellipsis. While a surface is busy (a chat turn
// streaming) the left side leads with a spinner, the interrupt key and the elapsed
// seconds; that 1s clock lives here so only the bar re-renders.

import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { DEFAULT_HINT_PRIORITY, type KeyHint } from "../core/keymap.ts";

export type { KeyHint } from "../core/keymap.ts";

/** A busy surface: shown as "⠋ {label} · {elapsed}s" ahead of everything else. */
export interface StatusBusy {
	label: string;
	startedAt: number;
}

/** Horizontal padding of the bar (one cell each side). */
const BAR_PADDING = 2;
/** Cells between adjacent segments. */
const SEGMENT_GAP = 2;
/** Below this many cells the left text is dropped rather than squeezed. */
const LEFT_MIN_WIDTH = 12;
const ELLIPSIS = "…";
/** Joins the left text and its suffix ("CONSOLE · url · Right"). */
const LEFT_SUFFIX_SEPARATOR = " · ";
/** Fewest cells of left text worth keeping in front of a suffix. */
const LEFT_SUFFIX_MIN_TEXT = 4;
/** The first frame of the "dots" spinner the loading StatusMessage uses. */
const SPINNER_PLACEHOLDER = "⠋";
const SECOND_MS = 1000;

/** Terminal cell width of `text` (wide glyphs count as two). */
export function cellWidth(text: string): number {
	return Bun.stringWidth(text);
}

/** Cell width of one rendered "keys label" hint segment. */
export function hintWidth(hint: KeyHint): number {
	return cellWidth(hint.keys) + 1 + cellWidth(hint.label);
}

function takeWidth(chars: string[], max: number): string {
	let out = "";
	let used = 0;
	for (const char of chars) {
		const width = cellWidth(char);
		if (used + width > max) {
			break;
		}
		out += char;
		used += width;
	}
	return out;
}

/** Shorten `text` to at most `max` cells by replacing its middle with "…", so
 * both the start (scheme, mode) and the end (port) stay readable. */
export function middleTruncate(text: string, max: number): string {
	if (cellWidth(text) <= max) {
		return text;
	}
	if (max <= 0) {
		return "";
	}
	if (max === 1) {
		return ELLIPSIS;
	}
	const room = max - 1;
	const chars = Array.from(text);
	const head = takeWidth(chars, Math.ceil(room / 2));
	const tail = takeWidth(chars.toReversed(), Math.floor(room / 2));
	return `${head}${ELLIPSIS}${Array.from(tail).toReversed().join("")}`;
}

function joinLeft(text: string, suffix: string | undefined): string {
	if (!suffix) {
		return text;
	}
	return text ? `${text}${LEFT_SUFFIX_SEPARATOR}${suffix}` : suffix;
}

/**
 * Fit the left text into `max` cells. Without a `suffix` it is
 * middle-truncated. A suffix (the focused region) stays whole while it fits:
 * the text before it is trimmed instead, and only when fewer than
 * {@link LEFT_SUFFIX_MIN_TEXT} cells would remain for that text is the suffix
 * shown alone (trimmed if it must be).
 */
export function fitLeftText(
	text: string,
	max: number,
	suffix?: string
): string {
	if (!suffix) {
		return middleTruncate(text, max);
	}
	const joined = joinLeft(text, suffix);
	if (cellWidth(joined) <= max) {
		return joined;
	}
	const tail = `${LEFT_SUFFIX_SEPARATOR}${suffix}`;
	const room = max - cellWidth(tail);
	if (text && room >= LEFT_SUFFIX_MIN_TEXT) {
		return `${middleTruncate(text, room)}${tail}`;
	}
	return middleTruncate(suffix, max);
}

export interface StatusBarFit {
	/** The busy segment text, when it fits. */
	busy?: string;
	hints: KeyHint[];
	left: string;
}

/**
 * Fit the bar's segments into `width` cells. Order of claim: the busy segment,
 * priority-0 hints, a minimum slice of the left text, then the remaining hints by
 * ascending priority until the first that does not fit. When `leftPriority` is
 * set, the left text claims its full width at that rank (before any hint ranked
 * after it); otherwise it only takes what the hints leave. Hints keep their
 * original display order and are dropped whole; the left text is
 * middle-truncated to the space it ends up with, or dropped when fewer than
 * {@link LEFT_MIN_WIDTH} cells remain.
 */
export function fitStatusBar({
	busy,
	hints,
	left,
	leftPriority = Number.POSITIVE_INFINITY,
	leftSuffix,
	width,
}: {
	busy?: string;
	hints: readonly KeyHint[];
	left?: string;
	/** Rank at which the left text claims its full width (see above). */
	leftPriority?: number;
	/** Appended to the left text as " · suffix" and kept whole while it fits
	 * (see {@link fitLeftText}). */
	leftSuffix?: string;
	width: number;
}): StatusBarFit {
	const budget = Math.max(0, width - BAR_PADDING);
	let used = 0;
	let segments = 0;
	const claim = (cells: number): boolean => {
		const cost = cells + (segments > 0 ? SEGMENT_GAP : 0);
		if (used + cost > budget) {
			return false;
		}
		used += cost;
		segments += 1;
		return true;
	};

	const fittedBusy = busy && claim(cellWidth(busy)) ? busy : undefined;

	const ranked = hints
		.map((hint, index) => ({ hint, index }))
		.sort(
			(a, b) =>
				(a.hint.priority ?? DEFAULT_HINT_PRIORITY) -
					(b.hint.priority ?? DEFAULT_HINT_PRIORITY) || a.index - b.index
		);
	const kept = new Set<number>();
	const pinned = ranked.filter((entry) => entry.hint.priority === 0);
	for (const entry of pinned) {
		if (claim(hintWidth(entry.hint))) {
			kept.add(entry.index);
		}
	}

	const leftText = joinLeft(left ?? "", leftSuffix);
	const leftWidth = cellWidth(leftText);
	// Reserve the left minimum before the optional hints so a narrow bar keeps a
	// readable node/mode label instead of a long tail of shortcuts.
	const leftReserved =
		leftWidth > 0 && claim(Math.min(leftWidth, LEFT_MIN_WIDTH));
	let reservedCells = leftReserved ? Math.min(leftWidth, LEFT_MIN_WIDTH) : 0;
	let leftExpanded = !leftReserved || reservedCells >= leftWidth;
	/** Grow the reserved left slice to its full width; false when it cannot. */
	const expandLeft = (): boolean => {
		leftExpanded = true;
		const extra = leftWidth - reservedCells;
		if (used + extra > budget) {
			return false;
		}
		used += extra;
		reservedCells = leftWidth;
		return true;
	};

	// Strict priority: once a segment does not fit, every less important one is
	// dropped too, so a short low-priority hint never outlives a wider key one.
	for (const entry of ranked) {
		if (entry.hint.priority === 0) {
			continue;
		}
		const priority = entry.hint.priority ?? DEFAULT_HINT_PRIORITY;
		if (!leftExpanded && priority > leftPriority && !expandLeft()) {
			break;
		}
		if (!claim(hintWidth(entry.hint))) {
			break;
		}
		kept.add(entry.index);
	}

	const fittedLeft = leftReserved
		? fitLeftText(left ?? "", reservedCells + (budget - used), leftSuffix)
		: "";

	return {
		busy: fittedBusy,
		hints: hints.filter((_, index) => kept.has(index)),
		left: fittedLeft,
	};
}

/** Whole seconds since `startedAt`, ticking once a second while set. */
function useElapsedSeconds(startedAt: number | undefined): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (startedAt === undefined) {
			return;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
		return () => clearInterval(timer);
	}, [startedAt]);
	if (startedAt === undefined) {
		return 0;
	}
	return Math.max(0, Math.floor((now - startedAt) / SECOND_MS));
}

export function StatusBar({
	busy,
	hints,
	left,
	leftPriority,
	leftSuffix,
}: {
	/** Set while the focused surface is working (e.g. a chat turn streaming). */
	busy?: StatusBusy;
	hints: KeyHint[];
	/** Optional left-aligned status text (e.g. node url, streaming state). */
	left?: string;
	/** Hint rank at which the left text claims its full width; by default it
	 * only takes the space the hints leave. */
	leftPriority?: number;
	/** Appended after `left` (the focused region) and kept whole while the
	 * text before it is trimmed. */
	leftSuffix?: string;
}) {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const elapsed = useElapsedSeconds(busy?.startedAt);
	const busyLabel = busy ? `${busy.label} · ${elapsed}s` : undefined;
	const fit = fitStatusBar({
		busy: busyLabel ? `${SPINNER_PLACEHOLDER} ${busyLabel}` : undefined,
		hints,
		left,
		leftPriority,
		leftSuffix,
		width,
	});
	return (
		<box
			flexDirection="row"
			flexShrink={0}
			height={1}
			justifyContent="space-between"
			overflow="hidden"
			paddingLeft={1}
			paddingRight={1}
		>
			<box flexDirection="row" flexShrink={0} gap={SEGMENT_GAP}>
				{fit.busy && busyLabel ? (
					<box flexDirection="row" gap={1}>
						<Spinner color={theme.colors.primary} type="dots" />
						<text fg={theme.colors.foreground}>{busyLabel}</text>
					</box>
				) : null}
				{fit.left ? (
					<text fg={theme.colors.mutedForeground}>{fit.left}</text>
				) : null}
			</box>
			<box flexDirection="row" flexShrink={0} gap={SEGMENT_GAP}>
				{fit.hints.map((hint) => (
					<box flexDirection="row" gap={1} key={`${hint.keys}:${hint.label}`}>
						<text fg={theme.colors.primary}>{hint.keys}</text>
						<text fg={theme.colors.mutedForeground}>{hint.label}</text>
					</box>
				))}
			</box>
		</box>
	);
}
