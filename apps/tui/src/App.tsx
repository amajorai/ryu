/* @jsxImportSource @opentui/react */
// The shell: providers + the desktop-mirrored WorkspaceShell (TabStrip on top,
// Sidebar on the left, SplitView in the center, OverlayHost + CommandPalette
// floating, StatusBar at the bottom). This mirrors apps/desktop's Layout, not the
// legacy flat-tab CLI shell.
//
// Keyboard ownership (see InputFocusContext + the surface contract):
//   - Ctrl+C            quit (renderer.destroy)
//   - Ctrl+K            command palette
//   - Ctrl+T            new chat tab
//   - Ctrl+W            close the focused pane's active tab
//   - Ctrl+Shift+T      restore the last-closed tab
//   - Ctrl+Alt+S        toggle a two-pane split
//   - Alt+Left/Right    move focus between panes
//   - Ctrl+Tab          cycle tabs in the focused pane (Shift reverses)
// The palette, overlays, and node picker each own their keys while open; the
// shell suppresses its bindings for them (only Ctrl+C stays global). Surfaces own
// the remaining keys, gated on being the focused pane's active tab.

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { useEffect, useState } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider.tsx";
import { ChatIntentProvider } from "./core/ChatIntentContext.tsx";
import { CoreProvider, useCore } from "./core/CoreContext.tsx";
import { InputFocusProvider } from "./core/InputFocusContext.tsx";
import { fetchUpdateCheck } from "./core/update.ts";
import {
	healthCheck,
	loadNodes,
	type Node,
	nodeToTarget,
	resolveActive,
	setActive,
} from "./core/nodes.ts";
import {
	OverlayHost,
	OverlayProvider,
	useOverlay,
} from "./overlays/OverlayHost.tsx";
// Side-effect import: swaps the skeleton Settings/Gateway overlay bodies for the
// real ones (registerOverlay, last registration wins).
import "./overlays/register.ts";
import { CommandPalette } from "./palette/CommandPalette.tsx";
import { Sidebar } from "./sidebar/Sidebar.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { ryuTheme } from "./ui/theme.ts";
import { ToastHost, ToastProvider, useToast } from "./ui/toast.tsx";
import { NodePicker } from "./workspace/NodePicker.tsx";
import { SplitView } from "./workspace/SplitView.tsx";
import { TabStrip } from "./workspace/TabStrip.tsx";
import {
	useWorkspace,
	WorkspaceProvider,
} from "./workspace/WorkspaceContext.tsx";

const GLOBAL_HINTS = [
	{ keys: "^K", label: "palette" },
	{ keys: "^T", label: "new" },
	{ keys: "^W", label: "close" },
	{ keys: "^C", label: "quit" },
];

interface NodePickerState {
	health: Record<string, boolean>;
	index: number;
	nodes: Node[];
	open: boolean;
}

const CLOSED_NODE_PICKER: NodePickerState = {
	open: false,
	nodes: [],
	index: 0,
	health: {},
};

