import { useHotkey, useOptionalHotkeyBinding } from "@ryu/hotkeys/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect } from "react";
import { useAppShellPath } from "@/src/contributions/app-shell-routes.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { configureInterfaceEscape } from "@/src/interfaces/interface-escape-keys.ts";
import {
	backToChat,
	openInterfaceSwitcher,
} from "@/src/interfaces/interface-switcher.ts";
import { useInterfaceActive } from "@/src/interfaces/use-interface-active.ts";
import {
	DASHBOARDS_HOME_BUTTON_ID,
	DASHBOARDS_PLUGIN_ID,
} from "@/src/lib/dashboards/app.ts";
import { toggleFullscreen } from "@/src/lib/fullscreen.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useChatHotkeyTargets } from "@/src/store/useChatHotkeyTargets.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import type { DesktopWorkbenchValue } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { DESKTOP_SHELL_REGIONS } from "@/src/workbench/workbench-chrome.tsx";
import { workbenchLayoutCommands } from "@/src/workbench/workbench-commands.ts";
import type { OpenTab } from "./layout-constants.ts";

export interface LayoutHotkeysOptions {
	botProduct: boolean;
	canSwitchToConsole: boolean;
	dispatchWorkbench: DesktopWorkbenchValue["dispatch"];
	handleNewConversation: () => void;
	openTab: OpenTab;
	osAccess: boolean;
	toggleNavigation: () => void;
	toggleWorkbenchRegion: (region: "bottom" | "right") => void;
	workbenchState: DesktopWorkbenchValue["state"];
}

/** The shell's app-level hotkeys and tray interface items. Returns whether the
 *  interface switcher is available. */
