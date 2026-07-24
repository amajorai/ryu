// Unit tests for the pure helpers behind the Models catalog section. These are
// framework-free (no DOM, no network) formatters + filters that power the model
// list cards, the toolbar chips, and the detail header. They are exported from
// the section module and exercised directly here. The security-relevant one is
// `filterModelsByTokens`: it is the defensive org guard that keeps a mirror /
// cached page from leaking an out-of-org model card into an active org view.

import { describe, expect, test } from "bun:test";
import {
	buildModelChips,
	deviceSummaryLines,
	filterModelsByTokens,
	formatAgo,
	formatContext,
	formatCount,
	formatDate,
	formatParams,
} from "./models-catalog-section.tsx";
import type { ModelCard, ModelDetail } from "./types.ts";

function model(over: Partial<ModelCard> = {}): ModelCard {
	return {
		architecture: null,
		author: "acme",
		compatible: true,
		contextLength: null,
		createdAt: null,
		downloads: 0,
		format: "gguf",
		gated: false,
		id: "acme/thing",
		installed: false,
		lastModified: null,
		likes: 0,
		name: "Thing",
		needsEngine: null,
		params: null,
		pipelineTag: null,
		tags: [],
		...over,
	};
}

function device(
	over: Partial<ModelDetail["device"]> = {}
): ModelDetail["device"] {
	return {
		gpuName: null,
		os: "linux",
		ramHuman: "",
		unifiedMemory: false,
		vramBytes: null,
		vramHuman: "",
		...over,
	};
}

describe("filterModelsByTokens", () => {
	test("no org and no active tokens returns every model", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		expect(filterModelsByTokens(models, new Set(), "")).toHaveLength(2);
	});

	test("org guard drops cards whose author is not the active org", () => {
		// Defensive guard: a mirror / cached page must never leak an out-of-org
		// card into an active org view.
		const models = [
			model({ id: "in", author: "google" }),
			model({ id: "out", author: "meta" }),
		];
		const kept = filterModelsByTokens(models, new Set(), "google");
		expect(kept.map((m) => m.id)).toEqual(["in"]);
	});

	test("org match is case- and whitespace-insensitive", () => {
		const models = [model({ author: "Google" })];
		expect(filterModelsByTokens(models, new Set(), "  google  ")).toHaveLength(
			1
		);
	});

	test("an active token keeps only cards carrying that token (AND logic)", () => {
		const models = [
			model({ id: "vl", name: "Qwen-VL-7B" }),
			model({ id: "plain", name: "Qwen-7B" }),
		];
		const kept = filterModelsByTokens(models, new Set(["vision"]), "");
		expect(kept.map((m) => m.id)).toEqual(["vl"]);
	});

	test("multiple active tokens require ALL to be present", () => {
		const both = model({ id: "both", name: "Qwen-VL-Coder-7B" });
		const one = model({ id: "one", name: "Qwen-VL-7B" });
		const kept = filterModelsByTokens(
			[both, one],
			new Set(["vision", "coder"]),
			""
		);
		expect(kept.map((m) => m.id)).toEqual(["both"]);
	});

	test("tokens found only in tags still satisfy the filter", () => {
		const models = [model({ id: "t", name: "Plain", tags: ["vision"] })];
		expect(filterModelsByTokens(models, new Set(["vision"]), "")).toHaveLength(
			1
		);
	});

	test("org guard and token filter compose", () => {
		const models = [
			model({ id: "keep", author: "google", name: "Gemma-VL-4B" }),
			model({ id: "wrong-org", author: "meta", name: "Llama-VL-8B" }),
			model({ id: "wrong-token", author: "google", name: "Gemma-4B" }),
		];
		const kept = filterModelsByTokens(models, new Set(["vision"]), "google");
		expect(kept.map((m) => m.id)).toEqual(["keep"]);
	});
});

describe("buildModelChips", () => {
	test("no org and no tokens yields no chips", () => {
		expect(buildModelChips("", new Set(), () => undefined, () => undefined)).toEqual(
			[]
		);
	});

	test("an org produces a removable Org chip that clears the org", () => {
		const cleared: string[] = [];
		const chips = buildModelChips(
			"google",
			new Set(),
			(o) => cleared.push(o),
			() => undefined
		);
		expect(chips).toHaveLength(1);
		expect(chips[0]?.key).toBe("org:google");
		expect(chips[0]?.label).toBe("Org: google");
		chips[0]?.onRemove();
		expect(cleared).toEqual([""]);
	});

	test("a token chip uses the friendly label and toggles the token off", () => {
		const toggled: string[] = [];
		const chips = buildModelChips(
			"",
			new Set(["vision"]),
			() => undefined,
			(id) => toggled.push(id)
		);
		expect(chips).toHaveLength(1);
		expect(chips[0]?.key).toBe("token:vision");
		expect(chips[0]?.label).toBe("Vision");
		chips[0]?.onRemove();
		expect(toggled).toEqual(["vision"]);
	});

	test("an unknown token id falls back to the raw id as its label", () => {
		const chips = buildModelChips(
			"",
			new Set(["mystery"]),
			() => undefined,
			() => undefined
		);
		expect(chips[0]?.label).toBe("mystery");
	});

	test("org and token chips are emitted together, org first", () => {
		const chips = buildModelChips(
			"acme",
			new Set(["vision"]),
			() => undefined,
			() => undefined
		);
		expect(chips.map((c) => c.key)).toEqual(["org:acme", "token:vision"]);
	});
});

