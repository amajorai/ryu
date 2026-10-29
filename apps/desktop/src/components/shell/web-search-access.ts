import { z } from "zod";

export const WEB_SEARCH_ACCESS_MODE_PREF_KEY = "web-search-access-mode";

export const WEB_SEARCH_ACCESS_MODE_OPTIONS = [
	{
		value: "disabled",
		label: "Disabled",
		description: "Don't allow web search",
	},
	{
		value: "cached",
		label: "Cached",
		description: "Use the selected provider's maintained search index",
	},
	{
		value: "indexed",
		label: "Indexed",
		description: "Allow indexed external web access",
	},
	{
		value: "live",
		label: "Live",
		description: "Allow unrestricted, current web access",
	},
] as const;

export type WebSearchAccessMode =
	(typeof WEB_SEARCH_ACCESS_MODE_OPTIONS)[number]["value"];

export const DEFAULT_WEB_SEARCH_ACCESS_MODE: WebSearchAccessMode = "live";

const webSearchAccessModeSchema = z.enum([
	"disabled",
	"cached",
	"indexed",
	"live",
]);

export function isWebSearchAccessMode(
	value: Parameters<typeof webSearchAccessModeSchema.safeParse>[0]
): value is WebSearchAccessMode {
	return webSearchAccessModeSchema.safeParse(value).success;
}

export function parseWebSearchAccessMode(
	value: string | null
): WebSearchAccessMode {
	if (value === null) {
		return DEFAULT_WEB_SEARCH_ACCESS_MODE;
	}
	if (isWebSearchAccessMode(value)) {
		return value;
	}
	throw new Error("Invalid web search access mode preference");
}
