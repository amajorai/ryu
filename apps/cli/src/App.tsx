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

import type {
	CliRenderer,
	KeyEvent,
	MouseEvent,
	Renderable,
} from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type ReactNode,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "./core/ChatIntentContext.tsx";
import { ContributionsProvider } from "./core/ContributionsContext.tsx";
import { CoreProvider, useCore } from "./core/CoreContext.tsx";
import { CoreHealthProvider } from "./core/CoreHealthContext.tsx";
import { chatActivity } from "./core/chatActivity.ts";
import { herdrReporter } from "./core/herdr.ts";
import { fetchActiveAccountIdentity } from "./core/humanMentions.ts";
import {
	InputFocusProvider,
	useInputFocused,
	useRunInterruptHandler,
	useSetNodePickerOpen,
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
import { fetchManagedNodes } from "./core/managedNodes.ts";
import {
	healthCheck,
	loadNodes,
	type Node,
	nodeToTarget,
	resolveActive,
	setActive,
} from "./core/nodes.ts";
import {
	ProductModeProvider,
	useCliProductMode,
} from "./core/ProductModeContext.tsx";
import type { ProductMode } from "./core/productMode.ts";
import { startCliAutoUpdate } from "./core/self-update.ts";
import {
	TITLE_SPINNER_INTERVAL_MS,
	terminalTitle,
} from "./core/terminalTitle.ts";
import { fetchUpdateCheck } from "./core/update.ts";
import { streamUserNotifications } from "./core/userNotificationStream.ts";
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
	DEFAULT_HINT_PRIORITY,
	type FocusArrow,
	globalHints,
	isHelpKey,
	matchGlobalBinding,
	moveTargetFor,
} from "./core/keymap.ts";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { SIDEBAR_ROOT_ID, Sidebar } from "./sidebar/Sidebar.tsx";
import {
	copySelectionToClipboard,
	useCopyOnSelect,
	useSelectionSafeActivate,
} from "./ui/clipboard.ts";
import { type KeyHint, StatusBar } from "./ui/StatusBar.tsx";
import { StatusProvider, useActiveStatus } from "./ui/StatusContext.tsx";
import { TerminalThemeProvider } from "./ui/TerminalThemeProvider.tsx";
import { ToastHost, ToastProvider, useToast } from "./ui/toast.tsx";
import { NodePicker } from "./workspace/NodePicker.tsx";
import { RegionView } from "./workspace/RegionView.tsx";
import { SplitView } from "./workspace/SplitView.tsx";
import { TabStrip } from "./workspace/TabStrip.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "./workspace/WorkspaceContext.tsx";
import { fileWorkbenchPersistence } from "./workspace/workbenchPersistence.ts";

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

// Global hints come from GLOBAL_KEYMAP (core/keymap.ts). Priorities decide what
// survives a narrow terminal (lower is kept first): the palette and quit always
// stay; the focused surface's hints rank right after them.
/** Surface hints rank after palette, quit and F1 (0, 1, 1.2) and ahead of the
 * other globals (2+); a surface's own priorities only order its hints within
 * this band. */
const SURFACE_HINT_PRIORITY = 1.5;
const SURFACE_HINT_SPREAD = 1000;
/** The node/mode text shows in full once palette, quit and the surface's hints
 * fit, ahead of the secondary globals (^T, ^W, ^N, ^⇧M, F1) - those stay one ^K away. */
const LEFT_STATUS_PRIORITY = 1.9;

/** A second Ctrl+C within this window quits. */
export const EXIT_CONFIRM_WINDOW_MS = 2000;
export const EXIT_CONFIRM_MESSAGE = "Press Ctrl+C again to quit";

interface NodePickerState {
	health: Record<string, boolean>;
	index: number;
	managedState: "loading" | "ready" | "error";
	nodes: Node[];
	open: boolean;
}

const CLOSED_NODE_PICKER: NodePickerState = {
	managedState: "ready",
	open: false,
	nodes: [],
	index: 0,
	health: {},
};

/**
 * Mirror the focused tab into the terminal title (an OSC window-title sequence) and the Herdr pane
 * metadata. The title spinner advances on its own slow tick and the title is
 * written only when its text changes, so streaming never floods the terminal.
 */
