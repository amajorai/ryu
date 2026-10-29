import { describe, expect, it } from "bun:test";
import {
	type ConversationModelChange,
	parseConversationContextHandoffFrame,
	parseConversationModelChange,
	parseConversationModelSelectionFrame,
	parseConversationModelSelectionState,
	parseConversationModelSelectionWriteResult,
} from "./conversation-model-selection-schema.ts";

const change: ConversationModelChange = {
	changedBy: "user-1",
	createdAt: 1_800_000_000_000,
	id: "change-1",
	kind: "change",
	modelId: "claude-sonnet-4",
	modelLabel: "Claude Sonnet 4",
	providerId: "anthropic",
	providerLabel: "Anthropic",
	sequence: 1,
};

describe("conversation model selection parsing", () => {
	it("parses persisted model-change records", () => {
		expect(parseConversationModelChange(change)).toEqual(change);
	});

	it("parses the current choice alongside ordered shared history", () => {
		const nextChange = { ...change, id: "change-2", sequence: 2 };
		expect(
			parseConversationModelSelectionState({
				changes: [change, nextChange],
				current: nextChange,
			})
		).toEqual({
			changes: [change, nextChange],
			current: nextChange,
			handoffs: [],
		});
	});

	it("parses applied context handoffs and drops malformed markers", () => {
		const handoff = {
			createdAt: 1_800_000_000_500,
			fromContext: 1_000_000,
			fromModel: "Claude Sonnet 4",
			id: "handoff-1",
			modelChangeId: "change-2",
			outcome: "applied",
			reason: "smaller-context",
			summarizedCount: 12,
			summary: "[Handoff summary]\n- earlier",
			toContext: 256_000,
			toModel: "GPT-5",
		};
		const state = parseConversationModelSelectionState({
			changes: [change],
			current: change,
			handoffs: [handoff, { ...handoff, id: 7 }],
		});
		expect(state.handoffs).toHaveLength(1);
		expect(state.handoffs[0]).toMatchObject({
			modelChangeId: "change-2",
			summarizedCount: 12,
			toContext: 256_000,
		});
		expect(
			parseConversationContextHandoffFrame({
				conversationId: "conversation-1",
				handoff,
				type: "contextHandoff",
			})?.handoff.id
		).toBe("handoff-1");
		expect(
			parseConversationContextHandoffFrame({
				conversationId: "conversation-1",
				handoff: { ...handoff, outcome: "notNeeded" },
				type: "contextHandoff",
			})
		).toBeNull();
	});

	it("parses successful write responses and rejects malformed ones", () => {
		expect(
			parseConversationModelSelectionWriteResult({ change, changed: true })
		).toEqual({ change, changed: true });
		expect(() =>
			parseConversationModelSelectionWriteResult({ changed: true })
		).toThrow("Core returned an invalid model-selection event");
	});

	it("allows the automatic-routing selection to have no provider or model", () => {
		expect(
			parseConversationModelChange({
				...change,
				kind: "initial",
				modelId: null,
				modelLabel: null,
				providerId: null,
				providerLabel: null,
			})
		).toMatchObject({ kind: "initial", modelId: null, providerId: null });
	});

	it("rejects malformed live room events", () => {
		expect(
			parseConversationModelSelectionFrame({
				change,
				conversationId: "conversation-1",
				type: "message",
			})
		).toBeNull();
		expect(
			parseConversationModelSelectionFrame({
				change: { ...change, sequence: Number.MAX_SAFE_INTEGER + 1 },
				conversationId: "conversation-1",
				type: "modelSelection",
			})
		).toBeNull();
	});
});
