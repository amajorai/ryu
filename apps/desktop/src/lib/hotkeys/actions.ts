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
		label: "Toggle Command Palette",
		category: "General",
		defaultBinding: "Mod+K",
		description: "Open or close the search-everything command palette.",
	},
	{
		id: "settings.open",
		label: "Open Settings",
		category: "General",
		defaultBinding: "Mod+.",
	},
	{
		id: "gateway.open",
		label: "Open Gateway Settings",
		category: "General",
		defaultBinding: "Mod+,",
	},
	{
		id: "sidebar.toggle",
		label: "Toggle Sidebar",
		category: "General",
		defaultBinding: "Mod+B",
	},
	{
		id: "assistant.toggle",
		label: "Toggle Ryu Chat",
		category: "General",
		// Mod+B is the sidebar and Mod+K the palette; Mod+J is the free member of
		// that same "toggle a surface" family and is what an editor user reaches
		// for. The assistant is the third such surface, so it takes it.
		defaultBinding: "Mod+J",
		description:
			"Open or close the floating Ryu chat. Always opens the FLOATING layout, never the docked sidebar one — a hotkey that reopened whichever layout was last used would look dead when that was the sidebar.",
	},
	{
		id: "window.fullscreen-toggle",
		label: "Toggle Full Screen",
		category: "General",
		// F11, not the macOS ⌃⌘F: `eventToChord` collapses ctrlKey and metaKey
		// into a single `Mod` token, so a Cmd+Ctrl chord is unrepresentable in
		// this format and would never fire. F11 works on every platform.
		defaultBinding: "F11",
		description: "Enter or leave OS fullscreen, like a browser or Electron.",
	},
	// --- Tabs ---
	{
		id: "tab.new",
		label: "New Tab",
		category: "Tabs",
		defaultBinding: "Mod+T",
	},
	{
		id: "tab.close",
		label: "Close Tab",
		category: "Tabs",
		defaultBinding: "Mod+W",
	},
	{
		id: "tab.restore",
		label: "Restore Closed Tab",
		category: "Tabs",
		defaultBinding: "Mod+Shift+T",
	},
	{
		id: "tab.split-toggle",
		label: "Toggle Split View",
		category: "Tabs",
		defaultBinding: "Mod+Alt+S",
	},
	{
		id: "tab.next",
		label: "Next Tab",
		category: "Tabs",
		defaultBinding: "Mod+Tab",
		description:
			"Cycle to the next open tab. Order follows Settings → Tabs → Switch tabs with Ctrl/Cmd+Tab (in sequence or most recently used).",
	},
	{
		id: "tab.prev",
		label: "Previous Tab",
		category: "Tabs",
		defaultBinding: "Mod+Shift+Tab",
		description:
			"Cycle to the previous open tab. Order follows Settings → Tabs → Switch tabs with Ctrl/Cmd+Tab.",
	},
	// --- Navigation ---
	{
		id: "nav.back",
		label: "Go Back",
		category: "Navigation",
		defaultBinding: "Alt+Left",
	},
	{
		id: "nav.forward",
		label: "Go Forward",
		category: "Navigation",
		defaultBinding: "Alt+Right",
	},
	{
		id: "nav.home",
		label: "Go To Home",
		category: "Navigation",
		defaultBinding: null,
	},
	{
		id: "nav.timeline",
		label: "Go To Timeline",
		category: "Navigation",
		defaultBinding: null,
	},
	{
		id: "nav.library",
		label: "Go To Library",
		category: "Navigation",
		defaultBinding: null,
	},
	// --- Chat ---
	{
		id: "chat.new",
		label: "New Chat",
		category: "Chat",
		defaultBinding: "Mod+N",
	},
	{
		id: "chat.search",
		label: "Search Chat or Files",
		category: "Chat",
		defaultBinding: "Mod+F",
		description:
			"Open search in the focused chat. Press again to switch between chat messages and project files.",
	},
	// Both of these act on the FOCUSED chat. Every chat tab stays mounted, so the
	// handler cannot be registered per-tab (last-writer-wins would let a hidden tab
	// own it). The active tab publishes into `useChatHotkeyTargets` and Layout
	// binds these ids once — see that store for the full argument.
	{
		id: "chat.stop",
		label: "Stop The Current Reply",
		category: "Chat",
		defaultBinding: "Mod+Shift+Backspace",
		description:
			"Interrupt the reply streaming in the focused chat. Does nothing when that chat has no turn in flight.",
	},
	{
		id: "chat.toggle-bottom-panel",
		label: "Toggle Bottom Panel",
		category: "Chat",
		defaultBinding: "Mod+Alt+Down",
		description:
			"Show or hide the focused chat's bottom dock (terminal, diff, preview…).",
	},
	{
		id: "chat.toggle-right-panel",
		label: "Toggle Right Panel",
		category: "Chat",
		defaultBinding: "Mod+Alt+Right",
		description:
			"Show or hide the focused chat's right dock (files, context, subagents…).",
	},
	{
		id: "chat.voice-mode",
		label: "Start Voice Mode",
		category: "Chat",
		defaultBinding: null,
		description:
			"Open the realtime voice overlay for the focused chat. Unbound by default — this is the IN-APP overlay, distinct from the system-wide push-to-talk and dictation shortcuts under Global.",
	},
	// --- Composer (focus-scoped: only fire inside the prompt input) ---
	{
		id: "composer.cycle-agent",
		label: "Cycle Agent",
		category: "Composer",
		defaultBinding: "Tab",
		description:
			"While typing in the composer (desktop or island), cycle the selected agent.",
	},
	{
		id: "composer.cycle-mode",
		label: "Cycle Mode",
		category: "Composer",
		defaultBinding: "Shift+Tab",
		description:
			"While typing in the composer, cycle approval / permission mode.",
	},
	{
		id: "composer.cycle-model",
		label: "Cycle Model",
		category: "Composer",
		defaultBinding: "Shift+M",
		description: "While typing in the composer, cycle the selected model.",
	},
	{
		id: "composer.cycle-thinking",
		label: "Cycle Thinking Effort",
		category: "Composer",
		defaultBinding: "Shift+T",
		description:
			"While typing in the composer, cycle thinking / reasoning effort.",
	},
	// --- Global (OS-level, managed by the island's native layer) ---
	{
		id: "island.summon",
		label: "Summon Command Bar",
		category: "Global",
		defaultBinding: "Mod+Shift+Space",
		global: true,
		description: "System-wide hotkey that opens the island command bar.",
	},
	{
		id: "voice.push-to-talk",
		label: "Push-To-Talk",
		category: "Global",
		defaultBinding: "Mod+Shift+A",
		global: true,
		description: "Hold to dictate a voice message into the island.",
	},
	{
		id: "dictation.toggle",
		label: "System-Wide Dictation",
		category: "Global",
		defaultBinding: "Mod+Shift+D",
		global: true,
		description: "Toggle inline dictation anywhere on the desktop.",
	},
];
