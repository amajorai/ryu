import { describe, expect, it } from "bun:test";
import { safeMediaUrl } from "./safe-media-url.ts";

describe("safeMediaUrl", () => {
	it("allows same-site, web, and blob media", () => {
		expect(safeMediaUrl("/uploads/image.png")).toBe("/uploads/image.png");
		expect(safeMediaUrl("https://cdn.example/image.png")).toBe(
			"https://cdn.example/image.png"
		);
		expect(safeMediaUrl("blob:https://app.example/id")).toBe(
			"blob:https://app.example/id"
		);
		expect(safeMediaUrl("data:image/png;base64,AAAA")).toBe(
			"data:image/png;base64,AAAA"
		);
	});

	it("rejects native Blob objects and non-URL inputs", () => {
		expect(safeMediaUrl(new Blob(["image"], { type: "image/png" }))).toBeNull();
		expect(safeMediaUrl({ src: "https://example.com/avatar.png" })).toBeNull();
		expect(safeMediaUrl(undefined)).toBeNull();
		expect(safeMediaUrl(null)).toBeNull();
	});

	it("rejects executable and non-media schemes", () => {
		expect(safeMediaUrl("javascript:alert(1)")).toBeNull();
		expect(safeMediaUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(safeMediaUrl("data:image/svg+xml,<svg></svg>")).toBeNull();
		expect(safeMediaUrl("file:///etc/passwd")).toBeNull();
		expect(safeMediaUrl("//attacker.example/image.png")).toBeNull();
	});
});
