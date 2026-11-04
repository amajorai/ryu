import type {
	BrowserImageRuntimeStatus,
	BrowserImageStatusDetail,
} from "@ryu/browser-local-ai";
import { translate as tl } from "@ryu/i18n/core";
import { formatPercent } from "@ryu/i18n/format-percent";

// The browser image runtime publishes its status line as a code plus values
// (`status`) beside an English `statusMessage`. The editor's status line shows
// the code as a whole sentence in the reader's language, with the download
// percent in their number format and a real plural for the subject count. A
// failure leads with one translated sentence; the model's own (English) cause
// follows as the detail value. A status with no code (an older runtime, a test
// harness) keeps its `statusMessage`.

function downloadPercent(progress: number): string {
	return formatPercent(Math.max(0, Math.min(100, progress)) / 100);
}

/** The status line for one runtime status code, in the active UI language. */
export function imageStatusText(detail: BrowserImageStatusDetail): string {
	switch (detail.code) {
		case "segmentation.preparing":
			return tl("Preparing segmentation on {device}.", detail.values);
		case "background.preparing":
			return tl("Preparing background removal on {device}.", detail.values);
		case "segmentation.downloading":
			return detail.values.progress === undefined
				? tl("Downloading segmentation model files on {device}…", {
						device: detail.values.device,
					})
				: tl("Downloading segmentation model ({percent}).", {
						percent: downloadPercent(detail.values.progress),
					});
		case "background.downloading":
			return detail.values.progress === undefined
				? tl("Downloading background-removal model files on {device}…", {
						device: detail.values.device,
					})
				: tl("Downloading background-removal model ({percent}).", {
						percent: downloadPercent(detail.values.progress),
					});
		case "segmentation.ready":
			return tl("Segmentation model ready in this browser.");
		case "background.ready":
			return tl("Background-removal model ready in this browser.");
		case "segmentation.running":
			return tl("Finding subjects…");
		case "background.running":
			return tl("Removing background…");
		case "segments.found":
			return tl(
				"{count, plural, one {# subject found.} other {# subjects found.}}",
				detail.values
			);
		case "background.removed":
			return tl("Background removed.");
		case "segmentation.failed":
			return tl("Segmentation failed. Details: {detail}", detail.values);
		case "background.failed":
			return tl("Background removal failed. Details: {detail}", detail.values);
		default:
			return "";
	}
}

/** The editor's status line for a runtime status, or null when there is none. */
export function imageStatusLine(
	status: BrowserImageRuntimeStatus | null
): string | null {
	if (!status) {
		return null;
	}
	if (!status.status) {
		return status.statusMessage;
	}
	return imageStatusText(status.status) || status.statusMessage;
}
