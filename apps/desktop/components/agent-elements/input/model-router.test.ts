import { describe, expect, test } from "bun:test";
import {
	modelMenuItem,
	OPENROUTER_AUTO_MODEL_ID,
	OPENROUTER_PARETO_CODE_MODEL_ID,
	ryuAliasModelName,
} from "./model-router.ts";

describe("modelMenuItem", () => {
	test("labels OpenRouter's general and coding routers", () => {
		expect(modelMenuItem(OPENROUTER_AUTO_MODEL_ID)).toEqual({
			description: "OpenRouter picks a strong model for each task.",
			id: OPENROUTER_AUTO_MODEL_ID,
			name: "Auto Router",
		});
		expect(modelMenuItem(OPENROUTER_PARETO_CODE_MODEL_ID)).toEqual({
			description: "OpenRouter picks a coding model with its Pareto router.",
			id: OPENROUTER_PARETO_CODE_MODEL_ID,
			name: "Auto Code",
		});
	});

	test("keeps a provider-supplied name for discovered models", () => {
		expect(
			modelMenuItem(OPENROUTER_PARETO_CODE_MODEL_ID, "Pareto Code")
		).toEqual({
			description: "OpenRouter picks a coding model with its Pareto router.",
			id: OPENROUTER_PARETO_CODE_MODEL_ID,
			name: "Pareto Code",
		});
	});

	test("falls back to the model id for ordinary models", () => {
		expect(modelMenuItem("anthropic/claude-sonnet-4")).toEqual({
			description: undefined,
			id: "anthropic/claude-sonnet-4",
			name: "anthropic/claude-sonnet-4",
		});
	});

	test("names Ryu managed-tier aliases without the supplier", () => {
		expect(modelMenuItem("ryu-code/max")).toEqual({
			description: undefined,
			id: "ryu-code/max",
			name: "Ryu Code Max",
		});
		expect(ryuAliasModelName("ryu-fast/lite")).toBe("Ryu Fast Lite");
		expect(ryuAliasModelName("ryu-frontier/standard")).toBe(
			"Ryu Frontier Standard"
		);
		expect(ryuAliasModelName("ryu-code/claude-sonnet-4-5")).toBeNull();
		expect(ryuAliasModelName("ryu-unknown/max")).toBeNull();
	});
});
