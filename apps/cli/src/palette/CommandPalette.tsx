/* @jsxImportSource @opentui/react */
// CommandPalette - the Ctrl+K fuzzy jump-to palette (the desktop CommandPalette
// analog). Destinations mirror the desktop NAV_ITEMS (openTab), plus overlay
// entries (Gateway/Settings, reached by Channels/Identities/Credits aliases),
// workspace actions (Split Center, Close tab, Reopen closed tab), the Layout
// actions (Move tab to Right/Bottom/Center, Show/Hide a region, Reset layout)
// and global actions
// (New chat, Switch node, Quit). Navigation destinations are
// merged with any surface registered in the router PLUS every declarative view an
// enabled plugin contributes (each opens at its /plugin-view/<plugin>/<viewId>
// route), and extra actions can be contributed via registerPaletteAction (the
// registration hook downstream code uses without editing this file).
//
// The shell owns the open/closed state (it binds Ctrl+K) and passes it in; the
// palette owns its query + selection and its keyboard (gated on `open`).
//
// Unfiltered, the palette lists grouped rows (Suggested = recently run, then
// Navigation, Actions, Plugins) with a right-aligned shortcut column. Filtered,
// it shows one flat list ranked by rankPaletteEntries (exact > prefix >
// word-prefix > substring > subsequence). Rows respond to hover and click.

import type { KeyEvent, MouseEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useContributions } from "../core/ContributionsContext.tsx";
import { pluginViewPath, surfaceClaimToken } from "../core/contributions.ts";
import { GLOBAL_KEYMAP, paletteShortcut } from "../core/keymap.ts";
import type { ProductMode } from "../core/productMode.ts";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { Modal, modalSize } from "../ui/Modal.tsx";
import { listSurfaces } from "../workspace/router.ts";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import { rankPaletteEntries } from "./rank.ts";
import { paletteWindow } from "./window.ts";

export type PaletteGroup = "Suggested" | "Navigation" | "Actions" | "Plugins";

export interface PaletteAction {
	/** Extra search terms that match without appearing in the label. */
	aliases?: string[];
	/** Section shown when the query is empty (extra actions default to Plugins). */
	group?: PaletteGroup;
	id: string;
	label: string;
	run: () => void;
	/** Key chord shown muted and right-aligned, e.g. "Ctrl+W". */
	shortcut?: string;
}

// Module-level registry for extra palette actions (parity with router.ts). A
// downstream module calls registerPaletteAction(...) once at import time; the
// palette folds these in after the built-ins.
const extraActions: PaletteAction[] = [];

/** Contribute an extra action to the palette. Idempotent by id. */
export function registerPaletteAction(action: PaletteAction): void {
	if (!extraActions.some((existing) => existing.id === action.id)) {
		extraActions.push(action);
	}
}

const MAX_VISIBLE = 10;
const MAX_SUGGESTED = 3;
const PANEL_MAX_WIDTH = 72;
// Unfiltered section order; Suggested is filled from recently run ids.
const GROUP_ORDER: readonly PaletteGroup[] = [
	"Navigation",
	"Actions",
	"Plugins",
];

// Recently run entry ids, most recent first. Module-level (session-scoped, not
// persisted) so it survives the palette closing and reopening.
const recentIds: string[] = [];

function rememberRecent(id: string): void {
	const existing = recentIds.indexOf(id);
	if (existing !== -1) {
		recentIds.splice(existing, 1);
	}
	recentIds.unshift(id);
	recentIds.length = Math.min(recentIds.length, MAX_SUGGESTED * 3);
}

/** Forget recently run entries (tests isolate the Suggested section with it). */
export function clearPaletteRecents(): void {
	recentIds.length = 0;
}

/** The keymap registry's display keys for a shell binding, so the palette's
 * shortcut column always matches what the shell dispatches. */
function globalKeys(id: string): string | undefined {
	return GLOBAL_KEYMAP.find((entry) => entry.id === id)?.keys;
}

