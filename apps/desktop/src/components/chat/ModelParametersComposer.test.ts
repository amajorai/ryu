import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}

const { chatParameterModel } = await import("./ModelParametersComposer.tsx");

test("an explicit provider pick is a cloud model for that provider", () => {
	expect(
		chatParameterModel({
			engine: "ryu",
			modelId: "claude-sonnet",
			providerId: "anthropic",
		})
	).toEqual({
		id: "claude-sonnet",
		kind: "cloud",
		label: "claude-sonnet",
		provider: "anthropic",
	});
});

test("a local engine binding is a local model on that engine", () => {
	expect(
		chatParameterModel({ engine: "llamacpp", modelId: "qwen3:8b" })
	).toEqual({
		engine: "llamacpp",
		id: "qwen3:8b",
		kind: "local",
		label: "qwen3:8b",
	});
});

test("Ryu's own agent routes its model through the gateway", () => {
	expect(chatParameterModel({ engine: "ryu", modelId: "gpt-5" })?.kind).toBe(
		"cloud"
	);
});

test("external agents and empty selections get no parameters", () => {
	expect(
		chatParameterModel({ engine: "acp:claude-code", modelId: "opus" })
	).toBeNull();
	expect(chatParameterModel({ engine: "llamacpp", modelId: null })).toBeNull();
});
