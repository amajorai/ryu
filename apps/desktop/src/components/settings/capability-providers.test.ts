import { describe, expect, test } from "bun:test";
import { MODALITIES } from "@/src/lib/api/gateway.ts";

// The capability rows are a hand-written list, and the gateway's `Modality` is a
// Rust enum serialized to these strings. If the two ever drift, a row would read
// the modality map at a key nothing writes and silently render "Unrouted" for a
// capability that IS routed — no error anywhere.
//
// Imported as data rather than by rendering the component, so this stays a unit
// test with no DOM.
const ROUTED = ["image", "stt", "tts", "video", "audio"] as const;

describe("capability provider rows", () => {
	test("every routed capability is a real gateway modality", () => {
		for (const modality of ROUTED) {
			expect(MODALITIES).toContain(modality);
		}
	});

	test("chat is not among them", () => {
		// Chat is the section ABOVE this one and is routed by the model map, not
		// the modality map. Listing it here would offer the same choice twice from
		// two controls that disagree.
		expect(ROUTED).not.toContain("chat");
	});

	test("covers every non-chat modality the gateway defines", () => {
		// The inverse direction: a modality the gateway gains and this list does
		// not would be invisible in settings — routable, but with nothing on
		// screen saying so.
		const uncovered = MODALITIES.filter(
			(m) => m !== "chat" && !ROUTED.includes(m)
		);
		expect(uncovered).toEqual([]);
	});
});
