// packages/protocol/src/hardware.test.ts
//
// Tests for the RHP v1.1 narrowing guards, the pairing-URI codec and the Mode A
// BLE link codec. The guards validate the `type` discriminator against the KNOWN
// client/server type sets (unlike the voice guard, which accepts any string
// type) — so an unknown type is rejected. parseRhpMessage tries client THEN
// server and returns null for invalid JSON or an unrecognized type.
// buildPairingUri / parsePairingUri are a round-trip pair over the
// `ryu-pair://<id>?n=&t=[&v=2&k=]` shape. The BLE codec and the v2 QR are checked
// against the shared golden vectors in crates/core/hardware/tests/vectors.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	bleLinkPdu,
	buildPairingUri,
	classifyBlePdu,
	decodeBase64Url,
	encodeBase64Url,
	formatSas,
	isRhpClientMsg,
	isRhpServerMsg,
	parseBleLinkOp,
	parsePairingUri,
	parseRhpMessage,
	RHP_BLE_MAX_MESSAGE,
	RhpBleAssembler,
	RhpBleLinkOp,
	segmentBleMessage,
} from "./hardware.ts";

const VECTORS_DIR = join(
	import.meta.dir,
	"../../../crates/core/hardware/tests/vectors"
);

function readVector<S extends z.ZodType>(name: string, schema: S): z.output<S> {
	return schema.parse(
		JSON.parse(readFileSync(join(VECTORS_DIR, name), "utf8"))
	);
}

const bleVectors = readVector(
	"rhp_v1_1_ble.json",
	z.object({
		classify: z.object({
			"7b": z.string(),
			a1: z.string(),
			a2: z.string(),
			other: z.string(),
		}),
		link_control: z.object({
			LINK_CLOSED: z.string(),
			LINK_OPEN: z.string(),
			RESTART: z.string(),
		}),
		reject: z.array(
			z.object({ name: z.string(), pdus_hex: z.array(z.string()) })
		),
		segmentations: z.array(
			z.object({
				first_seq: z.number(),
				message_hex: z.string(),
				mtu: z.number(),
				name: z.string(),
				pdus_hex: z.array(z.string()),
			})
		),
	})
);

