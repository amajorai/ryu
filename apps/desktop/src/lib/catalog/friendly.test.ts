// Tests for the catalog friendly-display helpers. Pure functions, no React.

import { describe, expect, it } from "bun:test";
import type { ModelCard } from "@/src/lib/api/models.ts";
import type { SkillCard } from "@/src/lib/api/skills.ts";
import {
	displayTokens,
	extractTokens,
	friendlyDownloadLabel,
	friendlyModelDisplay,
	friendlyModelName,
	friendlyQuant,
	ggufFileRole,
	matchesQuery,
	modelHaystack,
	parseModelSize,
	parsePipelineModalities,
	quantVariantRank,
	skillHaystack,
	skillOrg,
	titleCase,
} from "./friendly.ts";

describe("parseModelSize", () => {
	it("reads a dense param count and picks the right tier", () => {
		expect(parseModelSize("gemma-2-27b-it")).toMatchObject({
			tier: "Large",
			raw: "27B",
		});
		expect(parseModelSize("llama-3-8b-instruct")?.tier).toBe("Medium");
		expect(parseModelSize("qwen2.5-1.5b")?.tier).toBe("Small");
		expect(parseModelSize("llama-3.1-70b")?.tier).toBe("Extra Large");
	});

	it("prefers the total param count over MoE active params for the tier", () => {
		const size = parseModelSize("Qwen3-30B-A3B");
		expect(size?.tier).toBe("Large");
		expect(size?.raw).toBe("30B");
		expect(size?.tooltip).toContain("active");
	});

	it("handles effective-param (E2B) and million (M) suffixes", () => {
		expect(parseModelSize("gemma-4-E2B-it")).toMatchObject({
			tier: "Small",
			raw: "E2B",
		});
		expect(parseModelSize("gemma-3-270m")).toMatchObject({
			tier: "Small",
			raw: "270M",
		});
	});

	it("returns null when there is no size token", () => {
		expect(parseModelSize("my-cool-model")).toBeNull();
	});
});

describe("extractTokens", () => {
	it("recognizes common name tokens", () => {
		const ids = extractTokens("gemma-4-E2B-it-GGUF").map((t) => t.id);
		expect(ids).toContain("instruct");
		expect(ids).toContain("gguf");
	});

	it("maps abliterated/dolphin to a single Uncensored badge", () => {
		expect(extractTokens("llama-3-8b-abliterated").map((t) => t.id)).toContain(
			"uncensored"
		);
		expect(extractTokens("dolphin-2.9-llama3").map((t) => t.id)).toContain(
			"uncensored"
		);
	});

	it("recognizes qat, reasoning, coder and moe", () => {
		expect(extractTokens("gemma-3-12b-it-qat").map((t) => t.id)).toContain(
			"qat"
		);
		expect(extractTokens("deepseek-r1-distill-qwen").map((t) => t.id)).toEqual(
			expect.arrayContaining(["r1", "distilled"])
		);
		expect(extractTokens("qwen2.5-coder-7b").map((t) => t.id)).toContain(
			"coder"
		);
		expect(extractTokens("Qwen3-30B-A3B-moe").map((t) => t.id)).toContain(
			"moe"
		);
	});

	it("also scans Hub tags, deduping against the name", () => {
		const ids = extractTokens("some-model", ["text-generation", "vision"]).map(
			(t) => t.id
		);
		expect(ids).toContain("vision");
	});
});

describe("displayTokens", () => {
	it("passes tokens through unchanged in technical mode", () => {
		const tokens = extractTokens("gemma-4-E2B-it-GGUF");
		expect(displayTokens(tokens, false)).toBe(tokens);
		expect(displayTokens(tokens, false).map((t) => t.label)).toContain("GGUF");
	});

	it("hides technical badges and simplifies labels in friendly mode", () => {
		const labels = displayTokens(
			extractTokens("gemma-4-E2B-it-GGUF"),
			true
		).map((t) => t.label);
		expect(labels).not.toContain("GGUF");
		expect(labels).toContain("Chat-ready"); // instruct → Chat-ready
	});

	it("collapses reasoning jargon into one Reasoning badge", () => {
		const labels = displayTokens(
			extractTokens("deepseek-r1-cot-reasoning"),
			true
		).map((t) => t.label);
		expect(labels.filter((l) => l === "Reasoning")).toHaveLength(1);
	});
});

