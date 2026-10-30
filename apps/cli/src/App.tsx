/* @jsxImportSource @opentui/react */
// The shell: providers + the desktop-mirrored WorkspaceShell (TabStrip on top,
// Sidebar on the left, SplitView in the center with the Right and Bottom
// workbench regions beside and below it, OverlayHost + CommandPalette
// floating, StatusBar at the bottom). This mirrors apps/desktop's Layout, not the
// legacy flat-tab CLI shell.
//
// Keyboard ownership (see InputFocusContext + the surface contract):
//   - Ctrl+C            copy selection, else interrupt the active surface
//                       (stop a stream / clear a draft), else press twice
//                       within 2s to quit (renderer.destroy)
//   - Ctrl+K            command palette
//   - Ctrl+Shift+M      product mode picker
//   - Ctrl+T            new chat tab
//   - Ctrl+W            close the focused pane's active tab
//   - Ctrl+Shift+T      restore the last-closed tab
//   - Ctrl+Alt+S        toggle a two-pane split
//   - Alt+Arrow         focus the nearest visible pane in that direction
//   - Ctrl+Shift+Right  move the focused tab to Right
//   - Ctrl+Shift+Down   move the focused tab to Bottom
//   - Ctrl+Shift+Up     move the focused tab back to Center
//   - Ctrl+Tab          cycle tabs in the focused pane (Shift reverses)
//   - Ctrl+B / Alt+B    show / hide the sidebar (persisted in cli-layout.json;
//                       until chosen it auto-hides below 100 columns)
//   - F6 / Alt+0        sidebar focus mode: the sidebar takes ↑/↓/Enter/←/→
//                       (surfaces yield via InputFocusContext); Esc / F6 return
//   - F1 / Ctrl+?       keyboard shortcuts overlay (toggles; a bare "?" opens it
//                       too while no text field owns character input)
// Every binding is declared once in core/keymap.ts (GLOBAL_KEYMAP) and dispatched
// here by id, so the overlay, status-bar hints and palette shortcuts stay in sync.
// The palette, overlays, and node picker each own their keys while open; the
// shell suppresses its bindings for them (only Ctrl+C stays global). Surfaces own
// the remaining keys, gated on being the focused pane's active tab.

import type { KeyEvent, MouseEvent } from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { CLOSED_NODE_PICKER, useShellNodePicker } from "./App-node-picker.ts";
import {
	isInsideSidebar,
	PersistentWorkspaceProvider,
	ShellStatusBar,
	SidebarRail,
} from "./App-shell-chrome.tsx";
import {
	useCliAutoUpdate,
	useLaunchUpdateNotice,
	useUserNotificationFeed,
} from "./App-shell-feeds.ts";
import { useShellTitle } from "./App-shell-title.ts";
import { ChatIntentProvider } from "./core/ChatIntentContext.tsx";
import { ContributionsProvider } from "./core/ContributionsContext.tsx";
import { CoreProvider, useCore } from "./core/CoreContext.tsx";
import { CoreHealthProvider } from "./core/CoreHealthContext.tsx";
import { herdrReporter } from "./core/herdr.ts";
import {
	InputFocusProvider,
	useInputFocused,
	useRunInterruptHandler,
	useSetPaletteOpen,
	useSetSidebarFocused,
	useSidebarFocused,
} from "./core/InputFocusContext.tsx";
import {
	type LayoutPreference,
	readLayoutPreference,
	resolveSidebarVisible,
	writeLayoutPreference,
} from "./core/layoutPreferences.ts";
import {
	ProductModeProvider,
	useCliProductMode,
} from "./core/ProductModeContext.tsx";
import type { ProductMode } from "./core/productMode.ts";
import {
	OverlayHost,
	OverlayProvider,
	useOverlay,
} from "./overlays/OverlayHost.tsx";
// Side-effect import: swaps the skeleton Settings/Gateway overlay bodies for the
// real ones (registerOverlay, last registration wins).
import "./overlays/register.ts";
import { WaitlistGate } from "./components/WaitlistGate.tsx";
import {
	type FocusArrow,
	isHelpKey,
	matchGlobalBinding,
	moveTargetFor,
} from "./core/keymap.ts";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { copySelectionToClipboard, useCopyOnSelect } from "./ui/clipboard.ts";
import { StatusProvider } from "./ui/StatusContext.tsx";
import { TerminalThemeProvider } from "./ui/TerminalThemeProvider.tsx";
import { ToastHost, ToastProvider, useToast } from "./ui/toast.tsx";
import { NodePicker } from "./workspace/NodePicker.tsx";
import { RegionView } from "./workspace/RegionView.tsx";
import { SplitView } from "./workspace/SplitView.tsx";
import { TabStrip } from "./workspace/TabStrip.tsx";
import { useWorkspace } from "./workspace/WorkspaceContext.tsx";

