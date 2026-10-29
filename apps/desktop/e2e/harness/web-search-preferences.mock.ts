import {
	isWebSearchAccessMode,
	WEB_SEARCH_ACCESS_MODE_PREF_KEY,
} from "../../src/components/shell/web-search-access.ts";
import type { ApiTarget } from "../../src/lib/api/client.ts";

let webSearchAccessMode = "cached";
// `?fail=get` or `?fail=put` makes that request reject, for the error states.
const failure = new URLSearchParams(window.location.search).get("fail");

export async function getPreference(
	_target: ApiTarget,
	key: string
): Promise<string | null> {
	if (failure === "get") {
		throw new Error("The preferences request failed");
	}
	return key === WEB_SEARCH_ACCESS_MODE_PREF_KEY ? webSearchAccessMode : null;
}

export async function setPreference(
	_target: ApiTarget,
	key: string,
	value: string
): Promise<boolean> {
	if (failure === "put") {
		throw new Error("The preferences request failed");
	}
	if (
		key !== WEB_SEARCH_ACCESS_MODE_PREF_KEY ||
		!isWebSearchAccessMode(value)
	) {
		return false;
	}
	webSearchAccessMode = value;
	return true;
}
