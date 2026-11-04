import { afterEach, describe, expect, test } from "bun:test";
import {
	BROWSER_IMAGE_STATUS_CODES,
	type BrowserImageRuntimeStatus,
	type BrowserImageStatusDetail,
} from "@ryu/browser-local-ai";
import { formatMessage } from "@ryu/i18n/lite";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { messageForStatus } from "./ImageEditorDialog-canvas.ts";
import { imageStatusText } from "./ImageEditorDialog-status.ts";

/** A German stand-in: marks every catalog message and formats it in de. */
const german: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "de",
	translate: (_id, values, fallback) =>
		`[de] ${formatMessage(fallback ?? "", values ?? {}, "de")}`,
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

const SAMPLES: Record<string, BrowserImageStatusDetail> = {
	"background.downloading": {
		code: "background.downloading",
		values: { device: "wasm", progress: 42.4 },
	},
	"background.failed": {
		code: "background.failed",
		values: { detail: "wasm backend missing" },
	},
	"background.preparing": {
		code: "background.preparing",
		values: { device: "wasm" },
	},
	"background.ready": { code: "background.ready" },
	"background.removed": { code: "background.removed" },
	"background.running": { code: "background.running" },
	"segmentation.downloading": {
		code: "segmentation.downloading",
		values: { device: "wasm" },
	},
	"segmentation.failed": {
		code: "segmentation.failed",
		values: { detail: "wasm backend missing" },
	},
	"segmentation.preparing": {
		code: "segmentation.preparing",
		values: { device: "wasm" },
	},
	"segmentation.ready": { code: "segmentation.ready" },
	"segmentation.running": { code: "segmentation.running" },
	"segments.found": { code: "segments.found", values: { count: 3 } },
};

function runtimeStatus(
	detail: BrowserImageStatusDetail | undefined,
	statusMessage = "English line."
): BrowserImageRuntimeStatus {
	return {
		modelId: "org/model",
		phase: "ready",
		status: detail,
		statusMessage,
		task: "image-segmentation",
	};
}

describe("image editor status line", () => {
	test("every runtime code renders as a translated catalog message", () => {
		registerActiveI18nRuntime(german);
		expect(Object.keys(SAMPLES).sort()).toEqual(
			[...BROWSER_IMAGE_STATUS_CODES].sort()
		);
		for (const detail of Object.values(SAMPLES)) {
			expect(imageStatusText(detail)).toStartWith("[de] ");
		}
	});

	test("the download percent uses the reader's number format", () => {
		registerActiveI18nRuntime(german);
		const line = imageStatusText(SAMPLES["background.downloading"]!);
		expect(line).toBe(
			`[de] Downloading background-removal model (${new Intl.NumberFormat("de", { style: "percent" }).format(0.42)}).`
		);
		expect(line).not.toContain("42%");
	});

	test("the subject count is a real plural", () => {
		expect(
			imageStatusText({ code: "segments.found", values: { count: 1 } })
		).toBe("1 subject found.");
		expect(
			imageStatusText({ code: "segments.found", values: { count: 4 } })
		).toBe("4 subjects found.");
	});

	test("a failure leads with a sentence and keeps the raw cause as detail", () => {
		expect(imageStatusText(SAMPLES["segmentation.failed"]!)).toBe(
			"Segmentation failed. Details: wasm backend missing"
		);
	});

	test("messageForStatus prefers the code and falls back to the English line", () => {
		registerActiveI18nRuntime(german);
		expect(messageForStatus(null)).toBeNull();
		expect(
			messageForStatus(runtimeStatus({ code: "background.removed" }))
		).toBe("[de] Background removed.");
		expect(messageForStatus(runtimeStatus(undefined))).toBe("English line.");
	});
});
