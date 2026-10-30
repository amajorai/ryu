import { useBotTerminology } from "@ryu/ui/hooks/use-bot-terminology.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useAgentRowStylePref } from "@/src/hooks/useAgentRowStyle.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { useChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import { useChromeShadows } from "@/src/hooks/useChromeShadows.ts";
import { useDialogOverlayBlur } from "@/src/hooks/useDialogOverlayBlur.ts";
import { useDiffViewPrefs } from "@/src/hooks/useDiffViewPrefs.ts";
import { useFileTreePrefs } from "@/src/hooks/useFileTreePrefs.ts";
import { useFileTreeThemeStyles } from "@/src/hooks/useFileTreeThemeStyles.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useInvertedBackgrounds } from "@/src/hooks/useInvertedBackgrounds.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePointerCursor } from "@/src/hooks/usePointerCursor.ts";
import { usePopupOverlayBlur } from "@/src/hooks/usePopupOverlayBlur.ts";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import { useSidebarMode } from "@/src/hooks/useSidebarMode.ts";
import { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabDropdown } from "@/src/hooks/useTabDropdown.ts";
import { useUsageBarPrefs } from "@/src/hooks/useUsageBarPrefs.ts";
import {
	useSidebarTransparency,
	useWindowTransparency,
} from "@/src/hooks/useWindowTransparency.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
	bindAppearanceThemeMode,
} from "@/src/lib/appearance-settings.ts";
import {
	NOTIFICATION_LAYOUT_STEPS,
	notificationLayoutStepIndex,
	setNotificationLayout,
	useNotificationLayout,
} from "@/src/lib/notification-layout.ts";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import {
	deriveToolDetailPreset,
	TOOL_DETAIL_PRESETS,
	TOOL_DETAIL_STEPS,
	type ToolDetailStepId,
	toolDetailStepIndex,
} from "@/src/lib/tool-detail-ladder.ts";
import appearanceStyles from "./appearance.module.css";
import type { AppearanceTreePreviewStyle } from "./appearance-tab-model.ts";

/**
 * The Appearance tab's preference hooks (toggles, sidebar, chat view, diff and
 * file-tree prefs), in the order the tab called them.
 */
