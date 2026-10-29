// Appearance settings registry entries.
//
// Import this module once from AppearanceTab (or app boot) so every appearance
// preference is registered before "Reset to defaults" runs. Adding a new
// Appearance control: give it a module-level setter (or use setPersistedToggle),
// then `registerSetting` here — do not extend a hardcoded reset checklist.
//
// Theme mode (next-themes) needs a React setter; call
// `bindAppearanceThemeMode(setTheme)` from AppearanceTab so reset can update it.

import {
	BOT_TERMINOLOGY_STORAGE_KEY,
	DEFAULT_BOT_TERMINOLOGY,
	setBotTerminology,
} from "@ryu/ui/hooks/use-bot-terminology.ts";
import {
	DEFAULT_AGENT_ROW_STYLE,
	setAgentRowStyle,
} from "@/src/hooks/useAgentRowStyle.ts";
import { resetBackgroundCustomization } from "@/src/hooks/useBackgroundCustomization.ts";
import {
	DEFAULT_CHAT_DATE_GROUPING,
	setChatDateGrouping,
} from "@/src/hooks/useChatDateGrouping.ts";
import {
	CHAT_PICKER_PLACEMENT_KEY,
	DEFAULT_CHAT_PICKER_PLACEMENT,
	setChatPickerPlacement,
} from "@/src/hooks/useChatPickerPlacement.ts";
import { setChromeShadows } from "@/src/hooks/useChromeShadows.ts";
import { setDialogOverlayBlur } from "@/src/hooks/useDialogOverlayBlur.ts";
import { resetDiffViewPrefs } from "@/src/hooks/useDiffViewPrefs.ts";
import { resetFileTreePrefs } from "@/src/hooks/useFileTreePrefs.ts";
import {
	DEFAULT_FRIENDLY_MODE,
	setFriendlyMode,
} from "@/src/hooks/useFriendlyMode.ts";
import { setInvertedBackgrounds } from "@/src/hooks/useInvertedBackgrounds.ts";
import {
	DEFAULT_NODE_SELECTOR_DETAIL,
	NODE_SELECTOR_DETAIL_KEY,
} from "@/src/hooks/useNodeSelectorDetail.ts";
import { setPersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { setPointerCursor } from "@/src/hooks/usePointerCursor.ts";
import {
	DEFAULT_POPUP_OVERLAY_BLUR,
	POPUP_OVERLAY_BLUR_STORAGE_KEY,
	setPopupOverlayBlur,
} from "@/src/hooks/usePopupOverlayBlur.ts";
import {
	DEFAULT_SEASONAL_EFFECTS,
	DEFAULT_SEASONAL_THEME,
	SEASONAL_EFFECTS_KEY,
	setSeasonalThemeSetting,
} from "@/src/hooks/useSeasonalEffects.ts";
import {
	DEFAULT_SIDEBAR_CHAT_PREVIEW,
	SIDEBAR_CHAT_PREVIEW_KEY,
} from "@/src/hooks/useSidebarChatPreview.ts";
import {
	DEFAULT_SIDEBAR_GROUPED_NAV,
	setSidebarGroupedNav,
} from "@/src/hooks/useSidebarGroupedNav.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	setSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import {
	DEFAULT_SIDEBAR_VARIANT,
	setSidebarVariant,
} from "@/src/hooks/useSidebarVariant.ts";
import {
	DEFAULT_TAB_DROPDOWN,
	TAB_DROPDOWN_KEY,
} from "@/src/hooks/useTabDropdown.ts";
import {
	DEFAULT_TAB_SEARCH_BUTTON,
	TAB_SEARCH_BUTTON_KEY,
} from "@/src/hooks/useTabSearchButton.ts";
import {
	CODE_FONTS,
	DEFAULT_CHAT_WIDTH,
	DEFAULT_RADIUS,
	DEFAULT_SCALE,
	DEFAULT_SIDEBAR_WIDTH,
	DEFAULT_SPACING,
	HEADING_FONTS,
	resetCardSpacing,
	setChatWidth,
	setCodeFont,
	setContrast,
	setDarkPreset,
	setHeadingFont,
	setLightPreset,
	setRadius,
	setScale,
	setSidebarWidthSetting,
	setSpacing,
	setUiFont,
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import { resetUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import {
	DEFAULT_SIDEBAR_TRANSPARENCY,
	DEFAULT_WINDOW_TRANSPARENCY,
	SIDEBAR_TRANSPARENCY_KEY,
	setSidebarTransparency,
	setWindowTransparency,
	WINDOW_TRANSPARENCY_KEY,
} from "@/src/hooks/useWindowTransparency.ts";
import {
	DEFAULT_INTERFACE_LEVEL,
	setInterfaceLevel,
} from "@/src/lib/interface-level.ts";
import {
	DEFAULT_NOTIFICATION_LAYOUT,
	NOTIFICATION_LAYOUT_KEY,
	setNotificationLayout,
} from "@/src/lib/notification-layout.ts";
import { readProductMode } from "@/src/lib/product-mode.ts";
import { interfaceLevelForProductMode } from "@/src/lib/response-mode-prompt.ts";
import { registerSetting, resetCategory } from "@/src/lib/settings-registry.ts";
import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from "@/src/lib/themes/presets.ts";
import { DEFAULT_TIMEZONE, resetTimezone } from "@/src/lib/timezone.ts";

/** localStorage / toggle keys owned by Appearance. Use these in the tab too. */
export const APPEARANCE_KEYS = {
	sidebarOverflowPopover: "ryu:sidebar-overflow-popover",
	tabDropdown: TAB_DROPDOWN_KEY,
	tabSearchButton: TAB_SEARCH_BUTTON_KEY,
	notificationLayout: NOTIFICATION_LAYOUT_KEY,
	groupToolUses: "ryu:group-tool-uses",
	hideToolDetail: "ryu:hide-tool-detail",
	expandFileEdits: "ryu:expand-file-edits",
	expandCommands: "ryu:expand-commands",
	expandCodeBlocks: "ryu:expand-code-blocks",
	pinUserMessage: "ryu:pin-user-message",
	openChatAtBottom: "ryu:open-chat-at-bottom",
	animationsEnabled: "ryu:animations-enabled",
	streamAnimation: "ryu:stream-animation",
	markdownComposer: "ryu:markdown-composer",
	sidebarChatPreview: SIDEBAR_CHAT_PREVIEW_KEY,
	chatPickerPlacement: CHAT_PICKER_PLACEMENT_KEY,
	inferenceStats: "ryu:inference-stats",
	popupOverlayBlur: POPUP_OVERLAY_BLUR_STORAGE_KEY,
	// Re-exported from useSeasonalEffects so the seasonal switch reads its key
	// from the same place as every other Appearance toggle.
	seasonalEffects: SEASONAL_EFFECTS_KEY,
	nodeSelectorDetail: NODE_SELECTOR_DETAIL_KEY,
	botTerminology: BOT_TERMINOLOGY_STORAGE_KEY,
	sidebarTransparency: SIDEBAR_TRANSPARENCY_KEY,
	windowTransparency: WINDOW_TRANSPARENCY_KEY,
} as const;

/** Defaults for Appearance toggles / presets (local UI sync after reset). */
export const APPEARANCE_DEFAULTS = {
	themeMode: "system",
	lightPreset: DEFAULT_LIGHT_ID,
	darkPreset: DEFAULT_DARK_ID,
	uiFont: UI_FONTS[0].value,
	headingFont: HEADING_FONTS[0].value,
	codeFont: CODE_FONTS[0].value,
	contrast: 50,
	radius: DEFAULT_RADIUS,
	spacing: DEFAULT_SPACING,
	scale: DEFAULT_SCALE,
	chatWidth: DEFAULT_CHAT_WIDTH,
	sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
	friendlyNames: DEFAULT_FRIENDLY_MODE,
	botTerminology: DEFAULT_BOT_TERMINOLOGY,
	pointerCursor: false,
	chromeShadows: true,
	// Flat transparent dialog backdrops are the shared default (see
	// @ryu/ui hooks/use-dialog-overlay-blur.ts); Reset must restore that, not
	// the dimmed + blurred look. Keep this in step with
	// DEFAULT_DIALOG_OVERLAY_BLUR — two defaults that disagree is the bug.
	dialogOverlayBlur: false,
	popupOverlayBlur: DEFAULT_POPUP_OVERLAY_BLUR,
	invertedBackgrounds: false,
	sidebarMode: DEFAULT_SIDEBAR_MODE,
	sidebarVariant: DEFAULT_SIDEBAR_VARIANT,
	agentRowStyle: DEFAULT_AGENT_ROW_STYLE,
	sidebarChatPreview: DEFAULT_SIDEBAR_CHAT_PREVIEW,
	chatPickerPlacement: DEFAULT_CHAT_PICKER_PLACEMENT,
	interfaceLevel: DEFAULT_INTERFACE_LEVEL,
	groupChatsByDate: DEFAULT_CHAT_DATE_GROUPING,
	sidebarGroupedNav: DEFAULT_SIDEBAR_GROUPED_NAV,
	sidebarOverflowPopover: false,
	tabDropdown: DEFAULT_TAB_DROPDOWN,
	tabSearchButton: DEFAULT_TAB_SEARCH_BUTTON,
	notificationLayout: DEFAULT_NOTIFICATION_LAYOUT,
	groupToolUses: true,
	// Detail level "None". OFF as the SHIPPED default — must stay in step with
	// DEFAULT_PREFS.hideToolDetail in
	// packages/blocks/src/desktop/agent-elements/chat-display-prefs.tsx and the
	// usePersistedToggle default in ChatDisplayPrefsProvider.tsx.
	//
	// A fresh install nevertheless starts at "None", because Interface mode
	// defaults to Ryu Work and `seedInterfaceLevel()` writes this key on first run
	// (`src/lib/interface-level.ts`). That is a SEEDED value, not a changed
	// default: it only ever writes a key nobody has written, so this three-way
	// chain still describes what an unseeded consumer falls back to.
	hideToolDetail: false,
	nodeSelectorDetail: DEFAULT_NODE_SELECTOR_DETAIL,
	expandFileEdits: false,
	expandCommands: false,
	expandCodeBlocks: false,
	pinUserMessage: true,
	openChatAtBottom: true,
	animationsEnabled: true,
	streamAnimation: true,
	markdownComposer: false,
	// On by default: the Session Stats plugin provides token counts, speeds, cache,
	// context, and usage details when the active provider reports them. Must stay in
	// step with DEFAULT_PREFS.inferenceStats in
	// packages/blocks/src/desktop/agent-elements/chat-display-prefs.tsx — two
	// defaults that disagree means the switch and the transcript disagree until
	// the user touches it.
	inferenceStats: true,
	seasonalEffects: DEFAULT_SEASONAL_EFFECTS,
	seasonalTheme: DEFAULT_SEASONAL_THEME,
	timezone: DEFAULT_TIMEZONE,
	sidebarTransparency: DEFAULT_SIDEBAR_TRANSPARENCY,
	windowTransparency: DEFAULT_WINDOW_TRANSPARENCY,
} as const;

type ThemeModeSetter = ((mode: string) => void) | null;

let themeModeSetter: ThemeModeSetter = null;

/**
 * Bind next-themes' `setTheme` so appearance reset can update React state.
 * Call from AppearanceTab; pass `null` on unmount.
 */
export function bindAppearanceThemeMode(setter: ThemeModeSetter): void {
	themeModeSetter = setter;
}

function registerAppearanceSettings(): void {
	registerSetting({
		id: "appearance.theme-mode",
		category: "appearance",
		label: "Theme mode",
		reset: () => {
			try {
				localStorage.setItem("theme", APPEARANCE_DEFAULTS.themeMode);
			} catch {
				// best-effort
			}
			themeModeSetter?.(APPEARANCE_DEFAULTS.themeMode);
		},
	});

	registerSetting({
		id: "appearance.light-preset",
		category: "appearance",
		label: "Light theme preset",
		reset: () => setLightPreset(APPEARANCE_DEFAULTS.lightPreset),
	});

	registerSetting({
		id: "appearance.dark-preset",
		category: "appearance",
		label: "Dark theme preset",
		reset: () => setDarkPreset(APPEARANCE_DEFAULTS.darkPreset),
	});

	registerSetting({
		id: "appearance.ui-font",
		category: "appearance",
		label: "UI font",
		reset: () => setUiFont(APPEARANCE_DEFAULTS.uiFont),
	});

	registerSetting({
		id: "appearance.heading-font",
		category: "appearance",
		label: "Heading font",
		reset: () => setHeadingFont(APPEARANCE_DEFAULTS.headingFont),
	});

	registerSetting({
		id: "appearance.code-font",
		category: "appearance",
		label: "Code font",
		reset: () => setCodeFont(APPEARANCE_DEFAULTS.codeFont),
	});

	registerSetting({
		id: "appearance.contrast",
		category: "appearance",
		label: "Contrast",
		reset: () => setContrast(APPEARANCE_DEFAULTS.contrast),
	});

	registerSetting({
		id: "appearance.radius",
		category: "appearance",
		label: "Corner radius",
		reset: () => setRadius(APPEARANCE_DEFAULTS.radius),
	});

	registerSetting({
		id: "appearance.spacing",
		category: "appearance",
		label: "Spacing",
		reset: () => setSpacing(APPEARANCE_DEFAULTS.spacing),
	});

	registerSetting({
		id: "appearance.scale",
		category: "appearance",
		label: "UI scale",
		reset: () => setScale(APPEARANCE_DEFAULTS.scale),
	});

	registerSetting({
		id: "appearance.card-spacing",
		category: "appearance",
		label: "Card spacing",
		reset: () => resetCardSpacing(),
	});

	registerSetting({
		id: "appearance.chat-width",
		category: "appearance",
		label: "Chat width",
		reset: () => setChatWidth(APPEARANCE_DEFAULTS.chatWidth),
	});

	registerSetting({
		id: "appearance.sidebar-width",
		category: "appearance",
		label: "Sidebar width",
		reset: () => setSidebarWidthSetting(APPEARANCE_DEFAULTS.sidebarWidth),
	});

	registerSetting({
		id: "appearance.friendly-names",
		category: "appearance",
		label: "Friendly names",
		reset: () => setFriendlyMode(APPEARANCE_DEFAULTS.friendlyNames),
	});

	registerSetting({
		id: "appearance.bot-terminology",
		category: "appearance",
		label: "Use Bot terminology",
		reset: () => setBotTerminology(APPEARANCE_DEFAULTS.botTerminology),
	});

	registerSetting({
		id: "appearance.pointer-cursor",
		category: "appearance",
		label: "Pointer cursor",
		reset: () => setPointerCursor(APPEARANCE_DEFAULTS.pointerCursor),
	});

	registerSetting({
		id: "appearance.chrome-shadows",
		category: "appearance",
		label: "Chrome shadows",
		reset: () => setChromeShadows(APPEARANCE_DEFAULTS.chromeShadows),
	});

	registerSetting({
		id: "appearance.dialog-overlay-blur",
		category: "appearance",
		label: "Dialog overlay blur",
		reset: () => setDialogOverlayBlur(APPEARANCE_DEFAULTS.dialogOverlayBlur),
	});

	registerSetting({
		id: "appearance.popup-overlay-blur",
		category: "appearance",
		label: "Popup overlay blur",
		reset: () => setPopupOverlayBlur(APPEARANCE_DEFAULTS.popupOverlayBlur),
	});

	registerSetting({
		id: "appearance.inverted-backgrounds",
		category: "appearance",
		label: "Inverted backgrounds",
		reset: () =>
			setInvertedBackgrounds(APPEARANCE_DEFAULTS.invertedBackgrounds),
	});

	registerSetting({
		id: "appearance.sidebar-transparency",
		category: "appearance",
		label: "Transparent sidebar",
		reset: () =>
			setSidebarTransparency(APPEARANCE_DEFAULTS.sidebarTransparency),
	});

	registerSetting({
		id: "appearance.window-transparency",
		category: "appearance",
		label: "Transparent window",
		reset: () => setWindowTransparency(APPEARANCE_DEFAULTS.windowTransparency),
	});

	registerSetting({
		id: "appearance.sidebar-mode",
		category: "appearance",
		label: "Sidebar mode",
		reset: () => setSidebarMode(APPEARANCE_DEFAULTS.sidebarMode),
	});

	registerSetting({
		id: "appearance.sidebar-variant",
		category: "appearance",
		label: "Sidebar variant",
		reset: () => setSidebarVariant(APPEARANCE_DEFAULTS.sidebarVariant),
	});

	registerSetting({
		id: "appearance.agent-row-style",
		category: "appearance",
		label: "Agent row style",
		reset: () => setAgentRowStyle(APPEARANCE_DEFAULTS.agentRowStyle),
	});

	registerSetting({
		id: "appearance.sidebar-chat-preview",
		category: "appearance",
		label: "Show chat activity in sidebar",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.sidebarChatPreview,
				APPEARANCE_DEFAULTS.sidebarChatPreview
			),
	});

	registerSetting({
		id: "appearance.chat-picker-placement",
		category: "appearance",
		label: "Chat model and agent picker placement",
		reset: () =>
			setChatPickerPlacement(APPEARANCE_DEFAULTS.chatPickerPlacement),
	});

	registerSetting({
		id: "appearance.markdown-composer",
		category: "appearance",
		label: "Rich Markdown composer",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.markdownComposer,
				APPEARANCE_DEFAULTS.markdownComposer
			),
	});

	// Restores the level ONLY — deliberately not the transcript prefs the level
	// implies, even though picking a level in the account menu does write those.
	// `resetCategory` runs every registered reset, and `appearance.hide-tool-detail`
	// (below) writes that same key from `APPEARANCE_DEFAULTS`; a level reset that
	// also wrote it would make the final state depend on registration ORDER, which
	// is the kind of bug that only shows up once someone reorders this file. Each
	// pref is restored by the one entry that owns it.
	//
	// The level's default is the one the current product surface implies (Bot →
	// Ryu Work, everything else → Code), not the global `APPEARANCE_DEFAULTS`
	// value: the level also picks the response mode, which is part of every Ryu
	// assistant thread's system prompt, and an appearance reset must not switch
	// it (and reset those threads' prompt cache) without the interface switcher's
	// confirmation.
	registerSetting({
		id: "appearance.interface-level",
		category: "appearance",
		label: "Interface mode",
		reset: () =>
			setInterfaceLevel(interfaceLevelForProductMode(readProductMode()), {
				applyPrefs: false,
			}),
	});

	// The id stays `group-chats-by-date` although the preference now buckets every
	// sidebar list (a project's chats, a space's pages, an app's feed), not just
	// Chats. It is the settings-search anchor and the sync-manifest key
	// (`ryu:sidebar-group-chats-by-date`), so renaming it would orphan both for the
	// sake of cosmetics. Only the label moved.
	registerSetting({
		id: "appearance.group-chats-by-date",
		category: "appearance",
		label: "Group lists by date",
		reset: () => setChatDateGrouping(APPEARANCE_DEFAULTS.groupChatsByDate),
	});

	registerSetting({
		id: "appearance.sidebar-grouped-nav",
		category: "appearance",
		label: "Projects & Spaces as pickers",
		reset: () => setSidebarGroupedNav(APPEARANCE_DEFAULTS.sidebarGroupedNav),
	});

	registerSetting({
		id: "appearance.sidebar-overflow-popover",
		category: "appearance",
		label: "Sidebar overflow popover",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.sidebarOverflowPopover,
				APPEARANCE_DEFAULTS.sidebarOverflowPopover
			),
	});

	registerSetting({
		id: "appearance.tab-dropdown",
		category: "appearance",
		label: "Show tabs as a dropdown",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.tabDropdown,
				APPEARANCE_DEFAULTS.tabDropdown
			),
	});

	registerSetting({
		id: "appearance.tab-search-button",
		category: "appearance",
		label: "Show tab search button",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.tabSearchButton,
				APPEARANCE_DEFAULTS.tabSearchButton
			),
	});

	registerSetting({
		id: "appearance.notification-layout",
		category: "appearance",
		label: "Notification layout",
		reset: () => setNotificationLayout(APPEARANCE_DEFAULTS.notificationLayout),
	});

	registerSetting({
		id: "appearance.node-selector-detail",
		category: "appearance",
		label: "Detailed node picker",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.nodeSelectorDetail,
				APPEARANCE_DEFAULTS.nodeSelectorDetail
			),
	});

	registerSetting({
		id: "appearance.group-tool-uses",
		category: "appearance",
		label: "Group tool uses",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.groupToolUses,
				APPEARANCE_DEFAULTS.groupToolUses
			),
	});

	registerSetting({
		id: "appearance.hide-tool-detail",
		category: "appearance",
		label: "Hide tool detail",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.hideToolDetail,
				APPEARANCE_DEFAULTS.hideToolDetail
			),
	});

	registerSetting({
		id: "appearance.expand-file-edits",
		category: "appearance",
		label: "Expand file edits",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.expandFileEdits,
				APPEARANCE_DEFAULTS.expandFileEdits
			),
	});

	registerSetting({
		id: "appearance.expand-commands",
		category: "appearance",
		label: "Expand commands",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.expandCommands,
				APPEARANCE_DEFAULTS.expandCommands
			),
	});

	registerSetting({
		id: "appearance.expand-code-blocks",
		category: "appearance",
		label: "Expand code blocks",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.expandCodeBlocks,
				APPEARANCE_DEFAULTS.expandCodeBlocks
			),
	});

	registerSetting({
		id: "appearance.pin-user-message",
		category: "appearance",
		label: "Pin user message",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.pinUserMessage,
				APPEARANCE_DEFAULTS.pinUserMessage
			),
	});

	registerSetting({
		id: "appearance.open-chat-at-bottom",
		category: "appearance",
		label: "Open chats at the latest message",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.openChatAtBottom,
				APPEARANCE_DEFAULTS.openChatAtBottom
			),
	});

	registerSetting({
		id: "appearance.animations-enabled",
		category: "appearance",
		label: "Animations",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.animationsEnabled,
				APPEARANCE_DEFAULTS.animationsEnabled
			),
	});

	registerSetting({
		id: "appearance.stream-animation",
		category: "appearance",
		label: "Stream animation",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.streamAnimation,
				APPEARANCE_DEFAULTS.streamAnimation
			),
	});

	registerSetting({
		id: "appearance.seasonal-effects",
		category: "appearance",
		label: "Seasonal effects",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.seasonalEffects,
				APPEARANCE_DEFAULTS.seasonalEffects
			),
	});

	registerSetting({
		id: "appearance.seasonal-theme",
		category: "appearance",
		label: "Season",
		reset: () => setSeasonalThemeSetting(APPEARANCE_DEFAULTS.seasonalTheme),
	});

	registerSetting({
		id: "appearance.inference-stats",
		category: "appearance",
		label: "Inference stats",
		reset: () =>
			setPersistedToggle(
				APPEARANCE_KEYS.inferenceStats,
				APPEARANCE_DEFAULTS.inferenceStats
			),
	});

	registerSetting({
		id: "appearance.background-customization",
		category: "appearance",
		label: "Background customization",
		reset: () => resetBackgroundCustomization(),
	});

	registerSetting({
		id: "appearance.usage-bar",
		category: "appearance",
		label: "Usage bar",
		reset: () => resetUsageBarPrefs(),
	});

	registerSetting({
		id: "appearance.diff-view",
		category: "appearance",
		label: "Diff view",
		reset: () => resetDiffViewPrefs(),
	});

	registerSetting({
		id: "appearance.timezone",
		category: "appearance",
		label: "Time zone",
		reset: () => resetTimezone(),
	});

	registerSetting({
		id: "appearance.file-tree",
		category: "appearance",
		label: "File tree",
		reset: () => resetFileTreePrefs(),
	});
}

registerAppearanceSettings();

/** Reset every registered appearance setting to its default. */
export function resetAppearanceSettings(): void {
	resetCategory("appearance");
}