describe("friendlyModelName", () => {
	it("strips tokens + size and Title-Cases the rest", () => {
		expect(friendlyModelName("gemma-4-E2B-it-GGUF")).toBe("Gemma 4");
		expect(friendlyModelName("Qwen2.5-Coder-7B-Instruct")).toBe("Qwen2.5");
		expect(friendlyModelName("Meta-Llama-3.1-8B")).toBe("Meta Llama 3.1");
	});

	it("falls back to a title-case of the original when nothing remains", () => {
		// Every segment is a token/size — keep something readable.
		expect(friendlyModelName("it-gguf").length).toBeGreaterThan(0);
	});
});

describe("friendlyDownloadLabel", () => {
	it("makes a model label friendly while keeping the quant detail", () => {
		expect(
			friendlyDownloadLabel(
				"unsloth/gemma-4-12B-it-GGUF (gemma-4-12B-it-Q4_K_M.gguf)",
				"model"
			)
		).toBe("Gemma 4 · Balanced (recommended)");
	});

	it("keeps a non-quant detail verbatim", () => {
		expect(
			friendlyDownloadLabel(
				"unsloth/gemma-4-12B-it-GGUF (vision adapter)",
				"model"
			)
		).toBe("Gemma 4 · vision adapter");
	});

	it("title-cases skill labels", () => {
		expect(friendlyDownloadLabel("code-review", "skill")).toBe("Code Review");
	});

	it("leaves engine/agent/tool labels untouched", () => {
		expect(friendlyDownloadLabel("llama.cpp", "engine")).toBe("llama.cpp");
		expect(friendlyDownloadLabel("Some Tool", "tool")).toBe("Some Tool");
	});

	it("falls back to the raw label when it can't be parsed", () => {
		// No name survives stripping and no detail to show.
		const raw = "it-gguf";
		expect(friendlyDownloadLabel(raw, "model").length).toBeGreaterThan(0);
	});
});

describe("titleCase", () => {
	it("fixes lowercase slug-style skill names", () => {
		expect(titleCase("better-auth")).toBe("Better Auth");
		expect(titleCase("code_review")).toBe("Code Review");
		expect(titleCase("Already Nice")).toBe("Already Nice");
	});
});

describe("friendlyQuant", () => {
	it("maps quant labels to plain levels with the raw value in the tooltip", () => {
		expect(friendlyQuant("Q4_K_M").label).toBe("Balanced (recommended)");
		expect(friendlyQuant("Q8_0").label).toBe("Near-original");
		expect(friendlyQuant("Q2_K").label).toBe("Smallest");
		expect(friendlyQuant("Q6_K").label).toBe("High quality");
		expect(friendlyQuant("F16").label).toBe("Full quality (largest)");
		expect(friendlyQuant("Q4_K_M").tooltip).toContain("Q4_K_M");
	});

	it("maps the importance-matrix (IQ) families instead of leaking the raw label", () => {
		expect(friendlyQuant("IQ1_S").label).toBe("Tiny");
		expect(friendlyQuant("IQ2_XXS").label).toBe("Tiny");
		expect(friendlyQuant("IQ3_XXS").label).toBe("Smallest");
		expect(friendlyQuant("IQ4_XS").label).toBe("Balanced (recommended)");
		expect(friendlyQuant("IQ4_NL").label).toBe("Balanced (recommended)");
	});

	it("returns an ascending quality score per family for the meter", () => {
		expect(friendlyQuant("IQ1_S").quality).toBe(1);
		expect(friendlyQuant("Q2_K").quality).toBe(2);
		expect(friendlyQuant("IQ3_XXS").quality).toBe(2);
		expect(friendlyQuant("Q4_K_M").quality).toBe(3);
		expect(friendlyQuant("IQ4_XS").quality).toBe(3);
		expect(friendlyQuant("Q6_K").quality).toBe(4);
		expect(friendlyQuant("Q8_0").quality).toBe(5);
		expect(friendlyQuant("F16").quality).toBe(5);
		expect(friendlyQuant("BF16").quality).toBe(5);
	});

	it("gives an honest fallback with no meter when the quant is unknown", () => {
		// A null quant must not produce a fillable meter (an empty bar reads as
		// zero quality, a worse lie than the raw label).
		expect(friendlyQuant(null).label).toBe("Custom");
		expect(friendlyQuant(null).quality).toBeNull();
		// An unrecognized token keeps its raw label and stays meter-less.
		expect(friendlyQuant("XYZ9").label).toBe("XYZ9");
		expect(friendlyQuant("XYZ9").quality).toBeNull();
	});
});

