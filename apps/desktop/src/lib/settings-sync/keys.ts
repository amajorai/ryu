// What settings sync is allowed to carry, and how a key is named on the wire.
//
// THIS IS AN ALLOWLIST, NEVER A DENYLIST, and that is the single most important
// decision in the whole feature. The desktop writes to well over a hundred
// storage keys; some hold session tokens, some hold the account vault, some hold
// paths that only exist on one machine. A denylist would sync everything nobody
// remembered to exclude, and the first mistake would be a credential leaving the
// device. With an allowlist, the failure mode of forgetting a key is that a
// setting does not sync — visible, harmless, and fixable.
//
// Three categories are excluded on principle and must stay excluded:
//
//   1. CREDENTIALS AND IDENTITY — session token, the account vault, OIDC user,
//      provider API keys. These never leave the machine.
//   2. MACHINE-LOCAL FACTS — workspace folders, audio device ids, open tabs,
//      install ids. A microphone that exists on the Mac is not on the Windows
//      box; a path that resolves on one is a broken setting on the other.
//   3. STATE THAT IS NOT A SETTING — recents, pins, unread markers, onboarding
//      completion, imported-thread bookkeeping. Syncing these makes two machines
//      fight over transient state that neither user ever chose.
//
// Keyboard shortcuts are the one case that is not a plain storage key. They live
// in Core's preference store (shared by every window on a node) and they differ
// per OS, so they travel under a PLATFORM-QUALIFIED key: a Mac reads and writes
// `keybindings:darwin` only, and every Mac the user signs into shares that one
// set while their Windows machines share `keybindings:win32`.

import { isSealedLocalKey } from "../content-seal.ts";

/** The platforms whose shortcuts are stored separately. */
export type SyncPlatform = "darwin" | "win32" | "linux";

/** This machine's platform, for the per-OS shortcut slot. */
export function currentPlatform(): SyncPlatform {
	const ua = navigator.userAgent;
	if (ua.includes("Mac")) {
		return "darwin";
	}
	if (ua.includes("Windows")) {
		return "win32";
	}
	return "linux";
}

/** Wire key holding the keyboard shortcuts for one platform. */
export function keybindingsKey(platform: SyncPlatform): string {
	return `keybindings:${platform}`;
}

/** True when a wire key is a per-OS shortcut slot rather than a storage key. */
export function isKeybindingsKey(key: string): boolean {
	return key.startsWith("keybindings:");
}

/** The platform a `keybindings:<os>` key belongs to, or null. */
export function platformOfKeybindingsKey(key: string): SyncPlatform | null {
	const suffix = key.slice("keybindings:".length);
	return suffix === "darwin" || suffix === "win32" || suffix === "linux"
		? suffix
		: null;
}

/** A user-facing grouping, so the settings UI can say what is being synced. */
export type SyncGroup =
	| "appearance"
	| "layout"
	| "behavior"
	| "chat"
	| "shortcuts";

export interface SyncableKey {
	/**
	 * The value carries content one account authored (names it typed,
	 * conversation ids, routes), not just a preference. Such a value is never
	 * handed to an account it cannot be attributed to (see `local-store.ts`).
	 */
	accountContent?: true;
	group: SyncGroup;
	/** The desktop's own storage key. */
	key: string;
	/** What a user would call it. */
	label: string;
}

/**
 * Every desktop-client setting eligible for sync.
 *
 * Adding a row here is the deliberate act that makes a setting travel. Before
 * adding one, check it against the three exclusions above — in particular, that
 * its value means the same thing on another machine.
 */
