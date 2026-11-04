// The llmfit speed-estimate badges must read in the UI language: every known
// fit level and run path becomes a whole translated message, the graphics
// memory uses the locale's decimal, and an unknown engine word shows raw.

import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	llmfitFitLabel,
	llmfitMemoryLine,
	llmfitRateLabel,
} from "./llmfit-labels.ts";

const JA: Record<string, string> = {
	"Perfect fit": "完全に収まる",
	"Good fit": "十分に収まる",
	"Marginal fit": "ぎりぎり収まる",
	"Too tight to fit": "収まらない",
	"needs {memory} GB graphics memory": "{memory} GBのグラフィックメモリが必要",
	"needs {memory} GB graphics memory · GPU":
		"{memory} GBのグラフィックメモリが必要 · GPU",
	"needs {memory} GB graphics memory · CPU offload":
		"{memory} GBのグラフィックメモリが必要 · CPUオフロード",
	"needs {memory} GB graphics memory · CPU only":
		"{memory} GBのグラフィックメモリが必要 · CPUのみ",
	"needs {memory} GB graphics memory · {path}":
		"{memory} GBのグラフィックメモリが必要 · {path}",
	"≈{rate} tokens/sec": "約{rate}トークン/秒",
};

function catalogTl(
	catalog: Record<string, string>,
	locale: string
): LiteralMessage {
	return (source: string, values?: MessageValuesInput) =>
		formatMessage(catalog[source] ?? source, values, locale);
}

const ja = catalogTl(JA, "ja");
const en = catalogTl({}, "en");

describe("llmfitFitLabel", () => {
	test("translates every known fit level under ja", () => {
		expect(llmfitFitLabel(ja, "Perfect")).toBe("完全に収まる");
		expect(llmfitFitLabel(ja, "Good")).toBe("十分に収まる");
		expect(llmfitFitLabel(ja, "Marginal")).toBe("ぎりぎり収まる");
		expect(llmfitFitLabel(ja, "Too Tight")).toBe("収まらない");
	});

	test("accepts the engine's other spellings of a known level", () => {
		expect(llmfitFitLabel(ja, "too_tight")).toBe("収まらない");
		expect(llmfitFitLabel(ja, "TooTight")).toBe("収まらない");
		expect(llmfitFitLabel(ja, " perfect ")).toBe("完全に収まる");
	});

	test("shows an unknown level as the engine sent it", () => {
		expect(llmfitFitLabel(ja, "Excellent")).toBe("Excellent");
		expect(llmfitFitLabel(en, "Perfect")).toBe("Perfect fit");
	});
});

describe("llmfitMemoryLine", () => {
	test("uses one whole message per known path under ja", () => {
		expect(llmfitMemoryLine(ja, "ja", 4.5, "gpu")).toBe(
			"4.5 GBのグラフィックメモリが必要 · GPU"
		);
		expect(llmfitMemoryLine(ja, "ja", 4.5, "cpu_offload")).toBe(
			"4.5 GBのグラフィックメモリが必要 · CPUオフロード"
		);
		expect(llmfitMemoryLine(ja, "ja", 4.5, "cpu_only")).toBe(
			"4.5 GBのグラフィックメモリが必要 · CPUのみ"
		);
		expect(llmfitMemoryLine(ja, "ja", 4.5, null)).toBe(
			"4.5 GBのグラフィックメモリが必要"
		);
		expect(llmfitMemoryLine(ja, "ja", 4.5, "  ")).toBe(
			"4.5 GBのグラフィックメモリが必要"
		);
	});

	test("shows an unknown path raw inside the translated sentence", () => {
		expect(llmfitMemoryLine(ja, "ja", 2, "npu")).toBe(
			"2.0 GBのグラフィックメモリが必要 · npu"
		);
	});

	test("formats the memory with the locale's decimal", () => {
		expect(llmfitMemoryLine(en, "de", 4.25, "gpu")).toBe(
			"needs 4,3 GB graphics memory · GPU"
		);
		expect(llmfitMemoryLine(en, "en", 4.25, "gpu")).toBe(
			"needs 4.3 GB graphics memory · GPU"
		);
		expect(llmfitMemoryLine(en, "ar", 4.5, "cpu_only")).toBe(
			"needs 4.5 GB graphics memory · CPU only"
		);
	});
});

describe("llmfitRateLabel", () => {
	test("rounds and groups the rate for the locale", () => {
		expect(llmfitRateLabel(ja, "ja", 41.6)).toBe("約42トークン/秒");
		expect(llmfitRateLabel(en, "de", 1234.4)).toBe("≈1.234 tokens/sec");
	});
});
