import { describe, expect, it } from "bun:test";
import {
	type AcpConfigOption,
	type AcpSelectionStore,
	type AcpSessionConfig,
	buildConfigOptionSection,
	buildModelSection,
	deriveVisibleAcpOptions,
	flattenConfigOptions,
	formatAcpOptionLabel,
	isApprovalConfigOption,
	isBooleanConfigOption,
	isReasoningOption,
	mergeStreamedConfig,
	modelsDuplicateEffortLevels,
	persistStreamedConfig,
	seedAcpSelections,
	selectSimpleApprovalValue,
	shouldAdoptStreamedConfig,
} from "./composer-acp-sections.ts";

// An in-memory stand-in for each surface's localStorage-backed persistence, so
// the state machine's per-agent isolation is assertable without a DOM.
function fakeStore(): AcpSelectionStore & {
	config: Record<string, Record<string, string>>;
	mode: Record<string, string>;
	model: Record<string, string>;
} {
	const mode: Record<string, string> = {};
	const model: Record<string, string> = {};
	const config: Record<string, Record<string, string>> = {};
	return {
		mode,
		model,
		config,
		getAcpMode: (agentId) => (agentId ? (mode[agentId] ?? null) : null),
		getAcpModel: (agentId) => (agentId ? (model[agentId] ?? null) : null),
		getAcpConfig: (agentId) => (agentId ? (config[agentId] ?? {}) : {}),
		setAcpMode: (agentId, modeId) => {
			mode[agentId] = modeId;
		},
		setAcpModel: (agentId, modelId) => {
			model[agentId] = modelId;
		},
		setAcpConfigValue: (agentId, configId, valueId) => {
			config[agentId] = { ...config[agentId], [configId]: valueId };
		},
	};
}

function option(partial: Partial<AcpConfigOption> & { id: string }) {
	return { name: partial.id, ...partial } satisfies AcpConfigOption;
}

describe("flattenConfigOptions", () => {
	it("returns an empty list for a missing or empty option set", () => {
		expect(flattenConfigOptions(option({ id: "a" }))).toEqual([]);
		expect(flattenConfigOptions(option({ id: "a", options: [] }))).toEqual([]);
	});

	it("passes an ungrouped list through", () => {
		const opts = [
			{ value: "low", name: "Low" },
			{ value: "high", name: "High" },
		];
		expect(flattenConfigOptions(option({ id: "a", options: opts }))).toEqual(
			opts
		);
	});

	it("flattens the grouped form", () => {
		expect(
			flattenConfigOptions(
				option({
					id: "a",
					options: [
						{ options: [{ value: "1", name: "One" }] },
						{ options: [{ value: "2", name: "Two" }] },
					],
				})
			)
		).toEqual([
			{ value: "1", name: "One" },
			{ value: "2", name: "Two" },
		]);
	});
});

describe("formatAcpOptionLabel", () => {
	it("strips a redundant option-name prefix and capitalizes", () => {
		expect(formatAcpOptionLabel("Thinking", "Thinking: off")).toBe("Off");
	});

	it("matches the prefix case-insensitively", () => {
		expect(formatAcpOptionLabel("Thinking", "thinking: high")).toBe("High");
	});

	it("leaves an unprefixed value alone but still capitalizes", () => {
		expect(formatAcpOptionLabel("Thinking", "medium")).toBe("Medium");
	});

	it("returns an empty label unchanged rather than throwing", () => {
		expect(formatAcpOptionLabel("Thinking", "Thinking:")).toBe("");
		expect(formatAcpOptionLabel("Thinking", "   ")).toBe("");
	});
});

describe("isApprovalConfigOption", () => {
	it("classifies the mode category", () => {
		expect(isApprovalConfigOption(option({ id: "x", category: "mode" }))).toBe(
			true
		);
	});

	it.each([
		"approval",
		"permission",
		"sandbox",
		"access",
	])("classifies %p in the id/name", (word) => {
		expect(isApprovalConfigOption(option({ id: `cfg.${word}` }))).toBe(true);
		expect(
			isApprovalConfigOption(option({ id: "cfg", name: `Tool ${word}` }))
		).toBe(true);
	});

	it("leaves an unrelated option plain", () => {
		expect(
			isApprovalConfigOption(option({ id: "verbosity", name: "Verbosity" }))
		).toBe(false);
	});
});

