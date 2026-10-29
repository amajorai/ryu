import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataUIPart, UIDataTypes, UIMessage } from "ai";
import { deriveContextUsage } from "./context-usage.tsx";
import {
	formatCacheCountdown,
	modelDefaultCacheWarning,
	modelSwitchCacheWarning,
	promptCacheHitRate,
	promptCachePolicy,
	promptCacheStatus,
	promptEditCacheWarning,
} from "./prompt-cache.ts";

const OBSERVED_AT = 1_800_000_000_000;

function assistantMessage(
	type: DataUIPart<UIDataTypes>["type"],
	data: DataUIPart<UIDataTypes>["data"]
): UIMessage {
	return { id: "assistant-1", role: "assistant", parts: [{ type, data }] };
}

describe("promptCachePolicy", () => {
	test("maps provider families to their published cache lifetimes", () => {
		expect(promptCachePolicy("claude-sonnet-4-5")?.provider).toBe("Anthropic");
		expect(promptCachePolicy("us.anthropic.claude-opus-4-1")?.provider).toBe(
			"Anthropic"
		);
		expect(promptCachePolicy("sonnet[1m]")?.provider).toBe("Anthropic");
		expect(promptCachePolicy("openai/gpt-5.1")?.provider).toBe("OpenAI");
		expect(promptCachePolicy("o4-mini")?.provider).toBe("OpenAI");
		expect(promptCachePolicy("google/gemini-2.5-pro")?.kind).toBe("managed");
		expect(promptCachePolicy("deepseek-chat")?.provider).toBe("DeepSeek");
	});

	test("uses each provider's published default lifetime", () => {
		expect(promptCachePolicy("claude-opus-5-5")).toMatchObject({
			kind: "timed",
			ttlMs: 5 * 60_000,
		});
		expect(promptCachePolicy("gpt-5.6")).toMatchObject({
			kind: "timed",
			ttlMs: 30 * 60_000,
		});
	});

	test("does not claim a lifetime for open-weight or unknown models", () => {
		expect(promptCachePolicy("gpt-oss-120b")).toBeUndefined();
		expect(promptCachePolicy("qwen3-coder")).toBeUndefined();
		expect(promptCachePolicy("llama-3.3-70b")).toBeUndefined();
	});

	test("falls back to the provider or agent hint for ambiguous ids", () => {
		expect(promptCachePolicy("default", "claude-code")?.provider).toBe(
			"Anthropic"
		);
		expect(promptCachePolicy(null, "codex")?.provider).toBe("OpenAI");
	});
});

