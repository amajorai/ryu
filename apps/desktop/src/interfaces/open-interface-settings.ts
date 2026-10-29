import { requestSettingReveal } from "@/src/lib/settings-focus.ts";
import { SETTINGS_ENTRIES } from "@/src/lib/settings-index.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { useInterfaceSettings } from "./use-interface-settings.ts";

const INTERFACE_SETTINGS_ENTRY = SETTINGS_ENTRIES.find(
	(entry) => entry.id === "appearance.interfaces.interface"
);

/** Opens Settings → Appearance → Interfaces on the given interface. */
export function openInterfaceSettings(interfaceId: string) {
	useInterfaceSettings.getState().focusInterface(interfaceId);
	if (INTERFACE_SETTINGS_ENTRY) {
		requestSettingReveal(INTERFACE_SETTINGS_ENTRY);
	}
	useSettingsDialog.getState().openSettings("appearance");
}
