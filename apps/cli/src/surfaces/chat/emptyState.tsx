/* @jsxImportSource @opentui/react */

import type { BoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme, useUnicode } from "@/components/ui/theme-provider.tsx";
import { VERSION } from "../../cli/version.ts";
import type { ConversationRow } from "../../core/conversations.ts";

// Three-row block wordmark for roomy terminals; narrow or short transcript
// areas get a plain bold "ryu" so the centred hero never crowds the composer.
const RYU_WORDMARK = ["█▀▀ █ █ █ █", "█   ▀▄█ █ █", "▀   ▄▄▀ ▀▀▀"] as const;
const WORDMARK_WIDTH = 11;
const WORDMARK_MIN_WIDTH = 60;
const WORDMARK_MIN_HEIGHT = 20;
const EMPTY_STATE_MAX_WIDTH = 80;
const EMPTY_STATE_PADDING = 2;
const HINT_GAP = 3;
/**
 * Rows the shell and chat chrome take outside the hero: tab bar, chat status
 * line, the three-row composer and the workspace bar. On short terminals the
 * workspace body can overflow its slot, so the measured area alone can promise
 * rows that are not on screen; the hero also stays within this budget.
 */
const EMPTY_STATE_CHROME_ROWS = 6;
const RECENT_KEY_WIDTH = "Alt+1".length;
const RECENT_LABEL = "Resume";
const RECENT_GAP = 2;
/** Below this inner width the "Resume" label yields its room to the title. */
const RECENT_LABEL_MIN_WIDTH = 40;

/**
 * Wrap the hint chips whole (never mid-token) into `width`: the rows they take
 * and the widest row, so the hero column can shrink to fit them.
 */
function wrapHints(
	hints: readonly string[],
	width: number
): { rows: number; widest: number } {
	let rows = 1;
	let used = 0;
	let widest = 0;
	for (const hint of hints) {
		const next = used === 0 ? hint.length : used + HINT_GAP + hint.length;
		if (used > 0 && next > width) {
			rows += 1;
			used = hint.length;
		} else {
			used = next;
		}
		widest = Math.max(widest, used);
	}
	return { rows, widest };
}

function recentRowWidth(title: string, showLabel: boolean): number {
	const label = showLabel ? RECENT_LABEL.length + RECENT_GAP : 0;
	return RECENT_KEY_WIDTH + RECENT_GAP + label + title.length;
}

interface EmptyStateLayout {
	/** Inner content width: the hero column shrinks to its widest line. */
	innerWidth: number;
	recentCount: number;
	showRecentLabel: boolean;
	wordmark: boolean;
}

/**
 * Fit the hero into the measured transcript area: the mode, version and hints
 * always show; recent conversations come next, and the block wordmark only
 * when there is room left over. The column is as wide as its widest line
 * (capped), so the whole block centres rather than hugging the left edge.
 * Until the area is measured, show the minimum.
 */
function emptyStateLayout(
	area: { height: number; width: number } | null,
	lines: { hints: readonly string[]; mode: string; recentTitles: string[] },
	terminal: { height: number; width: number }
): EmptyStateLayout | null {
	if (!area) {
		return null;
	}
	const available = Math.max(
		1,
		Math.min(area.width, EMPTY_STATE_MAX_WIDTH) - EMPTY_STATE_PADDING * 2
	);
	const showRecentLabel = available >= RECENT_LABEL_MIN_WIDTH;
	const hintLayout = wrapHints(lines.hints, available);
	const natural = Math.max(
		WORDMARK_WIDTH,
		lines.mode.length,
		`v${VERSION}`.length,
		hintLayout.widest,
		...lines.recentTitles.map((title) => recentRowWidth(title, showRecentLabel))
	);
	const innerWidth = Math.min(available, natural);
	// Brand mark, blank + mode, version, hints.
	const coreRows = 1 + 2 + 1 + wrapHints(lines.hints, innerWidth).rows;
	const height = Math.min(
		area.height,
		terminal.height - EMPTY_STATE_CHROME_ROWS
	);
	const recentRoom = Math.max(0, height - coreRows - 1);
	const recentCount = Math.min(lines.recentTitles.length, recentRoom);
	const used = coreRows + (recentCount > 0 ? recentCount + 1 : 0);
	const wordmark =
		terminal.width >= WORDMARK_MIN_WIDTH &&
		terminal.height >= WORDMARK_MIN_HEIGHT &&
		height - used >= 2;
	return { innerWidth, recentCount, showRecentLabel, wordmark };
}

