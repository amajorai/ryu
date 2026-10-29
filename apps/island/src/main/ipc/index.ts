import type { BrowserWindow } from "electron";
import {
	type IslandBackground,
	isMaterialAppearance,
} from "../../shared/appearance.ts";
import { registerScreenSurfaceIpc } from "../screen-surface.ts";
import { registerAgentsIpc } from "./agents.ts";
import { registerAppearanceIpc } from "./appearance.ts";
import { registerCatalogIpc } from "./catalog.ts";
import { registerConsentIpc } from "./consent.ts";
import { registerCoreIpc } from "./core.ts";
import { registerDictationIpc } from "./dictation.ts";
import { registerKeybindingsIpc } from "./keybindings.ts";
import { registerLanguagePacksIpc } from "./language-packs.ts";
import { registerMeetingsIpc } from "./meetings.ts";
import { registerPluginsIpc } from "./plugins.ts";
import { registerQuestsIpc } from "./quests.ts";
import { registerSettingsIpc } from "./settings.ts";
import { registerShadowIpc } from "./shadow.ts";
import { registerSuggestionsIpc } from "./suggestions.ts";
import { registerSystemIpc } from "./system.ts";
import { registerThemeIpc } from "./theme.ts";
import { registerTtsIpc } from "./tts.ts";
import { registerUpdateIpc } from "./update.ts";
import { registerVoiceIpc } from "./voice.ts";
import { registerWinIpc } from "./win.ts";
import { registerWindowIpc } from "./window.ts";

// `ipcMain.handle` throws if the same channel is registered twice, but
// `registerIpc` is invoked once per window (including on macOS re-activation).
// Register the channel handlers exactly once and keep a mutable reference to the
// active window so streamed Core parts always reach the live renderer.
let registered = false;
let activeWindow: BrowserWindow | null = null;
// The Background the active window was built with: what the renderer must style
// for, even when Core now holds a different (or unreadable) value.
let activeBackground: IslandBackground = "acrylic";

/**
 * Registers IPC handlers for the island window. U1 wires the window-control
 * channels (click-through capture + manual drag). Core handlers stream events to
 * whichever window was registered most recently; Shadow handlers are
 * window-independent. Safe to call once per window.
 */
export function registerIpc(
	win: BrowserWindow,
	background: IslandBackground = "acrylic"
): void {
	activeWindow = win;
	activeBackground = background;
	// Window-control handlers are bound to the latest active window. A material
	// (acrylic/mica) window is content-tracked, so it acts on `win:setContentSize`.
	registerWinIpc(win, isMaterialAppearance(background));
	if (registered) {
		return;
	}
	registered = true;
	registerAppearanceIpc(() => activeBackground);
	registerCoreIpc(() => activeWindow);
	registerPluginsIpc(() => activeWindow);
	registerCatalogIpc();
	registerShadowIpc();
	registerSuggestionsIpc(() => activeWindow);
	registerMeetingsIpc(() => activeWindow);
	registerQuestsIpc(() => activeWindow);
	registerScreenSurfaceIpc(() => activeWindow);
	registerConsentIpc(() => activeWindow);
	registerSettingsIpc();
	registerSystemIpc(() => activeWindow);
	registerThemeIpc(() => activeWindow);
	registerUpdateIpc(() => activeWindow);
	registerVoiceIpc(() => activeWindow);
	registerDictationIpc(() => activeWindow);
	registerAgentsIpc(() => activeWindow);
	registerKeybindingsIpc(() => activeWindow);
	registerLanguagePacksIpc(() => activeWindow);
	registerTtsIpc(() => activeWindow);
	registerWindowIpc();
}
