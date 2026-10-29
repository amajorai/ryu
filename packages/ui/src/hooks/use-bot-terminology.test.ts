import { describe, expect, it } from "bun:test";
import {
	BOT_TERMINOLOGY_STORAGE_KEY,
	DEFAULT_BOT_TERMINOLOGY,
	replaceAgentTerms,
} from "./use-bot-terminology.ts";

describe("Bot terminology", () => {
	it("ships enabled with a stable storage key", () => {
		expect(DEFAULT_BOT_TERMINOLOGY).toBe(true);
		expect(BOT_TERMINOLOGY_STORAGE_KEY).toBe("ryu:bot-terminology");
	});

	it("replaces singular and plural words while preserving normal casing", () => {
		expect(
			replaceAgentTerms(
				"Agent agent Agents agents AGENT AGENTS Agent's agents' multi-agent"
			)
		).toBe("Bot bot Bots bots BOT BOTS Bot's bots' multi-bot");
	});

	it("keeps the article grammatical", () => {
		expect(
			replaceAgentTerms(
				"Add an agent. An agent's tools. AN AGENT. a plan, an idea"
			)
		).toBe("Add a bot. A bot's tools. A BOT. a plan, an idea");
	});

	it("does not rewrite larger words or technical identifiers", () => {
		expect(replaceAgentTerms("agentic Agentation agent_id subagents")).toBe(
			"agentic Agentation agent_id subagents"
		);
	});
});
