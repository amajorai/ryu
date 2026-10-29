import { getCurrentWindow } from "@tauri-apps/api/window";
import { readHostedStandaloneAppId } from "../lib/standalone-window.ts";

// Detect the Tauri window label synchronously via the internals object that
// Tauri injects before any JS runs. Falls back to "main" in a plain browser.
function getTauriWindowLabel(): string {
	try {
		return getCurrentWindow().label;
	} catch {
		return "main";
	}
}

export const WINDOW_LABEL = getTauriWindowLabel();
export const HOSTED_STANDALONE_APP_ID = readHostedStandaloneAppId(
	globalThis.window ? window.location.search : ""
);