const pairingVectors = readVector(
	"rhp_v1_1_pairing.json",
	z.object({
		ble_json: z.object({ qr_uri: z.string() }),
		device_pub_b64url: z.string(),
		device_pub_hex: z.string(),
		inputs: z.object({
			device_id: z.string(),
			pairing_nonce: z.string(),
		}),
		sas: z.string(),
		sas_display: z.string(),
	})
);

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}

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
			"capabilities_register",
			"capability_result",
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
			"capabilities_ack",
			"capability_invoke",
			"unpaired",
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
			version: 1,
		});
		expect(uri).toBe("ryu-pair://dev-1?n=abc&t=watch");
	});

	test("round-trips every device type", () => {
		for (const device_type of ["watch", "necklace", "desk"] as const) {
			const payload = {
				device_id: "d",
				nonce: "n",
				device_type,
				version: 1 as const,
			};
			expect(parsePairingUri(buildPairingUri(payload))).toEqual(payload);
		}
	});

	test("percent-encodes a nonce with reserved characters and decodes it back", () => {
		const payload = {
			device_id: "d",
			nonce: "a b&c",
			device_type: "desk" as const,
			version: 1 as const,
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

describe("pairing URI v2", () => {
	test("round-trips the golden v2 QR byte for byte", () => {
		const parsed = parsePairingUri(pairingVectors.ble_json.qr_uri);
		expect(parsed).toEqual({
			device_id: pairingVectors.inputs.device_id,
			device_pub: pairingVectors.device_pub_b64url,
			device_type: "watch",
			nonce: pairingVectors.inputs.pairing_nonce,
			version: 2,
		});
		if (!parsed) {
			throw new Error("golden QR did not parse");
		}
		expect(buildPairingUri(parsed)).toBe(pairingVectors.ble_json.qr_uri);
	});

	test("a QR without v still parses as a v1 device", () => {
		expect(parsePairingUri("ryu-pair://d?n=abc&t=necklace&k=ignored")).toEqual({
			device_id: "d",
			nonce: "abc",
			device_type: "necklace",
			version: 1,
		});
	});

	test("rejects v=2 without a strict 32-byte key, and unknown versions", () => {
		const base = "ryu-pair://d?n=abc&t=watch";
		const key = pairingVectors.device_pub_b64url;
		expect(parsePairingUri(`${base}&v=2`)).toBeNull();
		expect(parsePairingUri(`${base}&v=2&k=`)).toBeNull();
		// 31 bytes, padded, standard alphabet, non-zero trailing bits.
		expect(parsePairingUri(`${base}&v=2&k=${key.slice(0, 42)}`)).toBeNull();
		expect(parsePairingUri(`${base}&v=2&k=${key}%3D`)).toBeNull();
		expect(
			parsePairingUri(`${base}&v=2&k=${key.replaceAll("-", "+")}`)
		).toBeNull();
		expect(parsePairingUri(`${base}&v=2&k=${key.slice(0, 42)}x`)).toBeNull();
		expect(parsePairingUri(`${base}&v=3&k=${key}`)).toBeNull();
		expect(parsePairingUri(`${base}&v=1`)).toBeNull();
	});

	test("strict base64url decodes the golden key and re-encodes it", () => {
		const bytes = decodeBase64Url(pairingVectors.device_pub_b64url);
		expect(bytes && bytesToHex(bytes)).toBe(pairingVectors.device_pub_hex);
		expect(encodeBase64Url(hexToBytes(pairingVectors.device_pub_hex))).toBe(
			pairingVectors.device_pub_b64url
		);
		expect(decodeBase64Url("A")).toBeNull();
		expect(decodeBase64Url("AB")).toBeNull();
		expect(decodeBase64Url("AA")).toEqual(Uint8Array.of(0));
		expect(decodeBase64Url("")).toEqual(new Uint8Array(0));
	});

	test("formats the SAS in two groups of three", () => {
		expect(formatSas(pairingVectors.sas)).toBe(pairingVectors.sas_display);
	});
});

describe("Mode A BLE link codec", () => {
	test("classifies PDUs by byte0 exactly like the vectors", () => {
		expect<string>(classifyBlePdu(Uint8Array.of(0x7b))).toBe(
			bleVectors.classify["7b"]
		);
		expect<string>(classifyBlePdu(Uint8Array.of(0xa1, 0))).toBe(
			bleVectors.classify.a1
		);
		expect<string>(classifyBlePdu(Uint8Array.of(0xa2, 1))).toBe(
			bleVectors.classify.a2
		);
		for (const other of [0x00, 0x01, 0x04, 0x7f, 0xa0, 0xa3, 0xff]) {
			expect<string>(classifyBlePdu(Uint8Array.of(other))).toBe(
				bleVectors.classify.other
			);
		}
		expect(classifyBlePdu(new Uint8Array(0))).toBe("drop");
	});

	test("link-control PDUs match the vectors", () => {
		expect(bytesToHex(bleLinkPdu(RhpBleLinkOp.open))).toBe(
			bleVectors.link_control.LINK_OPEN
		);
		expect(bytesToHex(bleLinkPdu(RhpBleLinkOp.closed))).toBe(
			bleVectors.link_control.LINK_CLOSED
		);
		expect(parseBleLinkOp(hexToBytes(bleVectors.link_control.RESTART))).toBe(
			RhpBleLinkOp.restart
		);
		expect(parseBleLinkOp(Uint8Array.of(0xa2))).toBeNull();
		expect(parseBleLinkOp(Uint8Array.of(0xa1, 3))).toBeNull();
	});

	test("every segmentation reproduces pdus_hex and reassembles", () => {
		expect(bleVectors.segmentations.length).toBeGreaterThan(0);
		for (const vector of bleVectors.segmentations) {
			const message = hexToBytes(vector.message_hex);
			const { pdus, nextSeq } = segmentBleMessage(
				message,
				vector.mtu,
				vector.first_seq
			);
			expect(pdus.map(bytesToHex)).toEqual(vector.pdus_hex);
			expect(nextSeq).toBe((vector.first_seq + vector.pdus_hex.length) % 256);
			for (const pdu of pdus) {
				expect(pdu.length).toBeLessThanOrEqual(vector.mtu - 3);
			}

			const assembler = new RhpBleAssembler();
			// Advance the receiver to first_seq with a throwaway one-PDU message.
			for (let seq = 0; seq < vector.first_seq; seq += 1) {
				const filler = segmentBleMessage(Uint8Array.of(seq), 23, seq);
				const only = filler.pdus[0];
				if (!only) {
					throw new Error("filler segmentation was empty");
				}
				expect(assembler.push(only).kind).toBe("message");
			}
			const results = vector.pdus_hex.map((hex) =>
				assembler.push(hexToBytes(hex))
			);
			const last = results.pop();
			for (const pending of results) {
				expect(pending).toEqual({ kind: "pending" });
			}
			expect(last?.kind).toBe("message");
			if (last?.kind === "message") {
				expect(bytesToHex(last.bytes)).toBe(vector.message_hex);
			}
		}
	});

	test("every reject vector is a fatal assembly error", () => {
		expect(bleVectors.reject.length).toBeGreaterThan(0);
		const expected: Record<string, string> = {
			seq_gap: "seq",
			orphan_continuation: "orphan",
			start_while_open: "start_open",
			overflow: "overflow",
			short_end: "short",
			total_len_zero: "length",
			total_len_too_big: "length",
			reserved_flag_bits: "flags",
		};
		for (const vector of bleVectors.reject) {
			const assembler = new RhpBleAssembler();
			const results = vector.pdus_hex.map((hex) =>
				assembler.push(hexToBytes(hex))
			);
			const last = results.at(-1);
			expect(last?.kind).toBe("error");
			for (const earlier of results.slice(0, -1)) {
				expect(earlier.kind).toBe("pending");
			}
			if (last?.kind === "error") {
				expect<string>(last.reason).toBe(expected[vector.name] ?? "unlisted");
			}
		}
	});

	test("reset restarts the sequence after LINK_OPEN", () => {
		const assembler = new RhpBleAssembler();
		const first = segmentBleMessage(Uint8Array.of(1, 2, 3), 23, 0);
		for (const pdu of first.pdus) {
			assembler.push(pdu);
		}
		assembler.reset();
		const again = segmentBleMessage(Uint8Array.of(4), 23, 0);
		const only = again.pdus[0];
		if (!only) {
			throw new Error("segmentation was empty");
		}
		expect(assembler.push(only)).toEqual({
			bytes: Uint8Array.of(4),
			kind: "message",
		});
	});

	test("refuses empty or oversized messages and a too-small MTU", () => {
		expect(() => segmentBleMessage(new Uint8Array(0), 23, 0)).toThrow(
			RangeError
		);
		expect(() =>
			segmentBleMessage(new Uint8Array(RHP_BLE_MAX_MESSAGE + 1), 247, 0)
		).toThrow(RangeError);
		expect(() => segmentBleMessage(Uint8Array.of(1), 8, 0)).toThrow(RangeError);
		const largest = segmentBleMessage(
			new Uint8Array(RHP_BLE_MAX_MESSAGE),
			247,
			0
		);
		const assembler = new RhpBleAssembler();
		const results = largest.pdus.map((pdu) => assembler.push(pdu));
		expect(results.at(-1)?.kind).toBe("message");
	});
});

describe("transparent relay envelope compatibility", () => {
	test("retains legacy inherited and array discriminators", () => {
		const inherited = Object.create({ type: "ping" });
		const array = Object.assign([], { type: "pong" });
		expect(isRhpClientMsg(inherited)).toBe(true);
		expect(isRhpServerMsg(inherited)).toBe(false);
		expect(isRhpServerMsg(array)).toBe(true);
		expect(isRhpClientMsg(array)).toBe(false);
	});
	test("preserves every opaque control payload entry and native number", () => {
		const raw =
			'{"__proto__":{"retained":true},"future":1e400,"type":"telemetry","nested":[null,{"live":true}]}';
		expect(parseRhpMessage(raw)).toEqual(JSON.parse(raw));
		expect(JSON.stringify(parseRhpMessage(raw))).toBe(
			JSON.stringify(JSON.parse(raw))
		);
	});
});
