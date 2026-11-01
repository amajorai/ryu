import { describe, expect, test } from "bun:test";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { slidePreviewSrc } from "./slide-preview-url.ts";

describe("slidePreviewSrc", () => {
	test("encodes the rendered SVG so its text round-trips through the img src", () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg"><text>Q3 — edited & saved</text></svg>';
		const src = slidePreviewSrc(svg);
		expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toBe(svg);
	});

	test("is not a URL safeMediaUrl admits, which is why previews bypass it", () => {
		expect(safeMediaUrl(slidePreviewSrc("<svg/>"))).toBeNull();
	});
});
