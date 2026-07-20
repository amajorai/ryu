// The desktop app's declared hotkey actions and their default bindings.
//
// This is the single source of truth the Keyboard Shortcuts settings tab renders
// and the @ryu/hotkeys provider dispatches from. Ids are stable and kebab-cased;
// changing one drops any saved override for the old id (harmless — it just falls
// back to the default). Chords use the canonical cross-platform format where
// `Mod` = Cmd on macOS and Ctrl elsewhere.
//
// `global: true` marks OS-level accelerators owned by the native layer (the
// island's Electron globalShortcut). They are listed here for completeness and
// surfaced separately in the settings tab; the webview dispatch skips them.

import type { HotkeyRegistry } from "@ryu/hotkeys/registry";

export const DESKTOP_HOTKEYS: HotkeyRegistry = [
	// --- Window / App ---
	{
		id: "command-palette.toggle",
		label: "Toggle command palette",
		category: "General",
		defaultBinding: "Mod+K",
		description: "Open or close the search-everything command palette.",
	},
	{
		id: "settings.open",
		label: "Open settings",
		category: "General",
		defaultBinding: "Mod+,",
	},
	{
		id: "sidebar.toggle",
		label: "Toggle sidebar",
		category: "General",
		defaultBinding: "Mod+B",
	},
	// --- Tabs ---
	{
		id: "tab.new",
		label: "New tab",
		category: "Tabs",
		defaultBinding: "Mod+T",
	},
	{
		id: "tab.close",
		label: "Close tab",
		category: "Tabs",
		defaultBinding: "Mod+W",
	},
	{
		id: "tab.restore",
		label: "Restore closed tab",
		category: "Tabs",
		defaultBinding: "Mod+Shift+T",
	},
	{
		id: "tab.split-toggle",
		label: "Toggle split view",
		category: "Tabs",
		defaultBinding: "Mod+Alt+S",
	},
	// --- Navigation ---
	{
		id: "nav.back",
		label: "Go back",
		category: "Navigation",
		defaultBinding: "Alt+Left",
	},
	{
		id: "nav.forward",
		label: "Go forward",
		category: "Navigation",
		defaultBinding: "Alt+Right",
	},
	{
		id: "nav.home",
		label: "Go to Home",
		category: "Navigation",
		defaultBinding: null,
	},
	{
		id: "nav.timeline",
		label: "Go to Timeline",
		category: "Navigation",
		defaultBinding: null,
	},
	{
		id: "nav.library",
		label: "Go to Library",
		category: "Navigation",
		defaultBinding: null,
	},
	// --- Chat ---
	{
		id: "chat.new",
		label: "New chat",
		category: "Chat",
		defaultBinding: "Mod+N",
	},
	// --- Global (OS-level, managed by the island's native layer) ---
	{
		id: "island.summon",
		label: "Summon command bar",
		category: "Global",
		defaultBinding: "Mod+Shift+Space",
		global: true,
		description: "System-wide hotkey that opens the island command bar.",
	},
	{
		id: "voice.push-to-talk",
		label: "Push-to-talk",
		category: "Global",
		defaultBinding: "Mod+Shift+A",
		global: true,
		description: "Hold to dictate a voice message into the island.",
	},
	{
		id: "dictation.toggle",
		label: "System-wide dictation",
		category: "Global",
		defaultBinding: "Mod+Shift+D",
		global: true,
		description: "Toggle inline dictation anywhere on the desktop.",
	},
];