describe("quantVariantRank", () => {
	it("ranks the K-quant variants with _K_M as the canonical pick", () => {
		// Lower is more canonical: _K_M < _K_S < _K_L < bare _K.
		expect(quantVariantRank("Q4_K_M")).toBeLessThan(quantVariantRank("Q4_K_S"));
		expect(quantVariantRank("Q4_K_S")).toBeLessThan(quantVariantRank("Q4_K_L"));
		expect(quantVariantRank("Q5_K_L")).toBeLessThan(quantVariantRank("Q5_K"));
	});

	it("prefers K-quants over the legacy _0 / _1 formats", () => {
		expect(quantVariantRank("Q4_K_M")).toBeLessThan(quantVariantRank("Q4_0"));
		expect(quantVariantRank("Q4_0")).toBeLessThan(quantVariantRank("Q4_1"));
	});

	it("sorts unrecognized and missing quants last", () => {
		expect(quantVariantRank("IQ4_XS")).toBeGreaterThanOrEqual(10);
		expect(quantVariantRank(null)).toBeGreaterThan(quantVariantRank("Q4_1"));
		expect(quantVariantRank(null)).toBeGreaterThan(quantVariantRank("IQ4_XS"));
	});

	it("is case-insensitive", () => {
		expect(quantVariantRank("q5_k_m")).toBe(quantVariantRank("Q5_K_M"));
	});
});

describe("ggufFileRole", () => {
	it("flags auxiliary files that aren't model quants", () => {
		expect(ggufFileRole("mmproj-F16.gguf")?.label).toBe("Vision adapter");
		expect(ggufFileRole("MTP/gemma-4-E2B-it-Q8_0-MTP.gguf")?.label).toBe(
			"Draft head (MTP)"
		);
		expect(ggufFileRole("mtp-gemma-4-E2B-it.gguf")?.label).toBe(
			"Draft head (MTP)"
		);
		expect(ggufFileRole("qwen3-0.6B-draft-Q4_K_M.gguf")?.label).toBe(
			"Draft model"
		);
	});

	it("returns null for ordinary model quants", () => {
		expect(ggufFileRole("gemma-4-E2B-it-Q4_K_M.gguf")).toBeNull();
		expect(ggufFileRole("model.Q8_0.gguf")).toBeNull();
	});
});

describe("search haystacks", () => {
	const model: ModelCard = {
		id: "google/gemma-2-27b-it-GGUF",
		author: "google",
		name: "gemma-2-27b-it-GGUF",
		downloads: 0,
		likes: 0,
		pipelineTag: "text-generation",
		tags: ["conversational"],
		gated: false,
		createdAt: null,
		lastModified: null,
		installed: false,
	};

	it("matches a model by org, derived token label, and size", () => {
		const hay = modelHaystack(model);
		expect(matchesQuery(hay, "google")).toBe(true);
		expect(matchesQuery(hay, "instruct")).toBe(true); // derived from "it"
		expect(matchesQuery(hay, "27b")).toBe(true);
		expect(matchesQuery(hay, "qwen")).toBe(false);
	});

	it("requires all terms to match", () => {
		const hay = modelHaystack(model);
		expect(matchesQuery(hay, "gemma large")).toBe(true);
		expect(matchesQuery(hay, "gemma tiny")).toBe(false);
	});
});

