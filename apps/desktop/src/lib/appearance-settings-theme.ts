import { setBotTerminology } from "@ryu/ui/hooks/use-bot-terminology.ts";
import { setAgentRowStyle } from "@/src/hooks/useAgentRowStyle.ts";
import { setChatPickerPlacement } from "@/src/hooks/useChatPickerPlacement.ts";
import { setChromeShadows } from "@/src/hooks/useChromeShadows.ts";
import { setDialogOverlayBlur } from "@/src/hooks/useDialogOverlayBlur.ts";
import { setFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { setInvertedBackgrounds } from "@/src/hooks/useInvertedBackgrounds.ts";
import { setPersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { setPointerCursor } from "@/src/hooks/usePointerCursor.ts";
import { setPopupOverlayBlur } from "@/src/hooks/usePopupOverlayBlur.ts";
import { setSidebarMode } from "@/src/hooks/useSidebarMode.ts";
import { setSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import {
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
} from "@/src/hooks/useThemePreset.ts";
import {
	setSidebarTransparency,
	setWindowTransparency,
} from "@/src/hooks/useWindowTransparency.ts";
import { registerSetting } from "@/src/lib/settings-registry.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
	themeModeSetter,
} from "./appearance-settings-defaults.ts";

/** Theme, typography, density, chrome and sidebar preferences. */
export function registerAppearanceThemeSettings(): void {
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
}
