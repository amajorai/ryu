// Machine-readable image-runtime status. The runtime publishes a code plus the
// raw values (device, 0-100 progress, subject count, failure cause) beside its
// English `statusMessage`, so a UI renders the line in the reader's language
// and number format instead of showing English prose. `statusMessage` stays for
// logs and older consumers.

/** Codes with no values. */
export type BrowserImageStatusPlainCode =
	| "background.ready"
	| "background.removed"
	| "background.running"
	| "segmentation.ready"
	| "segmentation.running";

export type BrowserImageStatusDetail =
	| { code: BrowserImageStatusPlainCode }
	| {
			code: "background.preparing" | "segmentation.preparing";
			values: { device: string };
	  }
	| {
			code: "background.downloading" | "segmentation.downloading";
			/** `progress` is 0-100 when the download reports it. */
			values: { device: string; progress?: number };
	  }
	| { code: "segments.found"; values: { count: number } }
	| {
			code: "background.failed" | "segmentation.failed";
			/** The raw (usually English) cause, for a detail line. */
			values: { detail: string };
	  };

export type BrowserImageStatusCode = BrowserImageStatusDetail["code"];

/** Every code the image runtime can publish. */
export const BROWSER_IMAGE_STATUS_CODES: readonly BrowserImageStatusCode[] = [
	"background.downloading",
	"background.failed",
	"background.preparing",
	"background.ready",
	"background.removed",
	"background.running",
	"segmentation.downloading",
	"segmentation.failed",
	"segmentation.preparing",
	"segmentation.ready",
	"segmentation.running",
	"segments.found",
];
