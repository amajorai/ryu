// Unit tests for the pure catalog display helpers in friendly.ts. These power the
// shared catalog badges (token/size/quant parsing) and the friendly-mode name
// simplification; they are framework-free and deterministic, so we exercise the
// parsing edge cases directly (no DOM, no network).

import { describe, expect, test } from "bun:test";
import {
	displayTokens,
	extractTokens,
	friendlyModelName,
	friendlyQuant,
	ggufFileRole,
	parseModelSize,
	parsePipelineModalities,
	quantVariantRank,
	skillOrg,
	titleCase,
} from "./friendly.ts";
import type { SkillCard } from "./types.ts";

describe("extractTokens", () => {
	test("matches an alias against a name segment (Instruct)", () => {
		const tokens = extractTokens("Llama-3.1-8B-Instruct");
		expect(tokens.map((t) => t.id)).toContain("instruct");
	});

	test("keeps version dots intact so 3.1 is not mis-segmented", () => {
		// If the '.' in 3.1 were split, no spurious token should appear from it.
		const ids = extractTokens("Qwen-2.5-7B").map((t) => t.id);
		expect(ids).not.toContain("instruct");
	});

	test("matches aliases found only in tags", () => {
		const ids = extractTokens("SomeModel", ["vision", "coder"]).map(
			(t) => t.id
		);
		expect(ids).toContain("vision");
		expect(ids).toContain("coder");
	});

	test("returns tokens in vocabulary order and deduped", () => {
		// 'it' and 'instruct' are both aliases of the single `instruct` token.
		const tokens = extractTokens("model-it-instruct");
		const instructCount = tokens.filter((t) => t.id === "instruct").length;
		expect(instructCount).toBe(1);
	});

	test("no match yields an empty list", () => {
		expect(extractTokens("plainname")).toEqual([]);
	});
});

describe("displayTokens", () => {
	test("technical mode passes tokens through untouched", () => {
		const tokens = extractTokens("model", ["r1", "gguf"]);
		expect(displayTokens(tokens, false)).toEqual(tokens);
	});

	test("friendly mode drops hidden badges (gguf)", () => {
		const tokens = extractTokens("model", ["gguf"]);
		expect(tokens.map((t) => t.id)).toContain("gguf");
		expect(displayTokens(tokens, true)).toEqual([]);
	});

	test("friendly mode dedupes on the friendly label (r1 + cot -> Reasoning)", () => {
		const tokens = extractTokens("model", ["r1", "cot"]);
		const labels = displayTokens(tokens, true).map((t) => t.label);
		expect(labels).toEqual(["Reasoning"]);
	});

	test("friendly mode relabels instruct to Chat-ready", () => {
		const tokens = extractTokens("model-instruct");
		expect(displayTokens(tokens, true)[0]?.label).toBe("Chat-ready");
	});
});

describe("parseModelSize", () => {
	test("parses a plain size token into tier + raw", () => {
		const size = parseModelSize("Llama-3.1-8B-Instruct");
		expect(size?.raw).toBe("8B");
		expect(size?.tier).toBe("Medium");
	});

	test("picks the largest token as the headline (MoE active vs total)", () => {
		const size = parseModelSize("Qwen3-30B-A3B");
		expect(size?.raw).toBe("30B");
		expect(size?.tier).toBe("Large");
		// The tooltip still records the active-parameter token.
		expect(size?.tooltip).toContain("active parameters");
	});

	test("tier thresholds: small < 3B", () => {
		expect(parseModelSize("tiny-1B")?.tier).toBe("Small");
	});

	test("tier thresholds: extra large >= 70B", () => {
		expect(parseModelSize("giant-120B")?.tier).toBe("Extra Large");
	});

	test("million-scale token maps below 3B (Small)", () => {
		const size = parseModelSize("gemma-270M");
		expect(size?.raw).toBe("270M");
		expect(size?.tier).toBe("Small");
	});

	test("returns null when no size token is present", () => {
		expect(parseModelSize("just-a-name")).toBeNull();
	});
});

describe("friendlyModelName", () => {
	test("strips consumed token + size segments", () => {
		expect(friendlyModelName("gemma-4-E2B-it-GGUF")).toBe("Gemma 4");
	});

	test("falls back to title-case when nothing remains", () => {
		// Every segment is a recognized token/size -> fall back to full title case.
		// "it" is a short acronym so it upper-cases to "IT".
		expect(friendlyModelName("8B-it-gguf")).toBe("8B IT Gguf");
	});
});