describe("selectSimpleApprovalValue", () => {
	it("prefers an advertised Auto preset", () => {
		expect(
			selectSimpleApprovalValue([
				{ id: "default", name: "Ask for approval" },
				{ id: "auto", name: "Auto" },
				{ id: "full", name: "Full access" },
			])
		).toBe("auto");
	});

	it("falls back to an explicit approval choice", () => {
		expect(
			selectSimpleApprovalValue([
				{ id: "plan", name: "Plan" },
				{ id: "manual", name: "Manual" },
				{ id: "bypass", name: "Bypass permissions" },
			])
		).toBe("manual");
	});

	it("uses Ask for approval when Auto is unavailable", () => {
		expect(
			selectSimpleApprovalValue([
				{ id: "plan", name: "Plan" },
				{ id: "default", name: "Ask for approval" },
				{ id: "bypass", name: "Bypass permissions" },
			])
		).toBe("default");
	});

	it("does not guess a permissive mode", () => {
		expect(
			selectSimpleApprovalValue([
				{ id: "acceptEdits", name: "Accept edits" },
				{ id: "bypassPermissions", name: "Bypass permissions" },
			])
		).toBeNull();
	});
});

describe("isReasoningOption", () => {
	it.each([
		"thought",
		"reason",
		"think",
		"effort",
	])("classifies %p anywhere in category/id/name", (word) => {
		expect(isReasoningOption(option({ id: `cfg.${word}` }))).toBe(true);
		expect(isReasoningOption(option({ id: "cfg", category: word }))).toBe(true);
	});

	it("leaves an unrelated option alone", () => {
		expect(
			isReasoningOption(option({ id: "ryu.plan", name: "Plan mode" }))
		).toBe(false);
	});

	// Captured verbatim from opencode 1.18.5 over ACP (`session/set_config_option`
	// response, after selecting a model that has effort levels). Pinned because
	// that agent was reported as having no effort selector: the classifier was
	// never the gap — the option simply never reached it, since opencode omits it
	// from `session/new` until a model with effort levels is applied.
	it("classifies opencode's effort option, and renders it as the slider", () => {
		const openCodeEffort = {
			id: "effort",
			name: "Effort",
			description: "Available effort levels for this model",
			category: "thought_level",
			type: "select",
			currentValue: "low",
			options: [
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
				{ value: "xhigh", name: "Xhigh" },
			],
		};
		expect(isReasoningOption(openCodeEffort)).toBe(true);
		const section = buildConfigOptionSection(
			openCodeEffort,
			{},
			() => undefined
		);
		expect(section.variant).toBe("slider");
		expect(section.items.map((i) => i.id)).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(section.value).toBe("low");
	});
});

describe("buildConfigOptionSection", () => {
	const thinking = option({
		id: "thought_level",
		name: "Thinking",
		currentValue: "low",
		options: [
			{ value: "low", name: "Thinking: low" },
			{ value: "high", name: "Thinking: high" },
		],
	});

	it("keys, labels and formats the rows", () => {
		const section = buildConfigOptionSection(thinking, {}, () => undefined);
		expect(section.key).toBe("cfg-thought_level");
		expect(section.label).toBe("Thinking");
		expect(section.items.map((i) => i.name)).toEqual(["Low", "High"]);
	});

	it("prefers a live selection over the agent's currentValue", () => {
		expect(buildConfigOptionSection(thinking, {}, () => undefined).value).toBe(
			"low"
		);
		expect(
			buildConfigOptionSection(
				thinking,
				{ thought_level: "high" },
				() => undefined
			).value
		).toBe("high");
	});

	it("reports the option id alongside the picked value", () => {
		const seen: string[] = [];
		const section = buildConfigOptionSection(
			thinking,
			{},
			(configId, valueId) => seen.push(`${configId}=${valueId}`)
		);
		section.onChange("high");
		expect(seen).toEqual(["thought_level=high"]);
	});

	it("decorates approval-ish options only", () => {
		expect(
			buildConfigOptionSection(thinking, {}, () => undefined).decorate
		).toBeUndefined();
		expect(
			buildConfigOptionSection(
				option({ id: "approval_policy", category: "mode" }),
				{},
				() => undefined
			).decorate
		).toBeDefined();
	});
});