function WorkspaceShell() {
	const renderer = useRenderer();
	const { target, url, setTarget } = useCore();
	const { notify } = useToast();
	const { openId: overlayOpenId } = useOverlay();
	const {
		panes,
		focusedPaneId,
		openTab,
		closeTab,
		restoreTab,
		splitActive,
		focusPane,
		cycleTab,
	} = useWorkspace();

	const [paletteOpen, setPaletteOpen] = useState(false);
	const [nodePicker, setNodePicker] =
		useState<NodePickerState>(CLOSED_NODE_PICKER);

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
						`▲ Ryu ${notice.latest} is available (you have ${notice.current})`,
						"info"
					);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target, notify]);

	const quit = () => renderer.destroy();

	// Load ~/.ryu/nodes.json, snap the cursor to the active node, open the picker,
	// then probe each node's health in the background to fill in the dots.
	const openNodePicker = () => {
		const config = loadNodes();
		const nodes = config.nodes;
		const activeName = resolveActive(config).name;
		const byUrl = nodes.findIndex((node) => node.url === url);
		const byName = nodes.findIndex((node) => node.name === activeName);
		setNodePicker({
			open: true,
			nodes,
			index: byUrl >= 0 ? byUrl : Math.max(0, byName),
			health: {},
		});
		for (const node of nodes) {
			healthCheck(nodeToTarget(node))
				.then((ok) =>
					setNodePicker((prev) => ({
						...prev,
						health: { ...prev.health, [node.name]: ok },
					}))
				)
				.catch(() => undefined);
		}
	};

	const closeActiveTab = () => {
		const pane = panes.find((candidate) => candidate.id === focusedPaneId);
		if (pane?.activeTabId) {
			closeTab(pane.activeTabId);
		}
	};

	const movePane = (dir: 1 | -1) => {
		if (panes.length < 2) {
			return;
		}
		const at = panes.findIndex((pane) => pane.id === focusedPaneId);
		const next = panes[(at + dir + panes.length) % panes.length];
		focusPane(next.id);
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
				setActive(chosen.name);
				notify(`Switched to ${chosen.name}`, "info");
			}
		}
	};

	// Ctrl-modified workspace bindings. Returns true when a key was handled.
	const handleCtrlBinding = (key: KeyEvent): boolean => {
		if (!key.ctrl) {
			return false;
		}
		if (key.name === "k") {
			setPaletteOpen(true);
		} else if (key.name === "t") {
			if (key.shift) {
				restoreTab();
			} else {
				openTab("/chat", { forceNew: true });
			}
		} else if (key.name === "w") {
			closeActiveTab();
		} else if (key.option && key.name === "s") {
			splitActive();
		} else if (key.name === "tab") {
			cycleTab(key.shift ? -1 : 1);
		} else {
			return false;
		}
		return true;
	};

	// Alt-modified pane navigation. Returns true when a key was handled.
	const handleAltBinding = (key: KeyEvent): boolean => {
		if (!key.option) {
			return false;
		}
		if (key.name === "left") {
			movePane(-1);
		} else if (key.name === "right") {
			movePane(1);
		} else {
			return false;
		}
		return true;
	};

	// Shell workspace bindings (no overlay/palette/picker open). All are modified
	// keys (Ctrl/Alt), so they are safe to fire even while a surface composer owns
	// character input; there are no plain-key globals to suppress via inputFocused.
	const handleWorkspaceKey = (key: KeyEvent) => {
		if (!handleCtrlBinding(key)) {
			handleAltBinding(key);
		}
	};

	useKeyboard((key) => {
		if (key.ctrl && key.name === "c") {
			quit();
			return;
		}
		if (paletteOpen || overlayOpenId) {
			return;
		}
		if (nodePicker.open) {
			handleNodesKey(key);
			return;
		}
		handleWorkspaceKey(key);
	});

	return (
		<box
			backgroundColor={ryuTheme.colors.background}
			flexDirection="column"
			height="100%"
			width="100%"
		>
			<TabStrip />
			<box flexDirection="row" flexGrow={1}>
				<Sidebar
					onOpenPalette={() => setPaletteOpen(true)}
					onSwitchNode={openNodePicker}
				/>
				<SplitView />
			</box>
			<CommandPalette
				onClose={() => setPaletteOpen(false)}
				onQuit={quit}
				onSwitchNode={openNodePicker}
				open={paletteOpen}
			/>
			<OverlayHost />
			{nodePicker.open ? (
				<NodePicker
					currentUrl={url}
					health={nodePicker.health}
					index={nodePicker.index}
					nodes={nodePicker.nodes}
				/>
			) : null}
			<ToastHost />
			<StatusBar hints={GLOBAL_HINTS} left={url} />
		</box>
	);
}

/** Root component: stacks the providers around the workspace shell. */
export function App({ target }: { target?: ApiTarget }) {
	return (
		<ThemeProvider theme={ryuTheme}>
			<CoreProvider initial={target}>
				<InputFocusProvider>
					<ToastProvider>
						<ChatIntentProvider>
							<WorkspaceProvider>
								<OverlayProvider>
									<WorkspaceShell />
								</OverlayProvider>
							</WorkspaceProvider>
						</ChatIntentProvider>
					</ToastProvider>
				</InputFocusProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}
