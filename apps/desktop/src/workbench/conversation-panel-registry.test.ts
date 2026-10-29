import { describe, expect, test } from "bun:test";
import {
	type ConversationPanelSource,
	getConversationPanelSource,
	registerConversationPanelSource,
} from "./conversation-panel-registry.ts";

function source(conversationId: string): ConversationPanelSource {
	return {
		contextView: {
			conversationId,
			target: { token: "test", url: "http://127.0.0.1:1" },
		},
		cowork: undefined,
	};
}

describe("conversation panel registry", () => {
	test("keys sources by conversation and never crosses conversations", () => {
		const a = source("conv-a");
		const b = source("conv-b");
		const offA = registerConversationPanelSource("conv-a", a);
		const offB = registerConversationPanelSource("conv-b", b);
		expect(getConversationPanelSource("conv-a")).toBe(a);
		expect(getConversationPanelSource("conv-b")).toBe(b);
		offA();
		expect(getConversationPanelSource("conv-a")).toBeUndefined();
		expect(getConversationPanelSource("conv-b")).toBe(b);
		offB();
	});

	test("a stale registration closing does not remove the newer one", () => {
		const first = source("conv-c");
		const second = source("conv-c");
		const offFirst = registerConversationPanelSource("conv-c", first);
		const offSecond = registerConversationPanelSource("conv-c", second);
		offFirst();
		expect(getConversationPanelSource("conv-c")).toBe(second);
		offSecond();
		expect(getConversationPanelSource("conv-c")).toBeUndefined();
	});
});