describe("promptCacheStatus", () => {
	const usage = {
		used: 12_000,
		total: 200_000,
		promptTokens: 10_000,
		cacheReadTokens: 8000,
		cacheWriteTokens: 1000,
		model: "claude-sonnet-4-5",
		observedAt: OBSERVED_AT,
	};

	test("reports the hit rate over total input", () => {
		expect(promptCacheHitRate(usage)).toBe(0.8);
	});

	test("counts down from the last turn against the default TTL", () => {
		const status = promptCacheStatus(usage, OBSERVED_AT + 60_000);
		expect(status?.state).toBe("warm");
		expect(status?.remainingMs).toBe(4 * 60_000);
		expect(promptCacheStatus(usage, OBSERVED_AT + 5 * 60_000)?.state).toBe(
			"expired"
		);
	});

	test("is active while the reporting turn streams", () => {
		expect(
			promptCacheStatus({ ...usage, inFlight: true }, OBSERVED_AT)?.state
		).toBe("active");
	});

	test("says nothing when the provider reported no cache counters", () => {
		expect(
			promptCacheStatus({ used: 10, total: 100, promptTokens: 10 }, 0)
		).toBeNull();
	});

	test("does not invent an expiry for providers that publish none", () => {
		expect(
			promptCacheStatus({ ...usage, model: "gemini-2.5-pro" }, OBSERVED_AT)
				?.state
		).toBe("unknown");
	});

	test("reports an idle cache when the turn read and wrote nothing", () => {
		expect(
			promptCacheStatus(
				{ ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
				OBSERVED_AT
			)?.state
		).toBe("unused");
	});
});

describe("modelSwitchCacheWarning", () => {
	const usage = {
		used: 52_000,
		total: 200_000,
		promptTokens: 48_000,
		cacheReadTokens: 40_000,
		cacheWriteTokens: 2000,
		model: "claude-sonnet-4-5",
		observedAt: OBSERVED_AT,
	};

	test("warns while the cache is warm and names what is re-sent", () => {
		const warning = modelSwitchCacheWarning(
			usage,
			"GPT-5.1",
			OBSERVED_AT + 30_000
		);
		expect(warning?.title).toBe("Switching to GPT-5.1 resets the prompt cache");
		expect(warning?.description).toContain("48,000 tokens");
		expect(warning?.description).toContain("warm for 4:30");
	});

	test("stays quiet once the cache has expired or with no history", () => {
		expect(
			modelSwitchCacheWarning(usage, "GPT-5.1", OBSERVED_AT + 6 * 60_000)
		).toBeNull();
		expect(modelSwitchCacheWarning(null, "GPT-5.1", 0)).toBeNull();
	});
});

describe("promptEditCacheWarning", () => {
	test("nothing changed means no confirmation", () => {
		expect(promptEditCacheWarning([], "project")).toBeNull();
		expect(promptEditCacheWarning(["  "], "bot")).toBeNull();
	});

	test("names the fields and how far the miss reaches", () => {
		const warning = promptEditCacheWarning(
			["The project goal", "brief replies"],
			"project"
		);
		expect(warning?.title).toContain("prompt cache");
		expect(warning?.description).toContain(
			"The project goal and brief replies are part of the system prompt for every thread in this project"
		);
		expect(
			promptEditCacheWarning(["The goal"], "bot-in-project")?.description
		).toContain(
			"The goal is part of the system prompt for this bot's threads in this project"
		);
	});

	test("a plural label takes a plural verb", () => {
		expect(
			promptEditCacheWarning(["The project instructions"], "project")
				?.description
		).toContain("The project instructions are part of the system prompt");
		expect(
			promptEditCacheWarning(["The Alpha skill"], "skill-threads")?.description
		).toContain("The Alpha skill is part of");
	});

	test("names the node-wide reaches", () => {
		expect(
			promptEditCacheWarning(["About you"], "all-threads")?.description
		).toContain("for every thread on this node");
		expect(
			promptEditCacheWarning(["The response mode"], "ryu-agent")?.description
		).toContain("for every Ryu assistant thread");
		expect(
			promptEditCacheWarning(["The enabled skills"], "skill-threads")
				?.description
		).toContain("for every thread that loads skills");
	});
});

describe("modelDefaultCacheWarning", () => {
	const before = { model: "claude-x", provider: "anthropic" };

	test("effort-only edits keep the cache", () => {
		expect(modelDefaultCacheWarning("Atlas", before, { ...before })).toBeNull();
	});

	test("a model change warns about every inheriting thread", () => {
		expect(
			modelDefaultCacheWarning("Atlas", before, { ...before, model: "gpt-y" })
				?.description
		).toContain("Every thread that inherits Atlas switches model");
	});
});

describe("deriveContextUsage cache identity", () => {
	test("reads the serving model, timestamp and liveness from the part", () => {
		const usage = deriveContextUsage(
			[
				assistantMessage("data-acp-usage", {
					done: false,
					used: 1200,
					total: 32_000,
					promptTokens: 1000,
					cachedReadTokens: 700,
					thoughtTokens: 40,
					historyModelId: "claude-opus-4-1",
					observedAt: OBSERVED_AT,
				}),
			],
			undefined,
			{ model: "gpt-5.1", provider: "codex" }
		);
		expect(usage?.model).toBe("claude-opus-4-1");
		expect(usage?.provider).toBe("codex");
		expect(usage?.observedAt).toBe(OBSERVED_AT);
		expect(usage?.inFlight).toBe(true);
		expect(usage?.reasoningTokens).toBe(40);
	});

	test("falls back to the caller's model hint", () => {
		const usage = deriveContextUsage(
			[
				assistantMessage("data-ryu-stats", {
					promptTokens: 100,
					completionTokens: 10,
				}),
			],
			1000,
			{ model: "gpt-5.1" }
		);
		expect(usage?.model).toBe("gpt-5.1");
		expect(usage?.inFlight).toBe(false);
	});
});

describe("formatCacheCountdown", () => {
	test("renders minutes and zero-padded seconds", () => {
		expect(formatCacheCountdown(272_000)).toBe("4:32");
		expect(formatCacheCountdown(-5)).toBe("0:00");
	});
});

// agent-elements → desktop → src → blocks → packages → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const CORE_WARMTH_PATH =
	"apps/core/src/sidecar/adapters/prompt_cache_warmth.rs";

function coreWarmthSource(): string {
	const path = join(REPO_ROOT, CORE_WARMTH_PATH);
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(
			`parity test cannot read ${CORE_WARMTH_PATH} (resolved ${path}): ${error instanceof Error ? error.message : error}`
		);
	}
}

/** The `{ ... }` body of the first Rust item whose header is `header`. */
function rustItemBody(source: string, header: string): string {
	const start = source.indexOf(header);
	if (start < 0) {
		throw new Error(
			`parity test anchor lost its target: \`${header}\` is no longer in ${CORE_WARMTH_PATH}; re-point the anchor and re-check prompt-cache.ts against whatever replaced it`
		);
	}
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; open >= 0 && index < source.length; index++) {
		if (source[index] === "{") {
			depth++;
		} else if (source[index] === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(open, index + 1);
			}
		}
	}
	throw new Error(
		`parity test found \`${header}\` in ${CORE_WARMTH_PATH} but no closed body`
	);
}