const SHORTCUTS = {
	closeTab: globalKeys("close-tab"),
	keymap: paletteShortcut("action:keymap"),
	newChat: paletteShortcut("action:new-chat"),
	productMode: paletteShortcut("action:product-mode"),
	quit: paletteShortcut("action:quit"),
	reopenTab: globalKeys("restore-tab"),
	sidebar: paletteShortcut("action:sidebar"),
	split: globalKeys("split"),
	switchNode: paletteShortcut("action:node"),
} as const;

interface PaletteRow {
	entry: PaletteAction;
	group: PaletteGroup;
	key: string;
}

function groupedRows(entries: readonly PaletteAction[]): PaletteRow[] {
	const rows: PaletteRow[] = [];
	for (const id of recentIds) {
		const entry = entries.find((candidate) => candidate.id === id);
		if (entry && rows.length < MAX_SUGGESTED) {
			rows.push({ entry, group: "Suggested", key: `suggested:${entry.id}` });
		}
	}
	for (const group of GROUP_ORDER) {
		for (const entry of entries) {
			if ((entry.group ?? "Plugins") === group) {
				rows.push({ entry, group, key: entry.id });
			}
		}
	}
	return rows;
}

// Desktop NAV_ITEMS: label -> path (openTab destinations).
const NAV_DESTINATIONS: { label: string; path: string }[] = [
	{ label: "Chat", path: "/chat" },
	{ label: "Agents", path: "/agents" },
	{ label: "Engines", path: "/engines" },
	{ label: "Models", path: "/models" },
	{ label: "Skills", path: "/skills" },
	{ label: "Spaces", path: "/spaces" },
	{ label: "Tools", path: "/tools" },
	{ label: "Workflows", path: "/workflows" },
	{ label: "Calendar", path: "/calendar" },
	{ label: "Timeline", path: "/timeline" },
	{ label: "Monitors", path: "/monitors" },
	{ label: "Tasks", path: "/tasks" },
	{ label: "Inbox", path: "/inbox" },
	{ label: "Meetings", path: "/meetings" },
];

