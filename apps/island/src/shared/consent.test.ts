import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ISLAND_CONSENT,
	normalizeConsentBlob,
	parseConsent,
	serializeConsent,
} from "./consent.ts";

describe("normalizeConsentBlob", () => {
	it("defaults chat on and both gated capabilities unanswered", () => {
		expect(normalizeConsentBlob({})).toEqual({
			chat: true,
			contextRead: null,
			proactive: null,
		});
	});

	it("only an explicit false revokes chat", () => {
		expect(normalizeConsentBlob({ chat: false }).chat).toBe(false);
		expect(normalizeConsentBlob({ chat: true }).chat).toBe(true);
		// Anything non-false keeps chat on.
		expect(
			normalizeConsentBlob({ chat: "no" as unknown as boolean }).chat
		).toBe(true);
	});

	it("keeps true/false tri-states and coerces everything else to null", () => {
		expect(normalizeConsentBlob({ contextRead: true }).contextRead).toBe(true);
		expect(normalizeConsentBlob({ contextRead: false }).contextRead).toBe(
			false
		);
		expect(
			normalizeConsentBlob({
				contextRead: "yes" as unknown as boolean,
				proactive: 1 as unknown as boolean,
			})
		).toEqual({ chat: true, contextRead: null, proactive: null });
	});
});

describe("parseConsent", () => {
	it("falls back to the default for null/empty/malformed input", () => {
		expect(parseConsent(null)).toEqual(DEFAULT_ISLAND_CONSENT);
		expect(parseConsent("")).toEqual(DEFAULT_ISLAND_CONSENT);
		expect(parseConsent("{oops")).toEqual(DEFAULT_ISLAND_CONSENT);
	});

	it("normalizes a desktop-written blob the same way the local store does", () => {
		expect(
			parseConsent(
				JSON.stringify({ chat: false, contextRead: true, proactive: false })
			)
		).toEqual({ chat: false, contextRead: true, proactive: false });
	});
});

describe("serializeConsent", () => {
	it("round-trips through parseConsent", () => {
		const state = { chat: false, contextRead: true, proactive: null };
		expect(parseConsent(serializeConsent(state))).toEqual(state);
	});

	it("emits exactly the three canonical fields", () => {
		const raw = serializeConsent({
			chat: true,
			contextRead: null,
			proactive: true,
		});
		expect(JSON.parse(raw)).toEqual({
			chat: true,
			contextRead: null,
			proactive: true,
		});
	});
});