describe("friendlyQuant", () => {
	test("Q4 family is Balanced (recommended) with quality 3", () => {
		const info = friendlyQuant("Q4_K_M");
		expect(info.label).toBe("Balanced (recommended)");
		expect(info.quality).toBe(3);
		expect(info.tooltip).toContain("Q4_K_M");
	});

	test("Q2 family is Smallest with quality 2", () => {
		expect(friendlyQuant("Q2_K").quality).toBe(2);
	});

	test("F16 is full quality with quality 5", () => {
		expect(friendlyQuant("F16").quality).toBe(5);
	});

	test("null quant is Custom with null quality", () => {
		const info = friendlyQuant(null);
		expect(info.label).toBe("Custom");
		expect(info.quality).toBeNull();
	});

	test("unknown label passes through with null quality", () => {
		const info = friendlyQuant("ZZZ");
		expect(info.label).toBe("ZZZ");
		expect(info.quality).toBeNull();
	});
});

describe("quantVariantRank", () => {
	test("_K_M is the most canonical (0)", () => {
		expect(quantVariantRank("Q4_K_M")).toBe(0);
	});

	test("_K_S ranks after _K_M", () => {
		expect(quantVariantRank("Q5_K_S")).toBe(1);
	});

	test("_0 suffix ranks at 4", () => {
		expect(quantVariantRank("Q8_0")).toBe(4);
	});

	test("null sorts last (99)", () => {
		expect(quantVariantRank(null)).toBe(99);
	});

	test("unrecognized suffix sorts at 10", () => {
		expect(quantVariantRank("Q4_WEIRD")).toBe(10);
	});
});

describe("ggufFileRole", () => {
	test("mmproj file is a Vision adapter", () => {
		expect(ggufFileRole("model-mmproj-f16.gguf")?.label).toBe("Vision adapter");
	});

	test("mtp file is a Draft head", () => {
		expect(ggufFileRole("model-mtp.gguf")?.label).toBe("Draft head (MTP)");
	});

	test("draft file is a Draft model", () => {
		expect(ggufFileRole("model-draft.gguf")?.label).toBe("Draft model");
	});

	test("ordinary quant file has no auxiliary role", () => {
		expect(ggufFileRole("model-Q4_K_M.gguf")).toBeNull();
	});
});

describe("titleCase", () => {
	test("replaces separators and title-cases words", () => {
		expect(titleCase("hello-world_again")).toBe("Hello World Again");
	});

	test("upper-cases short acronym segments", () => {
		expect(titleCase("ai-tool")).toBe("AI Tool");
	});

	test("falls back to raw when nothing survives segmentation", () => {
		expect(titleCase("")).toBe("");
	});
});

describe("skillOrg", () => {
	const card = (source: string, id: string): SkillCard => ({
		id,
		installed: false,
		installs: 0,
		name: "x",
		slug: "x",
		source,
	});

	test("takes the owner segment from the source", () => {
		expect(skillOrg(card("acme/repo/slug", "id"))).toBe("acme");
	});

	test("falls back to the id when source is empty", () => {
		expect(skillOrg(card("", "owner/thing"))).toBe("owner");
	});
});

describe("parsePipelineModalities", () => {
	test("fixed tag: text-generation is text -> text", () => {
		expect(parsePipelineModalities("text-generation")).toEqual({
			inputs: ["text"],
			outputs: ["text"],
		});
	});

	test("dynamic <in>-to-<out> shape: image-to-text", () => {
		expect(parsePipelineModalities("image-to-text")).toEqual({
			inputs: ["image"],
			outputs: ["text"],
		});
	});

	test("'any-to-any' expands to every modality on both sides", () => {
		const flow = parsePipelineModalities("any-to-any");
		expect(flow?.inputs).toEqual(["text", "image", "pdf", "video", "audio"]);
		expect(flow?.outputs).toEqual(["text", "image", "pdf", "video", "audio"]);
	});

	test("null tag yields null", () => {
		expect(parsePipelineModalities(null)).toBeNull();
	});

	test("unrecognized tag yields null", () => {
		expect(parsePipelineModalities("totally-unknown")).toBeNull();
	});
});