export function CommandPalette({
	mode,
	open,
	onClose,
	onSwitchNode,
	onToggleSidebar = () => undefined,
	onQuit,
}: {
	mode: ProductMode;
	onClose: () => void;
	onQuit: () => void;
	onSwitchNode: () => void;
	/** Ctrl+B's fallback for terminals or multiplexers that keep Ctrl+B/Alt+B. */
	onToggleSidebar?: () => void;
	open: boolean;
}) {
	const theme = useTheme();
	const { height: terminalHeight, width: terminalWidth } =
		useTerminalDimensions();
	const workspace = useWorkspace();
	const {
		closeTab,
		focusedPaneId,
		openTab,
		panes,
		regionGroups,
		restoreTab,
		splitActive,
	} = workspace;
	const { openOverlay } = useOverlay();
	// Declarative views contributed by the enabled plugins. Each becomes a jump-to
	// destination the moment Core reports it — the palette never names an app.
	const { views } = useContributions();

	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);

	// The focused group may sit in Center or in the Right / Bottom region.
	const focusedActiveTabId =
		[...panes, regionGroups.right, regionGroups.bottom].find(
			(pane) => pane?.id === focusedPaneId
		)?.activeTabId ?? null;
	const centerSplit = panes.length > 1;

	// The action list depends only on the workspace/contributions, not the query,
	// so typing does not rebuild it.
	const entries = useMemo<PaletteAction[]>(() => {
		const close = () => {
			setQuery("");
			setIndex(0);
			onClose();
		};
		const destinations =
			mode === "bot"
				? NAV_DESTINATIONS.filter((destination) => destination.path === "/chat")
				: buildNavDestinations();
		const nav: PaletteAction[] = destinations.map((dest) => ({
			id: `nav:${dest.path}`,
			group: "Navigation",
			label: `Go to ${dest.label}`,
			run: () => {
				openTab(dest.path);
				close();
			},
		}));
		// A view that CLAIMS a built-in surface is already reachable under that
		// surface's own entry, so only the extra ones get their own destination.
		// The comparison is against the CLAIM TOKEN, not the bare surface id: a
		// claiming view is called `surface:calendar`, so matching `surface.id`
		// directly would never hit and every claim would list twice.
		const contributedNav: PaletteAction[] = views
			.filter(
				(view) =>
					view.plugin.length > 0 &&
					!listSurfaces().some(
						(surface) => surfaceClaimToken(surface.id) === view.id
					)
			)
			.map((view) => ({
				id: `view:${view.plugin}:${view.id}`,
				group: "Plugins",
				label: `Go to ${view.title ?? view.id}`,
				run: () => {
					openTab(pluginViewPath(view.plugin, view.id));
					close();
				},
			}));
		const workspaceActions: PaletteAction[] =
			mode === "bot"
				? []
				: [
						{
							id: "action:split",
							group: "Actions",
							label: centerSplit ? "Join Center panes" : "Split Center",
							aliases: ["split pane", "unsplit", "toggle split"],
							shortcut: SHORTCUTS.split,
							run: () => {
								close();
								splitActive();
							},
						},
						...(focusedActiveTabId
							? [
									{
										id: "action:close-tab",
										group: "Actions" as const,
										label: "Close tab",
										shortcut: SHORTCUTS.closeTab,
										run: () => {
											close();
											closeTab(focusedActiveTabId);
										},
									},
								]
							: []),
						{
							id: "action:reopen-tab",
							group: "Actions",
							label: "Reopen closed tab",
							aliases: ["restore tab"],
							shortcut: SHORTCUTS.reopenTab,
							run: () => {
								close();
								restoreTab();
							},
						},
					];
		const actions: PaletteAction[] = [
			{
				id: "action:new-chat",
				group: "Actions",
				label: "New chat",
				aliases: ["new tab"],
				shortcut: SHORTCUTS.newChat,
				run: () => {
					openTab("/chat", { forceNew: true });
					close();
				},
			},
			...workspaceActions,
			...(mode === "bot"
				? []
				: [
						{
							id: "action:gateway",
							group: "Actions" as const,
							label: "Open Gateway",
							aliases: ["channels", "identities"],
							run: () => {
								openOverlay("gateway");
								close();
							},
						},
					]),
			...layoutActions(workspace, close),
			{
				id: "action:settings",
				group: "Actions",
				label: "Open Settings",
				aliases: ["credits"],
				run: () => {
					openOverlay("settings");
					close();
				},
			},
			{
				id: "action:keymap",
				group: "Actions",
				label: "Keyboard shortcuts",
				aliases: ["keymap", "keybindings", "help"],
				shortcut: SHORTCUTS.keymap,
				run: () => {
					openOverlay("keymap");
					close();
				},
			},
			{
				id: "action:sidebar",
				group: "Actions",
				label: "Toggle sidebar",
				shortcut: SHORTCUTS.sidebar,
				run: () => {
					close();
					onToggleSidebar();
				},
			},
			{
				id: "action:product-mode",
				group: "Actions",
				label: "Switch between Bot, Agent and OS",
				shortcut: SHORTCUTS.productMode,
				run: () => {
					openOverlay("product-mode");
					close();
				},
			},
			...(mode === "bot"
				? []
				: [
						{
							id: "action:node",
							group: "Actions" as const,
							label: "Switch node",
							shortcut: SHORTCUTS.switchNode,
							run: () => {
								close();
								onSwitchNode();
							},
						},
					]),
			{
				id: "action:quit",
				group: "Actions",
				label: "Quit",
				shortcut: SHORTCUTS.quit,
				run: () => {
					close();
					onQuit();
				},
			},
			...extraActions.map((action) => ({
				...action,
				group: action.group ?? "Plugins",
				run: () => {
					close();
					action.run();
				},
			})),
		];
		return [...nav, ...contributedNav, ...actions];
	}, [
		views,
		mode,
		openTab,
		openOverlay,
		onClose,
		onSwitchNode,
		onToggleSidebar,
		onQuit,
		splitActive,
		closeTab,
		restoreTab,
		focusedActiveTabId,
		centerSplit,
		workspace,
	]);

	const filtered = query.trim().length > 0;
	const rows = useMemo<PaletteRow[]>(() => {
		if (!filtered) {
			return groupedRows(entries);
		}
		return rankPaletteEntries(entries, query, recentIds).map((entry) => ({
			entry,
			group: entry.group ?? "Plugins",
			key: entry.id,
		}));
	}, [entries, query, filtered]);

	const runRow = (row: PaletteRow | undefined) => {
		if (!row) {
			return;
		}
		rememberRecent(row.entry.id);
		row.entry.run();
	};

	const handleKey = (key: KeyEvent) => {
		if (key.name === "escape" || (key.ctrl && key.name === "k")) {
			setQuery("");
			setIndex(0);
			onClose();
		} else if (key.name === "up") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (key.name === "down") {
			setIndex((i) => Math.min(Math.max(0, rows.length - 1), i + 1));
		} else if (key.name === "return") {
			runRow(rows[index]);
		} else if (key.name === "backspace") {
			setQuery((q) => q.slice(0, -1));
			setIndex(0);
		} else if (key.ctrl || key.meta || key.option) {
			// Chords (Alt reported as meta or, under kitty, option) are not text.
			return;
		} else if (key.name === "space") {
			setQuery((q) => `${q} `);
			setIndex(0);
		} else if (key.name.length === 1) {
			setQuery((q) => q + key.name);
			setIndex(0);
		}
	};

	useKeyboard((key) => {
		if (open) {
			handleKey(key);
		}
	});

	if (!open) {
		return null;
	}
	// The palette windows its own rows (no scrollbox) into the rows the Modal
	// leaves for its body, so short terminals never clip the panel.
	const panel = modalSize(terminalWidth, terminalHeight, PANEL_MAX_WIDTH, true);
	const { end: visibleEnd, start: visibleStart } = paletteWindow(
		rows.length,
		index,
		panel.maxBodyRows,
		MAX_VISIBLE,
		filtered ? null : rows.map((row) => row.group)
	);
	const visibleRows = rows.slice(visibleStart, visibleEnd);
	// Suggested rows repeat entries listed below them, so count entries.
	const resultCount = filtered ? rows.length : entries.length;
	const panelWidth = panel.width;
	// Keep the end of a long query (where the cursor is) visible on one line:
	// the inner width loses 2 border, 2 padding and 2 for the glyph + gap.
	const queryWidth = panelWidth - 6;
	const queryText =
		query.length > queryWidth
			? `…${query.slice(query.length - queryWidth + 1)}`
			: query;
	const close = () => {
		setQuery("");
		setIndex(0);
		onClose();
	};
	const resultHint = `↑↓ select · Enter run · Esc close · ${resultCount} ${
		resultCount === 1 ? "result" : "results"
	}`;
	return (
		<Modal
			footer={resultHint}
			header={
				<box flexDirection="row" flexGrow={1} flexShrink={1} gap={1}>
					<text fg={theme.colors.primary}>{"⌕"}</text>
					<text
						fg={query ? theme.colors.foreground : theme.colors.mutedForeground}
						wrapMode="none"
					>
						{queryText || "Jump to…"}
					</text>
				</box>
			}
			hint=""
			onClose={close}
			scroll={false}
			width={PANEL_MAX_WIDTH}
			zIndex={50}
		>
			{visibleRows.map((row, visibleIndex) => {
				const rowIndex = visibleStart + visibleIndex;
				const selected = rowIndex === index;
				// The whole selected row takes the selection pair so the caret,
				// label and shortcut stay legible on the fill in every theme.
				const rowForeground = selected
					? theme.colors.selectionForeground
					: theme.colors.foreground;
				const previous = visibleRows[visibleIndex - 1];
				const showHeader =
					!filtered && (visibleIndex === 0 || previous?.group !== row.group);
				return (
					<box flexDirection="column" key={row.key}>
						{showHeader ? (
							<box paddingTop={visibleIndex === 0 ? 0 : 1}>
								<text fg={theme.colors.mutedForeground}>{row.group}</text>
							</box>
						) : null}
						<box
							backgroundColor={selected ? theme.colors.selection : undefined}
							flexDirection="row"
							gap={1}
							height={1}
							onMouseDown={(event: MouseEvent) => {
								event.stopPropagation();
								runRow(row);
							}}
							onMouseOver={() => setIndex(rowIndex)}
						>
							<text fg={rowForeground} flexShrink={0}>
								{selected ? "›" : " "}
							</text>
							<text
								fg={rowForeground}
								flexGrow={1}
								flexShrink={1}
								truncate
								wrapMode="none"
							>
								{row.entry.label}
							</text>
							{row.entry.shortcut ? (
								<text
									fg={
										selected
											? theme.colors.selectionForeground
											: theme.colors.mutedForeground
									}
									flexShrink={0}
								>
									{row.entry.shortcut}
								</text>
							) : null}
						</box>
					</box>
				);
			})}
			{rows.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>No matches</text>
			) : null}
		</Modal>
	);
}

