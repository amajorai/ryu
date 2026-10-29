import { describe, expect, it } from "bun:test";
import "@/src/lib/appearance-settings.ts";
import {
	APPEARANCE_DEFAULTS,
	APPEARANCE_KEYS,
} from "@/src/lib/appearance-settings.ts";
import {
	readInterfaceLevel,
	setInterfaceLevel,
} from "@/src/lib/interface-level.ts";
import { setProductMode, useProductModeStore } from "@/src/lib/product-mode.ts";
import { listSettingsByCategory } from "@/src/lib/settings-registry.ts";

/**
 * Guardrail: every Appearance preference must be registered so
 * "Reset to defaults" cannot silently skip new toggles again.
 */
describe("appearance settings registry", () => {
	it("registers the previously missed Appearance toggles", () => {
		const ids = new Set(listSettingsByCategory("appearance").map((e) => e.id));

		for (const id of [
			"appearance.bot-terminology",
			"appearance.animations-enabled",
			"appearance.stream-animation",
			"appearance.inverted-backgrounds",
			"appearance.sidebar-transparency",
			"appearance.window-transparency",
			"appearance.popup-overlay-blur",
			"appearance.sidebar-mode",
			"appearance.sidebar-variant",
			"appearance.group-chats-by-date",
			"appearance.sidebar-grouped-nav",
			"appearance.sidebar-overflow-popover",
			"appearance.tab-dropdown",
			"appearance.tab-search-button",
			"appearance.notification-layout",
			"appearance.group-tool-uses",
			"appearance.expand-file-edits",
			"appearance.expand-commands",
			"appearance.pin-user-message",
			"appearance.seasonal-effects",
			"appearance.seasonal-theme",
			"appearance.sidebar-chat-preview",
			"appearance.chat-picker-placement",
		]) {
			expect(ids.has(id)).toBe(true);
		}
	});

	it("keeps popup overlay blur opt-in", () => {
		expect(APPEARANCE_DEFAULTS.popupOverlayBlur).toBe(false);
		expect(APPEARANCE_KEYS.popupOverlayBlur).toBe("ryu_popup_overlay_blur");
	});

	it("keeps the new chat appearance preferences opt-in and composer-first", () => {
		expect(APPEARANCE_DEFAULTS.sidebarChatPreview).toBe(false);
		expect(APPEARANCE_KEYS.sidebarChatPreview).toBe("ryu:sidebar-chat-preview");
		expect(APPEARANCE_DEFAULTS.chatPickerPlacement).toBe("composer");
		expect(APPEARANCE_KEYS.chatPickerPlacement).toBe(
			"ryu:chat-picker-placement"
		);
	});

	it("ships the searchable tab dropdown on by default", () => {
		expect(APPEARANCE_DEFAULTS.tabDropdown).toBe(true);
		expect(APPEARANCE_KEYS.tabDropdown).toBe("ryu:tab-dropdown");
	});

	it("ships Bot terminology on with its stable storage key", () => {
		expect(APPEARANCE_DEFAULTS.botTerminology).toBe(true);
		expect(APPEARANCE_KEYS.botTerminology).toBe("ryu:bot-terminology");
	});

	it("keeps native surface transparency opt-in and independent", () => {
		expect(APPEARANCE_DEFAULTS.sidebarTransparency).toBe(false);
		expect(APPEARANCE_DEFAULTS.windowTransparency).toBe(false);
		expect(APPEARANCE_KEYS.sidebarTransparency).toBe(
			"ryu:sidebar-transparency"
		);
		expect(APPEARANCE_KEYS.windowTransparency).toBe("ryu:window-transparency");
	});

	it("registers core theme / layout prefs", () => {
		const ids = new Set(listSettingsByCategory("appearance").map((e) => e.id));

		for (const id of [
			"appearance.theme-mode",
			"appearance.light-preset",
			"appearance.dark-preset",
			"appearance.ui-font",
			"appearance.heading-font",
			"appearance.code-font",
			"appearance.contrast",
			"appearance.radius",
			"appearance.spacing",
			"appearance.card-spacing",
			"appearance.chat-width",
			"appearance.sidebar-width",
			"appearance.background-customization",
			"appearance.usage-bar",
			"appearance.diff-view",
			"appearance.file-tree",
			"appearance.timezone",
		]) {
			expect(ids.has(id)).toBe(true);
		}
	});

	it("resets the interface level to the current surface's level so the response mode does not move", () => {
		const entry = listSettingsByCategory("appearance").find(
			(e) => e.id === "appearance.interface-level"
		);
		if (!entry) {
			throw new Error("interface level is not registered");
		}
		const previous = useProductModeStore.getState().requestedMode;
		useProductModeStore.getState().setConsoleAccess(true);
		try {
			setProductMode("console");
			setInterfaceLevel("expert", { applyPrefs: false });
			entry.reset();
			expect(readInterfaceLevel()).toBe("expert");

			setProductMode("bot");
			setInterfaceLevel("expert", { applyPrefs: false });
			entry.reset();
			expect(readInterfaceLevel()).toBe("simple");
		} finally {
			setProductMode(previous);
			useProductModeStore.getState().setConsoleAccess(false);
		}
	});
});
