/* @jsxImportSource @opentui/react */
// TabStrip - the top titlebar strip of open tabs (the desktop TitleBar analog).
// One row that never wraps: each pane's tabs render as " n:title " chips (n is
// the Alt+n jump index, titles cut with "…"), the active chip is filled with the
// selection colour (muted when its pane is not focused) and carries a "×" close
// glyph, and pinned tabs show "*" before the title. When a pane's chips do not
// fit, a window around the active tab is shown with "‹ +N" / "+M ›" markers.
// Click a chip to focus it; middle-click a chip (or click its "×") to close it;
// click an overflow marker to reveal the nearest hidden tab. When a split is
// open the two panes are separated by a "│" bracket, and a pane whose chips fit
// in less than half the row lends its spare columns to the crowded one.

import { MouseButton, type MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { displayWidth } from "../sidebar/rows.ts";
import {
	allocatePaneBudgets,
	CLOSE_GLYPH,
	formatTabLabel,
	leadingOverflowLabel,
	PIN_GLYPH,
	tabRowWidth,
	trailingOverflowLabel,
	visibleTabWindow,
	windowColumns,
} from "./tabStripLayout.ts";
import { type Pane, type Tab, useWorkspace } from "./WorkspaceContext.tsx";

const BRAND = "Ryu";
/** Gap between the brand and each pane group. */
const GROUP_GAP = 1;
/** Chips carry their own " label " padding, so they sit flush. */
const CHIP_GAP = 0;
/** Left + right padding of the strip. */
const STRIP_PADDING = 2;
/** The "│" divider before every pane after the first, plus its gap. */
const PANE_DIVIDER_WIDTH = 2;

/** Columns left for the pane groups on a strip `columns` wide. */
function paneColumns(columns: number, paneCount: number): number {
	const fixed =
		STRIP_PADDING +
		displayWidth(BRAND) +
		paneCount * GROUP_GAP +
		Math.max(0, paneCount - 1) * PANE_DIVIDER_WIDTH;
	return Math.max(paneCount, columns - fixed);
}

export function TabStrip() {
	const theme = useTheme();
	const { panes, tabs } = useWorkspace();
	const { width } = useTerminalDimensions();
	const paneChips = panes.map((pane) => chipModels(pane, tabs));
	const budgets = allocatePaneBudgets(
		paneChips.map((chips) =>
			tabRowWidth(
				chips.map((chip) => chip.width),
				CHIP_GAP
			)
		),
		paneColumns(width, panes.length)
	);
	return (
		<box
			flexDirection="row"
			flexShrink={0}
			flexWrap="no-wrap"
			gap={GROUP_GAP}
			height={1}
			overflow="hidden"
			paddingLeft={1}
			paddingRight={1}
		>
			<text fg={theme.colors.primary} flexShrink={0} wrapMode="none">
				<b>{BRAND}</b>
			</text>
			{panes.map((pane, i) => (
				<PaneTabs
					budget={budgets[i] ?? 1}
					chips={paneChips[i] ?? []}
					first={i === 0}
					key={pane.id}
					pane={pane}
				/>
			))}
		</box>
	);
}

interface ChipModel {
	active: boolean;
	/** 1-based jump index (Alt+n). */
	index: number;
	label: string;
	tab: Tab;
	width: number;
}

function chipModels(pane: Pane, tabs: readonly Tab[]): ChipModel[] {
	const chips: ChipModel[] = [];
	for (const [position, id] of pane.tabIds.entries()) {
		const tab = tabs.find((candidate) => candidate.id === id);
		if (!tab) {
			continue;
		}
		const active = tab.id === pane.activeTabId;
		const label = formatTabLabel(
			position + 1,
			tab.title,
			undefined,
			tab.pinned
		);
		const closeWidth = active ? displayWidth(`${CLOSE_GLYPH} `) : 0;
		chips.push({
			active,
			index: position + 1,
			label,
			tab,
			width: displayWidth(` ${label} `) + closeWidth,
		});
	}
	return chips;
}

/**
 * When even the lone active chip plus its overflow markers is wider than the
 * pane's budget, cut its title by the excess so the row never clips into the
 * next pane (the "n:" index always survives).
 */
function fitLoneChip(shown: ChipModel[], excess: number): ChipModel[] {
	const [chip] = shown;
	if (!chip || excess <= 0 || shown.length !== 1) {
		return shown;
	}
	const label = formatTabLabel(
		chip.index,
		chip.tab.title,
		Math.max(0, displayWidth(chip.label) - excess),
		chip.tab.pinned
	);
	return [{ ...chip, label }];
}

function PaneTabs({
	pane,
	chips,
	first,
	budget,
}: {
	budget: number;
	chips: readonly ChipModel[];
	first: boolean;
	pane: Pane;
}) {
	const theme = useTheme();
	const { activateTab, focusedPaneId } = useWorkspace();
	const paneFocused = pane.id === focusedPaneId;
	const activeIndex = Math.max(
		0,
		chips.findIndex((chip) => chip.active)
	);
	const { start, end } = visibleTabWindow(
		chips.map((chip) => chip.width),
		activeIndex,
		budget,
		CHIP_GAP
	);
	const hiddenAfter = chips.length - end;
	const shown = fitLoneChip(
		chips.slice(start, end),
		windowColumns(
			chips.map((chip) => chip.width),
			start,
			end,
			CHIP_GAP
		) - budget
	);
	// Clicking an overflow marker reveals the nearest hidden tab on that side.
	const revealAt = (index: number) => (event: MouseEvent) => {
		const chip = chips[index];
		if (chip && event.button === MouseButton.LEFT) {
			activateTab(pane.id, chip.tab.id);
		}
	};

	return (
		<box flexDirection="row" flexShrink={0} flexWrap="no-wrap" gap={CHIP_GAP}>
			{first ? null : (
				<text fg={theme.colors.border} flexShrink={0} wrapMode="none">
					{"│ "}
				</text>
			)}
			{start > 0 ? (
				<text
					fg={theme.colors.mutedForeground}
					flexShrink={0}
					onMouseDown={revealAt(start - 1)}
					wrapMode="none"
				>
					{leadingOverflowLabel(start)}
				</text>
			) : null}
			{shown.map((chip) => (
				<TabChip
					active={chip.active}
					key={chip.tab.id}
					label={chip.label}
					paneFocused={paneFocused}
					paneId={pane.id}
					tab={chip.tab}
				/>
			))}
			{hiddenAfter > 0 ? (
				<text
					fg={theme.colors.mutedForeground}
					flexShrink={0}
					onMouseDown={revealAt(end)}
					wrapMode="none"
				>
					{trailingOverflowLabel(hiddenAfter)}
				</text>
			) : null}
		</box>
	);
}

function TabChip({
	tab,
	label,
	active,
	paneFocused,
	paneId,
}: {
	active: boolean;
	label: string;
	paneFocused: boolean;
	paneId: string;
	tab: Tab;
}) {
	const theme = useTheme();
	const { activateTab, closeTab } = useWorkspace();
	const highlighted = active && paneFocused;
	let color = theme.colors.mutedForeground;
	let backgroundColor: string | undefined;
	if (highlighted) {
		color = theme.colors.selectionForeground;
		backgroundColor = theme.colors.selection;
	} else if (active) {
		color = theme.colors.foreground;
		backgroundColor = theme.colors.muted;
	}
	const onChipMouseDown = (event: MouseEvent) => {
		if (event.button === MouseButton.MIDDLE) {
			closeTab(tab.id);
		} else if (event.button === MouseButton.LEFT) {
			activateTab(paneId, tab.id);
		}
	};
	const onCloseMouseDown = (event: MouseEvent) => {
		if (event.button !== MouseButton.LEFT) {
			return;
		}
		event.stopPropagation();
		closeTab(tab.id);
	};
	// The pin glyph sits after the "n:" index; split there to colour it.
	const pinAt = tab.pinned ? label.indexOf(PIN_GLYPH) : -1;
	const head = pinAt >= 0 ? label.slice(0, pinAt) : "";
	const title = pinAt >= 0 ? label.slice(pinAt + PIN_GLYPH.length) : label;
	const pinColor = highlighted ? color : theme.colors.accent;
	return (
		<box
			backgroundColor={backgroundColor}
			flexDirection="row"
			flexShrink={0}
			onMouseDown={onChipMouseDown}
		>
			<text fg={color} flexShrink={0} wrapMode="none">
				{" "}
				{head}
				{pinAt >= 0 ? <span fg={pinColor}>{PIN_GLYPH}</span> : null}
				{highlighted ? <b>{title}</b> : title}{" "}
			</text>
			{active ? (
				<text
					fg={color}
					flexShrink={0}
					onMouseDown={onCloseMouseDown}
					wrapMode="none"
				>
					{`${CLOSE_GLYPH} `}
				</text>
			) : null}
		</box>
	);
}
