import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { ryuAudioEngineLabel } from "./NodeSelector-voice-sandbox-parts.tsx";

test("the Audio sidecar's name is translated before it enters a sentence", () => {
	const tl: LiteralMessage = (source) => `[${source}]`;
	expect(ryuAudioEngineLabel(tl)).toBe("[Ryu Audio engine]");
});