// Core `CacheFamily` variant → the `provider` label of the desktop policy.
const PROVIDER_BY_CORE_FAMILY: Readonly<Record<string, string>> = {
	Anthropic: "Anthropic",
	OpenAi: "OpenAI",
	Google: "Google",
	DeepSeek: "DeepSeek",
	Xai: "xAI",
};

function coreFamilyVariants(source: string): string[] {
	const body = rustItemBody(source, "pub enum CacheFamily");
	return [...body.matchAll(/^\s*(\w+),?\s*$/gm)].map((match) => match[1] ?? "");
}

/** `default_ttl` arms: variant → minutes, or `null` for "no published expiry". */
function coreDefaultTtls(source: string): Map<string, number | null> {
	const body = rustItemBody(source, "pub fn default_ttl(self)");
	const ttls = new Map<string, number | null>();
	for (const arm of body.matchAll(
		/((?:Self::\w+\s*\|\s*)*Self::\w+)\s*=>\s*(None|Some\((\d+) \* MINUTE\))/g
	)) {
		const minutes = arm[3] === undefined ? null : Number(arm[3]);
		for (const variant of (arm[1] ?? "").matchAll(/Self::(\w+)/g)) {
			ttls.set(variant[1] ?? "", minutes);
		}
	}
	return ttls;
}

/** Every classification assert in Core's family test: [model, hint, provider]. */
function coreFamilyCases(
	source: string
): [string | undefined, string | undefined, string | undefined][] {
	const body = rustItemBody(
		source,
		"fn families_follow_the_model_then_the_provider_hint()"
	);
	const expected = String.raw`(?:Some\(CacheFamily::(\w+)\)|None)`;
	const cases: [string | undefined, string | undefined, string | undefined][] =
		[];
	for (const match of body.matchAll(
		new RegExp(String.raw`\bfamily\("([^"]*)"\),\s*${expected}`, "g")
	)) {
		cases.push([match[1], undefined, match[2]]);
	}
	const argument = String.raw`(?:Some\("([^"]*)"\)|None)`;
	for (const match of body.matchAll(
		new RegExp(
			String.raw`\bcache_family\(\s*${argument},\s*${argument}\s*\),\s*${expected}`,
			"g"
		)
	)) {
		cases.push([match[1], match[2], match[3]]);
	}
	const assertCount = body.match(/assert_eq!/g)?.length ?? 0;
	if (cases.length === 0 || cases.length !== assertCount) {
		throw new Error(
			`parity test parsed ${cases.length} of ${assertCount} asserts in families_follow_the_model_then_the_provider_hint (${CORE_WARMTH_PATH}); update the parser`
		);
	}
	return cases;
}

describe("Core parity", () => {
	const source = coreWarmthSource();
	const variants = coreFamilyVariants(source);
	const ttls = coreDefaultTtls(source);
	const cases = coreFamilyCases(source);

	test("every Core family has a desktop provider and a default_ttl arm", () => {
		expect(variants.length).toBeGreaterThan(0);
		expect([...variants].sort()).toEqual(
			Object.keys(PROVIDER_BY_CORE_FAMILY).sort()
		);
		expect([...ttls.keys()].sort()).toEqual([...variants].sort());
	});

	test.each(
		variants
	)("the %s policy matches Core's default_ttl arm", (variant) => {
		const model = cases.find(([, , family]) => family === variant)?.[0];
		if (model === undefined) {
			throw new Error(
				`families_follow_the_model_then_the_provider_hint has no model-only case for CacheFamily::${variant}`
			);
		}
		const policy = promptCachePolicy(model);
		expect(policy?.provider).toBe(PROVIDER_BY_CORE_FAMILY[variant]);
		const minutes = ttls.get(variant);
		if (minutes === null || minutes === undefined) {
			expect(policy?.kind).toBe("managed");
		} else {
			expect(policy).toMatchObject({ kind: "timed", ttlMs: minutes * 60_000 });
		}
	});

	test("parses Core's classification asserts", () => {
		expect(cases).toContainEqual(["google/gemma-3", undefined, "Google"]);
		expect(cases).toContainEqual([undefined, undefined, undefined]);
	});

	test.each(
		cases
	)("classifies %p (hint %p) as Core's %p", (model, provider, family) => {
		expect(promptCachePolicy(model, provider)?.provider).toBe(
			family === undefined ? undefined : PROVIDER_BY_CORE_FAMILY[family]
		);
	});
});