describe("buildModelSection", () => {
	const base = {
		acpModelConfigOption: undefined,
		acpOptionValues: {},
		acpSessionConfig: null,
		activeAgentIsAcp: false,
		effectiveAcpModel: null,
		engineModel: null,
		filterModelItems: (items: { id: string; name: string }[]) => items,
		hasDedicatedAcpModels: false,
		modelDisplayName: (raw: string) => raw,
		modelOptions: [],
		onAcpModelChange: () => undefined,
		onAcpOptionChange: () => undefined,
		onEngineModelChange: () => undefined,
	};

	it("prefers the dedicated ACP model set", () => {
		const section = buildModelSection({
			...base,
			hasDedicatedAcpModels: true,
			effectiveAcpModel: "opus",
			acpSessionConfig: {
				configOptions: null,
				modes: null,
				models: {
					currentModelId: "opus",
					availableModels: [{ modelId: "opus", name: "Opus" }],
				},
			},
		});
		expect(section.items).toEqual([{ id: "opus", name: "Opus" }]);
		expect(section.value).toBe("opus");
	});

	it("falls back to a category:model config option", () => {
		const section = buildModelSection({
			...base,
			activeAgentIsAcp: true,
			acpModelConfigOption: option({
				id: "model",
				category: "model",
				currentValue: "gpt-5",
				options: [{ value: "gpt-5", name: "GPT-5" }],
			}),
		});
		expect(section.value).toBe("gpt-5");
		expect(section.items).toEqual([
			{ id: "gpt-5", name: "GPT-5", description: undefined },
		]);
	});

	it.each([
		true,
		false,
	])("ignores boolean %s as an advertised current model but accepts a real text model choice", (reported) => {
		const filteredCurrent: (string | null | undefined)[] = [];
		const changes: [string, string][] = [];
		const section = buildModelSection({
			...base,
			activeAgentIsAcp: true,
			acpModelConfigOption: option({
				id: "model",
				category: "model",
				currentValue: reported,
				options: [{ value: "gpt-5", name: "GPT-5" }],
			}),
			filterModelItems: (items, current) => {
				filteredCurrent.push(current);
				return items;
			},
			onAcpOptionChange: (configId, valueId) => {
				changes.push([configId, valueId]);
			},
		});
		expect(filteredCurrent).toEqual([undefined]);
		expect(section.value).toBeUndefined();
		expect(section.items).toEqual([
			{ id: "gpt-5", name: "GPT-5", description: undefined },
		]);
		expect(changes).toEqual([]);
		section.onChange("gpt-5");
		expect(changes).toEqual([["model", "gpt-5"]]);
	});

	it("preserves a saved textual model over a boolean report and the literal text model false", () => {
		const section = buildModelSection({
			...base,
			activeAgentIsAcp: true,
			acpOptionValues: { model: "saved" },
			acpModelConfigOption: option({
				id: "model",
				category: "model",
				currentValue: false,
				options: [{ value: "saved", name: "Saved model" }],
			}),
		});
		expect(section.value).toBe("saved");
		const textModel = buildModelSection({
			...base,
			activeAgentIsAcp: true,
			acpModelConfigOption: option({
				id: "model",
				category: "model",
				currentValue: "false",
				options: [{ value: "false", name: "Text model false" }],
			}),
		});
		expect(textModel.value).toBe("false");
		expect(textModel.items).toEqual([
			{ id: "false", name: "Text model false", description: undefined },
		]);
	});

	it("falls back to the engine catalog only for a non-ACP agent", () => {
		const section = buildModelSection({
			...base,
			engineModel: "gemma",
			modelOptions: [{ id: "gemma", name: "Gemma" }],
		});
		expect(section.value).toBe("gemma");
		expect(
			buildModelSection({
				...base,
				activeAgentIsAcp: true,
				engineModel: "gemma",
				modelOptions: [{ id: "gemma", name: "Gemma" }],
			}).items
		).toEqual([]);
	});

	it("applies the display-name map and the per-branch filter", () => {
		const section = buildModelSection({
			...base,
			engineModel: "b",
			modelOptions: [
				{ id: "a", name: "a" },
				{ id: "b", name: "b" },
			],
			modelDisplayName: (raw) => raw.toUpperCase(),
			// A filter that hides everything still has to keep the branch's current
			// selection, or a hidden-but-selected model vanishes from under the user.
			filterModelItems: (items, current) =>
				items.filter((i) => i.id === current),
		});
		expect(section.items).toEqual([{ id: "b", name: "B" }]);
	});
});