/** Each product mode's display name (the stored values stay "bot" / "console" / "os"). */
const MODE_NAMES: Record<ProductMode, string> = {
	bot: "Bot",
	console: "Agent",
	os: "OS",
};

const REGION_NAMES = {
	bottom: "Bottom",
	center: "Center",
	left: "Left",
	right: "Right",
} as const;

/** A second Ctrl+C within this window quits. */
export const EXIT_CONFIRM_WINDOW_MS = 2000;
export const EXIT_CONFIRM_MESSAGE = "Press Ctrl+C again to quit";

function WorkspaceShell() {
	const renderer = useRenderer();
	const theme = useTheme();
	const { target, url, setTarget } = useCore();
	const { effectiveMode, modeStatus, setManagedNode } = useCliProductMode();
	// Account sessions live in the local Core vault. Keep that source stable while
	// the user switches the active node to a cloud node for this terminal session.
	const [authSourceTarget] = useState(target);
	const { dismiss, notify } = useToast();
	// Drag-select copies to the host clipboard (OSC 52) with a toast.
	useCopyOnSelect();
	const runInterruptHandler = useRunInterruptHandler();
	// When the first Ctrl+C of a two-press quit landed; null when disarmed.
	const exitArmedAt = useRef<number | null>(null);
	// The "press again" toast of the armed quit, dismissed when it disarms.
	const exitToastId = useRef<number | null>(null);
	const { openId: overlayOpenId, openOverlay, closeOverlay } = useOverlay();
	const inputFocused = useInputFocused();
	const {
		closeActiveTab,
		cycleTab,
		focusDirection,
		focusedPaneId,
		focusedRegion,
		focusTabByIndex,
		moveActiveTo,
		openTab,
		panes,
		regionGroups,
		restoreTab,
		splitActive,
		tabs,
	} = useWorkspace();
	// The focused group may sit in Center or in the Right / Bottom region.
	const focusedTabId =
		[...panes, regionGroups.right, regionGroups.bottom].find(
			(pane) => pane?.id === focusedPaneId
		)?.activeTabId ?? null;
	useShellTitle(
		renderer,
		tabs.find((tab) => tab.id === focusedTabId)?.title ?? null
	);

	const { width: terminalColumns } = useTerminalDimensions();
	const [layout, setLayout] = useState<LayoutPreference>(() =>
		readLayoutPreference()
	);
	const sidebarFocused = useSidebarFocused();
	const setSidebarFocused = useSetSidebarFocused();
	useEffect(() => () => setSidebarFocused(false), [setSidebarFocused]);
	// Focus mode peeks a hidden sidebar open until focus returns.
	const sidebarVisible =
		resolveSidebarVisible(layout.sidebar, terminalColumns) || sidebarFocused;
	const toggleSidebar = () => {
		const next: LayoutPreference = {
			sidebar: sidebarVisible ? "hidden" : "shown",
		};
		setLayout(writeLayoutPreference(next));
		if (sidebarVisible) {
			setSidebarFocused(false);
		}
	};

	const [paletteOpen, setPaletteOpen] = useState(false);
	const setPaletteCapture = useSetPaletteOpen();
	const { handleNodesKey, nodePicker, openNodePicker, setNodePicker } =
		useShellNodePicker({
			authSourceTarget,
			notify,
			setManagedNode,
			setTarget,
			url,
		});
	const openPalette = () => {
		setPaletteCapture(true);
		setPaletteOpen(true);
	};
	const closePalette = () => {
		setPaletteCapture(false);
		setPaletteOpen(false);
	};

	useLaunchUpdateNotice(target, notify);

	useCliAutoUpdate(target, notify);

	useUserNotificationFeed(target, authSourceTarget, notify);

	const quit = () => {
		// Hand the terminal its own title back before the renderer goes away.
		renderer.setTerminalTitle("");
		if (herdrReporter) {
			void herdrReporter.release().finally(() => renderer.destroy());
		} else {
			renderer.destroy();
		}
	};

	const switchNode = () => {
		if (effectiveMode === "bot" && modeStatus !== "checking") {
			notify(
				"Bot stays on its current workspace. Switch to Agent or OS to change nodes.",
				"info"
			);
		} else {
			openNodePicker();
		}
	};

	// Shell workspace bindings (no overlay/palette/picker open), dispatched by
	// GLOBAL_KEYMAP id. All but the bare "?" are modified keys, safe to fire while
	// a surface composer owns character input; "?" only matches when no text
	// field claims input (inputFocused).
	const workspaceActions: Record<string, (key: KeyEvent) => void> = {
		"close-tab": () => closeActiveTab(),
		"cycle-tab": (key) => cycleTab(key.shift ? -1 : 1),
		"focus-pane": (key) => focusDirection(key.name as FocusArrow),
		"focus-tab": (key) => focusTabByIndex(Number(key.name) - 1),
		keymap: () => openOverlay("keymap"),
		mode: () => openOverlay("product-mode"),
		"move-tab": (key) => {
			const region = moveTargetFor(key.name);
			if (region) {
				moveActiveTo(region);
			}
		},
		"new-tab": () => openTab("/chat", { forceNew: true }),
		node: () => switchNode(),
		palette: () => openPalette(),
		"restore-tab": () => restoreTab(),
		sidebar: () => toggleSidebar(),
		"sidebar-focus": () => setSidebarFocused(true),
		split: () => splitActive(),
	};

	// Sidebar focus mode: the Sidebar walks its rows on plain keys; the shell only
	// hands focus back (Esc / F6 / Alt+0) and still runs modified globals, which
	// leave focus mode first so the palette or a new tab gets the keyboard.
	const handleSidebarFocusKey = (key: KeyEvent) => {
		// No text field may act on a key the sidebar owns (a surface input left
		// focused would otherwise type "j" or submit on Enter).
		key.preventDefault();
		const id = matchGlobalBinding(key, { inputFocused: true });
		if (key.name === "escape" || id === "sidebar-focus") {
			setSidebarFocused(false);
			return;
		}
		if (id) {
			setSidebarFocused(false);
			workspaceActions[id]?.(key);
		}
	};

	const handleWorkspaceKey = (key: KeyEvent) => {
		const id = matchGlobalBinding(key, { inputFocused });
		if (id && id !== "focus-pane") {
			// A focused text field must not also act on a shell binding: the
			// composer reads Ctrl+K as delete-to-line-end, Ctrl+W as delete-word,
			// Ctrl+B / Alt+B as cursor motions and would type the digit of Alt+n.
			// Alt+Arrow stays shared so word motion still works in a single pane.
			key.preventDefault();
		}
		if (id) {
			workspaceActions[id]?.(key);
		}
	};

	// Cancels a pending two-press quit and removes its now-stale prompt.
	const disarmExit = () => {
		if (exitArmedAt.current === null) {
			return;
		}
		exitArmedAt.current = null;
		if (exitToastId.current !== null) {
			dismiss(exitToastId.current);
			exitToastId.current = null;
		}
	};

	// Layered Ctrl+C: copy a selection, else let the active surface stop its
	// stream or clear its draft, else arm a two-press quit.
	const handleCtrlC = () => {
		const selection = renderer.getSelection();
		if (copySelectionToClipboard(renderer, selection, notify) !== "empty") {
			renderer.clearSelection();
			return;
		}
		const surfaceOwnsKeys = !(paletteOpen || overlayOpenId || nodePicker.open);
		if (surfaceOwnsKeys && runInterruptHandler()) {
			disarmExit();
			return;
		}
		const armedAt = exitArmedAt.current;
		if (armedAt !== null && Date.now() - armedAt <= EXIT_CONFIRM_WINDOW_MS) {
			exitArmedAt.current = null;
			quit();
			return;
		}
		// Drop a lingering prompt so a re-arm shows a fresh toast, not "×2".
		disarmExit();
		exitArmedAt.current = Date.now();
		exitToastId.current = notify(EXIT_CONFIRM_MESSAGE, "warning", {
			ttlMs: EXIT_CONFIRM_WINDOW_MS,
		});
	};

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			handleCtrlC();
			return;
		}
		disarmExit();
		// F1 / Ctrl+? toggle the shortcuts overlay closed (a bare "?" is filter text
		// there). Other overlays keep F1 for themselves.
		if (overlayOpenId === "keymap" && isHelpKey(key, { inputFocused: true })) {
			closeOverlay();
			return;
		}
		if (paletteOpen || overlayOpenId) {
			return;
		}
		if (nodePicker.open) {
			handleNodesKey(key);
			return;
		}
		if (sidebarFocused) {
			handleSidebarFocusKey(key);
			return;
		}
		handleWorkspaceKey(key);
	});

	return (
		<box
			backgroundColor={theme.colors.background}
			flexDirection="column"
			height="100%"
			width="100%"
		>
			{effectiveMode === "bot" ? null : <TabStrip />}
			<box
				flexDirection="row"
				flexGrow={1}
				flexShrink={1}
				minHeight={0}
				onMouseDown={(event: MouseEvent) => {
					// A click in the pane hands the keyboard back, as Esc does.
					if (sidebarFocused && !isInsideSidebar(event.target)) {
						setSidebarFocused(false);
					}
				}}
				overflow="hidden"
			>
				{sidebarVisible ? null : <SidebarRail onShow={toggleSidebar} />}
				{sidebarVisible ? (
					<Sidebar
						// A modal opened by mouse over focus mode owns the keys, so the
						// sidebar must not walk or activate rows behind it.
						focused={
							sidebarFocused &&
							!(paletteOpen || overlayOpenId || nodePicker.open)
						}
						modeLabel={
							modeStatus === "checking"
								? "Checking"
								: effectiveMode === "bot"
									? "Bot"
									: effectiveMode === "os"
										? "OS"
										: "Agent"
						}
						onOpenPalette={openPalette}
						onReleaseFocus={() => setSidebarFocused(false)}
						onSwitchMode={() => openOverlay("product-mode")}
						onSwitchNode={openNodePicker}
						productMode={effectiveMode}
					/>
				) : null}
				<box
					flexDirection="column"
					flexGrow={1}
					flexShrink={1}
					minHeight={0}
					overflow="hidden"
				>
					<box
						flexDirection="row"
						flexGrow={1}
						flexShrink={1}
						minHeight={0}
						overflow="hidden"
					>
						<SplitView />
						<RegionView region="right" />
					</box>
					<RegionView region="bottom" />
				</box>
			</box>
			<CommandPalette
				mode={effectiveMode}
				onClose={closePalette}
				onQuit={quit}
				onSwitchNode={openNodePicker}
				onToggleSidebar={toggleSidebar}
				open={paletteOpen}
			/>
			<OverlayHost />
			{nodePicker.open ? (
				<NodePicker
					currentUrl={url}
					health={nodePicker.health}
					index={nodePicker.index}
					managedState={nodePicker.managedState}
					nodes={nodePicker.nodes}
					onClose={() => setNodePicker(CLOSED_NODE_PICKER)}
				/>
			) : null}
			<ShellStatusBar
				// The mode's name, not its stored value ("console" is Agent).
				left={`${MODE_NAMES[effectiveMode].toUpperCase()} · ${url}`}
				// Right / Bottom focus is named and kept; a narrow terminal trims the URL.
				leftSuffix={
					focusedRegion === "center" ? undefined : REGION_NAMES[focusedRegion]
				}
				mode={effectiveMode}
			/>
			{/* Absolute top-right layer; last so it paints above panes and overlays. */}
			<ToastHost />
		</box>
	);
}

/** Root component: stacks the providers around the workspace shell. */
export function App({
	persistLayout = false,
	target,
}: {
	/** Save and restore the pane layout in the Ryu home directory. Only the
	 *  CLI entry point turns this on, so tests never touch a profile. */
	persistLayout?: boolean;
	target?: ApiTarget;
}) {
	return (
		<CoreProvider initial={target}>
			<TerminalThemeProvider>
				<WaitlistGate>
					<CoreHealthProvider>
						<ContributionsProvider>
							<InputFocusProvider>
								<ToastProvider>
									<ChatIntentProvider>
										<PersistentWorkspaceProvider persist={persistLayout}>
											<OverlayProvider>
												<ProductModeProvider>
													<StatusProvider>
														<WorkspaceShell />
													</StatusProvider>
												</ProductModeProvider>
											</OverlayProvider>
										</PersistentWorkspaceProvider>
									</ChatIntentProvider>
								</ToastProvider>
							</InputFocusProvider>
						</ContributionsProvider>
					</CoreHealthProvider>
				</WaitlistGate>
			</TerminalThemeProvider>
		</CoreProvider>
	);
}
