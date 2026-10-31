import type { LiteralMessage } from "@ryu/i18n/react";
import type { DownloadArch, DownloadState } from "./download-assets.ts";

/** The sub-label under an arch name, explaining what that row can offer. */
export function archHintFor(
	state: DownloadState,
	arch: DownloadArch,
	tl: LiteralMessage
): string {
	if (state.kind === "building") {
		return tl("{version} is still building", { version: state.version });
	}
	if (state.kind === "unavailable") {
		return "Not available";
	}
	if (state.kind === "unknown") {
		return "Browse releases on GitHub";
	}
	const processors = arch === "arm" ? "ARM processors" : "Intel / AMD";
	// During a release window the newest tag has no binaries yet, so name the
	// version this button really hands over rather than implying it is the newest.
	return state.supersededByBuilding
		? `${processors} · ${state.servedVersion}`
		: processors;
}