describe("deriveVisibleAcpOptions", () => {
	const modes: AcpSessionConfig["modes"] = {
		currentModeId: "low",
		availableModes: [
			{ id: "low", name: "Low" },
			{ id: "high", name: "High" },
		],
	};

	it("hides the modes picker when a category:mode option exists", () => {
		const derived = deriveVisibleAcpOptions(
			{
				modes,
				models: null,
				configOptions: [option({ id: "approval", category: "mode" })],
			},
			false
		);
		expect(derived.hideAcpModesPicker).toBe(true);
	});

	it("hides the modes picker when a config option duplicates its value set", () => {
		const derived = deriveVisibleAcpOptions(
			{
				modes,
				models: null,
				configOptions: [
					option({
						id: "thought_level",
						options: [
							{ value: "high", name: "High" },
							{ value: "low", name: "Low" },
						],
					}),
				],
			},
			false
		);
		expect(derived.hideAcpModesPicker).toBe(true);
	});

	it("keeps the modes picker when nothing supersedes it", () => {
		const derived = deriveVisibleAcpOptions(
			{
				modes,
				models: null,
				configOptions: [
					option({
						id: "verbosity",
						options: [{ value: "terse", name: "Terse" }],
					}),
				],
			},
			false
		);
		expect(derived.hideAcpModesPicker).toBe(false);
	});

	it("routes a category:model option to the Model picker, not its own section", () => {
		const derived = deriveVisibleAcpOptions(
			{
				modes: null,
				models: null,
				configOptions: [option({ id: "model", category: "model" })],
			},
			false
		);
		expect(derived.acpModelConfigOption?.id).toBe("model");
		expect(derived.visibleAcpConfigOptions).toEqual([]);
	});

	it("suppresses the reasoning option only when reasoning is off", () => {
		const config: AcpSessionConfig = {
			modes: null,
			models: null,
			configOptions: [
				option({ id: "thought_level", name: "Thinking" }),
				option({ id: "verbosity", name: "Verbosity" }),
			],
		};
		expect(
			deriveVisibleAcpOptions(config, false).visibleAcpConfigOptions.map(
				(o) => o.id
			)
		).toEqual(["thought_level", "verbosity"]);
		expect(
			deriveVisibleAcpOptions(config, true).visibleAcpConfigOptions.map(
				(o) => o.id
			)
		).toEqual(["verbosity"]);
	});

	it("tolerates an absent config", () => {
		expect(deriveVisibleAcpOptions(null, false)).toEqual({
			acpModelConfigOption: undefined,
			hideAcpModesPicker: false,
			visibleAcpConfigOptions: [],
		});
	});
});

describe("shouldAdoptStreamedConfig", () => {
	const PLAN_OFF = { "ryu.plan": "off" };

	it("adopts the first write-back", () => {
		expect(
			shouldAdoptStreamedConfig({ config: PLAN_OFF, key: "m1:3" }, null)
		).toBe(true);
	});

	it("ignores a re-render of the SAME emission", () => {
		// The producer re-derives a fresh object on every stream chunk; only the
		// emission key stays stable, and that is what must gate adoption.
		expect(
			shouldAdoptStreamedConfig(
				{ config: { ...PLAN_OFF }, key: "m1:3" },
				"m1:3"
			)
		).toBe(false);
	});

	it("adopts a REPEATED, byte-identical config map under a new emission key", () => {
		// The bug this channel exists to fix: `ExitPlanMode` always writes
		// `{"ryu.plan":"off"}`, so a second plan cycle in one conversation re-emits
		// exactly the same pairs. A value-keyed guard swallows it and the Plan mode
		// pill stays armed — the agent then refuses the edits just approved.
		expect(
			shouldAdoptStreamedConfig(
				{ config: { ...PLAN_OFF }, key: "m7:1" },
				"m1:3"
			)
		).toBe(true);
	});

	it("ignores an absent write-back", () => {
		expect(shouldAdoptStreamedConfig(null, null)).toBe(false);
		expect(shouldAdoptStreamedConfig(undefined, "m1:3")).toBe(false);
	});
});

