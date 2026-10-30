import type { ShadowComputerUseConfigUpdate } from "@/src/lib/api/shadow.ts";

export const SHADOW_PLUGIN_ID = "@ryu/shadow";
export const MAX_HISTORY_RETENTION_DAYS = 3650;
export const JEV_SECRET_KEY = "SHADOW_JEV_API_KEY";
const PLANNER_OPTION_SEPARATOR = ":";
export function plannerOptionValue(pluginId: string, contributionId: string) {
	return `${pluginId}${PLANNER_OPTION_SEPARATOR}${contributionId}`;
}
export const COMPUTER_USE_DEFAULTS: ShadowComputerUseConfigUpdate = {
	planner: "native",
	jevUrl: "https://api.typesafe.ai/v1/systemone",
	jevModel: "jev-latest",
	layaUrl: "",
	localPluginId: "",
	localModelId: "",
	maxSteps: 12,
};