// Empty-state hero shown before the first turn: brand mark, the current
// agent/group mode, the version, a few key hints, and recent conversations,
// centred in the transcript area. The composer stays at the bottom; once
// messages exist the hero yields to the transcript.
export function EmptyStateHeader({
	agent,
	onVisibleRecentsChange,
	recents,
	simpleInterface,
	team,
}: {
	agent: string | null;
	onVisibleRecentsChange: (count: number) => void;
	recents: ConversationRow[];
	simpleInterface: boolean;
	team: string | null;
}) {
	const theme = useTheme();
	const unicode = useUnicode();
	const terminal = useTerminalDimensions();
	const areaRef = useRef<BoxRenderable | null>(null);
	const [area, setArea] = useState<{ height: number; width: number } | null>(
		null
	);
	const measureArea = useCallback(() => {
		const box = areaRef.current;
		if (!box) {
			return;
		}
		const { height, width } = box;
		setArea((current) =>
			current?.height === height && current.width === width
				? current
				: { height, width }
		);
	}, []);
	let mode = "Ask anything";
	if (team) {
		mode = `Group: ${team}`;
	} else if (agent) {
		mode = `Agent: ${agent}`;
	}
	const hints = simpleInterface
		? ["Chat with Ryu", "/ commands"]
		: ["Ctrl+A pick agent", "/ commands", "@ mention", "Ctrl+Q queue"];
	const layout = emptyStateLayout(
		area,
		{ hints, mode, recentTitles: recents.map((row) => row.title) },
		terminal
	);
	const recentCount = layout?.recentCount ?? 0;
	// Alt+1..3 must only reach rows the hero actually shows.
	useEffect(() => {
		onVisibleRecentsChange(recentCount);
	}, [onVisibleRecentsChange, recentCount]);
	useEffect(() => () => onVisibleRecentsChange(0), [onVisibleRecentsChange]);
	const shownRecents = recents.slice(0, recentCount);
	return (
		<box
			alignItems="center"
			flexBasis={0}
			flexDirection="column"
			flexGrow={1}
			flexShrink={1}
			justifyContent="center"
			minHeight={0}
			onSizeChange={measureArea}
			overflow="hidden"
			ref={areaRef}
		>
			<box
				flexDirection="column"
				flexShrink={0}
				paddingLeft={EMPTY_STATE_PADDING}
				paddingRight={EMPTY_STATE_PADDING}
				width={
					layout
						? layout.innerWidth + EMPTY_STATE_PADDING * 2
						: EMPTY_STATE_MAX_WIDTH
				}
			>
				{layout?.wordmark && unicode ? (
					RYU_WORDMARK.map((row) => (
						<text fg={theme.colors.primary} key={row}>
							{row}
						</text>
					))
				) : (
					<text fg={theme.colors.primary}>
						<b>ryu</b>
					</text>
				)}
				<box flexShrink={0} marginTop={1}>
					<text fg={theme.colors.primary}>
						<b>{mode}</b>
					</text>
				</box>
				<text fg={theme.colors.mutedForeground}>{`v${VERSION}`}</text>
				<box
					columnGap={HINT_GAP}
					flexDirection="row"
					flexShrink={0}
					flexWrap="wrap"
				>
					{hints.map((hint) => (
						<text
							fg={theme.colors.mutedForeground}
							flexShrink={0}
							key={hint}
							wrapMode="none"
						>
							{hint}
						</text>
					))}
				</box>
				{shownRecents.length > 0 ? (
					<box flexDirection="column" flexShrink={0} marginTop={1}>
						{shownRecents.map((row, index) => (
							<box flexDirection="row" gap={RECENT_GAP} key={row.id}>
								<text fg={theme.colors.foreground} flexShrink={0}>
									{`Alt+${index + 1}`}
								</text>
								{layout?.showRecentLabel ? (
									<text fg={theme.colors.mutedForeground} flexShrink={0}>
										{RECENT_LABEL}
									</text>
								) : null}
								<text
									fg={theme.colors.mutedForeground}
									flexGrow={1}
									flexShrink={1}
									truncate
									wrapMode="none"
								>
									{row.title}
								</text>
							</box>
						))}
					</box>
				) : null}
			</box>
		</box>
	);
}
