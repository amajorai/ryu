import { expect, test } from "bun:test";
import {
	type VoiceEngineInstallRecord,
	voiceEngineInstallRecordSchema,
} from "./voice-install-records.ts";

test("TTS installation confirms the complete host reply and preserves metadata", () => {
	for (const already_installed of [false, true]) {
		const result = {
			already_installed,
			engine: "pocket",
			installed: true,
			metadata: { runtime: "future", capabilities: ["speech"] },
		} satisfies VoiceEngineInstallRecord & {
			metadata: { runtime: string; capabilities: string[] };
		};
		expect(voiceEngineInstallRecordSchema.parse(result)).toBe(result);
	}
	for (const result of [
		{ engine: "pocket", installed: true },
		{ already_installed: false, engine: "pocket", installed: false },
		{ already_installed: "false", engine: "pocket", installed: true },
		{ already_installed: false, engine: 1, installed: true },
	]) {
		expect(voiceEngineInstallRecordSchema.safeParse(result).success).toBe(
			false
		);
	}
});
