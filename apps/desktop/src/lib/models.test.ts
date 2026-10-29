// apps/desktop/src/lib/models.test.ts
//
// Tests for the composer model picker's resolution: which model list an agent
// shows, and the per-agent "last picked" persistence. `modelsForAgent` has a
// precedence ladder — Core-served catalog > bundled offline fallback > the
// agent's own bound model > a generic "Auto" — and the engine is resolved from
// the id ("acp:claude" → "claude") or the agent row. A wrong branch here shows
// the user the wrong models for their engine.
//
// A real DOM (localStorage) is required for the persistence half; register
// happy-dom before importing.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// `isRegistered` is the registrator's OWN state, and it is the only thing
// `register()` actually checks before throwing. The previous guard tested
// `globalThis.window`, which is a different question: bun runs every file in this
// package in ONE process, so the registrator module — and its private
// `#registered` flag — is shared across files while `globalThis.window` is not a
// reliable proxy for it. The result was "Happy DOM has already been globally
// registered" thrown from whichever file happened to be evaluated second,
// failing 25 tests across 9 files that all pass individually.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { getAgentModel, modelsForAgent, setAgentModel } from "./models.ts";

const agent = (over: Partial<AgentSummary>) => ({
	builtIn: false,
	engine: null,
	id: "custom-1",
	model: null,
	...over,
});

beforeEach(() => {
	localStorage.clear();
});

describe("modelsForAgent — engine resolution", () => {
	test("resolves an acp: id to its engine and returns the offline fallback", () => {
		const models = modelsForAgent("acp:claude", []);
		expect(models.map((m) => m.id)).toEqual([
			"opus",
			"sonnet",
			"fable",
			"haiku",
		]);
	});

	test("resolves a custom agent's acp: engine binding", () => {
		const agents = [agent({ id: "my-codex", engine: "acp:codex" })];
		const models = modelsForAgent("my-codex", agents);
		expect(models[0]?.id).toBe("gpt-5.1-codex-max");
	});

	test("treats a built-in agent's own id as the engine", () => {
		const agents = [agent({ id: "gemini", builtIn: true, engine: null })];
		expect(modelsForAgent("gemini", agents).map((m) => m.id)).toEqual([
			"gemini-2.5-pro",
			"gemini-2.5-flash",
		]);
	});
});

describe("modelsForAgent — precedence ladder", () => {
	test("reads only owned engine rows while retaining valid future engine names", () => {
		for (const engine of ["constructor", "__proto__", "toString"]) {
			expect(modelsForAgent(engine, [], {})).toEqual([
				{ id: "auto", name: "Auto" },
			]);
		}
		const futureOptions = [{ id: "future-model", name: "Future model" }];
		expect(
			modelsForAgent("constructor", [], { constructor: futureOptions })
		).toBe(futureOptions);
	});

	test("prefers a non-empty Core catalog over the offline fallback", () => {
		const catalog = { claude: [{ id: "opus-4.8", name: "Opus 4.8" }] };
		const models = modelsForAgent("acp:claude", [], catalog);
		expect(models).toEqual([{ id: "opus-4.8", name: "Opus 4.8" }]);
	});

	test("falls through an empty catalog entry to the offline fallback", () => {
		const models = modelsForAgent("acp:claude", [], { claude: [] });
		expect(models[0]?.id).toBe("opus");
	});

	test("falls back to the agent's own bound model for an unknown engine", () => {
		const agents = [
			agent({ id: "weird", engine: "nonesuch", model: "mystery-1" }),
		];
		expect(modelsForAgent("weird", agents)).toEqual([
			{ id: "mystery-1", name: "mystery-1" },
		]);
	});

	test("returns a generic Auto entry when nothing else resolves", () => {
		expect(modelsForAgent(null, [])).toEqual([{ id: "auto", name: "Auto" }]);
		// An agent id not in the list, with no acp: prefix, resolves engine to the
		// id itself, which has no fallback and no matching agent row → Auto.
		expect(modelsForAgent("ghost-agent", [])).toEqual([
			{ id: "auto", name: "Auto" },
		]);
	});
});

describe("agent model persistence", () => {
	test("retains unknown stored rows and own prototype metadata while adding a model choice", () => {
		const stored =
			'{"agent-a":"model-a","future":{"__proto__":{"retained":true},"revision":2},"bad-choice":false,"__proto__":{"stored":true}}';
		localStorage.setItem("ryu_agent_model_selection", stored);
		expect(getAgentModel("bad-choice")).toBeNull();
		expect(getAgentModel("agent-a")).toBe("model-a");
		expect(localStorage.getItem("ryu_agent_model_selection")).toBe(stored);
		setAgentModel("agent-b", "model-b");
		expect(
			JSON.parse(localStorage.getItem("ryu_agent_model_selection") ?? "null")
		).toEqual({ ...JSON.parse(stored), "agent-b": "model-b" });
		expect(getAgentModel("agent-b")).toBe("model-b");
	});

	test("keeps old array snapshots and their unrelated unsupported entries on update", () => {
		localStorage.setItem(
			"ryu_agent_model_selection",
			'["first",{"future":true},null]'
		);
		expect(getAgentModel("0")).toBe("first");
		expect(getAgentModel("1")).toBeNull();
		setAgentModel("0", "replacement");
		expect(localStorage.getItem("ryu_agent_model_selection")).toBe(
			'["replacement",{"future":true},null]'
		);
	});

	test("retains unsupported scalar snapshots instead of overwriting them when a choice is saved", () => {
		for (const stored of ["null", "false", "42", '"future snapshot"']) {
			localStorage.setItem("ryu_agent_model_selection", stored);
			expect(getAgentModel("agent-a")).toBeNull();
			expect(() => setAgentModel("agent-a", "model-a")).toThrow();
			expect(localStorage.getItem("ryu_agent_model_selection")).toBe(stored);
		}
	});
	test("round-trips a per-agent model selection", () => {
		setAgentModel("agent-a", "opus");
		expect(getAgentModel("agent-a")).toBe("opus");
	});

	test("keeps selections isolated per agent and returns null when unset", () => {
		setAgentModel("agent-a", "opus");
		expect(getAgentModel("agent-b")).toBeNull();
		expect(getAgentModel(null)).toBeNull();
	});

	test("recovers null from a corrupt selections blob", () => {
		localStorage.setItem("ryu_agent_model_selection", "not-json");
		expect(getAgentModel("agent-a")).toBeNull();
	});
});