export function useAppearancePrefs() {
	// A settings-search hit may name a row on a sub-page that is currently
	// closed — and therefore not in the DOM the reveal polls. This says which
	// page to open first.
	const pendingSubpage = usePendingSubpage("appearance");
	const { isDesktop } = useAppSurface();
	// Workspace interfaces are what the Interfaces sub-page adjusts; without OS
	// access (or in the bot build) there is nothing to open, so it is hidden.
	const osAccess = useProductModeStore((state) => state.osAccess);
	const showInterfaces = osAccess && !isRyuBot();
	const { theme, setTheme } = useTheme();
	// next-themes' setter lives in React; bind it so registry reset can call it.
	useEffect(() => {
		bindAppearanceThemeMode(setTheme);
		return () => bindAppearanceThemeMode(null);
	}, [setTheme]);
	const pointerCursorEnabled = usePointerCursor();
	const chromeShadowsEnabled = useChromeShadows();
	const dialogOverlayBlurEnabled = useDialogOverlayBlur();
	const popupOverlayBlurEnabled = usePopupOverlayBlur();
	const invertedBackgroundsEnabled = useInvertedBackgrounds();
	const [friendlyNames, setFriendlyNames] = useFriendlyMode();
	const interfaceLevel = useInterfaceLevel();
	const [botTerminology, setBotTerminologyEnabled] = useBotTerminology();
	const botTerminologyForced = interfaceLevel === "simple";
	const [groupChatsByDate, setGroupChatsByDate] = useChatDateGrouping();
	const [sidebarGroupedNav, setSidebarGroupedNav] = useSidebarGroupedNav();
	const [sidebarTransparency, setSidebarTransparency] =
		useSidebarTransparency();
	const [windowTransparency, setWindowTransparency] = useWindowTransparency();
	// The STORED choice, not the drawn one: Bot mode forces messaging rows, and a
	// switch that flipped itself on when the user picked a sidebar mode would have
	// nothing left to restore when they left it.
	const agentRowStyle = useAgentRowStylePref();
	const [sidebarChatPreview, setSidebarChatPreview] = useSidebarChatPreview();
	const [chatPickerPlacement, setChatPickerPlacement] =
		useChatPickerPlacement();
	const [markdownComposer, setMarkdownComposer] = usePersistedToggle(
		APPEARANCE_KEYS.markdownComposer,
		APPEARANCE_DEFAULTS.markdownComposer
	);
	// Only the contributed half: the three built-in modes have their own switches
	// above, worded for what they actually do.
	const contributedModes = useSidebarModes().modes.filter((m) =>
		m.key.startsWith("plugin:")
	);
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const [sidebarOverflowPopover, setSidebarOverflowPopover] =
		usePersistedToggle(
			APPEARANCE_KEYS.sidebarOverflowPopover,
			APPEARANCE_DEFAULTS.sidebarOverflowPopover
		);
	const [tabDropdown, setTabDropdown] = useTabDropdown();
	const [tabSearchButtonVisible, setTabSearchButtonVisible] =
		usePersistedToggle(
			APPEARANCE_KEYS.tabSearchButton,
			APPEARANCE_DEFAULTS.tabSearchButton
		);
	const notificationLayout = useNotificationLayout();
	const notificationLayoutStep =
		notificationLayoutStepIndex(notificationLayout);
	const handleNotificationLayoutStep = useCallback((next: number) => {
		const layout = NOTIFICATION_LAYOUT_STEPS[Math.round(next)]?.id;
		if (layout) {
			setNotificationLayout(layout);
		}
	}, []);
	const [nodeSelectorDetail, setNodeSelectorDetail] = usePersistedToggle(
		APPEARANCE_KEYS.nodeSelectorDetail,
		APPEARANCE_DEFAULTS.nodeSelectorDetail
	);
	const usageBarPrefs = useUsageBarPrefs();
	const [groupToolUses, setGroupToolUses] = usePersistedToggle(
		APPEARANCE_KEYS.groupToolUses,
		APPEARANCE_DEFAULTS.groupToolUses
	);
	const [expandFileEdits, setExpandFileEdits] = usePersistedToggle(
		APPEARANCE_KEYS.expandFileEdits,
		APPEARANCE_DEFAULTS.expandFileEdits
	);
	const [expandCommands, setExpandCommands] = usePersistedToggle(
		APPEARANCE_KEYS.expandCommands,
		APPEARANCE_DEFAULTS.expandCommands
	);
	const [expandCodeBlocks, setExpandCodeBlocks] = usePersistedToggle(
		APPEARANCE_KEYS.expandCodeBlocks,
		APPEARANCE_DEFAULTS.expandCodeBlocks
	);
	const [hideToolDetail, setHideToolDetail] = usePersistedToggle(
		APPEARANCE_KEYS.hideToolDetail,
		APPEARANCE_DEFAULTS.hideToolDetail
	);
	const [pinUserMessage, setPinUserMessage] = usePersistedToggle(
		APPEARANCE_KEYS.pinUserMessage,
		APPEARANCE_DEFAULTS.pinUserMessage
	);
	const [openChatAtBottom, setOpenChatAtBottom] = usePersistedToggle(
		APPEARANCE_KEYS.openChatAtBottom,
		APPEARANCE_DEFAULTS.openChatAtBottom
	);
	const [inferenceStats, setInferenceStats] = usePersistedToggle(
		APPEARANCE_KEYS.inferenceStats,
		APPEARANCE_DEFAULTS.inferenceStats
	);
	const [animationsEnabled, setAnimationsEnabled] = usePersistedToggle(
		APPEARANCE_KEYS.animationsEnabled,
		APPEARANCE_DEFAULTS.animationsEnabled
	);
	const [streamAnimation, setStreamAnimation] = usePersistedToggle(
		APPEARANCE_KEYS.streamAnimation,
		APPEARANCE_DEFAULTS.streamAnimation
	);
	const diffPrefs = useDiffViewPrefs();
	const fileTreePrefs = useFileTreePrefs();
	const fileTreeThemeStyles = useFileTreeThemeStyles(fileTreePrefs);
	// Preserve every custom property and all four native layout fields published
	// by the installed @pierre/trees themeToTreeStyles owner.
	const treeThemeValues = new Map(
		Object.entries(
			z.record(z.string(), z.string()).parse(fileTreeThemeStyles ?? {})
		)
	);
	const treePreviewStyle: AppearanceTreePreviewStyle = {
		"--appearance-tree-scheme": treeThemeValues.get("colorScheme"),
		"--appearance-tree-background": treeThemeValues.get("backgroundColor"),
		"--appearance-tree-foreground": treeThemeValues.get("color"),
		"--appearance-tree-border": treeThemeValues.get("borderColor"),
		"--trees-theme-focus-ring": treeThemeValues.get("--trees-theme-focus-ring"),
		"--trees-theme-git-added-fg": treeThemeValues.get(
			"--trees-theme-git-added-fg"
		),
		"--trees-theme-git-deleted-fg": treeThemeValues.get(
			"--trees-theme-git-deleted-fg"
		),
		"--trees-theme-git-modified-fg": treeThemeValues.get(
			"--trees-theme-git-modified-fg"
		),
		"--trees-theme-input-bg": treeThemeValues.get("--trees-theme-input-bg"),
		"--trees-theme-input-border": treeThemeValues.get(
			"--trees-theme-input-border"
		),
		"--trees-theme-list-active-selection-bg": treeThemeValues.get(
			"--trees-theme-list-active-selection-bg"
		),
		"--trees-theme-list-active-selection-fg": treeThemeValues.get(
			"--trees-theme-list-active-selection-fg"
		),
		"--trees-theme-list-hover-bg": treeThemeValues.get(
			"--trees-theme-list-hover-bg"
		),
		"--trees-theme-scrollbar-thumb": treeThemeValues.get(
			"--trees-theme-scrollbar-thumb"
		),
		"--trees-theme-sidebar-bg": treeThemeValues.get("--trees-theme-sidebar-bg"),
		"--trees-theme-sidebar-border": treeThemeValues.get(
			"--trees-theme-sidebar-border"
		),
		"--trees-theme-sidebar-fg": treeThemeValues.get("--trees-theme-sidebar-fg"),
		"--trees-theme-sidebar-header-fg": treeThemeValues.get(
			"--trees-theme-sidebar-header-fg"
		),
	};
	const treePreviewClasses = cn(
		treeThemeValues.get("colorScheme") && appearanceStyles.treeScheme,
		treeThemeValues.get("backgroundColor") && appearanceStyles.treeBackground,
		treeThemeValues.get("color") && appearanceStyles.treeForeground,
		treeThemeValues.get("borderColor") && appearanceStyles.treeBorder
	);

	const toolDetailPreset = deriveToolDetailPreset(
		hideToolDetail,
		groupToolUses,
		expandFileEdits,
		expandCommands,
		expandCodeBlocks
	);
	const applyToolDetailStep = useCallback(
		(id: ToolDetailStepId) => {
			// None writes ONLY the visibility flag: the four expansion toggles keep
			// whatever the user had, so stepping back up restores their setup
			// instead of a preset we picked for them.
			if (id === "none") {
				setHideToolDetail(true);
				return;
			}
			setHideToolDetail(false);
			const preset = TOOL_DETAIL_PRESETS[id];
			setGroupToolUses(preset.group);
			setExpandFileEdits(preset.edits);
			setExpandCommands(preset.commands);
			setExpandCodeBlocks(preset.code);
		},
		[
			setHideToolDetail,
			setGroupToolUses,
			setExpandFileEdits,
			setExpandCommands,
			setExpandCodeBlocks,
		]
	);
	const toolDetailStep = toolDetailStepIndex(
		toolDetailPreset,
		groupToolUses,
		expandFileEdits,
		expandCommands,
		expandCodeBlocks
	);
	const handleToolDetailStep = useCallback(
		(next: number) => {
			const picked = TOOL_DETAIL_STEPS[Math.round(next)];
			if (picked) {
				applyToolDetailStep(picked.id);
			}
		},
		[applyToolDetailStep]
	);
	// Auto-reveal Advanced when the current combo matches no preset, so a "custom"
	// state is never hidden behind a collapsed section.
	const [toolDetailAdvancedOpen, setToolDetailAdvancedOpen] = useState(
		toolDetailPreset === "custom"
	);

	return {
		pendingSubpage,
		isDesktop,
		osAccess,
		showInterfaces,
		theme,
		setTheme,
		pointerCursorEnabled,
		chromeShadowsEnabled,
		dialogOverlayBlurEnabled,
		popupOverlayBlurEnabled,
		invertedBackgroundsEnabled,
		friendlyNames,
		setFriendlyNames,
		interfaceLevel,
		botTerminology,
		setBotTerminologyEnabled,
		botTerminologyForced,
		groupChatsByDate,
		setGroupChatsByDate,
		sidebarGroupedNav,
		setSidebarGroupedNav,
		sidebarTransparency,
		setSidebarTransparency,
		windowTransparency,
		setWindowTransparency,
		agentRowStyle,
		sidebarChatPreview,
		setSidebarChatPreview,
		chatPickerPlacement,
		setChatPickerPlacement,
		markdownComposer,
		setMarkdownComposer,
		contributedModes,
		sidebarMode,
		setSidebarMode,
		sidebarVariant,
		setSidebarVariant,
		sidebarOverflowPopover,
		setSidebarOverflowPopover,
		tabDropdown,
		setTabDropdown,
		tabSearchButtonVisible,
		setTabSearchButtonVisible,
		notificationLayout,
		notificationLayoutStep,
		handleNotificationLayoutStep,
		nodeSelectorDetail,
		setNodeSelectorDetail,
		usageBarPrefs,
		groupToolUses,
		setGroupToolUses,
		expandFileEdits,
		setExpandFileEdits,
		expandCommands,
		setExpandCommands,
		expandCodeBlocks,
		setExpandCodeBlocks,
		hideToolDetail,
		setHideToolDetail,
		pinUserMessage,
		setPinUserMessage,
		openChatAtBottom,
		setOpenChatAtBottom,
		inferenceStats,
		setInferenceStats,
		animationsEnabled,
		setAnimationsEnabled,
		streamAnimation,
		setStreamAnimation,
		diffPrefs,
		fileTreePrefs,
		fileTreeThemeStyles,
		treeThemeValues,
		treePreviewStyle,
		treePreviewClasses,
		toolDetailPreset,
		applyToolDetailStep,
		toolDetailStep,
		handleToolDetailStep,
		toolDetailAdvancedOpen,
		setToolDetailAdvancedOpen,
	};
}

export type AppearancePrefs = ReturnType<typeof useAppearancePrefs>;
