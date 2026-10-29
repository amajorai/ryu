import type { ContextBreakdownData } from "@ryu/blocks/desktop/agent-elements/context-breakdown-model.ts";
// Exact camelCase wire DTO from Core ContextBreakdown/ContextSegment. The fixture
// supplies a remembered last-turn snapshot; it does not simulate prompt assembly.
export const CONTEXT_PANEL_BREAKDOWN: ContextBreakdownData = {
	attributed: 460,
	plane: "openai",
	reserveOutput: 100,
	segments: [
		{ kind: "instructions", label: "Instructions", tokens: 200 },
		{ kind: "messages", label: "Messages", tokens: 160 },
		{
			kind: "tools",
			label: "Tools",
			tokens: 100,
			detail: "4 tools across 2 servers",
		},
	],
	window: 1000,
};
export const CONTEXT_PANEL_STATS = {
	contextWindow: 1000,
	promptTokens: 630,
	completionTokens: 100,
	totalTokens: 730,
	tokensPerSecond: 42,
};