describe("mergeStreamedConfig", () => {
	it("merges over the current selections instead of replacing them", () => {
		// The map also carries every other advertised option; replacing it would
		// silently drop the user's thinking-effort pick.
		expect(
			mergeStreamedConfig(
				{ thought_level: "high", "ryu.plan": "on" },
				{ "ryu.plan": "off" }
			)
		).toEqual({ thought_level: "high", "ryu.plan": "off" });
	});

	it("does not mutate the previous map", () => {
		const prev = { thought_level: "high" };
		mergeStreamedConfig(prev, { "ryu.plan": "off" });
		expect(prev).toEqual({ thought_level: "high" });
	});
});

describe("per-agent isolation", () => {
	it("seeds each agent from its own persisted selections", () => {
		const store = fakeStore();
		store.setAcpMode("pi", "plan");
		store.setAcpModel("pi", "opus");
		store.setAcpConfigValue("pi", "thought_level", "high");
		store.setAcpMode("codex", "read-only");

		expect(seedAcpSelections(store, "pi")).toEqual({
			mode: "plan",
			model: "opus",
			options: { thought_level: "high" },
		});
		expect(seedAcpSelections(store, "codex")).toEqual({
			mode: "read-only",
			model: null,
			options: {},
		});
		expect(seedAcpSelections(store, null)).toEqual({
			mode: null,
			model: null,
			options: {},
		});
	});

	it("writes a streamed config back to the named agent only", () => {
		const store = fakeStore();
		store.setAcpConfigValue("codex", "ryu.plan", "on");
		persistStreamedConfig(store, "pi", { "ryu.plan": "off" });

		expect(store.getAcpConfig("pi")).toEqual({ "ryu.plan": "off" });
		// The agent that was NOT the write-back's target keeps its own pick — the
		// clobber that an agentId-keyed effect dep would reintroduce.
		expect(store.getAcpConfig("codex")).toEqual({ "ryu.plan": "on" });
	});

	it("merges a write-back into an agent's existing selections", () => {
		const store = fakeStore();
		store.setAcpConfigValue("pi", "thought_level", "high");
		persistStreamedConfig(store, "pi", { "ryu.plan": "off" });
		expect(store.getAcpConfig("pi")).toEqual({
			thought_level: "high",
			"ryu.plan": "off",
		});
	});

	it("persists nothing when no agent is selected", () => {
		const store = fakeStore();
		persistStreamedConfig(store, null, { "ryu.plan": "off" });
		expect(store.config).toEqual({});
	});
});

describe("boolean config options (unstable_boolean_config)", () => {
	// A `type: "boolean"` option carries NO `options` array — its entire payload
	// is `currentValue: true|false`. Before this, it flattened to an empty item
	// list and drew a picker with nothing in it.
	const toggle: AcpConfigOption = {
		id: "web_search",
		name: "Web search",
		type: "boolean",
		currentValue: true,
	};

	it("is recognised as a toggle, not a select", () => {
		expect(isBooleanConfigOption(toggle)).toBe(true);
		expect(
			isBooleanConfigOption({ id: "effort", name: "Effort", type: "select" })
		).toBe(false);
	});

	it("renders two rows even though the option advertises none", () => {
		const section = buildConfigOptionSection(toggle, {}, () => {
			// no-op
		});
		expect(section.items.map((i) => i.id)).toEqual(["true", "false"]);
		expect(section.items.map((i) => i.name)).toEqual(["On", "Off"]);
	});

	it("reflects a real JSON boolean as the selected string id", () => {
		// Every layer between here and the wire stores picks as strings, so the
		// section's value has to be the STRING form or nothing looks selected.
		const on = buildConfigOptionSection(toggle, {}, () => {
			// no-op
		});
		expect(on.value).toBe("true");

		const off = buildConfigOptionSection(
			{ ...toggle, currentValue: false },
			{},
			() => {
				// no-op
			}
		);
		expect(off.value).toBe("false");
	});

	it("lets a stored pick override the advertised state", () => {
		const section = buildConfigOptionSection(
			toggle,
			{ web_search: "false" },
			() => {
				// no-op
			}
		);
		expect(section.value).toBe("false");
	});

	it("never renders as a slider", () => {
		// The slider variant is for an ORDERED scale (reasoning effort). Two
		// states are not a scale.
		const section = buildConfigOptionSection(
			{ ...toggle, id: "reasoning", name: "Reasoning" },
			{},
			() => {
				// no-op
			}
		);
		expect(section.variant).toBeUndefined();
	});

	it("survives the visibility filter", () => {
		// The filter drops `category:"model"` and reasoning-when-off. A toggle is
		// neither, so it must reach the composer.
		const { visibleAcpConfigOptions } = deriveVisibleAcpOptions(
			{ configOptions: [toggle], models: null, modes: null },
			false
		);
		expect(visibleAcpConfigOptions).toHaveLength(1);
		const visibleToggle = visibleAcpConfigOptions[0];
		if (!visibleToggle)
			throw new Error("Boolean control did not survive the visibility filter");
		expect(visibleToggle.id).toBe("web_search");
	});
});

