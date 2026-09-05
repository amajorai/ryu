import {
	setPersistedToggle,
	usePersistedToggle,
} from "@/src/hooks/usePersistedToggle.ts";
import { registerSetting } from "@/src/lib/settings-registry.ts";

/** Whether the chat header keeps its bottom-panel control visible. */
export const SHOW_BOTTOM_PANEL_TOGGLE_KEY = "ryu:show-bottom-panel-toggle";
export const DEFAULT_SHOW_BOTTOM_PANEL_TOGGLE = true;

export function useShowBottomPanelToggle(): [
	boolean,
	(value: boolean) => void,
] {
	return usePersistedToggle(
		SHOW_BOTTOM_PANEL_TOGGLE_KEY,
		DEFAULT_SHOW_BOTTOM_PANEL_TOGGLE
	);
}

registerSetting({
	category: "general",
	id: "general.bottom-panel-toggle",
	label: "Bottom panel",
	reset: () =>
		setPersistedToggle(
			SHOW_BOTTOM_PANEL_TOGGLE_KEY,
			DEFAULT_SHOW_BOTTOM_PANEL_TOGGLE
		),
});