export const SYNCABLE_KEYS: SyncableKey[] = [
	// --- Appearance ---
	{ key: "theme", label: "Light / dark / system", group: "appearance" },
	{ key: "ryu_light_preset", label: "Light theme preset", group: "appearance" },
	{ key: "ryu_dark_preset", label: "Dark theme preset", group: "appearance" },
	{
		key: "ryu_custom_themes",
		accountContent: true,
		label: "Saved custom themes",
		group: "appearance",
	},
	{ key: "ryu_high_contrast", label: "High contrast", group: "appearance" },
	{ key: "ryu_ui_font", label: "UI font", group: "appearance" },
	{ key: "ryu_heading_font", label: "Heading font", group: "appearance" },
	{ key: "ryu_code_font", label: "Code font", group: "appearance" },
	{ key: "ryu_contrast", label: "Muted contrast", group: "appearance" },
	{ key: "ryu_radius", label: "Roundness", group: "appearance" },
	{
		key: "ryu_chrome_shadows",
		label: "Navigation & sidebar shadows",
		group: "appearance",
	},
	{
		key: "ryu_inverted_backgrounds",
		label: "Invert overlay backgrounds",
		group: "appearance",
	},
	{
		key: "ryu:sidebar-transparency",
		label: "Transparent sidebar",
		group: "appearance",
	},
	{
		key: "ryu:window-transparency",
		label: "Transparent window",
		group: "appearance",
	},
	{ key: "ryu_pointer_cursor", label: "Pointer cursor", group: "appearance" },
	{
		key: "ryu:agent-row-style",
		label: "Messaging-style agent rows",
		group: "appearance",
	},
	{
		key: "ryu:sidebar-chat-preview",
		label: "Show chat activity in sidebar",
		group: "appearance",
	},
	{
		key: "ryu:chat-picker-placement",
		label: "Chat model and agent picker placement",
		group: "appearance",
	},
	{ key: "ryu:diff-view-prefs", label: "Diff viewer", group: "appearance" },
	{ key: "ryu:file-tree-prefs", label: "File tree", group: "appearance" },
	{ key: "ryu:usage-bar-prefs", label: "Usage meter", group: "appearance" },
	{
		key: "ryu:animations-enabled",
		label: "Enable animations",
		group: "appearance",
	},
	{
		key: "ryu:stream-animation",
		label: "Animate streaming chat text",
		group: "appearance",
	},
	{
		key: "ryu:seasonal-effects",
		label: "Seasonal effects",
		group: "appearance",
	},
	{ key: "ryu:seasonal-theme", label: "Season", group: "appearance" },

	// --- Layout & sizing ---
	{ key: "ryu_spacing", label: "Zoom (spacing)", group: "layout" },
	{ key: "ryu_ui_scale", label: "Scale (UI zoom)", group: "layout" },
	{ key: "ryu_card_spacing", label: "Card padding", group: "layout" },
	{ key: "ryu_chat_width", label: "Chat width", group: "layout" },
	{ key: "ryu:sidebar-width", label: "Sidebar width", group: "layout" },
	{ key: "ryu:sidebar-mode", label: "Sidebar mode", group: "layout" },
	{ key: "ryu:sidebar-variant", label: "Sidebar variant", group: "layout" },
	{
		key: "ryu:sidebar-section-order",
		label: "Sidebar section order",
		group: "layout",
	},
	{
		key: "ryu:sidebar-hidden-sections",
		label: "Hidden sidebar sections",
		group: "layout",
	},
	{
		key: "ryu:sidebar-collapsed-sections",
		label: "Collapsed sidebar sections",
		group: "layout",
	},
	{
		key: "ryu:sidebar-chrome-order",
		label: "Sidebar chrome order",
		group: "layout",
	},
	{
		key: "ryu:sidebar-hidden-chrome",
		label: "Hidden sidebar chrome",
		group: "layout",
	},
	{
		key: "ryu:sidebar-section-sorts",
		label: "Sidebar section sorting",
		group: "layout",
	},
	{
		key: "ryu:sidebar-section-page-sizes",
		label: "Sidebar page sizes",
		group: "layout",
	},
	{
		key: "ryu:sidebar-group-chats-by-date",
		label: "Group lists by date",
		group: "layout",
	},
	// Sidebar sections (Projects, Chats, and the user's own) follow the account.
	// Assignments name main-thread conversation ids; a row this node does not have
	// simply does not render, and its placement is kept for the node that does.
	{
		key: "ryu:bot-chat-sections:v1",
		accountContent: true,
		label: "Sidebar sections",
		group: "layout",
	},
	{
		key: "ryu:bot-chat-section-order:v1",
		accountContent: true,
		label: "Sidebar section order (Bot mode)",
		group: "layout",
	},
	{
		key: "ryu:bot-chat-section-collapsed:v1",
		accountContent: true,
		label: "Collapsed sidebar sections (Bot mode)",
		group: "layout",
	},
	// Portable: it is a layout preference, not a pointer at anything machine-local.
	// The picker's SELECTION is not synced for the opposite reason — it is a folder
	// path or a space id, which name things that exist on one node.
	{
		key: "ryu:sidebar-grouped-nav",
		label: "Projects & Spaces as pickers",
		group: "layout",
	},
	{
		key: "ryu:sidebar-overflow-popover",
		label: "Search overflow in a popover",
		group: "layout",
	},
	{
		key: "ryu:tab-search-button",
		label: "Show tab search button",
		group: "layout",
	},
	{
		key: "ryu:tab-dropdown",
		label: "Show tabs as a dropdown",
		group: "layout",
	},
	{
		key: "ryu:notification-layout",
		label: "Notification layout",
		group: "layout",
	},
	// Saved PANE SHAPES, not the live layout: a preset is id-free and path-free
	// (`lib/splitPresets.ts`), so "one tall pane beside two stacked" means the
	// same thing on every machine. The open tabs and their arrangement
	// (`ryu_session_tabs`) stay machine-local, exclusion 2. If a preset ever
	// grows a workspace or folder field, it stops being portable and this row
	// has to go.
	{
		key: "ryu_split_presets",
		accountContent: true,
		label: "Split layout presets",
		group: "layout",
	},
	{
		key: "ryu:home-section-order",
		label: "Home section order",
		group: "layout",
	},
	{ key: "ryu:library-view", label: "Library view", group: "layout" },
	{ key: "ryu:store-view-mode", label: "Store view", group: "layout" },
	{
		key: "ryu:auto-hide-titlebar",
		label: "Auto-hide title bar",
		group: "layout",
	},
	{
		key: "ryu:floating-tabs",
		label: "Floating tabs",
		group: "layout",
	},

	// --- Behavior ---
	{ key: "ryu_tab_layout", label: "Tab layout", group: "behavior" },
	{ key: "ryu_tab_sizing", label: "Fit tabs to width", group: "behavior" },
	{
		key: "ryu_tab_open_behavior",
		label: "Open links in the current tab",
		group: "behavior",
	},
	{
		key: "ryu_tab_switch_behavior",
		label: "Ctrl/Cmd+Tab order",
		group: "behavior",
	},
	{
		key: "ryu_tab_unload_minutes",
		label: "Unload inactive tabs",
		group: "behavior",
	},
	{
		key: "ryu_sidebar_open_in_new_tab",
		label: "Open sidebar items in a new tab",
		group: "behavior",
	},
	{
		key: "ryu_startup_behavior",
		label: "What opens on startup",
		group: "behavior",
	},
	{ key: "ryu:timezone", label: "Time zone", group: "behavior" },
	{
		key: "ryu_picker_recents_limit",
		label: "Picker recents limit",
		group: "behavior",
	},

	// --- Chat ---
	{
		key: "ryu.chat.queue_followups",
		label: "Queue follow-up messages",
		group: "chat",
	},
	{
		key: "ryu:composer-send-shortcut",
		label: "Send shortcut",
		group: "chat",
	},
	{
		key: "ryu_queue_drain_mode",
		label: "How queued messages send (Auto / Claude Code)",
		group: "chat",
	},
	{
		key: "ryu:composer-selection-apply-mode",
		label: "Composer selection changes",
		group: "chat",
	},
	{ key: "ryu:assistant-mode", label: "Assistant mode", group: "chat" },
	{
		key: "ryu:auto-import-agent-threads",
		label: "Auto-import agent threads",
		group: "chat",
	},
	{ key: "ryu_long_term_memory", label: "Long-term memory", group: "chat" },
	{ key: "ryu:group-tool-uses", label: "Group tool uses", group: "chat" },
	{
		key: "ryu:expand-file-edits",
		label: "Show file edits expanded",
		group: "chat",
	},
	{ key: "ryu:expand-commands", label: "Auto-expand commands", group: "chat" },
	{ key: "ryu:expand-code-blocks", label: "Expand code blocks", group: "chat" },
	{
		key: "ryu:pin-user-message",
		label: "Pin user message while scrolling",
		group: "chat",
	},
	{
		key: "ryu:open-chat-at-bottom",
		label: "Open chats at the latest message",
		group: "chat",
	},
	{
		key: "ryu:inference-stats",
		label: "Inference stats",
		group: "chat",
	},
	{
		key: "ryu:voice-show-transcript",
		label: "Show transcript in voice mode",
		group: "chat",
	},
	{ key: "ryu.tts.engine", label: "Audio engine", group: "chat" },
	{ key: "ryu.tts.voice", label: "Audio voice", group: "chat" },
];

