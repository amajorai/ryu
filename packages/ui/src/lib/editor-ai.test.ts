// Unit tests for the editor AI config registry. Holds module-level state, so
// every test restores the default via a full reset. `setEditorAiConfig`
// partial-merges into the current config — these tests pin that merge behavior.

import { afterEach, describe, expect, test } from "bun:test";
import { getEditorAiConfig, setEditorAiConfig } from "./editor-ai.ts";

// Restore the documented default after each test (the module has no reset fn,
// so we set the fields back explicitly).
afterEach(() => {
	setEditorAiConfig({
		baseUrl: null,
		model: "",
		enabled: false,
		agentId: undefined,
		apiKey: undefined,
		headers: undefined,
	});
});

describe("editor AI config registry", () => {
	test("defaults to disabled with no backend", () => {
		const c = getEditorAiConfig();
		expect(c.baseUrl).toBeNull();
		expect(c.model).toBe("");
		expect(c.enabled).toBe(false);
	});

	test("a partial update merges into the current config, leaving other fields intact", () => {
		setEditorAiConfig({ baseUrl: "http://127.0.0.1:7981/v1", model: "gpt" });
		let c = getEditorAiConfig();
		expect(c.baseUrl).toBe("http://127.0.0.1:7981/v1");
		expect(c.model).toBe("gpt");
		expect(c.enabled).toBe(false);

		// A second partial patch only touches the named field.
		setEditorAiConfig({ enabled: true });
		c = getEditorAiConfig();
		expect(c.enabled).toBe(true);
		expect(c.baseUrl).toBe("http://127.0.0.1:7981/v1");
		expect(c.model).toBe("gpt");
	});

	test("carries the optional routing fields (agentId, apiKey, headers)", () => {
		setEditorAiConfig({
			agentId: "agent-7",
			apiKey: "sk-test",
			headers: { "x-ryu-agent-id": "agent-7" },
		});
		const c = getEditorAiConfig();
		expect(c.agentId).toBe("agent-7");
		expect(c.apiKey).toBe("sk-test");
		expect(c.headers).toEqual({ "x-ryu-agent-id": "agent-7" });
	});
});