describe("parsePipelineModalities", () => {
	it("parses the <in>-to-<out> shape, incl. multi-input", () => {
		expect(parsePipelineModalities("image-text-to-text")).toEqual({
			inputs: ["text", "image"],
			outputs: ["text"],
		});
		expect(parsePipelineModalities("text-to-image")).toEqual({
			inputs: ["text"],
			outputs: ["image"],
		});
		expect(parsePipelineModalities("text-to-speech")).toEqual({
			inputs: ["text"],
			outputs: ["audio"],
		});
	});

	it("expands any-to-any to every modality both ways", () => {
		const flow = parsePipelineModalities("any-to-any");
		expect(flow?.inputs).toEqual(["text", "image", "pdf", "video", "audio"]);
		expect(flow?.outputs).toEqual(["text", "image", "pdf", "video", "audio"]);
	});

	it("handles non-to tags via the fixed table", () => {
		expect(parsePipelineModalities("text-generation")).toEqual({
			inputs: ["text"],
			outputs: ["text"],
		});
		expect(parsePipelineModalities("automatic-speech-recognition")).toEqual({
			inputs: ["audio"],
			outputs: ["text"],
		});
		expect(
			parsePipelineModalities("document-question-answering")?.inputs
		).toEqual(["text", "pdf"]);
	});

	it("returns null for missing or unknown tags", () => {
		expect(parsePipelineModalities(null)).toBeNull();
		expect(parsePipelineModalities("some-unknown-task")).toBeNull();
	});
});

describe("skill helpers", () => {
	const skill: SkillCard = {
		id: "amajorai/skills/ship",
		slug: "ship",
		name: "ship",
		source: "amajorai/skills",
		installs: 10,
		installed: false,
	};

	it("derives the org and matches it in search", () => {
		expect(skillOrg(skill)).toBe("amajorai");
		expect(matchesQuery(skillHaystack(skill), "amajorai")).toBe(true);
		expect(matchesQuery(skillHaystack(skill), "ship")).toBe(true);
	});
});

describe("friendlyModelDisplay", () => {
	it("folds a quant into the friendly compression label, never raw Q4_K_M", () => {
		const d = friendlyModelDisplay("gemma-4-12B-it-Q4_K_M");
		expect(d.label).toBe("Gemma 4 · Balanced (recommended)");
		expect(d.name).toBe("Gemma 4");
		expect(d.quant?.label).toBe("Balanced (recommended)");
		// The exact developer string survives in the hover tooltip.
		expect(d.tooltip).toContain("gemma-4-12B-it-Q4_K_M");
		expect(d.tooltip).toContain("Q4_K_M");
		// Never leak the mangled "Q4 K M" the plain name helper would produce.
		expect(d.label).not.toContain("Q4 K M");
	});

	it("uses only the last path segment of a repo slug", () => {
		const d = friendlyModelDisplay("unsloth/gemma-4-12B-it-GGUF");
		expect(d.name).toBe("Gemma 4");
		expect(d.quant).toBeNull();
		expect(d.label).toBe("Gemma 4");
		expect(d.original).toBe("unsloth/gemma-4-12B-it-GGUF");
	});

	it("leaves an already-clean name (no quant) intact, original kept for hover", () => {
		const d = friendlyModelDisplay("Opus");
		expect(d.label).toBe("Opus");
		expect(d.quant).toBeNull();
		expect(d.tooltip).toBe("Opus");
	});

	it("maps a full-precision token to the friendly tier", () => {
		const d = friendlyModelDisplay("qwen2.5-7b-instruct-F16");
		expect(d.quant?.label).toBe("Full quality (largest)");
		expect(d.label).toContain("Full quality (largest)");
	});
});
