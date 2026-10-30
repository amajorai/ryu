import { resetBackgroundCustomization } from "@/src/hooks/useBackgroundCustomization.ts";
import { setChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { resetDiffViewPrefs } from "@/src/hooks/useDiffViewPrefs.ts";
import { resetFileTreePrefs } from "@/src/hooks/useFileTreePrefs.ts";
import { setPersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { setSeasonalThemeSetting } from "@/src/hooks/useSeasonalEffects.ts";
import { setSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import { resetUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import { setInterfaceLevel } from "@/src/lib/interface-level.ts";
import { setNotificationLayout } from "@/src/lib/notification-layout.ts";
import { readProductMode } from "@/src/lib/product-mode.ts";
import { interfaceLevelForProductMode } from "@/src/lib/response-mode-prompt.ts";
import { registerSetting } from "@/src/lib/settings-registry.ts";
import { resetTimezone } from "@/src/lib/timezone.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
} from "./appearance-settings-defaults.ts";

/** Interface level, tabs, transcript, motion, seasonal and workspace preferences. */
export function registerAppearanceDisplaySettings(): void {
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
