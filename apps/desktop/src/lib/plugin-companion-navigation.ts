import type { PluginCompanion } from "./api/plugins.ts";

/** Keep contextual companions available to routers without advertising a global launch. */
export function isNavigablePluginCompanion(
	companion: Pick<PluginCompanion, "hasUi" | "navigationVisible">
): boolean {
	return companion.hasUi !== false && companion.navigationVisible !== false;
}
