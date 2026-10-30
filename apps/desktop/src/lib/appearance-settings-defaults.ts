import {
	BOT_TERMINOLOGY_STORAGE_KEY,
	DEFAULT_BOT_TERMINOLOGY,
} from "@ryu/ui/hooks/use-bot-terminology.ts";
import { DEFAULT_AGENT_ROW_STYLE } from "@/src/hooks/useAgentRowStyle.ts";
import { DEFAULT_CHAT_DATE_GROUPING } from "@/src/hooks/useChatDateGrouping.ts";
import {
	CHAT_PICKER_PLACEMENT_KEY,
	DEFAULT_CHAT_PICKER_PLACEMENT,
} from "@/src/hooks/useChatPickerPlacement.ts";
import { DEFAULT_FRIENDLY_MODE } from "@/src/hooks/useFriendlyMode.ts";
import {
	DEFAULT_NODE_SELECTOR_DETAIL,
	NODE_SELECTOR_DETAIL_KEY,
} from "@/src/hooks/useNodeSelectorDetail.ts";
import {
	DEFAULT_POPUP_OVERLAY_BLUR,
	POPUP_OVERLAY_BLUR_STORAGE_KEY,
} from "@/src/hooks/usePopupOverlayBlur.ts";
import {
	DEFAULT_SEASONAL_EFFECTS,
	DEFAULT_SEASONAL_THEME,
	SEASONAL_EFFECTS_KEY,
} from "@/src/hooks/useSeasonalEffects.ts";
import {
	DEFAULT_SIDEBAR_CHAT_PREVIEW,
	SIDEBAR_CHAT_PREVIEW_KEY,
} from "@/src/hooks/useSidebarChatPreview.ts";
import { DEFAULT_SIDEBAR_GROUPED_NAV } from "@/src/hooks/useSidebarGroupedNav.ts";
import { DEFAULT_SIDEBAR_MODE } from "@/src/hooks/useSidebarMode.ts";
import { DEFAULT_SIDEBAR_VARIANT } from "@/src/hooks/useSidebarVariant.ts";
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
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import {
	DEFAULT_SIDEBAR_TRANSPARENCY,
	DEFAULT_WINDOW_TRANSPARENCY,
	SIDEBAR_TRANSPARENCY_KEY,
	WINDOW_TRANSPARENCY_KEY,
} from "@/src/hooks/useWindowTransparency.ts";
import { DEFAULT_INTERFACE_LEVEL } from "@/src/lib/interface-level.ts";
import {
	DEFAULT_NOTIFICATION_LAYOUT,
	NOTIFICATION_LAYOUT_KEY,
} from "@/src/lib/notification-layout.ts";
import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from "@/src/lib/themes/presets.ts";
import { DEFAULT_TIMEZONE } from "@/src/lib/timezone.ts";

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
	chromeShadows: false,
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

export type ThemeModeSetter = ((mode: string) => void) | null;

export let themeModeSetter: ThemeModeSetter = null;

/**
 * Bind next-themes' `setTheme` so appearance reset can update React state.
 * Call from AppearanceTab; pass `null` on unmount.
 */
export function bindAppearanceThemeMode(setter: ThemeModeSetter): void {
	themeModeSetter = setter;
}
