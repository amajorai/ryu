// packages/protocol/src/voice.test.ts
//
// Tests for the RVP inbound-frame guard. NOTE: parseVoiceServerMsg does NOT
// validate the `type` VALUE against the known server-message set — it returns
// the parsed object for ANY string `type` (contrast parseRhpMessage in
// hardware.ts, which rejects unknown types). It returns null only for invalid
// JSON, a non-object value, or a missing / non-string `type`.

import { describe, expect, test } from "bun:test";
import { parseVoiceServerMsg } from "./voice.ts";

describe("parseVoiceServerMsg", () => {
	test("parses a known server message", () => {
		expect(
			parseVoiceServerMsg(
				'{"type":"ready","session_id":"s","tts_sample_rate":24000}'
			)
		).toEqual({ type: "ready", session_id: "s", tts_sample_rate: 24_000 });
	});

	test("accepts ANY string type (no value validation) — current behavior", () => {
		expect(parseVoiceServerMsg('{"type":"garbage"}')).toEqual({
			type: "garbage",
		});
	});

	test("returns null for invalid JSON", () => {
		expect(parseVoiceServerMsg("{oops")).toBeNull();
	});

	test("returns null when type is missing or not a string", () => {
		expect(parseVoiceServerMsg('{"text":"hi"}')).toBeNull();
		expect(parseVoiceServerMsg('{"type":5}')).toBeNull();
	});

	test("returns null for a JSON null or primitive", () => {
		expect(parseVoiceServerMsg("null")).toBeNull();
		expect(parseVoiceServerMsg('"a string"')).toBeNull();
		expect(parseVoiceServerMsg("42")).toBeNull();
	});
});
