import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	messageIsEphemeral,
	normalizeMessages,
} from "./live-message-observations.ts";

const text = [{ text: "Hello", type: "text" as const }];

test("only host-marked client rows are ephemeral (no persisted-message actions)", () => {
	const voiceTurn: UIMessage = {
		id: "voice-call-a-1",
		metadata: { ryuEphemeral: true },
		parts: text,
		role: "assistant",
	};
	const liveTurn: UIMessage = { id: "msg-1", parts: text, role: "assistant" };
	const persisted: UIMessage = {
		id: "msg-2",
		metadata: { ryuPersisted: true },
		parts: text,
		role: "user",
	};
	expect(messageIsEphemeral(voiceTurn)).toBe(true);
	expect(messageIsEphemeral(liveTurn)).toBe(false);
	expect(messageIsEphemeral(persisted)).toBe(false);
	// The transcript normalizes before deciding action availability.
	const [normalized] = normalizeMessages([voiceTurn]);
	expect(normalized && messageIsEphemeral(normalized)).toBe(true);
});
