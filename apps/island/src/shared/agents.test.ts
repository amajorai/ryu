import { describe, expect, it } from "bun:test";
import {
	agentIdOrUndefined,
	DEFAULT_AGENT_ID,
	DEFAULT_ISLAND_AGENT_PREFS,
	parseIslandAgentPrefs,
} from "./agents.ts";

describe("parseIslandAgentPrefs", () => {
	it("returns the flagship default for null/empty/malformed input", () => {
		expect(parseIslandAgentPrefs(null)).toEqual(DEFAULT_ISLAND_AGENT_PREFS);
		expect(parseIslandAgentPrefs("")).toEqual(DEFAULT_ISLAND_AGENT_PREFS);
		expect(parseIslandAgentPrefs("{bad")).toEqual(DEFAULT_ISLAND_AGENT_PREFS);
		expect(DEFAULT_ISLAND_AGENT_PREFS).toEqual({
			voiceAgent: DEFAULT_AGENT_ID,
			proactiveAgent: DEFAULT_AGENT_ID,
		});
	});

	it("parses both routed agents", () => {
		expect(
			parseIslandAgentPrefs(
				JSON.stringify({ voiceAgent: "coder", proactiveAgent: "researcher" })
			)
		).toEqual({ voiceAgent: "coder", proactiveAgent: "researcher" });
	});

	it("preserves an empty string (Core's default local model) as-is", () => {
		expect(
			parseIslandAgentPrefs(
				JSON.stringify({ voiceAgent: "", proactiveAgent: "" })
			)
		).toEqual({ voiceAgent: "", proactiveAgent: "" });
	});

	it("falls back per-field to the flagship for a non-string value", () => {
		expect(
			parseIslandAgentPrefs(JSON.stringify({ voiceAgent: 42 as unknown }))
		).toEqual({
			voiceAgent: DEFAULT_AGENT_ID,
			proactiveAgent: DEFAULT_AGENT_ID,
		});
	});
});

describe("agentIdOrUndefined", () => {
	it("maps an empty string to undefined and keeps a real id", () => {
		expect(agentIdOrUndefined("")).toBeUndefined();
		expect(agentIdOrUndefined("ryu")).toBe("ryu");
	});
});