export function useLayoutHotkeys({
	botProduct,
	canSwitchToConsole,
	dispatchWorkbench,
	handleNewConversation,
	openTab,
	osAccess,
	toggleNavigation,
	toggleWorkbenchRegion,
	workbenchState,
}: LayoutHotkeysOptions) {
	// App-level shortcuts whose handlers live here (sidebar, settings, new chat,
	// route jumps). Everything routes through the unified hotkey registry, so all
	// of these are rebindable in Settings → Keyboard Shortcuts.
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	useHotkey("sidebar.toggle", toggleNavigation);
	useHotkey("settings.open", () => {
		if (!botProduct) {
			openSettings();
		}
	});
	useHotkey("gateway.open", () => {
		if (!botProduct) {
			openGateway();
		}
	});
	useHotkey("chat.new", handleNewConversation);
	// "Go home" opens whatever path the Dashboards app declares — and does nothing
	// when no enabled app claims it, so the shortcut can't land the user on an
	// "App not enabled" card for a feature they never turned on.
	const dashboardPath = useAppShellPath(
		DASHBOARDS_PLUGIN_ID,
		DASHBOARDS_HOME_BUTTON_ID
	);
	useHotkey("nav.home", () => {
		if (botProduct) {
			return;
		}
		if (dashboardPath) {
			openTab(dashboardPath);
		}
	});
	// Same rule for the Timeline shortcut, which reaches an app-owned path
	// (`/timeline` resolves through the companion-alias catch-all): no enabled app
	// claims it → the shortcut does nothing, rather than opening a dead tab. This is
	// the AFFORDANCE tier `use-companion-alias.ts` describes.
	const timelineCompanion = useCompanionAlias("/timeline");
	useHotkey("nav.timeline", () => {
		if (botProduct) {
			return;
		}
		if (timelineCompanion) {
			openTab("/timeline");
		}
	});
	useHotkey("nav.library", () => {
		if (!botProduct) {
			openTab("/library");
		}
	});
	// Chat-owned shortcuts, bound ONCE here and dispatched to whichever chat tab
	// is focused. They cannot be registered inside ChatPage: every chat tab stays
	// mounted, and the registry keeps one handler per id (last-writer-wins), so a
	// hidden tab would end up owning Stop and abort the wrong stream. The focused
	// tab publishes its live handlers into `useChatHotkeyTargets`; reading them
	// through `getState()` inside the handler keeps this component from
	// re-rendering on every status change.
	useHotkey("chat.stop", () => {
		const { isStreaming, stop } = useChatHotkeyTargets.getState();
		// No-op unless the focused chat actually has a turn in flight, so the key
		// never interrupts something the user cannot see.
		if (isStreaming) {
			stop?.();
		}
	});
	useHotkey("chat.voice-mode", () => {
		useChatHotkeyTargets.getState().startVoiceMode?.();
	});
	// The docks are ChatPage-local state, so they arrive through the same slot as
	// Stop. A no-op when the focused surface is not a chat, which is correct: the
	// panels only exist there.
	// Layout hotkeys run the same commands as the palette's Layout group.
	const runWorkbenchCommand = (commandId: string) => {
		const command = workbenchLayoutCommands({
			dispatch: dispatchWorkbench,
			movableRegions: DESKTOP_SHELL_REGIONS,
			state: workbenchState,
		}).find((candidate) => candidate.id === commandId);
		if (command && !command.disabled) {
			command.run();
		}
	};
	useHotkey("workbench.focus-next-pane", () =>
		runWorkbenchCommand("workbench-focus-next-pane")
	);
	useHotkey("workbench.focus-previous-pane", () =>
		runWorkbenchCommand("workbench-focus-previous-pane")
	);
	useHotkey("workbench.move-tab-to-center", () =>
		runWorkbenchCommand("workbench-move-to-center")
	);
	useHotkey("workbench.move-tab-to-right", () =>
		runWorkbenchCommand("workbench-move-to-right")
	);
	useHotkey("workbench.move-tab-to-bottom", () =>
		runWorkbenchCommand("workbench-move-to-bottom")
	);
	useHotkey("workbench.equalize-center-panes", () =>
		runWorkbenchCommand("workbench-equalize-center")
	);
	useHotkey("workbench.reset-layout", () =>
		runWorkbenchCommand("workbench-reset-layout")
	);
	// A focused chat registers its own toggles (with the workbench frame they
	// drive the same panes, falling back to the chat's Context); elsewhere the
	// keys show or hide the workbench's Bottom/Right region directly.
	useHotkey("chat.toggle-bottom-panel", () => {
		const toggle = useChatHotkeyTargets.getState().toggleBottomPanel;
		if (toggle) {
			toggle();
		} else {
			toggleWorkbenchRegion("bottom");
		}
	});
	useHotkey("chat.toggle-right-panel", () => {
		const toggle = useChatHotkeyTargets.getState().toggleRightPanel;
		if (toggle) {
			toggle();
		} else {
			toggleWorkbenchRegion("right");
		}
	});
	useHotkey("chat.search", () => {
		useChatHotkeyTargets.getState().toggleSearch?.();
	});
	// The interface switcher, from the chat, the OS desktop or any interface:
	// whichever switcher menu is on screen, else the fallback dialog.
	// Handled by the always-on capture listener (interface-escape-keys.ts), not
	// the hotkey provider, so no interface can swallow the chord; the binding
	// still comes from the registry and the user's overrides.
	const canSwitchInterface = !isRyuBot() && (canSwitchToConsole || osAccess);
	const switchBinding = useOptionalHotkeyBinding("interface.switch");
	const interfaceShown = useInterfaceActive((state) => state.active);
	// The tray's Switch Interface… and Back to Default Interface items.
	useEffect(() => {
		let disposed = false;
		const unlisteners: (() => void)[] = [];
		const track = (unlisten: () => void) => {
			if (disposed) {
				unlisten();
			} else {
				unlisteners.push(unlisten);
			}
		};
		const ignore = (error: unknown) => {
			console.error("tray interface subscription failed", error);
		};
		listenWhenReady("tray-switch-interface", () => {
			if (canSwitchInterface) {
				openInterfaceSwitcher();
			}
		})
			.then(track)
			.catch(ignore);
		listenWhenReady("tray-default-interface", () => {
			backToChat(canSwitchToConsole);
		})
			.then(track)
			.catch(ignore);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
	}, [canSwitchInterface, canSwitchToConsole]);
	useEffect(() => {
		configureInterfaceEscape({
			binding: switchBinding,
			enabled: canSwitchInterface,
			interfaceShown,
			onBackToChat: () => backToChat(canSwitchToConsole),
		});
	}, [canSwitchInterface, canSwitchToConsole, interfaceShown, switchBinding]);
	// The floating Ryu chat. `open("floating")` explicitly, never the bare
	// `open()`: that restores the LAST layout, and when that was `sidebar` the
	// AssistantDock renders nothing — the key would look broken.
	useHotkey("assistant.toggle", () => {
		const { mode, open, close } = useAssistantStore.getState();
		if (mode === "closed") {
			open("floating");
		} else {
			close();
		}
	});
	// allowInInput: the default binding (F11) is a bare key, which the dispatcher
	// otherwise suppresses while a field has focus — i.e. most of the time, since
	// the composer holds focus on the main surfaces.
	useHotkey(
		"window.fullscreen-toggle",
		() => {
			toggleFullscreen().catch(() => {
				toast.error("Couldn't toggle full screen in this window.");
			});
		},
		{ allowInInput: true }
	);
	return canSwitchInterface;
}
