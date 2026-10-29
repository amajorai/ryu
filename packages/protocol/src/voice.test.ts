// packages/protocol/src/voice.test.ts
//
// Tests for the RVP inbound-frame guard. NOTE: parseVoiceServerMsg does NOT
// validate the `type` VALUE against the known server-message set — it returns
// the parsed object for ANY string `type` (contrast parseRhpMessage in
// hardware.ts, which rejects unknown types). It returns null only for invalid
// JSON, a non-object value, or a missing / non-string `type`.

import { describe, expect, test } from "bun:test";
import { parseVoiceServerMsg, voiceServerMsgSchema } from "./voice.ts";

describe("parseVoiceServerMsg", () => {
	test("accepts Core's persisted call summary and rejects malformed durations", () => {
		const summary = {
			type: "call_ended",
			conversationId: "conversation-1",
			messageId: "message-1",
			durationSeconds: 84,
			content: "Call ended · 01:24",
		};
		expect(parseVoiceServerMsg(JSON.stringify(summary))).toEqual(summary);
		for (const durationSeconds of [-1, 1.5, "84", null]) {
			expect(
				parseVoiceServerMsg(JSON.stringify({ ...summary, durationSeconds }))
			).toBeNull();
		}
		expect(parseVoiceServerMsg('{"type":"call_ended"}')).toBeNull();
	});
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

describe("supported voice payload admission", () => {
	test("validates every field required by state, transcript and summary callbacks", () => {
		expect(
			voiceServerMsgSchema.safeParse({ type: "state", value: "listening" })
				.success
		).toBe(true);
		expect(
			voiceServerMsgSchema.safeParse({ type: "state", value: "future" }).success
		).toBe(false);
		expect(
			voiceServerMsgSchema.safeParse({
				type: "stt",
				text: "hello",
				final: false,
			}).success
		).toBe(true);
		expect(
			voiceServerMsgSchema.safeParse({
				type: "stt",
				text: "hello",
				final: "false",
			}).success
		).toBe(false);
		expect(
			voiceServerMsgSchema.safeParse({
				type: "call_ended",
				content: "summary",
				conversationId: "c",
				messageId: "m",
				durationSeconds: 0,
			}).success
		).toBe(true);
		expect(
			voiceServerMsgSchema.safeParse({
				type: "call_ended",
				content: "summary",
				conversationId: "c",
				messageId: "m",
				durationSeconds: -1,
			}).success
		).toBe(false);
	});
	test("preserves transport extensions and their exact native JSON output", () => {
		const raw =
			'{"metadata":1e400,"__proto__":{"retained":true},"type":"future","nested":[null,{"enabled":true}]}';
		expect(parseVoiceServerMsg(raw)).toEqual(JSON.parse(raw));
		expect(JSON.stringify(parseVoiceServerMsg(raw))).toBe(
			JSON.stringify(JSON.parse(raw))
		);
		expect(
			voiceServerMsgSchema.safeParse(parseVoiceServerMsg(raw)).success
		).toBe(false);
		const supported = JSON.parse(
			'{"__proto__":{"retained":true},"extra":"kept","type":"chat_delta","text":"hello"}'
		);
		expect(voiceServerMsgSchema.parse(supported)).toBe(supported);
		expect(JSON.stringify(voiceServerMsgSchema.parse(supported))).toBe(
			JSON.stringify(supported)
		);
	});
});