// Built from a real `codex-acp` probe capture, not from an assumption about the
// id shape: codex ships 4 base models x 6 effort levels in `availableModels`
// AND a clean 4-item `category:"model"` option beside a `thought_level` one.
const CODEX_BASE_MODELS = [
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4-mini",
];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function codexConfig(): AcpSessionConfig {
	return {
		models: {
			currentModelId: "gpt-5.6-terra[medium]",
			availableModels: CODEX_BASE_MODELS.flatMap((base) =>
				CODEX_EFFORTS.map((effort) => ({
					modelId: `${base}[${effort}]`,
					name: `${base} (${effort})`,
				}))
			),
		},
		modes: null,
		configOptions: [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "gpt-5.6-terra",
				options: CODEX_BASE_MODELS.map((m) => ({ value: m, name: m })),
			},
			{
				id: "reasoning_effort",
				name: "Reasoning effort",
				category: "thought_level",
				type: "select",
				currentValue: "medium",
				options: CODEX_EFFORTS.map((e) => ({ value: e, name: e })),
			},
		],
	};
}

describe("modelsDuplicateEffortLevels", () => {
	it("detects the codex base x effort cross-product", () => {
		expect(modelsDuplicateEffortLevels(codexConfig())).toBe(true);
	});

	it("leaves a plain model list alone", () => {
		const config = codexConfig();
		config.models = {
			currentModelId: "sonnet",
			availableModels: [
				{ modelId: "sonnet", name: "Sonnet" },
				{ modelId: "opus", name: "Opus" },
			],
		};
		expect(modelsDuplicateEffortLevels(config)).toBe(false);
	});

	it("needs an effort option to compare against", () => {
		// Suffixed ids alone prove nothing — without a thought_level option there
		// is no second control to be duplicating.
		const config = codexConfig();
		config.configOptions = (config.configOptions ?? []).filter(
			(o) => o.category !== "thought_level"
		);
		expect(modelsDuplicateEffortLevels(config)).toBe(false);
	});

	it("is strict: ONE unsuffixed model keeps the dedicated list", () => {
		// Safe direction to be wrong in — an agent whose list merely happens to
		// contain a bracketed id must not lose its own model picker.
		const config = codexConfig();
		config.models?.availableModels.push({
			modelId: "gpt-5.6-nova",
			name: "GPT-5.6-Nova",
		});
		expect(modelsDuplicateEffortLevels(config)).toBe(false);
	});

	it("ignores a bracketed suffix that is not an effort level", () => {
		const config = codexConfig();
		config.models = {
			currentModelId: "llama[8b]",
			availableModels: [{ modelId: "llama[8b]", name: "Llama 8B" }],
		};
		expect(modelsDuplicateEffortLevels(config)).toBe(false);
	});

	it("says no when there are no models at all", () => {
		const config = codexConfig();
		config.models = null;
		expect(modelsDuplicateEffortLevels(config)).toBe(false);
		expect(modelsDuplicateEffortLevels(null)).toBe(false);
	});
});