function useShellTitle(renderer: CliRenderer, tabTitle: string | null) {
	const focusedChat = useSyncExternalStore(
		chatActivity.subscribe,
		chatActivity.focused
	);
	const label = focusedChat?.title ?? tabTitle ?? "";
	const streaming = focusedChat?.streaming ?? false;
	const model = focusedChat?.model ?? null;
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		setFrame(0);
		if (!streaming) {
			return;
		}
		const timer = setInterval(
			() => setFrame((value) => value + 1),
			TITLE_SPINNER_INTERVAL_MS
		);
		return () => clearInterval(timer);
	}, [streaming]);
	const title = terminalTitle(label, streaming ? frame : null);
	const written = useRef<string | null>(null);
	useEffect(() => {
		if (written.current === title) {
			return;
		}
		written.current = title;
		renderer.setTerminalTitle(title);
	}, [renderer, title]);
	useEffect(() => {
		if (label) {
			herdrReporter?.reportMetadata({ title: label, model });
		}
	}, [label, model]);
}

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
	const setNodePickerCapture = useSetNodePickerOpen();
	const [nodePicker, setNodePicker] =
		useState<NodePickerState>(CLOSED_NODE_PICKER);
	useEffect(() => {
		setNodePickerCapture(nodePicker.open);
		return () => setNodePickerCapture(false);
	}, [nodePicker.open, setNodePickerCapture]);
	const managedNodesRequest = useRef(0);
	const autoUpdateStarted = useRef(false);
	const openPalette = () => {
		setPaletteCapture(true);
		setPaletteOpen(true);
	};
	const closePalette = () => {
		setPaletteCapture(false);
		setPaletteOpen(false);
	};

	// Launch update notice, the port of apps/cli's on-launch fetch_update_check.
	// Runs on mount and on every node switch (target changes), flashing a toast
	// when the node reports a newer Ryu release. Errors resolve to null in the
	// reader, so this never blocks the shell.
	useEffect(() => {
		let cancelled = false;
		fetchUpdateCheck(target)
			.then((notice) => {
				if (!cancelled && notice?.available) {
					notify(
						`▲ Core ${notice.latest} is available (node ${notice.current})`,
						"info"
					);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target, notify]);

	// Download and verify the matching CLI release without delaying or interrupting
	// the terminal session. The replacement takes effect the next time ryu-cli runs.
	useEffect(() => {
		if (autoUpdateStarted.current) {
			return;
		}
		autoUpdateStarted.current = true;
		let cancelled = false;
		void startCliAutoUpdate(target)
			.then((result) => {
				if (cancelled) {
					return;
				}
				if (result.status === "installed") {
					notify(
						`Ryu CLI ${result.version} is ready and will run on your next launch.`,
						"success"
					);
				} else if (result.status === "pending-exit") {
					notify(
						`Ryu CLI ${result.version} will install after this session closes.`,
						"success"
					);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target, notify]);

	// Match Desktop's per-user notification feed. Core performs recipient filtering;
	// the local account id is included for local nodes that have no verified caller.
	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const run = async (userId: string | null) => {
			const seenNotificationIds = new Set<string>();
			const onEvent = (event: {
				body?: string | null;
				level?: string;
				notification_id?: string | null;
				target_user_id?: string | null;
				title: string;
			}) => {
				if (event.target_user_id && userId && event.target_user_id !== userId) {
					return;
				}
				const notificationId = event.notification_id;
				if (notificationId && seenNotificationIds.has(notificationId)) {
					return;
				}
				if (notificationId) {
					seenNotificationIds.add(notificationId);
					if (seenNotificationIds.size > 128) {
						const oldest = seenNotificationIds.values().next().value;
						if (oldest) {
							seenNotificationIds.delete(oldest);
						}
					}
				}
				const variant =
					event.level === "error" || event.level === "warning"
						? "error"
						: "info";
				const message = event.body
					? `${event.title} · ${event.body}`
					: event.title;
				notify(message, variant);
			};
			while (!cancelled) {
				try {
					await streamUserNotifications(
						target,
						userId,
						onEvent,
						controller.signal
					);
				} catch {
					// Connection failures are transient; reconnect without spamming the TUI.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, 2000);
				});
			}
		};
		const start = async () => {
			const identityTarget = target.userJwt ? target : authSourceTarget;
			const identity = await fetchActiveAccountIdentity(identityTarget);
			if (cancelled || !(identity || target.userJwt)) {
				return;
			}
			const userId = identity?.userId ?? null;
			await run(userId);
		};
		void start().catch(() => undefined);
		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [authSourceTarget, notify, target]);

	const quit = () => {
		// Hand the terminal its own title back before the renderer goes away.
		renderer.setTerminalTitle("");
		if (herdrReporter) {
			void herdrReporter.release().finally(() => renderer.destroy());
		} else {
			renderer.destroy();
		}
	};

	// Load local nodes immediately, then add control-plane managed nodes for this
	// session. Their short-lived userJwt is never written to the local node file.
	const openNodePicker = () => {
		const config = loadNodes();
		const requestId = ++managedNodesRequest.current;
		const activeName = resolveActive(config).name;
		const byUrl = config.nodes.findIndex((node) => node.url === url);
		const byName = config.nodes.findIndex((node) => node.name === activeName);
		setNodePicker({
			open: true,
			nodes: config.nodes,
			index: byUrl >= 0 ? byUrl : Math.max(0, byName),
			managedState: "loading",
			health: {},
		});
		for (const node of config.nodes) {
			healthCheck(nodeToTarget(node))
				.then((ok) =>
					setNodePicker((prev) => ({
						...prev,
						health: { ...prev.health, [node.name]: ok },
					}))
				)
				.catch(() => undefined);
		}
		fetchManagedNodes(authSourceTarget)
			.then((managedNodes) => {
				if (requestId !== managedNodesRequest.current) {
					return;
				}
				const nodes = [...config.nodes, ...(managedNodes ?? [])];
				const byActiveUrl = nodes.findIndex((node) => node.url === url);
				setNodePicker((previous) => {
					if (!previous.open || requestId !== managedNodesRequest.current) {
						return previous;
					}
					return {
						...previous,
						nodes,
						index: byActiveUrl >= 0 ? byActiveUrl : previous.index,
						managedState: managedNodes === null ? "error" : "ready",
					};
				});
				for (const node of managedNodes ?? []) {
					healthCheck(nodeToTarget(node))
						.then((ok) =>
							setNodePicker((previous) => ({
								...previous,
								health: { ...previous.health, [node.name]: ok },
							}))
						)
						.catch(() => undefined);
				}
			})
			.catch(() => {
				if (requestId === managedNodesRequest.current) {
					setNodePicker((previous) =>
						previous.open ? { ...previous, managedState: "error" } : previous
					);
				}
			});
	};

	// Node picker is open: ↑/↓ move, Enter switches (and persists), Esc closes.
	const handleNodesKey = (key: KeyEvent) => {
		const count = nodePicker.nodes.length;
		if (key.name === "escape") {
			setNodePicker(CLOSED_NODE_PICKER);
			return;
		}
		if (count === 0) {
			return;
		}
		if (key.name === "up" || key.name === "k") {
			setNodePicker((prev) => ({
				...prev,
				index: (prev.index - 1 + count) % count,
			}));
		} else if (key.name === "down" || key.name === "j") {
			setNodePicker((prev) => ({ ...prev, index: (prev.index + 1) % count }));
		} else if (key.name === "return") {
			const chosen = nodePicker.nodes[nodePicker.index];
			setNodePicker(CLOSED_NODE_PICKER);
			if (chosen) {
				setTarget(nodeToTarget(chosen));
				setManagedNode(chosen.managed ? chosen : null);
				if (!chosen.managed) {
					setActive(chosen.name);
				}
				notify(`Switched to ${chosen.name}`, "info");
			}
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

/** The workspace, with its layout saved to the Ryu home directory when the
 *  entry point asks for it. A failed save is reported once and the session
 *  keeps running from memory. Embedded and test renders stay in memory. */
function PersistentWorkspaceProvider({
	children,
	persist,
}: {
	children: ReactNode;
	persist: boolean;
}) {
	const { notify } = useToast();
	const notifyRef = useRef(notify);
	notifyRef.current = notify;
	const [persistence] = useState(() =>
		persist
			? fileWorkbenchPersistence({
					onError: (message) => notifyRef.current(message, "error"),
				})
			: undefined
	);
	return (
		<WorkspaceProvider persistence={persistence}>{children}</WorkspaceProvider>
	);
}

/** Whether a mouse target sits inside the sidebar's root box. */
function isInsideSidebar(target: Renderable | null): boolean {
	for (let node = target; node; node = node.parent) {
		if (node.id === SIDEBAR_ROOT_ID) {
			return true;
		}
	}
	return false;
}

/** The one-column rail a hidden sidebar leaves behind; a click shows it again
 * (herdr's collapsed sidebar). */
function SidebarRail({ onShow }: { onShow: () => void }) {
	const theme = useTheme();
	const activate = useSelectionSafeActivate();
	// A tinted strip reads as a collapsed panel edge rather than a prompt marker
	// beside the pane's first line; the whole strip is the click target.
	return (
		<box
			backgroundColor={theme.colors.muted}
			flexDirection="column"
			flexShrink={0}
			paddingTop={1}
			width={1}
			{...activate(onShow)}
		>
			<text fg={theme.colors.mutedForeground} selectable={false}>
				›
			</text>
		</box>
	);
}

/** The shell's bottom bar: global hints merged with the focused surface's
 * contribution. Its own component so a surface publishing hints or the busy
 * clock re-renders only the bar, not the whole shell. */
function ShellStatusBar({
	left,
	leftSuffix,
	mode,
}: {
	left: string;
	/** The focused region, kept visible when the left text is trimmed. */
	leftSuffix?: string;
	mode: ProductMode;
}) {
	const status = useActiveStatus();
	const globals: KeyHint[] = globalHints(mode);
	const surfaceHints = (status?.hints ?? []).map((hint) => ({
		...hint,
		priority:
			SURFACE_HINT_PRIORITY +
			(hint.priority ?? DEFAULT_HINT_PRIORITY) / SURFACE_HINT_SPREAD,
	}));
	return (
		<StatusBar
			busy={status?.busy}
			hints={[...surfaceHints, ...globals]}
			left={status?.left ?? left}
			leftPriority={LEFT_STATUS_PRIORITY}
			leftSuffix={leftSuffix}
		/>
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