const SYNCABLE_SET = new Set(SYNCABLE_KEYS.map((k) => k.key));

/** Allowlisted keys whose values carry account-authored content. */
export const ACCOUNT_CONTENT_KEYS: readonly string[] = SYNCABLE_KEYS.filter(
	(k) => k.accountContent
).map((k) => k.key);

/**
 * Whether a storage key is eligible for sync. Keys sealed with this device's
 * key (`content-seal.ts`: session tabs, workbench layout, signed-in user, bot
 * feed engagement, Prompt Studio suites) never are: their stored form only
 * opens on this device, and their content must not leave it.
 */
export function isSyncableKey(key: string): boolean {
	return SYNCABLE_SET.has(key) && !isSealedLocalKey(key);
}

/** Human label for a wire key, including the per-OS shortcut slots. */
export function labelForKey(key: string): string {
	if (isKeybindingsKey(key)) {
		const platform = platformOfKeybindingsKey(key);
		const name =
			platform === "darwin"
				? "macOS"
				: platform === "win32"
					? "Windows"
					: "Linux";
		return `Keyboard shortcuts (${name})`;
	}
	return SYNCABLE_KEYS.find((k) => k.key === key)?.label ?? key;
}

/** The group a wire key belongs to, for the settings UI's summary. */
export function groupForKey(key: string): SyncGroup {
	if (isKeybindingsKey(key)) {
		return "shortcuts";
	}
	return SYNCABLE_KEYS.find((k) => k.key === key)?.group ?? "behavior";
}

/** Display order + names for the groups. */
export const SYNC_GROUP_LABELS = {
	appearance: "Appearance",
	layout: "Layout",
	behavior: "Behavior",
	chat: "Chat",
	shortcuts: "Keyboard Shortcuts",
} satisfies Record<SyncGroup, string>;