// Merge the static NAV_DESTINATIONS with any registered surface path that is not
// already listed, so newly registered surfaces are reachable from the palette
// without editing this file.
const SIDE_REGIONS = [
	["right", "Right"],
	["bottom", "Bottom"],
] as const;

/** Pane layout actions, matching the Desktop palette's Layout group. */
function layoutActions(
	workspace: ReturnType<typeof useWorkspace>,
	close: () => void
): PaletteAction[] {
	const run = (action: () => void) => () => {
		action();
		close();
	};
	const actions: PaletteAction[] = [];
	for (const [region, name] of SIDE_REGIONS) {
		if (workspace.focusedRegion !== region) {
			actions.push({
				id: `layout:move-${region}`,
				group: "Actions",
				label: `Move tab to ${name}`,
				run: run(() => workspace.moveActiveTo(region)),
			});
		}
		const hasTabs = workspace.state.groups.some(
			(group) => group.region === region && group.itemIds.length > 0
		);
		if (hasTabs) {
			const open = workspace.state.openRegions[region];
			actions.push({
				id: `layout:toggle-${region}`,
				group: "Actions",
				label: `${open ? "Hide" : "Show"} ${name}`,
				run: run(() =>
					open ? workspace.hideRegion(region) : workspace.showRegion(region)
				),
			});
		}
	}
	if (workspace.focusedRegion !== "center") {
		actions.push({
			id: "layout:move-center",
			group: "Actions",
			label: "Move tab to Center",
			run: run(() => workspace.moveActiveTo("center")),
		});
	}
	// Split / join Center is the "action:split" entry (Ctrl+Alt+S shortcut).
	actions.push({
		id: "layout:reset",
		group: "Actions",
		label: "Reset layout",
		run: run(workspace.resetLayout),
	});
	return actions;
}

function buildNavDestinations(): { label: string; path: string }[] {
	const known = new Set(NAV_DESTINATIONS.map((dest) => dest.path));
	const extra: { label: string; path: string }[] = [];
	for (const surface of listSurfaces()) {
		const path = `/${surface.id}`;
		// Only fold in a surface whose id-path is one it actually owns; deep-link
		// aliases (e.g. store-models owns /models, not /store-models) are already
		// covered by the static NAV_DESTINATIONS and would otherwise 404.
		if (!known.has(path) && surface.match(path)) {
			extra.push({ label: surface.title, path });
		}
	}
	return [...NAV_DESTINATIONS, ...extra];
}
