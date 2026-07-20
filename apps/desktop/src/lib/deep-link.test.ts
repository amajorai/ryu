import { describe, expect, it } from "bun:test";
import { pickRecommendedQuant } from "./deep-link.ts";

// The `ryu://` parse/build grammar is tested in @ryuhq/protocol
// (packages/protocol/src/deep-link.test.ts). This file covers only the
// desktop-specific quant picker.

describe("pickRecommendedQuant", () => {
	const file = (over: Partial<import("./api/models.ts").ModelFile>) =>
		({
			filename: "f.gguf",
			fit: "ok",
			fitLabel: "",
			installed: false,
			quant: null,
			sha256: null,
			sizeBytes: 1000,
			sizeHuman: "1 KB",
			url: "https://example.com/f.gguf",
			...over,
		}) as import("./api/models.ts").ModelFile;

	it("prefers the best device fit", () => {
		const best = pickRecommendedQuant([
			file({ filename: "cpu.gguf", fit: "cpu" }),
			file({ filename: "great.gguf", fit: "great" }),
			file({ filename: "ok.gguf", fit: "ok" }),
		]);
		expect(best?.filename).toBe("great.gguf");
	});

	it("breaks fit ties toward the smaller file", () => {
		const best = pickRecommendedQuant([
			file({ filename: "big.gguf", fit: "ok", sizeBytes: 5000 }),
			file({ filename: "small.gguf", fit: "ok", sizeBytes: 2000 }),
		]);
		expect(best?.filename).toBe("small.gguf");
	});

	it("prefers an already-installed quant so re-triggering is a no-op", () => {
		const best = pickRecommendedQuant([
			file({ filename: "great.gguf", fit: "great" }),
			file({ filename: "installed.gguf", fit: "cpu", installed: true }),
		]);
		expect(best?.filename).toBe("installed.gguf");
	});

	it("returns null when there are no files", () => {
		expect(pickRecommendedQuant([])).toBeNull();
	});
});
