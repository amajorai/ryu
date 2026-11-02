import { describe, expect, test } from "bun:test";
import { leadSentence } from "./product-statement.tsx";

describe("leadSentence", () => {
	test("English keeps the space before the rest", () => {
		expect(
			leadSentence("Ryu Core is the runtime. Every agent runs on it.")
		).toEqual(["Ryu Core is the runtime.", " Every agent runs on it."]);
	});

	test("does not split inside a decimal or a single sentence", () => {
		expect(leadSentence("It takes 1.2s to start.")).toEqual([
			"It takes 1.2s to start.",
			"",
		]);
	});

	test("Japanese splits after the full-width stop without a space", () => {
		expect(
			leadSentence(
				"Ryu Core はランタイムです。すべてのエージェントが動きます。"
			)
		).toEqual([
			"Ryu Core はランタイムです。",
			"すべてのエージェントが動きます。",
		]);
	});

	test("Arabic splits after its question mark", () => {
		expect(leadSentence("ما هو Ryu Core؟ إنه بيئة التشغيل.")).toEqual([
			"ما هو Ryu Core؟",
			" إنه بيئة التشغيل.",
		]);
	});
});