describe("formatAgo", () => {
	test("null yields null", () => {
		expect(formatAgo(null)).toBeNull();
	});

	test("an unparseable date yields null", () => {
		expect(formatAgo("not-a-date")).toBeNull();
	});

	test("a date about a year in the past reads in years", () => {
		const d = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
		expect(formatAgo(d)).toContain("year");
	});

	test("a date minutes in the past reads in minutes", () => {
		const d = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		expect(formatAgo(d)).toContain("minute");
	});

	test("a sub-minute delta falls through to seconds", () => {
		const d = new Date(Date.now() - 5 * 1000).toISOString();
		// Intl 'auto' may render "now"/"seconds"; either way it is non-null and
		// is not measured in a larger unit.
		const out = formatAgo(d);
		expect(out).not.toBeNull();
		expect(out).not.toContain("minute");
	});
});

describe("formatDate", () => {
	test("null yields null", () => {
		expect(formatDate(null)).toBeNull();
	});

	test("an unparseable date yields null", () => {
		expect(formatDate("nope")).toBeNull();
	});

	test("a valid ISO date renders a label containing the year", () => {
		expect(formatDate("2026-06-10T00:00:00Z")).toContain("2026");
	});
});

describe("formatCount", () => {
	test("millions render as N.NM", () => {
		expect(formatCount(1_234_567)).toBe("1.2M");
	});

	test("thousands render as N.Nk", () => {
		expect(formatCount(1500)).toBe("1.5k");
	});

	test("under 1000 renders the raw integer", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(999)).toBe("999");
	});
});

describe("formatContext", () => {
	test("null / zero / negative yield null (omit the chip)", () => {
		expect(formatContext(null)).toBeNull();
		expect(formatContext(0)).toBeNull();
		expect(formatContext(-5)).toBeNull();
	});

	test("a kilo-range window rounds to the nearest K", () => {
		expect(formatContext(32_768)).toBe("32K");
	});

	test("an exact power-of-two mega window renders a whole M", () => {
		expect(formatContext(1_048_576)).toBe("1M");
	});

	test("a non-round mega window keeps one decimal", () => {
		// 1.5 * 1,048,576 = 1,572,864 -> 1.5M
		expect(formatContext(1_572_864)).toBe("1.5M");
	});

	test("a sub-1024 window renders the raw token count", () => {
		expect(formatContext(512)).toBe("512");
	});
});

describe("formatParams", () => {
	test("null / zero yield null", () => {
		expect(formatParams(null)).toBeNull();
		expect(formatParams(0)).toBeNull();
	});

	test("a billion-scale count reads in B with one decimal below 10B", () => {
		expect(formatParams(8_000_000_000)).toBe("8.0B");
	});

	test(">= 10B rounds to a whole B", () => {
		expect(formatParams(70_000_000_000)).toBe("70B");
	});

	test("the 500M boundary flips to B (0.5B)", () => {
		expect(formatParams(500_000_000)).toBe("0.5B");
	});

	test("a mid-million count reads in M", () => {
		expect(formatParams(270_000_000)).toBe("270M");
	});

	test("a sub-million count renders raw", () => {
		expect(formatParams(500_000)).toBe("500000");
	});
});

describe("deviceSummaryLines", () => {
	test("unified memory collapses to a single line", () => {
		expect(
			deviceSummaryLines(device({ unifiedMemory: true, ramHuman: "16 GB" }))
		).toEqual(["16 GB unified memory"]);
	});

	test("discrete GPU lists gpu, vram, and system RAM lines", () => {
		expect(
			deviceSummaryLines(
				device({
					gpuName: "RTX 4090",
					vramHuman: "24 GB",
					ramHuman: "64 GB",
				})
			)
		).toEqual(["RTX 4090", "24 GB GPU RAM", "64 GB system RAM"]);
	});

	test("no hardware details falls back to the OS name", () => {
		expect(deviceSummaryLines(device({ os: "windows" }))).toEqual(["windows"]);
	});

	test("empty everything falls back to 'unknown hardware'", () => {
		expect(deviceSummaryLines(device({ os: "" }))).toEqual([
			"unknown hardware",
		]);
	});

	test("unified memory with no ramHuman falls through to the detail branch", () => {
		// unifiedMemory true but ramHuman empty: the single-line branch is skipped.
		expect(
			deviceSummaryLines(device({ unifiedMemory: true, ramHuman: "" }))
		).toEqual(["linux"]);
	});
});
