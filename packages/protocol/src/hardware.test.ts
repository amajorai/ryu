// packages/protocol/src/hardware.test.ts
//
// Tests for the RHP v1 narrowing guards and pairing-URI codec. The guards
// validate the `type` discriminator against the KNOWN client/server type sets
// (unlike the voice guard, which accepts any string type) — so an unknown type
// is rejected. parseRhpMessage tries client THEN server and returns null for
// invalid JSON or an unrecognized type. buildPairingUri / parsePairingUri are a
// round-trip pair over the `ryu-pair://<id>?n=&t=` shape.

import { describe, expect, test } from "bun:test";
import {
	buildPairingUri,
	isRhpClientMsg,
	isRhpServerMsg,
	parsePairingUri,
	parseRhpMessage,
} from "./hardware.ts";

describe("isRhpClientMsg / isRhpServerMsg", () => {
	test("accepts each known client type and rejects them as server", () => {
		for (const type of [
			"hello",
			"mode",
			"listen",
			"text",
			"abort",
			"camera_meta",
			"telemetry",
			"ping",
		]) {
			expect(isRhpClientMsg({ type })).toBe(true);
			expect(isRhpServerMsg({ type })).toBe(false);
		}
	});

	test("accepts each known server type and rejects them as client", () => {
		for (const type of [
			"hello_ack",
			"stt",
			"chat_delta",
			"chat_end",
			"emotion",
			"tts_start",
			"tts_end",
			"ambient_ack",
			"ambient_skip",
			"display",
			"error",
			"pong",
		]) {
			expect(isRhpServerMsg({ type })).toBe(true);
			expect(isRhpClientMsg({ type })).toBe(false);
		}
	});

	test("rejects unknown types and non-object / typeless envelopes", () => {
		expect(isRhpClientMsg({ type: "garbage" })).toBe(false);
		expect(isRhpServerMsg({ type: "garbage" })).toBe(false);
		expect(isRhpClientMsg({ type: 42 })).toBe(false);
		expect(isRhpClientMsg(null)).toBe(false);
		expect(isRhpClientMsg("hello")).toBe(false);
		expect(isRhpClientMsg({})).toBe(false);
	});
});

describe("parseRhpMessage", () => {
	test("parses a client message", () => {
		expect(parseRhpMessage('{"type":"ping"}')).toEqual({ type: "ping" });
	});

	test("parses a server message", () => {
		expect(parseRhpMessage('{"type":"pong"}')).toEqual({ type: "pong" });
	});

	test("preserves the full payload of a recognized frame", () => {
		const raw = '{"type":"stt","text":"hi","final":true}';
		expect(parseRhpMessage(raw)).toEqual({
			type: "stt",
			text: "hi",
			final: true,
		});
	});

	test("returns null for invalid JSON", () => {
		expect(parseRhpMessage("{not json")).toBeNull();
	});

	test("returns null for a valid-JSON but unknown type", () => {
		expect(parseRhpMessage('{"type":"garbage"}')).toBeNull();
	});

	test("returns null for a JSON primitive with no type", () => {
		expect(parseRhpMessage('"just a string"')).toBeNull();
		expect(parseRhpMessage("123")).toBeNull();
	});
});

describe("buildPairingUri / parsePairingUri", () => {
	test("builds the ryu-pair:// URL with nonce and type query params", () => {
		const uri = buildPairingUri({
			device_id: "dev-1",
			nonce: "abc",
			device_type: "watch",
		});
		expect(uri).toBe("ryu-pair://dev-1?n=abc&t=watch");
	});

	test("round-trips every device type", () => {
		for (const device_type of ["watch", "necklace", "desk"] as const) {
			const payload = { device_id: "d", nonce: "n", device_type };
			expect(parsePairingUri(buildPairingUri(payload))).toEqual(payload);
		}
	});

	test("percent-encodes a nonce with reserved characters and decodes it back", () => {
		const payload = {
			device_id: "d",
			nonce: "a b&c",
			device_type: "desk" as const,
		};
		const uri = buildPairingUri(payload);
		expect(uri).not.toContain("a b&c");
		expect(parsePairingUri(uri)).toEqual(payload);
	});

	test("rejects a wrong scheme, a missing query, and missing fields", () => {
		expect(parsePairingUri("https://dev-1?n=a&t=watch")).toBeNull();
		expect(parsePairingUri("ryu-pair://dev-1")).toBeNull();
		expect(parsePairingUri("ryu-pair://dev-1?t=watch")).toBeNull();
		expect(parsePairingUri("ryu-pair://?n=a&t=watch")).toBeNull();
	});

	test("rejects an unknown device type", () => {
		expect(parsePairingUri("ryu-pair://d?n=a&t=phone")).toBeNull();
	});
});
